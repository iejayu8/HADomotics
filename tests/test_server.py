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
    srv.CONFIG_FILE = tmp_path / "config.yaml"
    srv.IMAGES_DIR.mkdir(parents=True, exist_ok=True)

    yield tmp_path


@pytest.fixture()
def client(tmp_data, monkeypatch):
    """Authenticated Home Assistant ingress request from an administrator."""
    from unittest.mock import patch
    import server as srv

    monkeypatch.setenv("ALLOW_DIRECT_ACCESS", "false")
    monkeypatch.delenv("CORS_ORIGINS", raising=False)
    srv._state_cache.clear()
    srv._token_cache.clear()
    srv._admin_cache = None
    srv.app.config["TESTING"] = True
    with patch.object(srv, "ingress_user_is_admin", return_value=True):
        with srv.app.test_client() as c:
            c.environ_base["REMOTE_ADDR"] = srv.INGRESS_SOURCE_IP
            c.environ_base["HTTP_X_REMOTE_USER_ID"] = "admin-user"
            yield c


@pytest.fixture()
def lan_client(tmp_data, monkeypatch):
    """A direct client, as if the host port were reachable from the LAN."""
    import server as srv

    monkeypatch.setenv("ALLOW_DIRECT_ACCESS", "false")
    monkeypatch.delenv("CORS_ORIGINS", raising=False)
    srv._state_cache.clear()
    srv._token_cache.clear()
    srv._admin_cache = None
    srv.app.config["TESTING"] = True
    with srv.app.test_client() as c:
        c.environ_base["REMOTE_ADDR"] = "192.168.1.50"
        yield c


@pytest.fixture()
def ingress_member(tmp_data, monkeypatch):
    """Ingress session for a non-administrator Home Assistant user."""
    from unittest.mock import patch
    import server as srv

    monkeypatch.setenv("ALLOW_DIRECT_ACCESS", "false")
    srv._state_cache.clear()
    srv._token_cache.clear()
    srv._admin_cache = None
    srv.app.config["TESTING"] = True
    with patch.object(srv, "ingress_user_is_admin", return_value=False):
        with srv.app.test_client() as c:
            c.environ_base["REMOTE_ADDR"] = srv.INGRESS_SOURCE_IP
            c.environ_base["HTTP_X_REMOTE_USER_ID"] = "family-user"
            yield c


# ---------------------------------------------------------------------------
# Floors
# ---------------------------------------------------------------------------


def test_list_floors_default(client):
    """Default config is the single built-in floor."""
    resp = client.get("/api/floors")
    assert resp.status_code == 200
    floors = resp.get_json()
    ids = [f["id"] for f in floors]
    assert ids == ["floor1"]


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


# ---------------------------------------------------------------------------
# _safe_path_within helper
# ---------------------------------------------------------------------------


def test_safe_path_within_valid(tmp_data):
    import server as srv

    result = srv._safe_path_within(srv.IMAGES_DIR, "somefile.png")
    assert result is not None
    assert result.parent == srv.IMAGES_DIR.resolve()


def test_safe_path_within_traversal(tmp_data):
    import server as srv

    result = srv._safe_path_within(srv.IMAGES_DIR, "../../etc/passwd")
    assert result is None


# ---------------------------------------------------------------------------
# load_config with corrupt JSON
# ---------------------------------------------------------------------------


def test_load_config_corrupt_json(tmp_data):
    import server as srv

    srv.CONFIG_FILE.write_text("this is not valid json")
    config = srv.load_config()
    # Should fall back to defaults
    assert "floors" in config
    ids = [f["id"] for f in config["floors"]]
    assert "floor1" in ids


# ---------------------------------------------------------------------------
# Static / index routes
# ---------------------------------------------------------------------------


def test_index_route(client):
    import server as srv

    # Create the static/index.html file so Flask can serve it
    static_dir = srv.app.static_folder
    os.makedirs(static_dir, exist_ok=True)
    index_path = os.path.join(static_dir, "index.html")
    created = not os.path.exists(index_path)
    if created:
        with open(index_path, "w") as f:
            f.write("<html></html>")
    try:
        resp = client.get("/")
        assert resp.status_code == 200
        resp2 = client.get("/index.html")
        assert resp2.status_code == 200
    finally:
        if created:
            os.remove(index_path)


def test_serve_static_route(client):
    import server as srv

    static_dir = srv.app.static_folder
    os.makedirs(static_dir, exist_ok=True)
    asset_path = os.path.join(static_dir, "test_asset.js")
    with open(asset_path, "w") as f:
        f.write("// test")
    try:
        resp = client.get("/static/test_asset.js")
        assert resp.status_code == 200
    finally:
        os.remove(asset_path)


# ---------------------------------------------------------------------------
# Floors – additional error paths
# ---------------------------------------------------------------------------


def test_update_floor_not_found(client):
    resp = client.put(
        "/api/floors/no_such_floor",
        data=json.dumps({"name": "Ghost"}),
        content_type="application/json",
    )
    assert resp.status_code == 404


def test_update_floor_order(client):
    resp = client.put(
        "/api/floors/floor1",
        data=json.dumps({"order": 99}),
        content_type="application/json",
    )
    assert resp.status_code == 200
    assert resp.get_json()["order"] == 99


def test_delete_floor_not_found(client):
    resp = client.delete("/api/floors/no_such_floor")
    assert resp.status_code == 404


def test_delete_floor_removes_image_file(client):
    """Deleting a floor that has an image should unlink the image file."""
    # Upload an image first
    png_data = make_minimal_png()
    client.post(
        "/api/floors/floor1/image",
        data={"image": (io.BytesIO(png_data), "f.png", "image/png")},
        content_type="multipart/form-data",
    )
    floor = client.get("/api/floors/floor1").get_json()
    img_filename = floor["image"]

    import server as srv

    img_file = srv.IMAGES_DIR / img_filename
    assert img_file.exists()

    client.delete("/api/floors/floor1")
    assert not img_file.exists()


def test_list_floors_has_image_flag(client):
    """has_image should be False before uploading and True after."""
    floors = client.get("/api/floors").get_json()
    floor1_summary = next(f for f in floors if f["id"] == "floor1")
    assert floor1_summary["has_image"] is False

    png_data = make_minimal_png()
    client.post(
        "/api/floors/floor1/image",
        data={"image": (io.BytesIO(png_data), "f.png", "image/png")},
        content_type="multipart/form-data",
    )

    floors_after = client.get("/api/floors").get_json()
    floor1_after = next(f for f in floors_after if f["id"] == "floor1")
    assert floor1_after["has_image"] is True


# ---------------------------------------------------------------------------
# Image upload – additional paths
# ---------------------------------------------------------------------------


def test_upload_image_invalid_floor_id(client):
    """Floor IDs with unsafe characters should be rejected."""
    png_data = make_minimal_png()
    resp = client.post(
        "/api/floors/bad!floor/image",
        data={"image": (io.BytesIO(png_data), "f.png", "image/png")},
        content_type="multipart/form-data",
    )
    assert resp.status_code == 400
    assert "Invalid floor ID" in resp.get_json().get("error", "")


def test_upload_image_floor_not_found(client):
    png_data = make_minimal_png()
    resp = client.post(
        "/api/floors/no_such_floor/image",
        data={"image": (io.BytesIO(png_data), "f.png", "image/png")},
        content_type="multipart/form-data",
    )
    assert resp.status_code == 404


