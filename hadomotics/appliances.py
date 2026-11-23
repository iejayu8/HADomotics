"""HADomotics — electrodomésticos en el plano de Dispositivos.

Mismo patrón que la presencia de Seguridad:
- GET /api/appliances/map        aparatos (appliances_map.json) con las
                                 posiciones guardadas aplicadas
- PUT /api/appliances/positions  mover un aparato en modo edición (solo admin:
                                 la puerta de autenticación del add-on no deja
                                 escribir a nadie más)

Las acciones de cada aparato no pasan por aquí: el panel llama a los servicios
de Home Assistant como los demás controles (hass.callService dentro de HA como
el usuario; fuera, el proxy de servicios del add-on con su lista blanca).
"""

from __future__ import annotations

import copy
import json
import logging
import math
from pathlib import Path
from typing import Callable

from flask import Blueprint, jsonify, request

log = logging.getLogger("hadomotics.appliances")

MAP_FILE = Path(__file__).resolve().parent / "appliances_map.json"
OVERLAYS_FILE = Path(__file__).resolve().parent / "plan_overlays.json"

POSITION_MIN = -1.0
POSITION_MAX = 2.0

# (dominio, servicio) que usan los popups de los aparatos. El proxy del add-on
# los permite: por dominio (ALLOWED_HA_SERVICES en server.py) o, para
# number/select, solo con estas entidades (ENTITY_SCOPED).
ACTION_SERVICES = frozenset({
    ("button", "press"),
    ("number", "set_value"),
    ("select", "select_option"),
    ("switch", "turn_off"),
    ("switch", "turn_on"),
    ("vacuum", "locate"),
    ("vacuum", "pause"),
    ("vacuum", "return_to_base"),
    ("vacuum", "set_fan_speed"),
    ("vacuum", "start"),
})


def load_map(path: Path = MAP_FILE) -> dict:
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def _floor_keys(overlays: dict) -> set[str]:
    return {f.get("key") for f in (overlays or {}).get("floors", []) if isinstance(f, dict) and f.get("key")}


def _valid_record(rec, floor_keys: set[str]) -> bool:
    if not isinstance(rec, dict) or rec.get("floor") not in floor_keys:
        return False
    for k in ("x", "y"):
        v = rec.get(k)
        if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
            return False
        if not POSITION_MIN <= float(v) <= POSITION_MAX:
            return False
    return True


def services_used(appliance_map: dict) -> set[tuple[str, str]]:
    """Todos los (dominio, servicio) que puede llamar el panel para estos aparatos."""
    out: set[tuple[str, str]] = set()
    for a in appliance_map.get("appliances", []):
        for act in a.get("actions", []):
            out.add((act.get("domain"), act.get("service")))
        for c in a.get("controls", []):
            t = c.get("type")
            if t == "switch":
                out |= {("switch", "turn_on"), ("switch", "turn_off")}
            elif t == "number":
                out.add(("number", "set_value"))
            elif t == "select":
                out.add(("select", "select_option"))
            elif t == "fan_speed":
                out.add(("vacuum", "set_fan_speed"))
    return out


# Servicios que el proxy del add-on solo deja usar con las entidades de los aparatos.
ENTITY_SCOPED = frozenset({("number", "set_value"), ("select", "select_option")})


def entity_scoped_services(appliance_map: dict) -> dict[tuple[str, str], frozenset[str]]:
    """{(dominio, servicio): entidades} para number.set_value y select.select_option."""
    out: dict[tuple[str, str], set[str]] = {}
    for a in appliance_map.get("appliances", []):
        for c in a.get("controls", []):
            key = {"number": ("number", "set_value"), "select": ("select", "select_option")}.get(c.get("type"))
            if key:
                out.setdefault(key, set()).add(c["entity"])
        for act in a.get("actions", []):
            key = (act.get("domain"), act.get("service"))
            if key in ENTITY_SCOPED:
                out.setdefault(key, set()).add(act["entity"])
    return {k: frozenset(v) for k, v in out.items()}


def entities(appliance_map: dict) -> list[str]:
    out: list[str] = []

    def add(eid):
        if isinstance(eid, str) and eid and eid not in out:
            out.append(eid)

    for a in appliance_map.get("appliances", []):
        add(a.get("main"))
        for key in ("badge", "alerts", "status", "controls", "actions"):
            for item in a.get(key, []) or []:
                add(item.get("entity"))
                add(item.get("option_from"))
                for cond in item.get("enabled_when", []) or []:
                    add(cond.get("entity"))
        add((a.get("running") or {}).get("entity"))
    return out


def merge_positions(appliance_map: dict, positions: dict | None, overlays: dict | None = None) -> dict:
    """Mapa con las posiciones guardadas aplicadas; sin posiciones, el del repositorio."""
    merged = copy.deepcopy(appliance_map)
    if not isinstance(positions, dict) or not positions:
        return merged
    keys = _floor_keys(overlays) if overlays is not None else {a.get("floor") for a in merged.get("appliances", [])}
    for a in merged.get("appliances", []):
        rec = positions.get(a.get("id"))
        if not _valid_record(rec, keys):
            continue
        a["floor"] = rec["floor"]
        a["position"] = [round(float(rec["x"]), 5), round(float(rec["y"]), 5)]
        a["custom"] = True
    return merged


def validate_position(appliance_map: dict, overlays: dict, body: dict) -> tuple[str, dict]:
    """Valida la posición nueva de un aparato. Devuelve (id, registro)."""
    ident = str((body or {}).get("id") or "")
    if ident not in {a.get("id") for a in appliance_map.get("appliances", [])}:
        raise ValueError("Unknown appliance")
    rec = {"floor": (body or {}).get("floor"), "x": (body or {}).get("x"), "y": (body or {}).get("y")}
    if not _valid_record(rec, _floor_keys(overlays)):
        raise ValueError("Invalid floor or position")
    rec["x"] = round(float(rec["x"]), 5)
    rec["y"] = round(float(rec["y"]), 5)
    return ident, rec


def create_blueprint(
    *,
    map_path: Path = MAP_FILE,
    overlays_path: Path = OVERLAYS_FILE,
    load_positions: Callable[[], dict] | None = None,
    save_positions: Callable[[dict], None] | None = None,
) -> Blueprint:
    bp = Blueprint("appliances", __name__)

    def _positions() -> dict:
        try:
            got = load_positions() if load_positions else {}
        except Exception as exc:  # pragma: no cover - configuración ilegible
            log.warning("Could not read appliance positions: %s", type(exc).__name__)
            got = {}
        return got if isinstance(got, dict) else {}

    def _overlays() -> dict:
        with open(overlays_path, encoding="utf-8") as f:
            return json.load(f)

    @bp.route("/api/appliances/map", methods=["GET"])
    def appliances_map():
        return jsonify(merge_positions(load_map(map_path), _positions(), _overlays()))

    @bp.route("/api/appliances/positions", methods=["PUT"])
    def appliances_positions():
        if save_positions is None:
            return jsonify({"ok": False, "error": "Positions cannot be saved"}), 501
        try:
            ident, rec = validate_position(load_map(map_path), _overlays(), request.get_json(silent=True) or {})
        except ValueError as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400
        positions = dict(_positions())
        positions[ident] = rec
        save_positions(positions)
        log.info("appliance position %s -> %s", ident, rec["floor"])
        return jsonify({"ok": True, "id": ident, **rec})

    return bp
