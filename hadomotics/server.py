"""HADomotics - Home Assistant Domotics Addon Backend."""

import copy
import json
import logging
import os
import queue
import threading
import time
import uuid
from pathlib import Path

import requests
from flask import Flask, Response, jsonify, request, send_file, send_from_directory, stream_with_context
from flask_cors import CORS
from PIL import Image
import base64
from datetime import datetime

try:
    from websocket import WebSocketApp
except ImportError:  # pragma: no cover
    WebSocketApp = None

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
LOG_LEVEL = os.environ.get("LOG_LEVEL", "info").upper()
logging.basicConfig(
    level=getattr(logging, LOG_LEVEL, logging.INFO),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("hadomotics")

def _resolve_paths() -> tuple:
    data = Path(os.environ.get("DATA_DIR", "/data"))
    images = data / "images"
    config = data / "config.yaml"
    data.mkdir(parents=True, exist_ok=True)
    images.mkdir(parents=True, exist_ok=True)
    return data, images, config


DATA_DIR, IMAGES_DIR, CONFIG_FILE = _resolve_paths()

# Token: en el addon usa SUPERVISOR_TOKEN; en local puedes usar HA_TOKEN
SUPERVISOR_TOKEN = os.environ.get("SUPERVISOR_TOKEN", "")
HA_TOKEN = os.environ.get("HA_TOKEN", "") or SUPERVISOR_TOKEN

# URL: en el addon usa supervisor; en local usa HA_URL (ej. http://192.168.1.131:8123)
HA_URL = os.environ.get("HA_URL", "").rstrip("/")
if HA_URL:
    HA_BASE_URL = f"{HA_URL}/api"
    if HA_URL.startswith("https://"):
        HA_WS_URL = "wss://" + HA_URL[len("https://"):] + "/api/websocket"
    elif HA_URL.startswith("http://"):
        HA_WS_URL = "ws://" + HA_URL[len("http://"):] + "/api/websocket"
    else:
        HA_WS_URL = f"ws://{HA_URL}/api/websocket"
else:
    HA_BASE_URL = "http://supervisor/core/api"
    HA_WS_URL = "ws://supervisor/core/websocket"

ALLOWED_IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg"}

_EXT_MAP: dict[str, str] = {
    ".jpg": ".jpg",
    ".jpeg": ".jpg",
    ".png": ".png",
    ".gif": ".gif",
    ".webp": ".webp",
    ".svg": ".svg",
}

import re as _re
_SAFE_ID_RE = _re.compile(r"^[a-zA-Z0-9_-]{1,64}$")

app = Flask(__name__, static_folder="static")
CORS(app)

# ---------------------------------------------------------------------------
# HA WebSocket state cache + SSE clients
# ---------------------------------------------------------------------------

_state_cache: dict[str, dict] = {}
_state_lock = threading.Lock()
_sse_clients: list[queue.Queue] = []
_sse_lock = threading.Lock()
_ha_ws_connected = False
_ha_ws_msg_id = 0
_ha_ws_msg_lock = threading.Lock()


def _next_msg_id() -> int:
    global _ha_ws_msg_id
    with _ha_ws_msg_lock:
        _ha_ws_msg_id += 1
        return _ha_ws_msg_id


def _broadcast(msg: dict) -> None:
    """Push a JSON-serializable message to all SSE clients."""
    with _sse_lock:
        dead: list[queue.Queue] = []
        for q in _sse_clients:
            try:
                q.put_nowait(msg)
            except Exception:
                dead.append(q)
        for q in dead:
            if q in _sse_clients:
                _sse_clients.remove(q)


def _set_states_bulk(states: list) -> None:
    with _state_lock:
        _state_cache.clear()
        for s in states:
            eid = s.get("entity_id")
            if eid:
                _state_cache[eid] = s
    _broadcast({"type": "states", "states": states})


def _set_state_one(state_obj: dict) -> None:
    eid = state_obj.get("entity_id")
    if not eid:
        return
    with _state_lock:
        _state_cache[eid] = state_obj
    _broadcast({"type": "state_changed", "state": state_obj})


def _ha_ws_on_message(ws, message: str) -> None:
    global _ha_ws_connected
    try:
        data = json.loads(message)
    except json.JSONDecodeError:
        return

    msg_type = data.get("type")

    if msg_type == "auth_required":
        ws.send(json.dumps({"type": "auth", "access_token": HA_TOKEN}))
        return

    if msg_type == "auth_ok":
        _ha_ws_connected = True
        log.info("HA WebSocket authenticated")
        _broadcast({"type": "connected", "ha_ws": True})
        # Subscribe to state changes
        ws.send(json.dumps({
            "id": _next_msg_id(),
            "type": "subscribe_events",
            "event_type": "state_changed",
        }))
        # Full snapshot
        ws.send(json.dumps({
            "id": _next_msg_id(),
            "type": "get_states",
        }))
        return

    if msg_type == "auth_invalid":
        _ha_ws_connected = False
        log.error("HA WebSocket auth invalid: %s", data.get("message"))
        _broadcast({"type": "connected", "ha_ws": False, "error": "auth_invalid"})
        return

    if msg_type == "result":
        if not data.get("success", True):
            log.warning("HA WS result error: %s", data.get("error"))
            return
        result = data.get("result")
        # get_states returns a list of state objects
        if isinstance(result, list) and result and isinstance(result[0], dict) and "entity_id" in result[0]:
            _set_states_bulk(result)
            log.info("HA states snapshot loaded (%d entities)", len(result))
        return

    if msg_type == "event":
        event = data.get("event") or {}
        if event.get("event_type") == "state_changed":
            new_state = (event.get("data") or {}).get("new_state")
            if new_state:
                _set_state_one(new_state)
        return


def _ha_ws_on_error(ws, error) -> None:
    log.warning("HA WebSocket error: %s", error)


def _ha_ws_on_close(ws, close_status_code, close_msg) -> None:
    global _ha_ws_connected
    _ha_ws_connected = False
    log.info("HA WebSocket closed (%s %s)", close_status_code, close_msg)
    _broadcast({"type": "connected", "ha_ws": False})


def _ha_ws_on_open(ws) -> None:
    log.info("HA WebSocket opened -> %s", HA_WS_URL)


def _run_ha_websocket_once() -> None:
    if WebSocketApp is None:
        log.error("websocket-client not installed; cannot open HA WebSocket")
        time.sleep(10)
        return
    if not HA_TOKEN:
        log.debug("No HA token; skipping WebSocket connect")
        time.sleep(5)
        return

    ws = WebSocketApp(
        HA_WS_URL,
        on_open=_ha_ws_on_open,
        on_message=_ha_ws_on_message,
        on_error=_ha_ws_on_error,
        on_close=_ha_ws_on_close,
    )
    # Blocks until connection ends
    ws.run_forever(ping_interval=30, ping_timeout=10)


def _ha_ws_loop() -> None:
    """Background reconnect loop for Home Assistant WebSocket."""
    while True:
        try:
            _run_ha_websocket_once()
        except Exception as exc:
            log.warning("HA WebSocket loop error: %s", exp if (exp := exc) else exc)
        global _ha_ws_connected
        _ha_ws_connected = False
        time.sleep(3)


def _start_ha_ws_thread() -> None:
    t = threading.Thread(target=_ha_ws_loop, name="ha-websocket", daemon=True)
    t.start()
    log.info("HA WebSocket thread started (url=%s)", HA_WS_URL)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _safe_path_within(base_dir: Path, filename: str) -> Path | None:
    """Return a resolved path only if it is strictly inside base_dir, else None."""
    candidate = (base_dir / filename).resolve()
    try:
        candidate.relative_to(base_dir.resolve())
        return candidate
    except ValueError:
        return None


DEFAULT_FLOORS = [
    {"id": "floor1", "name": "Floor 1", "order": 0, "image": None, "elements": []},
]


def load_config() -> dict:
    """Load config from disk, initialising defaults if not present."""
    if CONFIG_FILE.exists():
        try:
            with open(CONFIG_FILE) as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError) as exc:
            log.warning("Could not read config file: %s – resetting to defaults", exc)
    return {"floors": copy.deepcopy(DEFAULT_FLOORS)}


