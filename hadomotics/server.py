"""HADomotics - Home Assistant Domotics Addon Backend."""

import copy
import hashlib
import json
import logging
import os
import queue
import re
import threading
import time
import uuid
from pathlib import Path

import requests
from flask import Flask, Response, jsonify, request, send_file, send_from_directory, stream_with_context
from PIL import Image
import base64
from datetime import datetime

try:
    from websocket import WebSocketApp, create_connection
except ImportError:  # pragma: no cover
    WebSocketApp = None
    create_connection = None

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

SUPERVISOR_TOKEN = os.environ.get("SUPERVISOR_TOKEN", "")
# Optional local-dev override. Kept separate from SUPERVISOR_TOKEN so tests
# (and a rotated supervisor token) can change either value after import.
HA_TOKEN = os.environ.get("HA_TOKEN", "")


def get_ha_token() -> str:
    """Token the add-on itself uses to call Home Assistant.

    Reads the module globals live. A local HA_TOKEN wins; otherwise the
    Supervisor token is used.
    """
    return (HA_TOKEN or SUPERVISOR_TOKEN or "").strip()

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

_SAFE_ID_RE = re.compile(r"^[a-zA-Z0-9_-]{1,64}$")
_HEX_COLOR_RE = re.compile(r"^#[0-9A-Fa-f]{6}$")
_SERVICE_RE = re.compile(r"^[a-z][a-z0-9_]{0,63}$")

# Supervisor container on the hassio network. Ingress connections originate
# here and nowhere else — other add-ons share 172.30.32.0/23, so a subnet
# check would be wrong. Do not trust X-Forwarded-For or X-Remote-User-* from
# any other peer; those headers are trivial to forge on a published port.
INGRESS_SOURCE_IP = os.environ.get("INGRESS_SOURCE_IP", "172.30.32.2")

# Domains the floor plan must never invoke. These are administration, code
# execution, or notification targets rather than device controls.
BLOCKED_HA_DOMAINS = frozenset({
    "backup",
    "camera",
    "cloud",
    "command_line",
    "conversation",
    "device_tracker",
    "esphome",
    "frontend",
    "hassio",
    "homeassistant",
    "logbook",
    "logger",
    "mqtt",
    "notify",
    "persistent_notification",
    "pyscript",
    "python_script",
    "recorder",
    "rest_command",
    "shell_command",
    "system_log",
    "template",
    "update",
    "zha",
    "zwave_js",
})

# Services the panel's custom "call-service" action and cover controls use,
# beyond the generic "<entity domain>.toggle" tap. Anything else is rejected
# so the Supervisor token is not a general Home Assistant admin API.
ALLOWED_HA_SERVICES: dict[str, frozenset[str]] = {
    "automation": frozenset({"trigger", "turn_on", "turn_off"}),
    "button": frozenset({"press"}),
    "climate": frozenset({"set_hvac_mode", "set_preset_mode", "set_temperature", "turn_off", "turn_on"}),
    "cover": frozenset({
        "close_cover",
        "open_cover",
        "set_cover_position",
        "set_cover_tilt_position",
        "stop_cover",
    }),
    "fan": frozenset({"set_percentage", "turn_off", "turn_on"}),
    "humidifier": frozenset({"set_humidity", "turn_off", "turn_on"}),
    "input_boolean": frozenset({"turn_off", "turn_on"}),
    "input_button": frozenset({"press"}),
    "light": frozenset({"turn_off", "turn_on"}),
    "lock": frozenset({"lock", "unlock"}),
    "media_player": frozenset({
        "media_pause",
        "media_play",
        "media_play_pause",
        "media_stop",
        "turn_off",
        "turn_on",
        "volume_down",
        "volume_mute",
        "volume_set",
        "volume_up",
    }),
    "remote": frozenset({"send_command", "turn_off", "turn_on"}),
    "scene": frozenset({"turn_on"}),
    "script": frozenset({"turn_off", "turn_on"}),
    "siren": frozenset({"turn_off", "turn_on"}),
    "switch": frozenset({"turn_off", "turn_on"}),
    "vacuum": frozenset({"pause", "return_to_base", "start", "start_pause", "stop"}),
    "valve": frozenset({"close_valve", "open_valve", "set_valve_position"}),
}

