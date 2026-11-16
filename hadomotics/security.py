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

import json
import logging
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


def create_blueprint(
    *,
    static_dir: Path,
    get_state: Callable[[str], dict | None],
    get_all_states: Callable[[], list],
    is_ws_connected: Callable[[], bool],
    invoke_service: Callable[[str, str, dict], tuple],
    map_path: Path = MAP_FILE,
    overlays_path: Path = OVERLAYS_FILE,
) -> Blueprint:
    bp = Blueprint("security", __name__)

    def _map() -> dict:
        return load_map(map_path)

    @bp.route("/seguridad")
    def seguridad_page():
        return send_from_directory(str(static_dir), "index.html")

    @bp.route("/api/security/map", methods=["GET"])
    def security_map():
        return jsonify(_map())

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