def save_config(config: dict) -> None:
    """Persist config to disk."""
    with open(CONFIG_FILE, "w") as f:
        json.dump(config, f, indent=2)


def get_floor(config: dict, floor_id: str) -> dict | None:
    """Return a floor dict by id, or None."""
    return next((f for f in config["floors"] if f["id"] == floor_id), None)


def ha_headers() -> dict:
    return {"Authorization": f"Bearer {HA_TOKEN}", "Content-Type": "application/json"}


# ---------------------------------------------------------------------------
# Static / frontend routes
# ---------------------------------------------------------------------------


@app.route("/")
@app.route("/index.html")
def index():
    return send_from_directory("static", "index.html")


@app.route("/static/<path:filename>")
def serve_static(filename):
    return send_from_directory("static", filename)


# ---------------------------------------------------------------------------
# Floor API
# ---------------------------------------------------------------------------


@app.route("/api/floors", methods=["GET"])
def list_floors():
    config = load_config()
    floors_summary = [
        {"id": f["id"], "name": f["name"], "order": f["order"], "has_image": bool(f.get("image"))}
        for f in sorted(config["floors"], key=lambda x: x.get("order", 0))
    ]
    return jsonify(floors_summary)


@app.route("/api/floors", methods=["POST"])
def create_floor():
    config = load_config()
    data = request.get_json(force=True)
    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"error": "name is required"}), 400
    floor_id = str(uuid.uuid4())
    order = max((f.get("order", 0) for f in config["floors"]), default=-1) + 1
    floor = {"id": floor_id, "name": name, "order": order, "image": None, "elements": []}
    config["floors"].append(floor)
    save_config(config)
    return jsonify(floor), 201