_TOKEN_CACHE_OK_TTL = 60.0
_TOKEN_CACHE_BAD_TTL = 15.0
_ADMIN_CACHE_OK_TTL = 60.0
_ADMIN_CACHE_BAD_TTL = 5.0

app = Flask(__name__, static_folder="static")

_token_cache: dict[str, tuple[float, bool]] = {}
_token_cache_lock = threading.Lock()
_admin_cache: tuple[float, set[str] | None] | None = None
_admin_cache_lock = threading.Lock()


def _addon_options() -> dict:
    path = DATA_DIR / "options.json"
    try:
        with open(path) as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def _env_or_option_flag(env_name: str, option_key: str, default: bool = False) -> bool:
    raw = os.environ.get(env_name)
    if raw is not None and raw.strip() != "":
        return raw.strip().lower() in {"1", "true", "yes", "on"}
    value = _addon_options().get(option_key, default)
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    return bool(value)


def direct_access_enabled() -> bool:
    """Direct (non-ingress) access is off unless the add-on option is set."""
    return _env_or_option_flag("ALLOW_DIRECT_ACCESS", "allow_direct_access", False)


def _configured_cors_origins() -> set[str]:
    raw = os.environ.get("CORS_ORIGINS")
    if raw is None:
        raw = _addon_options().get("cors_origins") or ""
    origins = set()
    for part in str(raw).split(","):
        item = part.strip().rstrip("/")
        if item and item != "*":
            origins.add(item)
    return origins


def _peer_ip() -> str:
    ip = request.remote_addr or ""
    if ip.startswith("::ffff:"):
        return ip[len("::ffff:"):]
    return ip


def _is_ingress_peer() -> bool:
    return _peer_ip() == INGRESS_SOURCE_IP


def _ingress_user_id() -> str:
    if not _is_ingress_peer():
        return ""
    return (request.headers.get("X-Remote-User-Id") or "").strip()


def _user_api_base() -> str:
    """Home Assistant API for calls authenticated as an end user.

    The Supervisor proxy at http://supervisor/core/api accepts the add-on
    token, not a long-lived user token. User tokens are checked against
    Home Assistant itself.
    """
    if HA_URL:
        return f"{HA_URL}/api"
    return os.environ.get("HA_CORE_URL", "http://homeassistant:8123/api").rstrip("/")


def _bearer_token() -> str:
    header = request.headers.get("Authorization", "")
    if not header.lower().startswith("bearer "):
        return ""
    token = header[7:].strip()
    if not token or len(token) > 4096:
        return ""
    return token


def _probe_ha_token(token: str) -> int | None:
    try:
        resp = requests.get(
            f"{_user_api_base()}/",
            headers={"Authorization": f"Bearer {token}"},
            timeout=5,
            allow_redirects=False,
        )
        return resp.status_code
    except Exception as exc:
        log.warning("Home Assistant token check failed: %s", exc)
        return None


def _ha_token_is_valid(token: str) -> bool:
    if not token:
        return False
    digest = hashlib.sha256(token.encode()).hexdigest()
    now = time.monotonic()
    with _token_cache_lock:
        hit = _token_cache.get(digest)
        if hit and hit[0] > now:
            return hit[1]
    status = _probe_ha_token(token)
    if status is None:
        return False
    ok = status == 200
    ttl = _TOKEN_CACHE_OK_TTL if ok else _TOKEN_CACHE_BAD_TTL
    with _token_cache_lock:
        _token_cache[digest] = (now + ttl, ok)
        if len(_token_cache) > 256:
            expired = [key for key, (exp, _) in _token_cache.items() if exp <= now]
            for key in expired:
                _token_cache.pop(key, None)
    return ok


def _user_record_is_admin(user: dict) -> bool:
    """Home Assistant admin flag across core versions.

    Older cores set ``is_admin``. Current cores omit it and put administrators
    in the ``system-admin`` group (owners are administrators too).
    """
    if user.get("is_admin") is True or user.get("is_owner") is True:
        return True
    groups = user.get("group_ids") or []
    return "system-admin" in groups


