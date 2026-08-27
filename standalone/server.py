"""HADomotics Standalone — Tuya Cloud / LAN, no Home Assistant."""
from __future__ import annotations

import base64
import copy
import json
import logging
import os
import queue
import threading
import time
import uuid
from datetime import datetime
from pathlib import Path

from flask import Flask, Response, jsonify, request, send_file, send_from_directory, stream_with_context
from flask_cors import CORS

from tuya_client import adapter

LOG_LEVEL = os.environ.get("LOG_LEVEL", "info").upper()
logging.basicConfig(
    level=getattr(logging, LOG_LEVEL, logging.INFO),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("hadomotics.standalone")

ROOT = Path(__file__).resolve().parent
WEB = ROOT / "web"
DATA_DIR = Path(os.environ.get("DATA_DIR", str(ROOT / "data")))
IMAGES_DIR = DATA_DIR / "images"
CONFIG_FILE = DATA_DIR / "config.json"
TUYA_FILE = DATA_DIR / "tuya.json"
DATA_DIR.mkdir(parents=True, exist_ok=True)
IMAGES_DIR.mkdir(parents=True, exist_ok=True)

app = Flask(__name__, static_folder=str(WEB), static_url_path="")
CORS(app)

DEFAULT_FLOORS = [
    {"id": "floor1", "name": "Planta 1", "order": 0, "image": None, "elements": []},
]

_sse_clients: list = []
_sse_lock = threading.Lock()
_poll_stop = threading.Event()


def load_config() -> dict:
    if CONFIG_FILE.exists():
        try:
            return json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError) as exc:
            log.warning("config read failed: %s", exc)
    return {"floors": copy.deepcopy(DEFAULT_FLOORS)}


def save_config(config: dict) -> None:
    CONFIG_FILE.write_text(json.dumps(config, indent=2), encoding="utf-8")


def get_floor(config: dict, floor_id: str):
    return next((f for f in config["floors"] if f["id"] == floor_id), None)


def _load_tuya_file() -> None:
    if not TUYA_FILE.exists():
        return
    try:
        cfg = json.loads(TUYA_FILE.read_text(encoding="utf-8"))
        adapter.configure(cfg)
    except Exception as exc:
        log.warning("Could not load tuya.json: %s", exc)


def _save_tuya_file(cfg: dict) -> None:
    safe = {
        "access_id": cfg.get("access_id", ""),
        "access_secret": cfg.get("access_secret", ""),
        "uid": cfg.get("uid", ""),
        "region": cfg.get("region", "eu"),
        "prefer_local": bool(cfg.get("prefer_local", True)),
    }
    TUYA_FILE.write_text(json.dumps(safe, indent=2), encoding="utf-8")


def _broadcast(msg: dict) -> None:
    with _sse_lock:
        dead = []
        for q in _sse_clients:
            try:
                q.put_nowait(msg)
            except Exception:
                dead.append(q)
        for q in dead:
            if q in _sse_clients:
                _sse_clients.remove(q)


def _poll_loop() -> None:
    while not _poll_stop.is_set():
        try:
            adapter.sync_devices()
            states = adapter.ha_style_states()
            _broadcast({"type": "states", "states": states})
            _broadcast({"type": "connected", "ha_ws": adapter.connected, "tuya": adapter.public_status()})
        except Exception as exc:
            log.debug("poll: %s", exc)
            _broadcast({"type": "connected", "ha_ws": False})
        _poll_stop.wait(8)


# ---------------------------------------------------------------------------
# Static / PWA
# ---------------------------------------------------------------------------
@app.route("/")
@app.route("/index.html")
def index():
    return send_from_directory(WEB, "index.html")


@app.route("/manifest.webmanifest")
def manifest():
    return send_from_directory(WEB, "manifest.webmanifest")


@app.route("/sw.js")
def sw():
    resp = send_from_directory(WEB, "sw.js")
    resp.headers["Service-Worker-Allowed"] = "/"
    resp.headers["Cache-Control"] = "no-cache"
    return resp


@app.route("/install/<path:name>")
def install_pages(name: str):
    return send_from_directory(WEB / "install", name)


@app.route("/css/<path:filename>")
def css(filename):
    return send_from_directory(WEB / "css", filename)


@app.route("/js/<path:filename>")
def js(filename):
    return send_from_directory(WEB / "js", filename)


@app.route("/icons/<path:filename>")
def icons(filename):
    return send_from_directory(WEB / "icons", filename)


# ---------------------------------------------------------------------------
# Floors / elements (same contract as the HA addon)
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
    data = request.get_json(force=True) or {}
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
    floor = get_floor(load_config(), floor_id)
    if floor is None:
        return jsonify({"error": "Floor not found"}), 404
    return jsonify(floor)


