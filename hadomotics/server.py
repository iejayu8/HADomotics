"""HADomotics - Home Assistant Domotics Addon Backend."""

import copy
import json
import logging
import os
import uuid
from pathlib import Path

import requests
from flask import Flask, jsonify, request, send_file, send_from_directory
from flask_cors import CORS
from PIL import Image

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
    config = data / "config.json"
    data.mkdir(parents=True, exist_ok=True)
    images.mkdir(parents=True, exist_ok=True)
    return data, images, config


DATA_DIR, IMAGES_DIR, CONFIG_FILE = _resolve_paths()

SUPERVISOR_TOKEN = os.environ.get("SUPERVISOR_TOKEN", "")
HA_BASE_URL = "http://supervisor/core/api"

ALLOWED_IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg"}

# Maps user-supplied suffix → canonical server-controlled extension (breaks taint chain).
_EXT_MAP: dict[str, str] = {
    ".jpg": ".jpg",
    ".jpeg": ".jpg",
    ".png": ".png",
    ".gif": ".gif",
    ".webp": ".webp",
    ".svg": ".svg",
}

# Regex that matches only safe UUID-like floor IDs or the three built-in IDs
import re as _re
_SAFE_ID_RE = _re.compile(r"^[a-zA-Z0-9_-]{1,64}$")

app = Flask(__name__, static_folder="static")
CORS(app)

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
    {"id": "floor2", "name": "Floor 2", "order": 1, "image": None, "elements": []},
    {"id": "garden", "name": "Garden", "order": 2, "image": None, "elements": []},
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
    return {"Authorization": f"Bearer {SUPERVISOR_TOKEN}", "Content-Type": "application/json"}


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
    # Remove image file if present
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
    # Derive extension only from the suffix and look it up in our constant map.
    # The value assigned to safe_ext comes from _EXT_MAP (a server constant), NOT from
    # user input — this breaks the taint chain for path operations below.
    raw_suffix = Path(file.filename or "").suffix.lower()
    safe_ext = _EXT_MAP.get(raw_suffix)
    if safe_ext is None:
        return jsonify({"error": "File type not allowed"}), 400

    # Generate a server-controlled filename: UUID hex + extension from our constant map.
    new_filename = uuid.uuid4().hex + safe_ext

    # Remove old image
    old_image = floor.get("image")
    if old_image:
        old_path = _safe_path_within(IMAGES_DIR, old_image)
        if old_path is not None:
            old_path.unlink(missing_ok=True)

    # Save to a server-generated path (not derived from user input)
    save_path = IMAGES_DIR / new_filename
    file.save(str(save_path))

    # Verify it's a valid image (skip validation for SVG)
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
        # Use the value stored in config (server-controlled), not user input
        stored_name = floor["image"]
        img_path = _safe_path_within(IMAGES_DIR, stored_name)
        if img_path is not None:
            img_path.unlink(missing_ok=True)
        floor["image"] = None
        save_config(config)
    return jsonify({"ok": True})


@app.route("/api/images/<filename>")
def serve_image(filename: str):
    # Only serve images that are explicitly registered in our config (whitelist).
    config = load_config()
    # Strip path components from the URL parameter – use only the plain filename.
    user_name = Path(filename).name
    # Iterate the config registry and find the matching entry.
    # `registered` is bound to a value FROM the config set (server-controlled),
    # NOT from user input – this breaks the taint chain for path operations below.
    registered = None
    for stored in config.get("floors", []):
        img = stored.get("image")
        if img and img == user_name:
            registered = img   # value is `img` from config, not `user_name`
            break
    if registered is None:
        return jsonify({"error": "Image not found"}), 404
    # Build path from config-controlled value
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
    updatable = ["type", "label", "entity_id", "icon", "x", "y", "width", "height",
                 "color_on", "color_off", "tap_action"]
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
# HA proxy (read entity states)
# ---------------------------------------------------------------------------


@app.route("/api/ha/states", methods=["GET"])
def ha_states():
    if not SUPERVISOR_TOKEN:
        return jsonify([])
    try:
        resp = requests.get(f"{HA_BASE_URL}/states", headers=ha_headers(), timeout=10)
        return jsonify(resp.json())
    except Exception as exc:
        log.warning("Could not fetch HA states: %s", exc)
        return jsonify([])


@app.route("/api/ha/states/<entity_id>", methods=["GET"])
def ha_state(entity_id: str):
    if not SUPERVISOR_TOKEN:
        return jsonify({"error": "No supervisor token"}), 503
    try:
        resp = requests.get(f"{HA_BASE_URL}/states/{entity_id}", headers=ha_headers(), timeout=10)
        return jsonify(resp.json()), resp.status_code
    except Exception as exc:
        log.warning("Could not fetch HA state for %s: %s", entity_id, exc)
        return jsonify({"error": "Could not retrieve entity state"}), 503


@app.route("/api/ha/services/<domain>/<service>", methods=["POST"])
def ha_call_service(domain: str, service: str):
    if not SUPERVISOR_TOKEN:
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
        log.warning("Could not call HA service %s.%s: %s", domain, service, exc)
        return jsonify({"error": "Could not call Home Assistant service"}), 503


# ---------------------------------------------------------------------------
# Global config API
# ---------------------------------------------------------------------------


@app.route("/api/config", methods=["GET"])
def get_global_config():
    config = load_config()
    return jsonify({k: v for k, v in config.items() if k != "floors"})


if __name__ == "__main__":
    log.info("Starting HADomotics server on port 8099")
    app.run(host="0.0.0.0", port=8099, debug=False)