def _fetch_admin_user_ids() -> set[str] | None:
    """Return Home Assistant administrator user ids, or None if unknown."""
    token = get_ha_token()
    if create_connection is None or not token:
        log.warning("Cannot resolve Home Assistant admins (no websocket or token)")
        return None
    ws = None
    try:
        ws = create_connection(HA_WS_URL, timeout=5)
        hello = json.loads(ws.recv())
        if hello.get("type") != "auth_required":
            log.warning("Unexpected HA websocket hello: %s", hello.get("type"))
            return None
        ws.send(json.dumps({"type": "auth", "access_token": token}))
        auth = json.loads(ws.recv())
        if auth.get("type") != "auth_ok":
            log.warning("HA admin lookup was not accepted")
            return None
        ws.send(json.dumps({"id": 1, "type": "config/auth/list"}))
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            msg = json.loads(ws.recv())
            if msg.get("type") == "result" and msg.get("id") == 1:
                if not msg.get("success"):
                    log.warning("HA admin lookup rejected")
                    return None
                users = msg.get("result") or []
                return {
                    user.get("id")
                    for user in users
                    if isinstance(user, dict) and user.get("id") and _user_record_is_admin(user)
                }
        log.warning("HA admin lookup timed out")
        return None
    except Exception as exc:
        log.warning("HA admin lookup failed: %s", exc)
        return None
    finally:
        if ws is not None:
            try:
                ws.close()
            except Exception:
                pass


def _cached_admin_ids() -> set[str] | None:
    global _admin_cache
    now = time.monotonic()
    with _admin_cache_lock:
        if _admin_cache and _admin_cache[0] > now:
            return _admin_cache[1]
    ids = _fetch_admin_user_ids()
    ttl = _ADMIN_CACHE_OK_TTL if ids is not None else _ADMIN_CACHE_BAD_TTL
    with _admin_cache_lock:
        _admin_cache = (now + ttl, ids)
    return ids


def ingress_user_is_admin(user_id: str) -> bool:
    """True when this ingress user is a Home Assistant administrator.

    Fails closed when the user id is missing or Home Assistant cannot be asked.
    The header is only consulted for the Supervisor peer.
    """
    if not user_id:
        return False
    admins = _cached_admin_ids()
    return bool(admins and user_id in admins)


def _service_allowed(domain: str, service: str) -> bool:
    if not _SERVICE_RE.match(domain) or not _SERVICE_RE.match(service):
        return False
    if domain in BLOCKED_HA_DOMAINS:
        return False
    # Default tap action on the floor plan is "<entity domain>.toggle".
    if service == "toggle":
        return True
    allowed = ALLOWED_HA_SERVICES.get(domain)
    return bool(allowed and service in allowed)


def _request_origin() -> str:
    return (request.headers.get("Origin") or "").strip().rstrip("/")


def _apply_cors(resp):
    origin = _request_origin()
    allowed = _configured_cors_origins()
    if direct_access_enabled() and origin and origin in allowed:
        resp.headers["Access-Control-Allow-Origin"] = origin
        resp.headers["Vary"] = "Origin"
        resp.headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type"
        resp.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS"
        resp.headers["Access-Control-Max-Age"] = "600"
    elif resp.headers.get("Access-Control-Allow-Origin") == "*":
        del resp.headers["Access-Control-Allow-Origin"]
    return resp


# Floor-plan reads the Lovelace card needs. Writes, backups, and every
# Home Assistant proxy route stay administrator-only.
_READ_ONLY_EXACT = {"/", "/index.html", "/api/floors"}


def _ingress_read_only(method: str, path: str) -> bool:
    if method != "GET":
        return False
    if path in _READ_ONLY_EXACT:
        return True
    if path.startswith("/static/"):
        return True
    if path.startswith("/api/images/"):
        return True
    if path.startswith("/api/floors/"):
        return True
    return False


def _authorize_request():
    if _is_ingress_peer():
        if _ingress_read_only(request.method, request.path):
            return None
        user_id = _ingress_user_id()
        if ingress_user_is_admin(user_id):
            return None
        log.warning(
            "Rejected non-admin ingress %s %s from %s",
            request.method,
            request.path,
            _peer_ip(),
        )
        return jsonify({"error": "Administrator access required"}), 403

    if direct_access_enabled() and _ha_token_is_valid(_bearer_token()):
        return None

    log.warning(
        "Rejected unauthenticated %s %s from %s",
        request.method,
        request.path,
        _peer_ip(),
    )
    return jsonify({"error": "Authentication required"}), 401