def test_upload_image_no_file(client):
    resp = client.post(
        "/api/floors/floor1/image",
        data={},
        content_type="multipart/form-data",
    )
    assert resp.status_code == 400


def test_upload_image_corrupt_content(client):
    """A file with a valid extension but invalid image data should be rejected."""
    resp = client.post(
        "/api/floors/floor1/image",
        data={"image": (io.BytesIO(b"not a real png"), "f.png", "image/png")},
        content_type="multipart/form-data",
    )
    assert resp.status_code == 400


def test_upload_image_replaces_old_image(client):
    """Uploading a second image should remove the previous file."""
    png_data = make_minimal_png()

    client.post(
        "/api/floors/floor1/image",
        data={"image": (io.BytesIO(png_data), "first.png", "image/png")},
        content_type="multipart/form-data",
    )
    first_filename = client.get("/api/floors/floor1").get_json()["image"]

    import server as srv

    first_path = srv.IMAGES_DIR / first_filename
    assert first_path.exists()

    client.post(
        "/api/floors/floor1/image",
        data={"image": (io.BytesIO(png_data), "second.png", "image/png")},
        content_type="multipart/form-data",
    )
    second_filename = client.get("/api/floors/floor1").get_json()["image"]

    assert second_filename != first_filename
    assert not first_path.exists()


def test_upload_image_jpeg(client):
    """Uploading a JPEG extension should be allowed and normalized to .jpg."""
    png_data = make_minimal_png()
    resp = client.post(
        "/api/floors/floor1/image",
        data={"image": (io.BytesIO(png_data), "photo.jpeg", "image/jpeg")},
        content_type="multipart/form-data",
    )
    # jpeg bytes will fail PIL verify because they're actually PNG bytes,
    # so we only check the extension handling (it may pass or fail at verify).
    # For JPEG extension mapping the important thing is it is not rejected by
    # the extension check (status won't be 400 due to file type; PIL verify may
    # still reject the content).
    assert resp.status_code in (200, 400)
    if resp.status_code == 400:
        body = resp.get_json()
        assert "corrupt" in body.get("error", "").lower() or "invalid" in body.get("error", "").lower()


# ---------------------------------------------------------------------------
# Image deletion – additional paths
# ---------------------------------------------------------------------------


def test_delete_image_floor_not_found(client):
    resp = client.delete("/api/floors/no_such_floor/image")
    assert resp.status_code == 404


def test_delete_image_no_image_set(client):
    """Deleting image from a floor that has none should still return 200."""
    resp = client.delete("/api/floors/floor1/image")
    assert resp.status_code == 200
    assert resp.get_json()["ok"] is True


# ---------------------------------------------------------------------------
# Image serving
# ---------------------------------------------------------------------------


def test_serve_image_success(client):
    """A registered image should be served."""
    png_data = make_minimal_png()
    client.post(
        "/api/floors/floor1/image",
        data={"image": (io.BytesIO(png_data), "f.png", "image/png")},
        content_type="multipart/form-data",
    )
    filename = client.get("/api/floors/floor1").get_json()["image"]

    resp = client.get(f"/api/images/{filename}")
    assert resp.status_code == 200


def test_serve_image_unregistered(client):
    """Requesting a filename not in config should return 404."""
    resp = client.get("/api/images/not_registered_at_all.png")
    assert resp.status_code == 404


def test_serve_image_file_deleted(client, tmp_data):
    """Image registered in config but deleted from disk should return 404."""
    import server as srv

    # Directly inject a config entry pointing to a non-existent file
    config = srv.load_config()
    config["floors"][0]["image"] = "ghost_image.png"
    srv.save_config(config)

    resp = client.get("/api/images/ghost_image.png")
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# Elements – floor-not-found paths
# ---------------------------------------------------------------------------


def test_list_elements_floor_not_found(client):
    resp = client.get("/api/floors/no_such_floor/elements")
    assert resp.status_code == 404


def test_create_element_floor_not_found(client):
    resp = client.post(
        "/api/floors/no_such_floor/elements",
        data=json.dumps({"label": "x", "type": "button"}),
        content_type="application/json",
    )
    assert resp.status_code == 404


def test_update_element_floor_not_found(client):
    resp = client.put(
        "/api/floors/no_such_floor/elements/some-id",
        data=json.dumps({"label": "x"}),
        content_type="application/json",
    )
    assert resp.status_code == 404


def test_update_element_not_found(client):
    resp = client.put(
        "/api/floors/floor1/elements/nonexistent-elem-id",
        data=json.dumps({"label": "x"}),
        content_type="application/json",
    )
    assert resp.status_code == 404


def test_delete_element_floor_not_found(client):
    resp = client.delete("/api/floors/no_such_floor/elements/some-id")
    assert resp.status_code == 404


def test_create_element_all_fields(client):
    """All optional element fields should be stored and returned."""
    payload = {
        "type": "light",
        "label": "Lamp",
        "entity_id": "light.lamp",
        "icon": "mdi:lamp",
        "x": 10.5,
        "y": 20.5,
        "width": 80.0,
        "height": 40.0,
        "color_on": "#FF0000",
        "color_off": "#000000",
        "tap_action": "navigate",
    }
    resp = client.post(
        "/api/floors/floor1/elements",
        data=json.dumps(payload),
        content_type="application/json",
    )
    assert resp.status_code == 201
    el = resp.get_json()
    for key, val in payload.items():
        assert el[key] == val


def test_update_element_all_fields(client):
    """All updatable fields on an element should be persisted."""
    create = client.post(
        "/api/floors/floor1/elements",
        data=json.dumps({"label": "orig", "type": "button"}),
        content_type="application/json",
    )
    eid = create.get_json()["id"]

    updates = {
        "type": "light",
        "label": "updated",
        "entity_id": "light.updated",
        "icon": "mdi:star",
        "x": 1.0,
        "y": 2.0,
        "width": 100.0,
        "height": 50.0,
        "color_on": "#FFFFFF",
        "color_off": "#111111",
        "tap_action": "more-info",
    }
    resp = client.put(
        f"/api/floors/floor1/elements/{eid}",
        data=json.dumps(updates),
        content_type="application/json",
    )
    assert resp.status_code == 200
    el = resp.get_json()
    for key, val in updates.items():
        assert el[key] == val


def test_bulk_update_colors_floor_only(client):
    f1 = client.post(
        "/api/floors",
        data=json.dumps({"name": "One"}),
        content_type="application/json",
    ).get_json()
    f2 = client.post(
        "/api/floors",
        data=json.dumps({"name": "Two"}),
        content_type="application/json",
    ).get_json()
    a = client.post(
        f"/api/floors/{f1['id']}/elements",
        data=json.dumps({"label": "a", "color_on": "#111111", "color_off": "#222222"}),
        content_type="application/json",
    ).get_json()
    b = client.post(
        f"/api/floors/{f2['id']}/elements",
        data=json.dumps({"label": "b", "color_on": "#111111", "color_off": "#222222"}),
        content_type="application/json",
    ).get_json()

    resp = client.put(
        "/api/elements/colors",
        data=json.dumps({
            "color_on": "#FFAA00",
            "color_off": "#333333",
            "scope": "floor",
            "floor_id": f1["id"],
        }),
        content_type="application/json",
    )
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["ok"] is True
    assert body["updated"] == 1

    floor1 = client.get(f"/api/floors/{f1['id']}").get_json()
    floor2 = client.get(f"/api/floors/{f2['id']}").get_json()
    el1 = next(e for e in floor1["elements"] if e["id"] == a["id"])
    el2 = next(e for e in floor2["elements"] if e["id"] == b["id"])
    assert el1["color_on"] == "#FFAA00"
    assert el1["color_off"] == "#333333"
    assert el2["color_on"] == "#111111"
    assert el2["color_off"] == "#222222"


