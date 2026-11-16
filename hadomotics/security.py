"""HADomotics — Seguridad (alarma Alarmo, zonas, sirena y presencia en los planos).

Cliente fino de Home Assistant, mismo patrón que Energía:
- GET  /seguridad              panel (el mismo index, abre la sub-app Seguridad)
- GET  /api/security/map       entidades de la vista (security_map.json)
- GET  /api/security/state     estados solo de esas entidades
- POST /api/security/alarm     armar/desarmar la alarma del mapa (solo admin;
                               dentro de HA el panel usa hass.callService como
                               el usuario). El código de Alarmo se reenvía tal
                               cual y nunca se guarda ni se registra.
- GET  /api/plan/overlays      capa de dibujo de los planos (plan_overlays.json)
"""

from __future__ import annotations

import copy
import json
import logging
import math
from pathlib import Path
from typing import Callable

from flask import Blueprint, jsonify, request, send_from_directory

log = logging.getLogger("hadomotics.security")

MAP_FILE = Path(__file__).resolve().parent / "security_map.json"
OVERLAYS_FILE = Path(__file__).resolve().parent / "plan_overlays.json"

# Servicio de Alarmo -> bit de supported_features que lo habilita
# (AlarmControlPanelEntityFeature: ARM_HOME=1, ARM_AWAY=2, ARM_NIGHT=4,
# TRIGGER=8, ARM_CUSTOM_BYPASS=16, ARM_VACATION=32).
ARM_SERVICES = {
    "alarm_arm_home": 1,
    "alarm_arm_away": 2,
    "alarm_arm_night": 4,
    "alarm_arm_vacation": 32,
    "alarm_arm_custom_bypass": 16,
}
ALARM_SERVICES = frozenset(set(ARM_SERVICES) | {"alarm_disarm"})


def load_map(path: Path = MAP_FILE) -> dict:
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def load_overlays(path: Path = OVERLAYS_FILE) -> dict:
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def mapped_entities(security_map: dict) -> list[str]:
    out: list[str] = []

    def add(eid):
        if isinstance(eid, str) and eid and eid not in out:
            out.append(eid)

    add((security_map.get("alarm") or {}).get("entity"))
    for z in security_map.get("zones") or []:
        add(z.get("entity"))
    siren = security_map.get("siren") or {}
    add(siren.get("entity"))
    for x in siren.get("extra") or []:
        add(x.get("entity"))
    for p in security_map.get("presence") or []:
        add(p.get("entity"))
    return out


def overlay_entities(overlays: dict) -> list[str]:
    out: list[str] = []
    for f in overlays.get("floors") or []:
        cable = f.get("evse_cable") or {}
        for k in ("power_entity", "state_entity"):
            eid = cable.get(k)
            if isinstance(eid, str) and eid and eid not in out:
                out.append(eid)
    return out


def code_required(service: str, attrs: dict) -> bool:
    """¿Pide código esta acción? Alarmo: code_format no nulo; al armar, además code_arm_required."""
    if not attrs.get("code_format"):
        return False
    if service == "alarm_disarm":
        return True
    return attrs.get("code_arm_required", True) is not False


def validate_alarm(security_map: dict, body: dict, current_state: dict | None):
    """Devuelve (domain, service, payload) o lanza ValueError."""
    alarm = (security_map.get("alarm") or {}).get("entity")
    entity_id = str(body.get("entity_id") or "")
    service = str(body.get("service") or "")
    if not alarm or entity_id != alarm:
        raise ValueError("entidad de alarma no permitida")
    if service.startswith("alarm_control_panel."):
        service = service.split(".", 1)[1]
    if service not in ALARM_SERVICES:
        raise ValueError(f"servicio {service or '(vacío)'} no permitido")
    if current_state is None:
        raise ValueError("estado de la alarma no disponible")
    attrs = current_state.get("attributes") or {}
    bit = ARM_SERVICES.get(service)
    if bit is not None:
        try:
            feats = int(attrs.get("supported_features") or 0)
        except (TypeError, ValueError):
            feats = 0
        if not feats & bit:
            raise ValueError(f"{service} no está disponible en {entity_id}")
    payload = {"entity_id": entity_id}
    code = body.get("code")
    if code_required(service, attrs):
        if not isinstance(code, str) or not code:
            raise ValueError("esta acción requiere el código de la alarma")
        payload["code"] = code
    elif isinstance(code, str) and code:
        payload["code"] = code
    return "alarm_control_panel", service, payload


# Posiciones de los marcadores de presencia movidos en modo edición.
# Se guardan en la configuración del add-on (/data), no en el repositorio:
#   {"<entity_id>": {"floor": "planta_baja", "x": 0.21, "y": 0.37, "outside": false}}
# x, y son fracciones de la imagen del plano (como en security_map.json). Se
# admiten valores fuera de [0, 1] para colocar un marcador fuera del dibujo.
POSITION_MIN = -1.0
POSITION_MAX = 2.0


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