@app.route("/api/floors/<floor_id>", methods=["GET"])
def get_floor_detail(floor_id: str):
    config = load_config()
    floor = get_floor(config, floor_id)
    if floor is None:
        return jsonify({"error": "Floor not found"}), 404
    return jsonify(floor)


@app.route("/api/floors/<floor_id>", methods=["PUT"])
def update_floor(floor_id: str):
    config = load_config()
    floor = get_floor(config, floor_id)
    if floor is None:
        return jsonify({"error": "Floor not found"}), 404
    data = request.get_json(force=True)
    if "name" in data:
        floor["name"] = (data["name"] or "").strip()
    if "order" in data:
        floor["order"] = int(data["order"])
    save_config(config)
    return jsonify(floor)


@app.route("/api/floors/<floor_id>", methods=["DELETE"])
def delete_floor(floor_id: str):
    config = load_config()
    floor = get_floor(config, floor_id)
    if floor is None:
        return jsonify({"error": "Floor not found"}), 404
    if floor.get("image"):
        img_path = IMAGES_DIR / floor["image"]
        img_path.unlink(missing_ok=True)
    config["floors"] = [f for f in config["floors"] if f["id"] != floor_id]
    save_config(config)
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# Floor image API
# ---------------------------------------------------------------------------


@app.route("/api/floors/<floor_id>/image", methods=["POST"])
def upload_floor_image(floor_id: str):
    if not _SAFE_ID_RE.match(floor_id):
        return jsonify({"error": "Invalid floor ID"}), 400
    config = load_config()
    floor = get_floor(config, floor_id)
    if floor is None:
        return jsonify({"error": "Floor not found"}), 404

    if "image" not in request.files:
        return jsonify({"error": "No image file provided"}), 400

    file = request.files["image"]
    raw_suffix = Path(file.filename or "").suffix.lower()
    safe_ext = _EXT_MAP.get(raw_suffix)
    if safe_ext is None:
        return jsonify({"error": "File type not allowed"}), 400

    new_filename = uuid.uuid4().hex + safe_ext

    old_image = floor.get("image")
    if old_image:
        old_path = _safe_path_within(IMAGES_DIR, old_image)
        if old_path is not None:
            old_path.unlink(missing_ok=True)

    save_path = IMAGES_DIR / new_filename
    file.save(str(save_path))

    if safe_ext != ".svg":
        try:
            with Image.open(save_path) as img:
                img.verify()
        except Exception as exc:
            save_path.unlink(missing_ok=True)
            log.warning("Image verification failed for floor %s: %s", floor_id, exc)
            return jsonify({"error": "Invalid or corrupt image file"}), 400

    floor["image"] = new_filename
    save_config(config)
    return jsonify({"ok": True, "image": new_filename})


@app.route("/api/floors/<floor_id>/image", methods=["DELETE"])
def delete_floor_image(floor_id: str):
    config = load_config()
    floor = get_floor(config, floor_id)
    if floor is None:
        return jsonify({"error": "Floor not found"}), 404
    if floor.get("image"):
        stored_name = floor["image"]
        img_path = _safe_path_within(IMAGES_DIR, stored_name)
        if img_path is not None:
            img_path.unlink(missing_ok=True)
        floor["image"] = None
        save_config(config)
    return jsonify({"ok": True})