def test_bulk_update_colors_all_floors(client):
    f1 = client.post(
        "/api/floors",
        data=json.dumps({"name": "One"}),
        content_type="application/json",
    ).get_json()
    f2 = client.post(
        "/api/floors",
        data=json.dumps({"name": "Two"}),
        content_type="application/json",
    ).get_json()
    client.post(
        f"/api/floors/{f1['id']}/elements",
        data=json.dumps({"label": "a"}),
        content_type="application/json",
    )
    client.post(
        f"/api/floors/{f1['id']}/elements",
        data=json.dumps({"label": "a2"}),
        content_type="application/json",
    )
    client.post(
        f"/api/floors/{f2['id']}/elements",
        data=json.dumps({"label": "b"}),
        content_type="application/json",
    )

    resp = client.put(
        "/api/elements/colors",
        data=json.dumps({
            "color_on": "#00FF00",
            "color_off": "#0000FF",
            "scope": "all",
        }),
        content_type="application/json",
    )
    assert resp.status_code == 200
    assert resp.get_json()["updated"] == 3

    for fid in (f1["id"], f2["id"]):
        floor = client.get(f"/api/floors/{fid}").get_json()
        for el in floor["elements"]:
            assert el["color_on"] == "#00FF00"
            assert el["color_off"] == "#0000FF"


def test_bulk_update_colors_invalid(client):
    resp = client.put(
        "/api/elements/colors",
        data=json.dumps({"color_on": "red", "scope": "all"}),
        content_type="application/json",
    )
    assert resp.status_code == 400

    resp = client.put(
        "/api/elements/colors",
        data=json.dumps({"color_on": "#FFFFFF", "scope": "floor"}),
        content_type="application/json",
    )
    assert resp.status_code == 400

    resp = client.put(
        "/api/elements/colors",
        data=json.dumps({"color_on": "#FFFFFF", "scope": "floor", "floor_id": "missing"}),
        content_type="application/json",
    )
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# HA proxy endpoints
# ---------------------------------------------------------------------------


class _Tokens:
    def __init__(self, supervisor="", ha=""):
        import server as srv

        self.srv = srv
        self.saved = (srv.HA_TOKEN, srv.SUPERVISOR_TOKEN)
        srv.HA_TOKEN = ha
        srv.SUPERVISOR_TOKEN = supervisor
        srv._state_cache.clear()

    def close(self):
        self.srv.HA_TOKEN, self.srv.SUPERVISOR_TOKEN = self.saved
        self.srv._state_cache.clear()


def test_ha_states_no_token(client):
    """Without a supervisor token the endpoint returns an empty list."""
    tokens = _Tokens()
    try:
        resp = client.get("/api/ha/states")
        assert resp.status_code == 200
        assert resp.get_json() == []
    finally:
        tokens.close()


def test_ha_state_no_token(client):
    """Without a supervisor token the endpoint returns 503."""
    tokens = _Tokens()
    try:
        resp = client.get("/api/ha/states/light.kitchen")
        assert resp.status_code == 503
    finally:
        tokens.close()


def test_ha_call_service_no_token(client):
    """Without a supervisor token the endpoint returns 503."""
    tokens = _Tokens()
    try:
        resp = client.post(
            "/api/ha/services/light/turn_on",
            data=json.dumps({"entity_id": "light.kitchen"}),
            content_type="application/json",
        )
        assert resp.status_code == 503
    finally:
        tokens.close()


def test_ha_states_with_token(client):
    """With a token, states are fetched from the HA API (mocked)."""
    from unittest.mock import patch, MagicMock

    tokens = _Tokens(supervisor="fake-token")
    mock_resp = MagicMock()
    mock_resp.json.return_value = [{"entity_id": "light.kitchen", "state": "on"}]
    try:
        with patch("server.requests.get", return_value=mock_resp) as mock_get:
            resp = client.get("/api/ha/states")
            assert resp.status_code == 200
            states = resp.get_json()
            assert states[0]["entity_id"] == "light.kitchen"
            mock_get.assert_called_once()
    finally:
        tokens.close()


def test_ha_states_network_error(client):
    """A network error should return an empty list gracefully."""
    from unittest.mock import patch

    tokens = _Tokens(supervisor="fake-token")
    try:
        with patch("server.requests.get", side_effect=Exception("timeout")):
            resp = client.get("/api/ha/states")
            assert resp.status_code == 200
            assert resp.get_json() == []
    finally:
        tokens.close()


def test_ha_state_with_token(client):
    """With a token, a single entity state is proxied from HA (mocked)."""
    from unittest.mock import patch, MagicMock

    tokens = _Tokens(supervisor="fake-token")
    mock_resp = MagicMock()
    mock_resp.json.return_value = {"entity_id": "light.kitchen", "state": "off"}
    mock_resp.status_code = 200
    try:
        with patch("server.requests.get", return_value=mock_resp):
            resp = client.get("/api/ha/states/light.kitchen")
            assert resp.status_code == 200
            assert resp.get_json()["state"] == "off"
    finally:
        tokens.close()


def test_ha_state_network_error(client):
    """A network error on entity state should return 503."""
    from unittest.mock import patch

    tokens = _Tokens(supervisor="fake-token")
    try:
        with patch("server.requests.get", side_effect=Exception("timeout")):
            resp = client.get("/api/ha/states/light.kitchen")
            assert resp.status_code == 503
    finally:
        tokens.close()


def test_ha_call_service_with_token(client):
    """With a token, services are called via the HA API (mocked)."""
    from unittest.mock import patch, MagicMock

    tokens = _Tokens(supervisor="fake-token")
    mock_resp = MagicMock()
    mock_resp.json.return_value = []
    mock_resp.status_code = 200
    try:
        with patch("server.requests.post", return_value=mock_resp) as mock_post:
            resp = client.post(
                "/api/ha/services/light/turn_on",
                data=json.dumps({"entity_id": "light.kitchen"}),
                content_type="application/json",
            )
            assert resp.status_code == 200
            mock_post.assert_called_once()
            auth = mock_post.call_args.kwargs["headers"]["Authorization"]
            assert auth == "Bearer fake-token"
    finally:
        tokens.close()


def test_ha_call_service_network_error(client):
    """A network error calling a service should return 503."""
    from unittest.mock import patch

    tokens = _Tokens(supervisor="fake-token")
    try:
        with patch("server.requests.post", side_effect=Exception("timeout")):
            resp = client.post(
                "/api/ha/services/light/turn_on",
                data=json.dumps({}),
                content_type="application/json",
            )
            assert resp.status_code == 503
    finally:
        tokens.close()


# ---------------------------------------------------------------------------
# Authentication, CORS, and the service allowlist
# ---------------------------------------------------------------------------


def _service_post(client, domain, service, payload=None, headers=None):
    return client.post(
        f"/api/ha/services/{domain}/{service}",
        data=json.dumps(payload if payload is not None else {"entity_id": "cover.garage"}),
        content_type="application/json",
        headers=headers,
    )


