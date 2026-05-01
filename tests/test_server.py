"""Tests for the HADomotics backend server."""

import io
import json
import os
import struct
import sys
import zlib

import pytest

# Set DATA_DIR before importing server (which creates dirs at module import time).
# Use a process-specific directory to avoid collisions in concurrent runs.
import tempfile as _tempfile
_TEST_DATA_DIR = _tempfile.mkdtemp(prefix="hadomotics_test_")
os.environ["DATA_DIR"] = _TEST_DATA_DIR

# Make the hadomotics package importable
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "hadomotics"))


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def make_minimal_png() -> bytes:
    """Return the smallest valid 1×1 PNG image as bytes."""

    def chunk(name: bytes, data: bytes) -> bytes:
        c = name + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0))
    raw = b"\x00\xFF\x00\x00"   # filter byte + RGB
    idat = chunk(b"IDAT", zlib.compress(raw))
    iend = chunk(b"IEND", b"")
    return sig + ihdr + idat + iend


@pytest.fixture()
def tmp_data(tmp_path):
    """Override DATA_DIR to a fresh temporary directory for each test."""
    import server as srv

    srv.DATA_DIR = tmp_path
    srv.IMAGES_DIR = tmp_path / "images"
    srv.CONFIG_FILE = tmp_path / "config.json"
    srv.IMAGES_DIR.mkdir(parents=True, exist_ok=True)

    yield tmp_path


@pytest.fixture()
def client(tmp_data):
    import server as srv
    srv.app.config["TESTING"] = True
    with srv.app.test_client() as c:
        yield c


# ---------------------------------------------------------------------------
# Floors
# ---------------------------------------------------------------------------


def test_list_floors_default(client):
    """Default config has three floors."""
    resp = client.get("/api/floors")
    assert resp.status_code == 200
    floors = resp.get_json()
    ids = [f["id"] for f in floors]
    assert "floor1" in ids
    assert "floor2" in ids
    assert "garden" in ids


def test_create_floor(client):
    resp = client.post(
        "/api/floors",
        data=json.dumps({"name": "Basement"}),
        content_type="application/json",
    )
    assert resp.status_code == 201
    floor = resp.get_json()
    assert floor["name"] == "Basement"
    assert floor["id"]
    assert floor["elements"] == []


def test_create_floor_missing_name(client):
    resp = client.post(
        "/api/floors",
        data=json.dumps({}),
        content_type="application/json",
    )
    assert resp.status_code == 400


def test_get_floor(client):
    resp = client.get("/api/floors/floor1")
    assert resp.status_code == 200
    floor = resp.get_json()
    assert floor["id"] == "floor1"
    assert "elements" in floor


def test_get_floor_not_found(client):
    resp = client.get("/api/floors/does_not_exist")
    assert resp.status_code == 404


def test_update_floor_name(client):
    resp = client.put(
        "/api/floors/floor1",
        data=json.dumps({"name": "Ground Floor"}),
        content_type="application/json",
    )
    assert resp.status_code == 200
    assert resp.get_json()["name"] == "Ground Floor"

    # Verify persistence
    resp2 = client.get("/api/floors/floor1")
    assert resp2.get_json()["name"] == "Ground Floor"


def test_delete_floor(client):
    # Create a new floor so we don't need the default ones
    create_resp = client.post(
        "/api/floors",
        data=json.dumps({"name": "Attic"}),
        content_type="application/json",
    )
    fid = create_resp.get_json()["id"]

    del_resp = client.delete(f"/api/floors/{fid}")
    assert del_resp.status_code == 200

    # Should be gone
    assert client.get(f"/api/floors/{fid}").status_code == 404


# ---------------------------------------------------------------------------
# Elements
# ---------------------------------------------------------------------------