def merge_positions(security_map: dict, positions: dict | None, overlays: dict | None = None) -> dict:
    """Mapa con las posiciones guardadas aplicadas. Sin posiciones, el mapa
    del repositorio tal cual (las posiciones de siempre son el valor por defecto)."""
    merged = copy.deepcopy(security_map)
    if not isinstance(positions, dict) or not positions:
        return merged
    keys = _floor_keys(overlays) if overlays is not None else {p.get("floor") for p in merged.get("presence", [])}
    for p in merged.get("presence", []):
        rec = positions.get(p.get("entity"))
        if not _valid_record(rec, keys):
            continue
        p["floor"] = rec["floor"]
        p["position"] = [round(float(rec["x"]), 5), round(float(rec["y"]), 5)]
        p["outside"] = bool(rec.get("outside"))
        p["custom"] = True
    return merged


def validate_position(security_map: dict, overlays: dict, body: dict) -> tuple[str, dict]:
    """Valida una posición nueva de un marcador. Devuelve (entity_id, registro)."""
    entity = str((body or {}).get("entity_id") or "")
    if entity not in {p.get("entity") for p in security_map.get("presence", [])}:
        raise ValueError("Unknown presence entity")
    rec = {
        "floor": (body or {}).get("floor"),
        "x": (body or {}).get("x"),
        "y": (body or {}).get("y"),
    }
    if not _valid_record(rec, _floor_keys(overlays)):
        raise ValueError("Invalid floor or position")
    rec["x"] = round(float(rec["x"]), 5)
    rec["y"] = round(float(rec["y"]), 5)
    rec["outside"] = bool((body or {}).get("outside"))
    return entity, rec


def create_blueprint(
    *,
    static_dir: Path,
    get_state: Callable[[str], dict | None],
    get_all_states: Callable[[], list],
    is_ws_connected: Callable[[], bool],
    invoke_service: Callable[[str, str, dict], tuple],
    map_path: Path = MAP_FILE,
    overlays_path: Path = OVERLAYS_FILE,
    load_positions: Callable[[], dict] | None = None,
    save_positions: Callable[[dict], None] | None = None,
) -> Blueprint:
    bp = Blueprint("security", __name__)

    def _map() -> dict:
        return load_map(map_path)

    def _positions() -> dict:
        try:
            got = load_positions() if load_positions else {}
        except Exception as exc:  # pragma: no cover - configuración ilegible
            log.warning("Could not read security positions: %s", type(exc).__name__)
            got = {}
        return got if isinstance(got, dict) else {}

    @bp.route("/seguridad")
    def seguridad_page():
        return send_from_directory(str(static_dir), "index.html")

    @bp.route("/api/security/map", methods=["GET"])
    def security_map():
        return jsonify(merge_positions(_map(), _positions(), load_overlays(overlays_path)))

    @bp.route("/api/security/positions", methods=["PUT"])
    def security_positions():
        """Guarda la posición de un marcador (solo administradores: la puerta
        de autenticación del add-on no deja escribir a nadie más)."""
        if save_positions is None:
            return jsonify({"ok": False, "error": "Positions cannot be saved"}), 501
        try:
            entity, rec = validate_position(_map(), load_overlays(overlays_path), request.get_json(silent=True) or {})
        except ValueError as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400
        positions = dict(_positions())
        positions[entity] = rec
        save_positions(positions)
        log.info("security position %s -> %s (outside=%s)", entity, rec["floor"], rec["outside"])
        return jsonify({"ok": True, "entity_id": entity, **rec})

    @bp.route("/api/plan/overlays", methods=["GET"])
    def plan_overlays():
        return jsonify(load_overlays(overlays_path))

    @bp.route("/api/security/state", methods=["GET"])
    def security_state():
        wanted = set(mapped_entities(_map())) | set(overlay_entities(load_overlays(overlays_path)))
        states = [s for s in (get_all_states() or []) if isinstance(s, dict) and s.get("entity_id") in wanted]
        have = {s["entity_id"] for s in states}
        for eid in sorted(wanted - have):
            one = get_state(eid)
            if isinstance(one, dict) and one.get("entity_id") == eid:
                states.append(one)
        return jsonify({"ha_ws": bool(is_ws_connected()), "states": states})

    @bp.route("/api/security/alarm", methods=["POST"])
    def security_alarm():
        body = request.get_json(silent=True) or {}
        m = _map()
        try:
            domain, service, payload = validate_alarm(
                m, body, get_state(str(body.get("entity_id") or ""))
            )
        except ValueError as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400
        status, result = invoke_service(domain, service, payload)
        # Nunca registrar el código.
        log.info("security alarm %s.%s %s -> HTTP %s", domain, service, payload.get("entity_id"), status)
        if status != 200:
            err = result.get("error") if isinstance(result, dict) else "Could not call Home Assistant service"
            return jsonify({"ok": False, "error": err}), status
        return jsonify({"ok": True, "service": f"{domain}.{service}"})

    return bp