def test_lan_service_call_is_rejected(lan_client):
    """An unauthenticated direct client cannot open a cover (or call anything)."""
    from unittest.mock import patch

    with patch("server.requests.post") as mock_post:
        resp = _service_post(lan_client, "cover", "open_cover")
    assert resp.status_code == 401
    assert resp.get_json()["error"] == "Authentication required"
    mock_post.assert_not_called()


def test_lan_cannot_spoof_ingress_identity(lan_client):
    """Forwarded headers do not make a LAN client look like Supervisor ingress."""
    from unittest.mock import patch

    headers = {
        "X-Remote-User-Id": "admin-user",
        "X-Remote-User-Name": "admin",
        "X-Forwarded-For": "172.30.32.2",
        "X-Ingress-Path": "/api/hassio_ingress/abc",
    }
    with patch("server.requests.post") as mock_post:
        resp = _service_post(lan_client, "cover", "open_cover", headers=headers)
    assert resp.status_code == 401
    mock_post.assert_not_called()
    assert resp.headers.get("Access-Control-Allow-Origin") != "*"


def test_lan_cannot_read_states_or_floors(lan_client):
    from unittest.mock import patch

    with patch("server.requests.get") as mock_get:
        states = lan_client.get("/api/ha/states")
        floors = lan_client.get("/api/floors")
    assert states.status_code == 401
    assert floors.status_code == 401
    mock_get.assert_not_called()


def test_ingress_admin_can_call_allowed_service(client):
    from unittest.mock import patch, MagicMock

    tokens = _Tokens(supervisor="supervisor-secret")
    mock_resp = MagicMock()
    mock_resp.json.return_value = []
    mock_resp.status_code = 200
    try:
        with patch("server.requests.post", return_value=mock_resp) as mock_post:
            resp = _service_post(client, "cover", "open_cover")
        assert resp.status_code == 200
        mock_post.assert_called_once()
        assert mock_post.call_args.kwargs["headers"]["Authorization"] == "Bearer supervisor-secret"
        assert mock_post.call_args.args[0].endswith("/services/cover/open_cover")
    finally:
        tokens.close()


def test_ingress_admin_blocks_unlisted_services(client):
    from unittest.mock import patch

    with patch("server.requests.post") as mock_post:
        restart = _service_post(client, "homeassistant", "restart", {})
        shell = _service_post(client, "shell_command", "reboot", {})
        weird = _service_post(client, "light", "destroy_world", {})
    assert restart.status_code == 403
    assert shell.status_code == 403
    assert weird.status_code == 403
    mock_post.assert_not_called()


def test_ingress_allows_floorplan_toggle_and_cover_position(client):
    from unittest.mock import patch, MagicMock

    tokens = _Tokens(supervisor="supervisor-secret")
    mock_resp = MagicMock()
    mock_resp.json.return_value = []
    mock_resp.status_code = 200
    try:
        with patch("server.requests.post", return_value=mock_resp) as mock_post:
            toggle = _service_post(client, "light", "toggle", {"entity_id": "light.kitchen"})
            position = _service_post(
                client,
                "cover",
                "set_cover_position",
                {"entity_id": "cover.garage", "position": 100},
            )
            custom = _service_post(client, "plant", "toggle", {"entity_id": "plant.fern"})
        assert toggle.status_code == 200
        assert position.status_code == 200
        assert custom.status_code == 200
        assert mock_post.call_count == 3
    finally:
        tokens.close()


def test_ingress_non_admin_can_read_floors_but_not_call_services(ingress_member):
    from unittest.mock import patch

    floors = ingress_member.get("/api/floors")
    assert floors.status_code == 200
    assert floors.get_json()[0]["id"] == "floor1"

    with patch("server.requests.post") as mock_post:
        service = _service_post(ingress_member, "cover", "open_cover")
    assert service.status_code == 403
    assert service.get_json()["error"] == "Administrator access required"
    mock_post.assert_not_called()

    created = ingress_member.post(
        "/api/floors",
        data=json.dumps({"name": "Secret"}),
        content_type="application/json",
    )
    assert created.status_code == 403
    states = ingress_member.get("/api/ha/states")
    assert states.status_code == 403


def test_ingress_without_user_header_is_not_admin(tmp_data, monkeypatch):
    """Supervisor peer without X-Remote-User-Id cannot drive services."""
    import server as srv

    monkeypatch.setenv("ALLOW_DIRECT_ACCESS", "false")
    srv.app.config["TESTING"] = True
    with srv.app.test_client() as c:
        c.environ_base["REMOTE_ADDR"] = srv.INGRESS_SOURCE_IP
        floors = c.get("/api/floors")
        service = _service_post(c, "cover", "open_cover")
    assert floors.status_code == 200
    assert service.status_code == 403


def test_direct_access_disabled_rejects_bearer_token(lan_client):
    from unittest.mock import patch

    with patch("server.requests.get") as mock_get, patch("server.requests.post") as mock_post:
        resp = _service_post(
            lan_client,
            "cover",
            "open_cover",
            headers={"Authorization": "Bearer user-token"},
        )
    assert resp.status_code == 401
    mock_get.assert_not_called()
    mock_post.assert_not_called()


def test_direct_access_valid_token_calls_ha_as_that_user(lan_client, monkeypatch):
    from unittest.mock import patch, MagicMock
    import server as srv

    monkeypatch.setenv("ALLOW_DIRECT_ACCESS", "true")
    tokens = _Tokens(supervisor="supervisor-secret")
    seen = {}

    def fake_get(url, headers=None, timeout=None, allow_redirects=None):
        seen["validate_url"] = url
        seen["validate_auth"] = headers["Authorization"]
        resp = MagicMock()
        resp.status_code = 200
        return resp

    def fake_post(url, headers=None, json=None, timeout=None, allow_redirects=None):
        seen["post_url"] = url
        seen["post_auth"] = headers["Authorization"]
        seen["body"] = json
        resp = MagicMock()
        resp.status_code = 200
        resp.json.return_value = []
        return resp

    try:
        with patch("server.requests.get", side_effect=fake_get), patch("server.requests.post", side_effect=fake_post):
            resp = _service_post(
                lan_client,
                "cover",
                "open_cover",
                headers={"Authorization": "Bearer user-token"},
            )
        assert resp.status_code == 200
        assert seen["validate_auth"] == "Bearer user-token"
        assert seen["post_auth"] == "Bearer user-token"
        assert "supervisor-secret" not in seen["post_auth"]
        assert seen["post_url"].endswith("/services/cover/open_cover")
        assert "/supervisor/core/" not in seen["validate_url"]
        assert seen["body"]["entity_id"] == "cover.garage"
    finally:
        tokens.close()


def test_direct_access_invalid_token_is_rejected(lan_client, monkeypatch):
    from unittest.mock import patch, MagicMock
    import server as srv

    monkeypatch.setenv("ALLOW_DIRECT_ACCESS", "true")
    bad = MagicMock()
    bad.status_code = 401
    with patch("server.requests.get", return_value=bad) as mock_get, patch("server.requests.post") as mock_post:
        resp = _service_post(
            lan_client,
            "cover",
            "open_cover",
            headers={"Authorization": "Bearer nope"},
        )
    assert resp.status_code == 401
    mock_get.assert_called_once()
    mock_post.assert_not_called()
    # The negative result is cached, so a second attempt does not hit HA again.
    resp2 = _service_post(
        lan_client,
        "cover",
        "open_cover",
        headers={"Authorization": "Bearer nope"},
    )
    assert resp2.status_code == 401
    mock_get.assert_called_once()
    srv._token_cache.clear()