@app.before_request
def _auth_gate():
    if request.method == "OPTIONS":
        origin = _request_origin()
        if direct_access_enabled() and origin and origin in _configured_cors_origins():
            resp = app.make_response(("", 204))
            return _apply_cors(resp)
        return jsonify({"error": "Origin not allowed"}), 403
    return _authorize_request()


@app.after_request
def _cors_after(resp):
    return _apply_cors(resp)

# ---------------------------------------------------------------------------
# HA WebSocket state cache + SSE clients
# ---------------------------------------------------------------------------

_state_cache: dict[str, dict] = {}
_state_lock = threading.Lock()
_sse_clients: list = []
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
        ws.send(json.dumps({"type": "auth", "access_token": get_ha_token()}))
        return

    if msg_type == "auth_ok":
        _ha_ws_connected = True
        log.info("HA WebSocket authenticated")
        _broadcast({"type": "connected", "ha_ws": True})
        ws.send(json.dumps({
            "id": _next_msg_id(),
            "type": "subscribe_events",
            "event_type": "state_changed",
        }))
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
    if not get_ha_token():
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
    ws.run_forever(ping_interval=30, ping_timeout=10)


def _ha_ws_loop() -> None:
    global _ha_ws_connected
    while True:
        try:
            _run_ha_websocket_once()
        except Exception as exc:
            log.warning("HA WebSocket loop error: %s", exc)
        _ha_ws_connected = False
        time.sleep(3)


def _start_ha_ws_thread() -> None:
    t = threading.Thread(target=_ha_ws_loop, name="ha-websocket", daemon=True)
    t.start()
    log.info("HA WebSocket thread started (url=%s)", HA_WS_URL)


def _safe_path_within(base_dir: Path, filename: str):
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
    if CONFIG_FILE.exists():
        try:
            with open(CONFIG_FILE) as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError) as exc:
            log.warning("Could not read config file: %s – resetting to defaults", exp if False else exc)
    return {"floors": copy.deepcopy(DEFAULT_FLOORS)}


def save_config(config: dict) -> None:
    with open(CONFIG_FILE, "w") as f:
        json.dump(config, f, indent=2)


def get_floor(config: dict, floor_id: str):
    return next((f for f in config["floors"] if f["id"] == floor_id), None)


def ha_headers(token: str | None = None) -> dict:
    used = get_ha_token() if token is None else token
    return {"Authorization": f"Bearer {used}", "Content-Type": "application/json"}


def _call_as_user() -> bool:
    """Direct-access requests must use the caller's own Home Assistant token."""
    return direct_access_enabled() and not _is_ingress_peer()


def _api_base_for_request() -> str:
    if _call_as_user():
        return _user_api_base()
    return HA_BASE_URL


def _token_for_request() -> str:
    if _call_as_user():
        return _bearer_token()
    return get_ha_token()


@app.route("/")
@app.route("/index.html")
def index():
    return send_from_directory("static", "index.html")


@app.route("/static/<path:filename>")
def serve_static(filename):
    return send_from_directory("static", filename)


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


@app.route("/api/elements/colors", methods=["PUT"])
def bulk_update_element_colors():
    data = request.get_json(force=True) or {}
    color_on = data.get("color_on")
    color_off = data.get("color_off")
    scope = data.get("scope", "floor")
    floor_id = data.get("floor_id")

    if color_on is None and color_off is None:
        return jsonify({"error": "color_on or color_off required"}), 400
    if color_on is not None and not _HEX_COLOR_RE.match(str(color_on)):
        return jsonify({"error": "Invalid color_on"}), 400
    if color_off is not None and not _HEX_COLOR_RE.match(str(color_off)):
        return jsonify({"error": "Invalid color_off"}), 400
    if scope not in ("floor", "all"):
        return jsonify({"error": "scope must be 'floor' or 'all'"}), 400
    if scope == "floor" and not floor_id:
        return jsonify({"error": "floor_id required when scope is floor"}), 400

    config = load_config()
    if scope == "floor":
        floor = get_floor(config, floor_id)
        if floor is None:
            return jsonify({"error": "Floor not found"}), 404
        targets = [floor]
    else:
        targets = config.get("floors", [])

    updated = 0
    for floor in targets:
        for el in floor.get("elements", []):
            if color_on is not None:
                el["color_on"] = color_on
            if color_off is not None:
                el["color_off"] = color_off
            updated += 1
    save_config(config)
    return jsonify({"ok": True, "updated": updated})