@app.route("/api/floors/<floor_id>", methods=["PUT"])
def update_floor(floor_id: str):
    config = load_config()
    floor = get_floor(config, floor_id)
    if floor is None:
        return jsonify({"error": "Floor not found"}), 404
    data = request.get_json(force=True) or {}
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
        (IMAGES_DIR / floor["image"]).unlink(missing_ok=True)
    config["floors"] = [f for f in config["floors"] if f["id"] != floor_id]
    save_config(config)
    return jsonify({"ok": True})


@app.route("/api/floors/<floor_id>/image", methods=["POST"])
def upload_floor_image(floor_id: str):
    config = load_config()
    floor = get_floor(config, floor_id)
    if floor is None:
        return jsonify({"error": "Floor not found"}), 404
    if "image" not in request.files:
        return jsonify({"error": "No image file provided"}), 400
    file = request.files["image"]
    suffix = Path(file.filename or "plan.png").suffix.lower() or ".png"
    if suffix not in {".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg"}:
        return jsonify({"error": "File type not allowed"}), 400
    new_filename = uuid.uuid4().hex + (".jpg" if suffix == ".jpeg" else suffix)
    if floor.get("image"):
        (IMAGES_DIR / floor["image"]).unlink(missing_ok=True)
    file.save(str(IMAGES_DIR / new_filename))
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
        (IMAGES_DIR / floor["image"]).unlink(missing_ok=True)
        floor["image"] = None
        save_config(config)
    return jsonify({"ok": True})


@app.route("/api/images/<filename>")
def serve_image(filename: str):
    path = (IMAGES_DIR / Path(filename).name).resolve()
    try:
        path.relative_to(IMAGES_DIR.resolve())
    except ValueError:
        return jsonify({"error": "Image not found"}), 404
    if not path.is_file():
        return jsonify({"error": "Image not found"}), 404
    return send_file(str(path))


@app.route("/api/floors/<floor_id>/elements", methods=["GET"])
def list_elements(floor_id: str):
    floor = get_floor(load_config(), floor_id)
    if floor is None:
        return jsonify({"error": "Floor not found"}), 404
    return jsonify(floor.get("elements", []))


@app.route("/api/floors/<floor_id>/elements", methods=["POST"])
def create_element(floor_id: str):
    config = load_config()
    floor = get_floor(config, floor_id)
    if floor is None:
        return jsonify({"error": "Floor not found"}), 404
    data = request.get_json(force=True) or {}
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
    for extra in ("rotation", "position", "service", "service_data"):
        if extra in data:
            element[extra] = data[extra]
    floor.setdefault("elements", []).append(element)
    save_config(config)
    return jsonify(element), 201


@app.route("/api/floors/<floor_id>/elements/<element_id>", methods=["PUT"])
def update_element(floor_id: str, element_id: str):
    config = load_config()
    floor = get_floor(config, floor_id)
    if floor is None:
        return jsonify({"error": "Floor not found"}), 404
    elem = next((e for e in floor.get("elements", []) if e["id"] == element_id), None)
    if elem is None:
        return jsonify({"error": "Element not found"}), 404
    data = request.get_json(force=True) or {}
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
# Tuya (replaces /api/ha/* so the existing frontend can stay almost identical)
# ---------------------------------------------------------------------------
@app.route("/api/tuya/config", methods=["GET"])
def tuya_get_config():
    return jsonify({**adapter.public_config(), **adapter.public_status()})


@app.route("/api/tuya/config", methods=["POST"])
def tuya_set_config():
    data = request.get_json(force=True) or {}
    current = {
        "access_id": adapter.access_id,
        "access_secret": adapter.access_secret,
        "uid": adapter.uid,
        "region": adapter.region,
        "prefer_local": adapter.prefer_local,
    }
    if data.get("access_id") is not None:
        current["access_id"] = data["access_id"]
    if data.get("access_secret"):
        current["access_secret"] = data["access_secret"]
    if data.get("uid") is not None:
        current["uid"] = data["uid"]
    if data.get("region"):
        current["region"] = data["region"]
    if "prefer_local" in data:
        current["prefer_local"] = bool(data["prefer_local"])
    status = adapter.configure(current)
    _save_tuya_file(current)
    _broadcast({"type": "connected", "ha_ws": adapter.connected, "tuya": status})
    return jsonify(status)


@app.route("/api/tuya/devices", methods=["GET"])
def tuya_devices():
    return jsonify(adapter.sync_devices(force=request.args.get("force") == "1"))


@app.route("/api/tuya/sync", methods=["POST"])
def tuya_sync():
    devices = adapter.sync_devices(force=True)
    _broadcast({"type": "states", "states": adapter.ha_style_states()})
    return jsonify({"ok": True, "devices": devices, "status": adapter.public_status()})