def test_cors_rejects_wildcard_and_unknown_origins(lan_client, monkeypatch):
    monkeypatch.setenv("ALLOW_DIRECT_ACCESS", "true")
    monkeypatch.setenv("CORS_ORIGINS", "*, https://home.example:8123")

    evil = lan_client.get("/api/floors", headers={"Origin": "https://evil.example"})
    assert evil.status_code == 401
    assert evil.headers.get("Access-Control-Allow-Origin") in (None, "")

    preflight = lan_client.open(
        "/api/ha/services/cover/open_cover",
        method="OPTIONS",
        headers={
            "Origin": "https://evil.example",
            "Access-Control-Request-Method": "POST",
        },
    )
    assert preflight.status_code == 403
    assert preflight.headers.get("Access-Control-Allow-Origin") != "*"

    allowed = lan_client.get("/api/floors", headers={"Origin": "https://home.example:8123"})
    assert allowed.headers.get("Access-Control-Allow-Origin") == "https://home.example:8123"

    star = lan_client.open(
        "/api/floors",
        method="OPTIONS",
        headers={"Origin": "*", "Access-Control-Request-Method": "GET"},
    )
    assert star.headers.get("Access-Control-Allow-Origin") in (None, "")


def test_cors_disabled_when_direct_access_is_off(lan_client, monkeypatch):
    monkeypatch.setenv("CORS_ORIGINS", "https://home.example:8123")
    resp = lan_client.get("/api/floors", headers={"Origin": "https://home.example:8123"})
    assert resp.status_code == 401
    assert resp.headers.get("Access-Control-Allow-Origin") in (None, "")


def test_fetch_admin_user_ids(monkeypatch):
    import server as srv

    class FakeWS:
        def __init__(self):
            self.sent = []
            self._incoming = [
                {"type": "auth_required"},
                {"type": "auth_ok"},
                {
                    "id": 1,
                    "type": "result",
                    "success": True,
                    "result": [
                        {"id": "admin-1", "is_admin": True},
                        {"id": "user-2", "is_admin": False},
                    ],
                },
            ]

        def recv(self):
            return json.dumps(self._incoming.pop(0))

        def send(self, payload):
            self.sent.append(json.loads(payload))

        def close(self):
            pass

    ws = FakeWS()
    monkeypatch.setattr(srv, "create_connection", lambda *args, **kwargs: ws)
    monkeypatch.setattr(srv, "HA_TOKEN", "tok")
    monkeypatch.setattr(srv, "SUPERVISOR_TOKEN", "")
    ids = srv._fetch_admin_user_ids()
    assert ids == {"admin-1"}
    assert ws.sent[0]["access_token"] == "tok"
    assert ws.sent[1]["type"] == "config/auth/list"


def test_admin_record_accepts_group_and_owner():
    import server as srv

    assert srv._user_record_is_admin({"id": "a", "is_admin": True}) is True
    assert srv._user_record_is_admin({"id": "b", "group_ids": ["system-admin"]}) is True
    assert srv._user_record_is_admin({"id": "c", "is_owner": True, "group_ids": []}) is True
    assert srv._user_record_is_admin({"id": "d", "group_ids": ["system-users"]}) is False
    assert srv._user_record_is_admin({"id": "e"}) is False


def test_fetch_admin_user_ids_without_is_admin_field(monkeypatch):
    """HA 2026.10 lists administrators via group_ids, not is_admin."""
    import server as srv

    class FakeWS:
        def __init__(self):
            self._incoming = [
                {"type": "auth_required"},
                {"type": "auth_ok"},
                {
                    "id": 1,
                    "type": "result",
                    "success": True,
                    "result": [
                        {"id": "owner", "is_owner": True, "group_ids": ["system-admin"]},
                        {"id": "family", "is_owner": False, "group_ids": ["system-users"]},
                    ],
                },
            ]

        def recv(self):
            return json.dumps(self._incoming.pop(0))

        def send(self, payload):
            return None

        def close(self):
            return None

    monkeypatch.setattr(srv, "create_connection", lambda *args, **kwargs: FakeWS())
    monkeypatch.setattr(srv, "HA_TOKEN", "tok")
    monkeypatch.setattr(srv, "SUPERVISOR_TOKEN", "")
    assert srv._fetch_admin_user_ids() == {"owner"}


def test_ingress_admin_check_fails_closed(monkeypatch):
    import server as srv

    srv._admin_cache = None
    monkeypatch.setattr(srv, "_fetch_admin_user_ids", lambda: None)
    assert srv.ingress_user_is_admin("") is False
    assert srv.ingress_user_is_admin("admin-1") is False
    srv._admin_cache = None


def test_direct_access_option_from_options_file(tmp_data, monkeypatch):
    import server as srv

    monkeypatch.delenv("ALLOW_DIRECT_ACCESS", raising=False)
    (srv.DATA_DIR / "options.json").write_text(json.dumps({"allow_direct_access": False}))
    assert srv.direct_access_enabled() is False
    (srv.DATA_DIR / "options.json").write_text(json.dumps({"allow_direct_access": True}))
    assert srv.direct_access_enabled() is True


# ---------------------------------------------------------------------------
# Energía on top of the ingress / allowlist model
# ---------------------------------------------------------------------------


def test_lan_cannot_read_energy(lan_client):
    from unittest.mock import patch

    with patch("server.requests.get") as mock_get, patch("server.requests.post") as mock_post:
        assert lan_client.get("/api/energy/map").status_code == 401
        assert lan_client.get("/api/energy/state").status_code == 401
        assert lan_client.get("/api/energy/flow").status_code == 401
        assert lan_client.get("/energia").status_code == 401
        posted = lan_client.post(
            "/api/energy/control",
            data=json.dumps({"entity_id": "input_boolean.carga_instantanea_tesla", "service": "input_boolean.turn_on"}),
            content_type="application/json",
        )
    assert posted.status_code == 401
    mock_get.assert_not_called()
    mock_post.assert_not_called()


def test_ingress_non_admin_can_read_energy_but_not_control_or_stream(ingress_member):
    from unittest.mock import patch

    assert ingress_member.get("/api/energy/map").status_code == 200
    state = ingress_member.get("/api/energy/state")
    assert state.status_code == 200
    assert "states" in state.get_json()
    flow = ingress_member.get("/api/energy/flow")
    assert flow.status_code == 200
    assert "directions" in flow.get_json()
    assert ingress_member.get("/energia").status_code == 200
    assert ingress_member.get("/api/ha/stream").status_code == 403
    with patch("server.requests.post") as mock_post:
        denied = ingress_member.post(
            "/api/energy/control",
            data=json.dumps({
                "entity_id": "input_boolean.carga_instantanea_tesla",
                "service": "input_boolean.turn_on",
                "dry_run": False,
            }),
            content_type="application/json",
        )
    assert denied.status_code == 403
    mock_post.assert_not_called()