@app.route("/api/ha/states", methods=["GET"])
def ha_states():
    # The in-memory cache is filled with the Supervisor token and contains
    # every entity. Only ingress (administrator) callers may see it.
    if not _call_as_user():
        with _state_lock:
            if _state_cache:
                return jsonify(list(_state_cache.values()))

    token = _token_for_request()
    if not token:
        return jsonify([])
    try:
        resp = requests.get(
            f"{_api_base_for_request()}/states",
            headers=ha_headers(token),
            timeout=10,
            allow_redirects=False,
        )
        data = resp.json()
        if isinstance(data, list) and not _call_as_user():
            _set_states_bulk(data)
        return jsonify(data)
    except Exception as exc:
        log.warning("Could not fetch HA states: %s", exc)
        return jsonify([])


@app.route("/api/ha/stream")
def ha_stream():
    # The stream replays the Supervisor-token cache. Direct tokens must not
    # subscribe to it; they can poll /api/ha/states with their own token.
    if not _is_ingress_peer():
        return jsonify({"error": "State stream is available through ingress only"}), 403

    def event_stream():
        q = queue.Queue(maxsize=200)
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
    if not _call_as_user():
        with _state_lock:
            cached = _state_cache.get(entity_id)
        if cached:
            return jsonify(cached)

    token = _token_for_request()
    if not token:
        return jsonify({"error": "No supervisor token"}), 503
    try:
        resp = requests.get(
            f"{_api_base_for_request()}/states/{entity_id}",
            headers=ha_headers(token),
            timeout=10,
            allow_redirects=False,
        )
        return jsonify(resp.json()), resp.status_code
    except Exception as exc:
        log.warning("Could not fetch HA state for %s: %s", entity_id, exc)
        return jsonify({"error": "Could not retrieve entity state"}), 503


@app.route("/api/ha/services/<domain>/<service>", methods=["POST"])
def ha_call_service(domain: str, service: str):
    domain = (domain or "").lower()
    service = (service or "").lower()
    if not _service_allowed(domain, service):
        log.warning("Blocked HA service %s.%s from %s", domain, service, _peer_ip())
        return jsonify({"error": "Service is not allowed"}), 403
    token = _token_for_request()
    if not token:
        return jsonify({"error": "No supervisor token"}), 503
    try:
        data = request.get_json(force=True) or {}
        if not isinstance(data, dict):
            return jsonify({"error": "JSON object required"}), 400
        resp = requests.post(
            f"{_api_base_for_request()}/services/{domain}/{service}",
            headers=ha_headers(token),
            json=data,
            timeout=10,
            allow_redirects=False,
        )
        return jsonify(resp.json()), resp.status_code
    except Exception as exc:
        log.warning("Could not call HA service %s.%s: %s", domain, service, exc)
        return jsonify({"error": "Could not call Home Assistant service"}), 503


@app.route("/api/config", methods=["GET"])
def get_global_config():
    config = load_config()
    return jsonify({k: v for k, v in config.items() if k != "floors"})


@app.route("/api/backup", methods=["GET"])
def backup_config():
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
                log.warning("Could not restore image: %s", exc)

        new_config["floors"].append(floor)

    save_config(new_config)
    return jsonify({"ok": True, "message": "Configuration restored successfully"})


if __name__ == "__main__":
    _start_ha_ws_thread()
    log.info("Starting HADomotics server on port 8099")
    log.info(
        "HA_BASE_URL=%s | HA_WS_URL=%s | token configured=%s | direct_access=%s | ingress_peer=%s",
        HA_BASE_URL,
        HA_WS_URL,
        bool(get_ha_token()),
        direct_access_enabled(),
        INGRESS_SOURCE_IP,
    )
    app.run(host="0.0.0.0", port=8099, debug=False, threaded=True)
