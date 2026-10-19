"""HADomotics — Energía (Carga Tesla, Solar/Inversor, Batería).

Cliente fino de Home Assistant: este módulo NO guarda ni calcula datos sincronizados.
- GET  /energia               -> panel (ingress) con las pantallas Coche/Carga, Solar/Inversor, Batería.
- GET  /api/energy/map        -> mapa de pantallas/entidades (energy_map.json).
- GET  /api/energy/state      -> estados actuales (de la caché websocket del add-on) solo de las entidades del mapa.
- POST /api/energy/control    -> llama un servicio SOLO para los controles deliberados del mapa,
                                 validando servicio, rango (min/max de HA) y opciones. Admite dry_run.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Callable

import requests
from flask import Blueprint, jsonify, request, send_from_directory

log = logging.getLogger("hadomotics.energy")

MAP_FILE = Path(__file__).resolve().parent / "energy_map.json"

# Servicios permitidos por tipo de control (dominio.servicio).
_ALLOWED = {
    "toggle": {"input_boolean.turn_on", "input_boolean.turn_off"},
    "number": {"input_number.set_value"},
    "select": {"input_select.select_option"},
}


def load_map(path: Path = MAP_FILE) -> dict:
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def mapped_entities(energy_map: dict) -> list[str]:
    out: list[str] = []
    for sc in energy_map.get("screens", []):
        for se in sc.get("sections", []):
            for it in se.get("items", []):
                if it.get("entity") and it["entity"] not in out:
                    out.append(it["entity"])
    return out


def controls(energy_map: dict) -> dict[str, str]:
    """entity_id -> tipo de control, solo para los controles deliberados."""
    out: dict[str, str] = {}
    for sc in energy_map.get("screens", []):
        for se in sc.get("sections", []):
            for it in se.get("items", []):
                if it.get("control") in _ALLOWED:
                    out[it["entity"]] = it["control"]
    return out


def validate_control(energy_map: dict, body: dict, current_state: dict | None):
    """Devuelve (domain, service, service_data) o lanza ValueError con el motivo."""
    entity_id = str(body.get("entity_id") or "")
    service_full = str(body.get("service") or "")
    data = body.get("data") or {}
    if not isinstance(data, dict):
        raise ValueError("data debe ser un objeto")
    ctl = controls(energy_map).get(entity_id)
    if not ctl:
        raise ValueError(f"{entity_id or '(vacío)'} no es un control editable")
    if service_full not in _ALLOWED[ctl] or service_full.split(".")[0] != entity_id.split(".")[0]:
        raise ValueError(f"servicio {service_full} no permitido para {entity_id}")
    domain, service = service_full.split(".", 1)
    attrs = (current_state or {}).get("attributes") or {}

    if ctl == "toggle":
        if data:
            raise ValueError("turn_on/turn_off no admite datos")
        return domain, service, {}

    if ctl == "number":
        if set(data) != {"value"}:
            raise ValueError("set_value requiere solo 'value'")
        try:
            value = float(data["value"])
        except (TypeError, ValueError):
            raise ValueError("value no es numérico")
        if current_state is None:
            raise ValueError("estado actual no disponible: no se puede validar el rango")
        lo, hi = attrs.get("min"), attrs.get("max")
        if lo is not None and value < float(lo) or hi is not None and value > float(hi):
            raise ValueError(f"value fuera de rango [{lo}, {hi}]")
        return domain, service, {"value": value}

    if ctl == "select":
        if set(data) != {"option"}:
            raise ValueError("select_option requiere solo 'option'")
        if current_state is None:
            raise ValueError("estado actual no disponible: no se pueden validar las opciones")
        if data["option"] not in (attrs.get("options") or []):
            raise ValueError(f"opción no válida: {data['option']}")
        return domain, service, {"option": data["option"]}

    raise ValueError("tipo de control desconocido")


def create_blueprint(
    *,
    static_dir: Path,
    get_state: Callable[[str], dict | None],
    get_all_states: Callable[[], list],
    is_ws_connected: Callable[[], bool],
    ha_base_url: Callable[[], str],
    ha_headers: Callable[[], dict],
    has_token: Callable[[], bool],
    map_path: Path = MAP_FILE,
) -> Blueprint:
    bp = Blueprint("energy", __name__)

    def _map() -> dict:
        return load_map(map_path)

    @bp.route("/energia")
    def energia_page():
        return send_from_directory(str(static_dir), "energia.html")

    @bp.route("/api/energy/map", methods=["GET"])
    def energy_map():
        return jsonify(_map())

    @bp.route("/api/energy/state", methods=["GET"])
    def energy_state():
        wanted = set(mapped_entities(_map()))
        states = [s for s in get_all_states() if s.get("entity_id") in wanted]
        return jsonify({"ha_ws": bool(is_ws_connected()), "states": states})

    @bp.route("/api/energy/control", methods=["POST"])
    def energy_control():
        body = request.get_json(silent=True) or {}
        dry_run = bool(body.get("dry_run"))
        try:
            domain, service, service_data = validate_control(
                _map(), body, get_state(str(body.get("entity_id") or ""))
            )
        except ValueError as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400
        payload = dict(service_data, entity_id=body["entity_id"])
        would_call = {"service": f"{domain}.{service}", "data": payload}
        if dry_run:
            log.info("energy control DRY-RUN %s", would_call)
            return jsonify({"ok": True, "dry_run": True, "would_call": would_call})
        if not has_token():
            return jsonify({"ok": False, "error": "No supervisor token"}), 503
        try:
            resp = requests.post(
                f"{ha_base_url()}/services/{domain}/{service}",
                headers=ha_headers(),
                json=payload,
                timeout=10,
            )
        except Exception as exc:  # pragma: no cover - red
            log.warning("energy control %s failed: %s", would_call, exc)
            return jsonify({"ok": False, "error": "Could not call Home Assistant service"}), 503
        log.info("energy control %s -> HTTP %s", would_call, resp.status_code)
        if resp.status_code >= 400:
            return jsonify({"ok": False, "error": f"HA HTTP {resp.status_code}"}), 502
        return jsonify({"ok": True, "called": would_call})

    return bp