def test_energy_allowlist_rejects_unlisted_and_accepts_helpers(client):
    from unittest.mock import patch, MagicMock

    tokens = _Tokens(supervisor="supervisor-secret")
    mock_resp = MagicMock()
    mock_resp.json.return_value = []
    mock_resp.status_code = 200
    try:
        with patch("server.requests.post", return_value=mock_resp) as mock_post:
            blocked = _service_post(client, "homeassistant", "restart", {})
            blocked_num = _service_post(client, "number", "set_value", {"entity_id": "number.evse_charging_power_limit", "value": 1})
            ok_num = _service_post(client, "input_number", "set_value", {"entity_id": "input_number.carga_umbral_solar_kwh", "value": 18})
            ok_sel = _service_post(client, "input_select", "select_option", {"entity_id": "input_select.carga_dia_lunes", "option": "casa"})
        assert blocked.status_code == 403
        assert blocked_num.status_code == 403
        assert ok_num.status_code == 200
        assert ok_sel.status_code == 200
        assert mock_post.call_count == 2
        urls = [c.args[0] for c in mock_post.call_args_list]
        assert any(u.endswith("/services/input_number/set_value") for u in urls)
        assert any(u.endswith("/services/input_select/select_option") for u in urls)
        for call in mock_post.call_args_list:
            assert call.kwargs["headers"]["Authorization"] == "Bearer supervisor-secret"
    finally:
        tokens.close()


def test_energy_control_dry_run_and_live_use_request_token(client):
    import server as srv
    from unittest.mock import patch, MagicMock

    tokens = _Tokens(supervisor="supervisor-secret")
    srv._state_cache["input_number.carga_umbral_solar_kwh"] = {
        "entity_id": "input_number.carga_umbral_solar_kwh",
        "state": "15",
        "attributes": {"min": 0, "max": 60},
    }
    srv._state_cache["input_boolean.carga_instantanea_tesla"] = {
        "entity_id": "input_boolean.carga_instantanea_tesla",
        "state": "off",
        "attributes": {},
    }
    mock_resp = MagicMock()
    mock_resp.json.return_value = []
    mock_resp.status_code = 200
    try:
        with patch("server.requests.post", return_value=mock_resp) as mock_post:
            dry = client.post(
                "/api/energy/control",
                data=json.dumps({
                    "entity_id": "input_number.carga_umbral_solar_kwh",
                    "service": "input_number.set_value",
                    "data": {"value": 18},
                    "dry_run": True,
                }),
                content_type="application/json",
            )
            assert dry.status_code == 200
            assert dry.get_json()["dry_run"] is True
            mock_post.assert_not_called()
            live = client.post(
                "/api/energy/control",
                data=json.dumps({
                    "entity_id": "input_boolean.carga_instantanea_tesla",
                    "service": "input_boolean.turn_on",
                }),
                content_type="application/json",
            )
            rejected = client.post(
                "/api/energy/control",
                data=json.dumps({
                    "entity_id": "number.evse_charging_power_limit",
                    "service": "number.set_value",
                    "data": {"value": 5000},
                }),
                content_type="application/json",
            )
        assert live.status_code == 200, live.get_json()
        assert rejected.status_code == 400
        mock_post.assert_called_once()
        assert mock_post.call_args.args[0].endswith("/services/input_boolean/turn_on")
        assert mock_post.call_args.kwargs["headers"]["Authorization"] == "Bearer supervisor-secret"
        assert "HA_TOKEN" not in (mock_post.call_args.kwargs["headers"]["Authorization"])
    finally:
        tokens.close()


def test_energy_direct_access_calls_as_user(lan_client, monkeypatch):
    import server as srv
    from unittest.mock import patch, MagicMock

    monkeypatch.setenv("ALLOW_DIRECT_ACCESS", "true")
    tokens = _Tokens(supervisor="supervisor-secret", ha="")
    srv._state_cache["input_boolean.carga_forzar_no"] = {
        "entity_id": "input_boolean.carga_forzar_no",
        "state": "off",
        "attributes": {},
    }
    seen = {}

    def fake_get(url, headers=None, timeout=None, allow_redirects=None):
        resp = MagicMock()
        resp.status_code = 200
        return resp

    def fake_post(url, headers=None, json=None, timeout=None, allow_redirects=None):
        seen["url"] = url
        seen["auth"] = headers["Authorization"]
        seen["body"] = json
        resp = MagicMock()
        resp.status_code = 200
        resp.json.return_value = []
        return resp

    try:
        with patch("server.requests.get", side_effect=fake_get), patch("server.requests.post", side_effect=fake_post):
            resp = lan_client.post(
                "/api/energy/control",
                data=json.dumps({
                    "entity_id": "input_boolean.carga_forzar_no",
                    "service": "input_boolean.turn_on",
                }),
                content_type="application/json",
                headers={"Authorization": "Bearer user-llat"},
            )
        assert resp.status_code == 200, resp.get_json()
        assert seen["auth"] == "Bearer user-llat"
        assert "supervisor-secret" not in seen["auth"]
        assert seen["url"].endswith("/services/input_boolean/turn_on")
        assert "homeassistant" in seen["url"]
    finally:
        tokens.close()


def test_energy_flow_reads_cache_without_ha_token_global(client):
    import server as srv

    tokens = _Tokens(supervisor="supervisor-secret", ha="")
    try:
        srv._state_cache["sensor.inverter_external_consumption"] = {
            "entity_id": "sensor.inverter_external_consumption",
            "state": "0.02",
            "attributes": {"unit_of_measurement": "kW"},
        }
        srv._state_cache["sensor.inverter_output_l1_power"] = {
            "entity_id": "sensor.inverter_output_l1_power",
            "state": "1012",
            "attributes": {"unit_of_measurement": "W"},
        }
        srv._state_cache["sensor.evse_charging_power"] = {
            "entity_id": "sensor.evse_charging_power",
            "state": "0",
            "attributes": {"unit_of_measurement": "W"},
        }
        body = client.get("/api/energy/flow").get_json()
        assert body["grid_w"] == 20.0
        assert body["house_w"] == 1012.0
        assert srv.HA_TOKEN == ""
    finally:
        tokens.close()


# ---------------------------------------------------------------------------
# Seguridad on top of the ingress / allowlist model
# ---------------------------------------------------------------------------


def test_lan_cannot_read_security(lan_client):
    from unittest.mock import patch

    with patch("server.requests.get") as mock_get, patch("server.requests.post") as mock_post:
        assert lan_client.get("/seguridad").status_code == 401
        assert lan_client.get("/api/security/map").status_code == 401
        assert lan_client.get("/api/security/state").status_code == 401
        assert lan_client.get("/api/plan/overlays").status_code == 401
        posted = lan_client.post(
            "/api/security/alarm",
            data=json.dumps({"entity_id": "alarm_control_panel.alarmo", "service": "alarm_disarm"}),
            content_type="application/json",
        )
    assert posted.status_code == 401
    mock_get.assert_not_called()
    mock_post.assert_not_called()


def test_ingress_member_reads_security_but_cannot_arm(ingress_member):
    from unittest.mock import patch

    assert ingress_member.get("/seguridad").status_code == 200
    assert ingress_member.get("/api/security/map").get_json()["alarm"]["entity"] == "alarm_control_panel.alarmo"
    assert "states" in ingress_member.get("/api/security/state").get_json()
    assert "floors" in ingress_member.get("/api/plan/overlays").get_json()
    with patch("server.requests.post") as mock_post:
        denied = ingress_member.post(
            "/api/security/alarm",
            data=json.dumps({"entity_id": "alarm_control_panel.alarmo", "service": "alarm_arm_away"}),
            content_type="application/json",
        )
    assert denied.status_code == 403
    mock_post.assert_not_called()