def test_create_element(client):
    payload = {
        "type": "light",
        "label": "Kitchen Light",
        "entity_id": "light.kitchen",
        "x": 100.0,
        "y": 200.0,
    }
    resp = client.post(
        "/api/floors/floor1/elements",
        data=json.dumps(payload),
        content_type="application/json",
    )
    assert resp.status_code == 201
    el = resp.get_json()
    assert el["type"] == "light"
    assert el["label"] == "Kitchen Light"
    assert el["entity_id"] == "light.kitchen"
    assert el["x"] == 100.0
    assert el["y"] == 200.0
    assert el["id"]


def test_list_elements(client):
    # Add two elements to a freshly-created floor to avoid cross-test contamination
    create_resp = client.post(
        "/api/floors",
        data=json.dumps({"name": "TestFloor"}),
        content_type="application/json",
    )
    fid = create_resp.get_json()["id"]

    for i in range(2):
        client.post(
            f"/api/floors/{fid}/elements",
            data=json.dumps({"label": f"elem{i}", "type": "button"}),
            content_type="application/json",
        )
    resp = client.get(f"/api/floors/{fid}/elements")
    assert resp.status_code == 200
    elements = resp.get_json()
    assert len(elements) == 2


def test_update_element(client):
    create = client.post(
        "/api/floors/floor1/elements",
        data=json.dumps({"label": "Old Label", "type": "button"}),
        content_type="application/json",
    )
    eid = create.get_json()["id"]

    resp = client.put(
        f"/api/floors/floor1/elements/{eid}",
        data=json.dumps({"label": "New Label", "x": 55.0}),
        content_type="application/json",
    )
    assert resp.status_code == 200
    updated = resp.get_json()
    assert updated["label"] == "New Label"
    assert updated["x"] == 55.0


def test_delete_element(client):
    create = client.post(
        "/api/floors/floor1/elements",
        data=json.dumps({"label": "Temp", "type": "button"}),
        content_type="application/json",
    )
    eid = create.get_json()["id"]

    del_resp = client.delete(f"/api/floors/floor1/elements/{eid}")
    assert del_resp.status_code == 200

    elements = client.get("/api/floors/floor1/elements").get_json()
    assert not any(e["id"] == eid for e in elements)


def test_delete_element_not_found(client):
    resp = client.delete("/api/floors/floor1/elements/nonexistent-id")
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# Image upload
# ---------------------------------------------------------------------------


def test_upload_image(client):
    # Create a minimal valid 1x1 PNG in memory
    png_data = make_minimal_png()
    data = {"image": (io.BytesIO(png_data), "floor.png", "image/png")}
    resp = client.post(
        "/api/floors/floor1/image",
        data=data,
        content_type="multipart/form-data",
    )
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["ok"] is True

    # Floor should now have an image
    floor = client.get("/api/floors/floor1").get_json()
    assert floor["image"] is not None


def test_upload_image_invalid_type(client):
    data = {"image": (io.BytesIO(b"not an image"), "file.exe", "application/octet-stream")}
    resp = client.post(
        "/api/floors/floor1/image",
        data=data,
        content_type="multipart/form-data",
    )
    assert resp.status_code == 400


def test_delete_image(client):
    png_data = make_minimal_png()
    data = {"image": (io.BytesIO(png_data), "floor.png", "image/png")}
    client.post(
        "/api/floors/floor1/image",
        data=data,
        content_type="multipart/form-data",
    )

    del_resp = client.delete("/api/floors/floor1/image")
    assert del_resp.status_code == 200

    floor = client.get("/api/floors/floor1").get_json()
    assert floor["image"] is None


# ---------------------------------------------------------------------------
# Image serving – path traversal prevention
# ---------------------------------------------------------------------------


def test_serve_image_path_traversal(client):
    resp = client.get("/api/images/../../etc/passwd")
    # Either 404 (file not found) or a safe response, never the actual file
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# Config endpoint
# ---------------------------------------------------------------------------


def test_get_config(client):
    resp = client.get("/api/config")
    assert resp.status_code == 200
    # Floors should not be exposed in the global config endpoint
    data = resp.get_json()
    assert "floors" not in data
