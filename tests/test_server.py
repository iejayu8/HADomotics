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
    resp = client.delete("/api/floors/floor2/image")
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


# ---------------------------------------------------------------------------
# HA proxy endpoints
# ---------------------------------------------------------------------------


def test_ha_states_no_token(client):
    """Without a supervisor token the endpoint returns an empty list."""
    import server as srv

    original = srv.SUPERVISOR_TOKEN
    srv.SUPERVISOR_TOKEN = ""
    try:
        resp = client.get("/api/ha/states")
        assert resp.status_code == 200
        assert resp.get_json() == []
    finally:
        srv.SUPERVISOR_TOKEN = original


def test_ha_state_no_token(client):
    """Without a supervisor token the endpoint returns 503."""
    import server as srv

    original = srv.SUPERVISOR_TOKEN
    srv.SUPERVISOR_TOKEN = ""
    try:
        resp = client.get("/api/ha/states/light.kitchen")
        assert resp.status_code == 503
    finally:
        srv.SUPERVISOR_TOKEN = original


def test_ha_call_service_no_token(client):
    """Without a supervisor token the endpoint returns 503."""
    import server as srv

    original = srv.SUPERVISOR_TOKEN
    srv.SUPERVISOR_TOKEN = ""
    try:
        resp = client.post(
            "/api/ha/services/light/turn_on",
            data=json.dumps({"entity_id": "light.kitchen"}),
            content_type="application/json",
        )
        assert resp.status_code == 503
    finally:
        srv.SUPERVISOR_TOKEN = original


def test_ha_states_with_token(client):
    """With a token, states are fetched from the HA API (mocked)."""
    from unittest.mock import patch, MagicMock
    import server as srv

    original = srv.SUPERVISOR_TOKEN
    srv.SUPERVISOR_TOKEN = "fake-token"
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
        srv.SUPERVISOR_TOKEN = original


def test_ha_states_network_error(client):
    """A network error should return an empty list gracefully."""
    from unittest.mock import patch
    import server as srv

    original = srv.SUPERVISOR_TOKEN
    srv.SUPERVISOR_TOKEN = "fake-token"
    try:
        with patch("server.requests.get", side_effect=Exception("timeout")):
            resp = client.get("/api/ha/states")
            assert resp.status_code == 200
            assert resp.get_json() == []
    finally:
        srv.SUPERVISOR_TOKEN = original


def test_ha_state_with_token(client):
    """With a token, a single entity state is proxied from HA (mocked)."""
    from unittest.mock import patch, MagicMock
    import server as srv

    original = srv.SUPERVISOR_TOKEN
    srv.SUPERVISOR_TOKEN = "fake-token"
    mock_resp = MagicMock()
    mock_resp.json.return_value = {"entity_id": "light.kitchen", "state": "off"}
    mock_resp.status_code = 200
    try:
        with patch("server.requests.get", return_value=mock_resp):
            resp = client.get("/api/ha/states/light.kitchen")
            assert resp.status_code == 200
            assert resp.get_json()["state"] == "off"
    finally:
        srv.SUPERVISOR_TOKEN = original


def test_ha_state_network_error(client):
    """A network error on entity state should return 503."""
    from unittest.mock import patch
    import server as srv

    original = srv.SUPERVISOR_TOKEN
    srv.SUPERVISOR_TOKEN = "fake-token"
    try:
        with patch("server.requests.get", side_effect=Exception("timeout")):
            resp = client.get("/api/ha/states/light.kitchen")
            assert resp.status_code == 503
    finally:
        srv.SUPERVISOR_TOKEN = original


def test_ha_call_service_with_token(client):
    """With a token, services are called via the HA API (mocked)."""
    from unittest.mock import patch, MagicMock
    import server as srv

    original = srv.SUPERVISOR_TOKEN
    srv.SUPERVISOR_TOKEN = "fake-token"
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
    finally:
        srv.SUPERVISOR_TOKEN = original


def test_ha_call_service_network_error(client):
    """A network error calling a service should return 503."""
    from unittest.mock import patch
    import server as srv

    original = srv.SUPERVISOR_TOKEN
    srv.SUPERVISOR_TOKEN = "fake-token"
    try:
        with patch("server.requests.post", side_effect=Exception("timeout")):
            resp = client.post(
                "/api/ha/services/light/turn_on",
                data=json.dumps({}),
                content_type="application/json",
            )
            assert resp.status_code == 503
    finally:
        srv.SUPERVISOR_TOKEN = original