def test_security_state_only_returns_mapped_entities(client):
    import server as srv

    srv._state_cache.update({
        "alarm_control_panel.alarmo": {"entity_id": "alarm_control_panel.alarmo", "state": "disarmed", "attributes": {}},
        "sensor.evse_charging_power": {"entity_id": "sensor.evse_charging_power", "state": "7200", "attributes": {"unit_of_measurement": "W"}},
        "lock.puerta": {"entity_id": "lock.puerta", "state": "locked", "attributes": {}},
    })
    try:
        ids = {s["entity_id"] for s in client.get("/api/security/state").get_json()["states"]}
    finally:
        srv._state_cache.clear()
    assert {"alarm_control_panel.alarmo", "sensor.evse_charging_power"} <= ids
    assert "lock.puerta" not in ids


def test_admin_arm_forwards_code_without_logging_it(client, caplog):
    import logging
    import server as srv
    from unittest.mock import patch, MagicMock

    tokens = _Tokens(supervisor="supervisor-secret")
    srv._state_cache["alarm_control_panel.alarmo"] = {
        "entity_id": "alarm_control_panel.alarmo",
        "state": "armed_away",
        "attributes": {"code_format": "number", "code_arm_required": False, "supported_features": 14},
    }
    mock_resp = MagicMock(status_code=200)
    try:
        with caplog.at_level(logging.DEBUG), patch("server.requests.post", return_value=mock_resp) as mock_post:
            missing = client.post(
                "/api/security/alarm",
                data=json.dumps({"entity_id": "alarm_control_panel.alarmo", "service": "alarm_disarm"}),
                content_type="application/json",
            )
            assert missing.status_code == 400
            mock_post.assert_not_called()
            ok = client.post(
                "/api/security/alarm",
                data=json.dumps({"entity_id": "alarm_control_panel.alarmo", "service": "alarm_disarm", "code": "97531"}),
                content_type="application/json",
            )
            assert ok.status_code == 200
            args, kwargs = mock_post.call_args
            assert args[0].endswith("/services/alarm_control_panel/alarm_disarm")
            assert kwargs["json"] == {"entity_id": "alarm_control_panel.alarmo", "code": "97531"}
            bad = client.post(
                "/api/security/alarm",
                data=json.dumps({"entity_id": "alarm_control_panel.alarmo", "service": "alarm_trigger"}),
                content_type="application/json",
            )
            assert bad.status_code == 400
    finally:
        tokens.close()
    assert "97531" not in caplog.text
    assert "97531" not in json.dumps(ok.get_json())


# ---------------------------------------------------------------------------
# 3.5.1 — mover elementos en Seguridad y elementos fuera del plano
# ---------------------------------------------------------------------------

_POS_ENTITY = "binary_sensor.sensormovimiento4"


def _put_position(c, **body):
    payload = {"entity_id": _POS_ENTITY, "floor": "planta_baja", "x": -0.04, "y": 0.5, "outside": True}
    payload.update(body)
    return c.put("/api/security/positions", data=json.dumps(payload), content_type="application/json")


def test_admin_moves_security_marker_and_it_persists(client):
    import server as srv
    from unittest.mock import patch

    with patch("server.requests.post") as mock_post:
        r = _put_position(client)
    assert r.status_code == 200
    assert r.get_json()["outside"] is True
    mock_post.assert_not_called()  # nunca se escribe en Home Assistant
    stored = srv.load_config()["security_positions"][_POS_ENTITY]
    assert stored == {"floor": "planta_baja", "x": -0.04, "y": 0.5, "outside": True}
    p = next(p for p in client.get("/api/security/map").get_json()["presence"] if p["entity"] == _POS_ENTITY)
    assert p["position"] == [-0.04, 0.5] and p["outside"] is True and p["custom"] is True
    # Moverlo dentro otra vez.
    assert _put_position(client, x=0.3, y=0.4, outside=False).status_code == 200
    p = next(p for p in client.get("/api/security/map").get_json()["presence"] if p["entity"] == _POS_ENTITY)
    assert p["position"] == [0.3, 0.4] and p["outside"] is False


def test_security_map_defaults_without_saved_positions(client):
    import security as sec

    data = client.get("/api/security/map").get_json()
    assert data["presence"] == sec.load_map()["presence"]


def test_security_positions_validation(client):
    assert _put_position(client, entity_id="binary_sensor.nope").status_code == 400
    assert _put_position(client, floor="sotano").status_code == 400
    assert _put_position(client, x=3).status_code == 400
    assert _put_position(client, y=True).status_code == 400


def test_only_admins_move_security_markers(ingress_member, lan_client):
    import server as srv

    assert _put_position(ingress_member).status_code == 403
    assert _put_position(lan_client).status_code == 401
    assert "security_positions" not in srv.load_config()


def test_element_outside_flag_and_negative_coordinates(client):
    floor = client.post("/api/floors", data=json.dumps({"name": "PB"}), content_type="application/json").get_json()
    el = client.post(
        f"/api/floors/{floor['id']}/elements",
        data=json.dumps({"type": "scene", "entity_id": "scene.dia", "x": 10, "y": 10}),
        content_type="application/json",
    ).get_json()
    # Elemento antiguo: sin campo «outside».
    assert "outside" not in el
    r = client.put(
        f"/api/floors/{floor['id']}/elements/{el['id']}",
        data=json.dumps({"x": -42.5, "y": 790, "outside": 1}),
        content_type="application/json",
    )
    assert r.status_code == 200
    got = r.get_json()
    assert got["x"] == -42.5 and got["y"] == 790 and got["outside"] is True
    r = client.put(
        f"/api/floors/{floor['id']}/elements/{el['id']}",
        data=json.dumps({"x": 100, "y": 100, "outside": False}),
        content_type="application/json",
    )
    assert r.get_json()["outside"] is False


def test_backup_restore_keeps_security_positions(client):
    import server as srv

    assert _put_position(client).status_code == 200
    backup = client.get("/api/backup").get_json()
    assert backup["security_positions"][_POS_ENTITY]["outside"] is True
    srv.save_config({"floors": []})
    r = client.post("/api/restore", data=json.dumps(backup), content_type="application/json")
    assert r.status_code == 200
    assert srv.load_config()["security_positions"][_POS_ENTITY]["x"] == -0.04


# ---------------------------------------------------------------------------
# 3.5.1 — zonas conmutables y sirena
# ---------------------------------------------------------------------------

def _control(c, **body):
    return c.post("/api/security/control", data=json.dumps(body), content_type="application/json")