@app.route("/api/images/<filename>")
def serve_image(filename: str):
    config = load_config()
    user_name = Path(filename).name
    registered = None
    for stored in config.get("floors", []):
        img = stored.get("image")
        if img and img == user_name:
            registered = img
            break
    if registered is None:
        return jsonify({"error": "Image not found"}), 404
    path = _safe_path_within(IMAGES_DIR, registered)
    if path is None or not path.exists() or not path.is_file():
        return jsonify({"error": "Image not found"}), 404
    return send_file(str(path))


# ---------------------------------------------------------------------------
# Elements API
# ---------------------------------------------------------------------------


@app.route("/api/floors/<floor_id>/elements", methods=["GET"])
def list_elements(floor_id: str):
    config = load_config()
    floor = get_floor(config, floor_id)
    if floor is None:
        return jsonify({"error": "Floor not found"}), 404
    return jsonify(floor.get("elements", []))


@app.route("/api/floors/<floor_id>/elements", methods=["POST"])
def create_element(floor_id: str):
    config = load_config()
    floor = get_floor(config, floor_id)
    if floor is None:
        return jsonify({"error": "Floor not found"}), 404

    data = request.get_json(force=True)
    element = {
        "id": str(uuid.uuid4()),
        "type": data.get("type", "button"),
        "label": data.get("label", ""),
        "entity_id": data.get("entity_id", ""),
        "icon": data.get("icon", ""),
        "x": float(data.get("x", 50)),
        "y": float(data.get("y", 50)),
        "width": float(data.get("width", 60)),
        "height": float(data.get("height", 30)),
        "color_on": data.get("color_on", "#4CAF50"),
        "color_off": data.get("color_off", "#9E9E9E"),
        "tap_action": data.get("tap_action", "toggle"),
        "state_position": data.get("state_position", "bottom"),
    }
    floor.setdefault("elements", []).append(element)
    save_config(config)
    return jsonify(element), 201


@app.route("/api/floors/<floor_id>/elements/<element_id>", methods=["PUT"])
def update_element(floor_id: str, element_id: str):
    config = load_config()
    floor = get_floor(config, floor_id)
    if floor is None:
        return jsonify({"error": "Floor not found"}), 404

    elements = floor.get("elements", [])
    elem = next((e for e in elements if e["id"] == element_id), None)
    if elem is None:
        return jsonify({"error": "Element not found"}), 404

    data = request.get_json(force=True)

    updatable = [
        "type", "label", "entity_id", "icon", "x", "y", "width", "height",
        "color_on", "color_off", "tap_action", "rotation", "state_position",
        "position", "service", "service_data",
    ]

    for key in updatable:
        if key in data:
            elem[key] = data[key]

    save_config(config)
    return jsonify(elem)


@app.route("/api/floors/<floor_id>/elements/<element_id>", methods=["DELETE"])
def delete_element(floor_id: str, element_id: str):
    config = load_config()
    floor = get_floor(config, floor_id)
    if floor is None:
        return jsonify({"error": "Floor not found"}), 404

    before = len(floor.get("elements", []))
    floor["elements"] = [e for e in floor.get("elements", []) if e["id"] != element_id]
    if len(floor["elements"]) == before:
        return jsonify({"error": "Element not found"}), 404

    save_config(config)
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# HA proxy (states via cache / REST + SSE stream)
# ---------------------------------------------------------------------------


@app.route("/api/ha/states", methods=["GET"])
def ha_states():
    # Prefer live cache from WebSocket
    with _state_lock:
        if _state_cache:
            return jsonify(list(_state_cache.values()))

    if not HA_TOKEN:
        return jsonify([])
    try:
        resp = requests.get(f"{HA_BASE_URL}/states", headers=ha_headers(), timeout=10)
        data = resp.json()
        if isinstance(data, list):
            _set_states_bulk(data)
        return jsonify(data)
    except Exception as exc:
        log.warning("Could not fetch HA states: %s", exc)
        return jsonify([])