@app.route("/api/ha/states", methods=["GET"])
@app.route("/api/tuya/states", methods=["GET"])
def ha_states():
    try:
        return jsonify(adapter.ha_style_states())
    except Exception as exc:
        log.warning("states: %s", exc)
        return jsonify([])


@app.route("/api/ha/stream")
@app.route("/api/tuya/stream")
def ha_stream():
    def event_stream():
        q: queue.Queue = queue.Queue(maxsize=200)
        with _sse_lock:
            _sse_clients.append(q)
        try:
            yield f"data: {json.dumps({'type': 'connected', 'ha_ws': adapter.connected, 'tuya': adapter.public_status()})}\n\n"
            try:
                snapshot = adapter.ha_style_states()
            except Exception:
                snapshot = []
            if snapshot:
                yield f"data: {json.dumps({'type': 'states', 'states': snapshot})}\n\n"
            while True:
                try:
                    msg = q.get(timeout=25)
                    yield f"data: {json.dumps(msg)}\n\n"
                except queue.Empty:
                    yield ": keepalive\n\n"
        finally:
            with _sse_lock:
                if q in _sse_clients:
                    _sse_clients.remove(q)

    return Response(
        stream_with_context(event_stream()),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"},
    )


def _parse_tuya_entity(entity_id: str) -> tuple[str, str | None]:
    """tuya.<deviceId> or tuya.<deviceId>.<code>"""
    parts = (entity_id or "").split(".")
    if len(parts) >= 2 and parts[0] == "tuya":
        device_id = parts[1]
        code = parts[2] if len(parts) > 2 else None
        return device_id, code
    return entity_id, None


@app.route("/api/ha/services/<domain>/<service>", methods=["POST"])
@app.route("/api/tuya/services/<domain>/<service>", methods=["POST"])
def ha_call_service(domain: str, service: str):
    data = request.get_json(force=True) or {}
    entity_id = data.get("entity_id") or ""
    device_id, code = _parse_tuya_entity(entity_id)
    try:
        if service in ("set_cover_position", "set_position") or domain == "cover" and "position" in data:
            pos = int(data.get("position", 50))
            result = adapter.set_cover(device_id, pos, code)
        elif service == "turn_on":
            result = adapter.command(device_id, [{"code": code or "switch_1", "value": True}])
        elif service == "turn_off":
            result = adapter.command(device_id, [{"code": code or "switch_1", "value": False}])
        else:
            result = adapter.toggle(device_id, code)
        _broadcast({"type": "states", "states": adapter.ha_style_states()})
        return jsonify(result)
    except Exception as exc:
        log.warning("service %s.%s failed: %s", domain, service, exc)
        return jsonify({"error": str(exc)}), 400


@app.route("/api/backup", methods=["GET"])
def backup_config():
    config = load_config()
    backup = {
        "version": "standalone-0.1.0",
        "exported_at": str(datetime.utcnow()),
        "tuya": adapter.public_config(),
        "floors": [],
    }
    for floor in config.get("floors", []):
        floor_data = {
            "id": floor["id"],
            "name": floor["name"],
            "order": floor.get("order", 0),
            "elements": floor.get("elements", []),
            "image_base64": None,
            "image_ext": None,
        }
        if floor.get("image"):
            img_path = IMAGES_DIR / floor["image"]
            if img_path.exists():
                floor_data["image_base64"] = base64.b64encode(img_path.read_bytes()).decode("utf-8")
                floor_data["image_ext"] = img_path.suffix
        backup["floors"].append(floor_data)
    return jsonify(backup)


@app.route("/api/restore", methods=["POST"])
def restore_config():
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
            "image": None,
        }
        if floor_data.get("image_base64") and floor_data.get("image_ext"):
            try:
                img_bytes = base64.b64decode(floor_data["image_base64"])
                new_filename = uuid.uuid4().hex + floor_data["image_ext"]
                (IMAGES_DIR / new_filename).write_bytes(img_bytes)
                floor["image"] = new_filename
            except Exception as exc:
                log.warning("restore image: %s", exc)
        new_config["floors"].append(floor)
    save_config(new_config)
    return jsonify({"ok": True, "message": "Configuration restored successfully"})


def _start_background() -> None:
    t = threading.Thread(target=_poll_loop, name="tuya-poll", daemon=True)
    t.start()


_load_tuya_file()
_start_background()


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8099"))
    log.info("HADomotics Standalone on 0.0.0.0:%s (demo=%s)", port, adapter.demo)
    app.run(host="0.0.0.0", port=port, debug=False, threaded=True)