def test_admin_switches_zone_and_siren_config_through_whitelist(client):
    import server as srv
    from unittest.mock import patch, MagicMock

    tokens = _Tokens(supervisor="supervisor-secret")
    tone = "select.heiman_warningdevice_ef_3_0_tono_de_sirena_predeterminado"
    srv._state_cache[tone] = {"entity_id": tone, "state": "Burglar", "attributes": {"options": ["Burglar", "Fire"]}}
    try:
        with patch("server.requests.post", return_value=MagicMock(status_code=200)) as mock_post:
            r = _control(client, entity_id="input_boolean.notificacion_alarma_piscina", service="turn_off")
            assert r.status_code == 200
            args, kwargs = mock_post.call_args
            assert args[0].endswith("/services/input_boolean/turn_off")
            assert kwargs["json"] == {"entity_id": "input_boolean.notificacion_alarma_piscina"}
            r = _control(client, entity_id=tone, service="select_option", option="Fire")
            assert r.status_code == 200
            args, kwargs = mock_post.call_args
            assert args[0].endswith("/services/select/select_option")
            assert kwargs["json"] == {"entity_id": tone, "option": "Fire"}
            assert _control(client, entity_id="input_boolean.alarma_sirena", service="turn_on").status_code == 200
            calls = mock_post.call_count
            # Fuera de la lista blanca o sin confirmar: nada llega a HA.
            assert _control(client, entity_id="input_boolean.otra", service="turn_on").status_code == 400
            assert _control(client, entity_id="lock.puerta", service="unlock").status_code == 400
            assert _control(client, entity_id=tone, service="select_option", option="Nope").status_code == 400
            assert _control(client, entity_id="siren.heiman_warningdevice_ef_3_0", service="turn_on").status_code == 400
            assert mock_post.call_count == calls
            # Probar sirena con confirmación: siren.turn_on solo con entity_id.
            r = _control(client, entity_id="siren.heiman_warningdevice_ef_3_0", service="turn_on", confirm=True)
            assert r.status_code == 200
            args, kwargs = mock_post.call_args
            assert args[0].endswith("/services/siren/turn_on")
            assert kwargs["json"] == {"entity_id": "siren.heiman_warningdevice_ef_3_0"}
    finally:
        tokens.close()
        srv._state_cache.clear()


def test_control_failure_is_reported_for_rollback(client):
    import server as srv
    from unittest.mock import patch, MagicMock

    tokens = _Tokens(supervisor="supervisor-secret")
    try:
        with patch("server.requests.post", return_value=MagicMock(status_code=500)):
            r = _control(client, entity_id="input_boolean.notificacion_alarma_hab1", service="turn_on")
    finally:
        tokens.close()
    assert r.status_code == 502 and r.get_json()["ok"] is False


def test_only_admins_switch_zones_or_siren(ingress_member, lan_client):
    from unittest.mock import patch

    with patch("server.requests.post") as mock_post:
        assert _control(ingress_member, entity_id="input_boolean.notificacion_alarma_piscina", service="turn_off").status_code == 403
        assert _control(ingress_member, entity_id="siren.heiman_warningdevice_ef_3_0", service="turn_on", confirm=True).status_code == 403
        assert _control(lan_client, entity_id="input_boolean.notificacion_alarma_piscina", service="turn_off").status_code == 401
    mock_post.assert_not_called()


def test_security_map_shows_the_siren_to_admins(client):
    assert client.get("/api/security/map").get_json()["user"] == {"admin": True}


def test_security_map_hides_the_siren_from_members(ingress_member):
    assert ingress_member.get("/api/security/map").get_json()["user"] == {"admin": False}


def test_security_invoke_blocks_services_outside_the_whitelist():
    import server as srv

    with srv.app.test_request_context("/api/security/control", method="POST"):
        _assert_invoke_blocked(srv)


def _assert_invoke_blocked(srv):
    assert srv._security_invoke("homeassistant", "restart", {})[0] == 403
    assert srv._security_invoke("input_boolean", "toggle", {"entity_id": "input_boolean.x"})[0] == 403
    assert srv._security_invoke("lock", "unlock", {"entity_id": "lock.x"})[0] == 403


# ---------------------------------------------------------------------------
# 3.7.0 — electrodomésticos en el plano
# ---------------------------------------------------------------------------

def _put_appliance(c, **body):
    payload = {"id": "roborock", "floor": "planta_baja", "x": 0.5, "y": 0.75}
    payload.update(body)
    return c.put("/api/appliances/positions", data=json.dumps(payload), content_type="application/json")


def test_appliance_map_is_an_ingress_read(ingress_member):
    import appliances

    r = ingress_member.get("/api/appliances/map")
    assert r.status_code == 200
    assert [a["id"] for a in r.get_json()["appliances"]] == [a["id"] for a in appliances.load_map()["appliances"]]


def test_admin_moves_appliance_and_it_persists_without_touching_ha(client):
    import server as srv
    from unittest.mock import patch

    with patch("server.requests.post") as mock_post:
        r = _put_appliance(client)
    assert r.status_code == 200
    mock_post.assert_not_called()
    assert srv.load_config()["appliance_positions"]["roborock"] == {"floor": "planta_baja", "x": 0.5, "y": 0.75}
    rb = next(a for a in client.get("/api/appliances/map").get_json()["appliances"] if a["id"] == "roborock")
    assert rb["position"] == [0.5, 0.75] and rb["custom"] is True
    assert _put_appliance(client, id="horno").status_code == 400
    assert _put_appliance(client, x=5).status_code == 400


def test_only_admins_move_appliances(ingress_member, lan_client):
    import server as srv

    assert _put_appliance(ingress_member).status_code == 403
    assert _put_appliance(lan_client).status_code == 401
    assert "appliance_positions" not in srv.load_config()


def test_backup_restore_keeps_appliance_positions(client):
    import server as srv

    assert _put_appliance(client).status_code == 200
    backup = client.get("/api/backup").get_json()
    assert backup["appliance_positions"]["roborock"]["x"] == 0.5
    srv.save_config({"floors": []})
    assert client.post("/api/restore", data=json.dumps(backup), content_type="application/json").status_code == 200
    assert srv.load_config()["appliance_positions"]["roborock"]["y"] == 0.75


def test_appliance_services_go_through_the_proxy(client):
    from unittest.mock import patch, MagicMock

    tokens = _Tokens(supervisor="supervisor-secret")
    ok = MagicMock(status_code=200)
    ok.json.return_value = []
    try:
        with patch("server.requests.post", return_value=ok) as mock_post:
            calls = [
                ("vacuum", "start", {"entity_id": "vacuum.qrevo_edge_2_pro"}),
                ("vacuum", "locate", {"entity_id": "vacuum.qrevo_edge_2_pro"}),
                ("vacuum", "set_fan_speed", {"entity_id": "vacuum.qrevo_edge_2_pro", "fan_speed": "turbo"}),
                ("select", "select_option", {"entity_id": "select.cocina_lavavajillas_programa_activo",
                                             "option": "dishcare_dishwasher_program_eco_50"}),
                ("button", "press", {"entity_id": "button.cocina_lavavajillas_detener_programa"}),
                ("number", "set_value", {"entity_id": "number.cocina_nevera_temperatura_del_frigorifico", "value": 4}),
            ]
            for d, s, data in calls:
                assert _service_post(client, d, s, data).status_code == 200, (d, s)
            blocked = _service_post(client, "vacuum", "send_command", {"entity_id": "vacuum.qrevo_edge_2_pro"})
            evse = _service_post(client, "number", "set_value", {"entity_id": "number.evse_charging_power_limit", "value": 1})
            tone = _service_post(client, "select", "select_option", {
                "entity_id": "select.heiman_warningdevice_ef_3_0_tono_de_sirena_predeterminado", "option": "x"})
        assert blocked.status_code == 403 and evse.status_code == 403 and tone.status_code == 403
        assert mock_post.call_count == len(calls)
    finally:
        tokens.close()