@app.route("/api/ha/stream")
def ha_stream():
    """Server-Sent Events: real-time entity state updates from HA WebSocket."""

    def event_stream():
        q: queue.Queue = queue.Queue(maxsize=200)
        with _sse_lock:
            _sse_clients.append(q)
        try:
            yield f"data: {json.dumps({'type': 'connected', 'ha_ws': _ha_ws_connected})}\n\n"
            with _state_lock:
                snapshot = list(_state_cache.values())
            if snapshot:
                yield f"data: {json.dumps({'type': 'states', 'states': snapshot})}\n\n"
            while True:
                try:
                    msg = q.get(timeout=25)
                    yield f"data: {json.dumps(msg)}\n\n"
                except queue.Empty:
                    # keep-alive comment so proxies don't close the stream
                    yield ": keepalive\n\n"
        finally:
            with _sse_lock:
                if q in _sse_clients:
                    _sse_clients.remove(q)

    return Response(
        stream_with_context(event_stream()),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


@app.route("/api/ha/states/<entity_id>", methods=["GET"])
def ha_state(entity_id: str):
    with _state_lock:
        cached = _state_cache.get(entity_id)
    if cached:
        return jsonify(cached)

    if not HA_TOKEN:
        return jsonify({"error": "No supervisor token"}), 503
    try:
        resp = requests.get(f"{HA_BASE_URL}/states/{entity_id}", headers=ha_headers(), timeout=10)
        return jsonify(resp.json()), resp.status_code
    except Exception as exc:
        log.warning("Could not fetch HA state for %s: %s", entity_id, exc)
        return jsonify({"error": "Could not retrieve entity state"}), 503


@app.route("/api/ha/services/<domain>/<service>", methods=["POST"])
def ha_call_service(domain: str, service: str):
    if not HA_TOKEN:
        return jsonify({"error": "No supervisor token"}), 503
    try:
        data = request.get_json(force=True) or {}
        resp = requests.post(
            f"{HA_BASE_URL}/services/{domain}/{service}",
            headers=ha_headers(),
            json=data,
            timeout=10,
        )
        return jsonify(resp.json()), resp.status_code
    except Exception as exc:
        log.warning("Could not call HA service %s.%s: %s", domain, service, exp if (exp := exc) else exc)
        return jsonify({"error": "Could not call Home Assistant service"}), 503


# ---------------------------------------------------------------------------
# Global config API
# ---------------------------------------------------------------------------


@app.route("/api/config", methods=["GET"])
def get_global_config():
    config = load_config()
    return jsonify({k: v for k, v in config.items() if k != "floors"})


# ---------------------------------------------------------------------------
# Backup / Restore
# ---------------------------------------------------------------------------

@app.route("/api/backup", methods=["GET"])
def backup_config():
    """Export full configuration including images as base64."""
    config = load_config()
    backup = {
        "version": "1.7.0",
        "exported_at": str(datetime.utcnow()),
        "floors": []
    }

    for floor in config.get("floors", []):
        floor_data = {
            "id": floor["id"],
            "name": floor["name"],
            "order": floor.get("order", 0),
            "elements": floor.get("elements", []),
            "image_base64": None,
            "image_ext": None
        }

        if floor.get("image"):
            img_path = IMAGES_DIR / floor["image"]
            if img_path.exists():
                try:
                    with open(img_path, "rb") as f:
                        img_bytes = f.read()
                    floor_data["image_base64"] = base64.b64encode(img_bytes).decode("utf-8")
                    floor_data["image_ext"] = img_path.suffix
                except Exception as exc:
                    log.warning("Could not read image for backup: %s", exc)

        backup["floors"].append(floor_data)

    return jsonify(backup)


@app.route("/api/restore", methods=["POST"])
def restore_config():
    """Restore configuration from backup JSON."""
    data = request.get_json(force=True)

    if not data or "floors" not in data:
        return jsonify({"error": "Invalid backup file"}), 400

    new_config = {"floors": []}

    for floor_data in data["floors"]:
        floor = {
            "id": floor_data.get("id") or str(uuid.uuid4()),
            "name": floor_data.get("name", "Unnamed Floor"),
            "order": floor_data.get("order", 0),
            "elements": floor_data.get("elements", []),
            "image": None
        }

        if floor_data.get("image_base64") and floor_data.get("image_ext"):
            try:
                img_bytes = base64.b64decode(floor_data["image_base64"])
                new_filename = uuid.uuid4().hex + floor_data["image_ext"]
                save_path = IMAGES_DIR / new_filename
                with open(save_path, "wb") as f:
                    f.write(img_bytes)
                floor["image"] = new_filename
            except Exception as exc:
                log.warning("Could not restore image: %s", exp if (exp := exc) else exp)

        new_config["floors"].append(floor)

    save_config(new_config)
    return jsonify({"ok": True, "message": "Configuration restored successfully"})


# Start HA WebSocket listener as soon as the module loads (addon + local)
_start_ha_ws_thread()

if __name__ == "__main__":
    log.info("Starting HADomotics server on port 8099")
    log.info("HA_BASE_URL=%s | HA_WS_URL=%s | token configured=%s", HA_BASE_URL, HA_WS_URL, bool(HA_TOKEN))
    app.run(host="0.0.0.0", port=8099, debug=False, threaded=True)
