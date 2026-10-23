"""HADomotics — Energía (Carga, Solar/Inversor, Batería y flujo).

Cliente fino de Home Assistant: este módulo no guarda ni calcula históricos.
- GET  /energia            panel (el mismo index, abre la sub-app Energía)
- GET  /api/energy/map     mapa de pantallas y entidades
- GET  /api/energy/state   estados solo de las entidades del mapa
- GET  /api/energy/flow    instantánea del flujo (W, kWh, autarquía, dirección)
- POST /api/energy/control control deliberado del mapa, con dry_run

Las llamadas reales las hace el servidor con el token de la petición
(get_ha_token / token del usuario), nunca con un HA_TOKEN capturado al importar.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Callable

from flask import Blueprint, jsonify, request, send_from_directory

log = logging.getLogger("hadomotics.energy")

MAP_FILE = Path(__file__).resolve().parent / "energy_map.json"

# Servicios permitidos por tipo de control (dominio.servicio).
_ALLOWED = {
    "toggle": {
        "input_boolean.turn_on",
        "input_boolean.turn_off",
        "automation.turn_on",
        "automation.turn_off",
    },
    "number": {"input_number.set_value"},
    "select": {"input_select.select_option"},
}

_KW_UNITS = {"kw", "kilowatt", "kilowatts"}
_W_UNITS = {"w", "watt", "watts"}
FLOW_DEADBAND_W = 1.0
# Grid CT values without a unit, at or under this, are kW (the Lovelace card
# auto-converts sensor.inverter_external_consumption, whose unit is kW).
_GRID_BARE_KW_MAX = 100.0


def load_map(path: Path = MAP_FILE) -> dict:
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def _walk_items(energy_map: dict):
    for sc in energy_map.get("screens", []):
        for se in sc.get("sections", []):
            for it in se.get("items", []):
                yield it


def mapped_entities(energy_map: dict) -> list[str]:
    out: list[str] = []
    for it in _walk_items(energy_map):
        if it.get("entity") and it["entity"] not in out:
            out.append(it["entity"])
    for eid in flow_entity_ids(energy_map):
        if eid not in out:
            out.append(eid)
    return out


def flow_entity_ids(energy_map: dict) -> list[str]:
    ents = (energy_map.get("flow") or {}).get("entities") or {}
    out: list[str] = []
    for eid in ents.values():
        if isinstance(eid, str) and eid not in out:
            out.append(eid)
    return out


def controls(energy_map: dict) -> dict[str, str]:
    """entity_id -> tipo de control, solo para los controles deliberados."""
    out: dict[str, str] = {}
    for it in _walk_items(energy_map):
        if it.get("control") in _ALLOWED and it.get("entity"):
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
    if "." not in entity_id or service_full not in _ALLOWED[ctl] or service_full.split(".")[0] != entity_id.split(".")[0]:
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
        if (lo is not None and value < float(lo)) or (hi is not None and value > float(hi)):
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


def _unit(state: dict | None) -> str:
    if not state:
        return ""
    attrs = state.get("attributes") or {}
    raw = attrs.get("unit_of_measurement") or state.get("unit_of_measurement") or ""
    return str(raw).strip().lower()


def state_number(state: dict | None) -> float | None:
    if not state:
        return None
    raw = state.get("state")
    if raw is None or raw in ("", "unknown", "unavailable", "none", "None"):
        return None
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return None
    if value != value:  # NaN
        return None
    return value


def power_watts(state: dict | None, *, kw_if_small: bool = False) -> float | None:
    """Watts from a Home Assistant power state.

    ``kW`` is multiplied by 1000. ``sensor.inverter_external_consumption`` is
    published in kW; pass ``kw_if_small`` so a bare small reading (no unit)
    is treated as kW the same way the sunsynk card auto-converts that sensor.
    """
    value = state_number(state)
    if value is None:
        return None
    unit = _unit(state)
    if unit in _KW_UNITS:
        return value * 1000.0
    if unit in _W_UNITS or unit == "":
        if kw_if_small and unit == "" and abs(value) <= _GRID_BARE_KW_MAX:
            return value * 1000.0
        return value
    if unit in {"mw"}:
        return value * 1_000_000.0
    return value


def energy_kwh(state: dict | None) -> float | None:
    value = state_number(state)
    if value is None:
        return None
    unit = _unit(state)
    if unit == "wh":
        return value / 1000.0
    if unit == "mwh":
        return value * 1000.0
    return value


def autarky_percent(load_kwh: float | None, import_kwh: float | None) -> float | None:
    """Daily self-sufficiency, the sunsynk ``autarky: energy`` figure.

    (consumo diario − importación diaria) / consumo diario, clamped to 0–100.
    """
    if load_kwh is None or import_kwh is None or load_kwh <= 0:
        return None
    pct = (load_kwh - import_kwh) / load_kwh * 100.0
    return max(0.0, min(100.0, pct))


def house_watts(inverter_w: float | None, aux_w: float | None) -> float | None:
    """Casa, derived like the card: inverter L1 output minus the AUX car.

    The Lovelace card does not configure an essential-power entity. If the
    car power is unavailable, the house figure is the inverter output rather
    than a subtraction of a missing number.
    """
    if inverter_w is None:
        return None
    if aux_w is None:
        return inverter_w
    return max(0.0, inverter_w - aux_w)


def _text_state(state: dict | None) -> str | None:
    if not state:
        return None
    raw = state.get("state")
    if raw is None or raw in ("", "unknown", "unavailable", "none", "None"):
        return None
    return str(raw)


def _bool_state(state: dict | None) -> bool | None:
    raw = _text_state(state)
    if raw is None:
        return None
    if raw in ("on", "true", "True", "home"):
        return True
    if raw in ("off", "false", "False"):
        return False
    return None


def build_flow(states: dict, energy_map: dict | None = None) -> dict:
    """Live power-flow snapshot. Missing or unavailable inputs stay None."""
    m = energy_map or load_map()
    flow = m.get("flow") or {}
    ents = flow.get("entities") or {}
    try:
        capacity = float(flow.get("battery_capacity_wh") or 7600)
    except (TypeError, ValueError):
        capacity = 7600.0

    def st(key: str):
        eid = ents.get(key)
        if not eid:
            return None
        return states.get(eid)

    solar = power_watts(st("pv_power"))
    pvs = []
    for i in (1, 2, 3):
        pvs.append({
            "power_w": power_watts(st(f"pv{i}_power")),
            "voltage_v": state_number(st(f"pv{i}_voltage")),
            "current_a": state_number(st(f"pv{i}_current")),
        })
    battery_w = power_watts(st("battery_power"))
    battery_soc = state_number(st("battery_soc"))
    grid_w = power_watts(st("grid_power"), kw_if_small=True)
    inverter_w = power_watts(st("inverter_power"))
    aux_w = power_watts(st("aux_power"))
    load_kwh = energy_kwh(st("load_daily"))
    import_kwh = energy_kwh(st("grid_import_daily"))
    grid_connected = _bool_state(st("grid_connected"))
    directions = _directions(solar, battery_w, grid_w, inverter_w, aux_w, grid_connected)
    remaining = None if battery_soc is None else max(0.0, battery_soc) / 100.0 * capacity
    return {
        "solar_w": solar,
        "pv": pvs,
        "solar_daily_kwh": energy_kwh(st("pv_daily")),
        "battery_w": battery_w,
        "battery_soc": battery_soc,
        "battery_state": _text_state(st("battery_state")),
        "battery_voltage_v": state_number(st("battery_voltage")),
        "battery_current_a": state_number(st("battery_current")),
        "battery_temp_c": state_number(st("battery_temp")),
        "battery_daily_charge_kwh": energy_kwh(st("battery_charge_daily")),
        "battery_daily_discharge_kwh": energy_kwh(st("battery_discharge_daily")),
        "battery_remaining_wh": remaining,
        "battery_capacity_wh": capacity,
        "grid_w": grid_w,
        "grid_connected": grid_connected,
        "grid_daily_import_kwh": import_kwh,
        "grid_daily_export_kwh": energy_kwh(st("grid_export_daily")),
        "inverter_w": inverter_w,
        "inverter_v": state_number(st("inverter_voltage")),
        "inverter_hz": state_number(st("inverter_frequency")),
        "inverter_temp_c": state_number(st("inverter_temp")),
        "inverter_dc_temp_c": state_number(st("inverter_dc_temp")),
        "inverter_state": _text_state(st("inverter_state")),
        "inverter_program": _text_state(st("inverter_program")),
        "inverter_pattern": _text_state(st("inverter_pattern")),
        "aux_w": aux_w,
        "aux_connected": _bool_state(st("aux_connected")),
        "aux_daily_kwh": energy_kwh(st("aux_daily")),
        "house_w": house_watts(inverter_w, aux_w),
        "load_daily_kwh": load_kwh,
        "autarky_pct": autarky_percent(load_kwh, import_kwh),
        "directions": directions,
        "colours": dict(flow.get("colours") or {}),
    }


def _directions(solar, battery_w, grid_w, inverter_w, aux_w, grid_connected) -> dict:
    house = house_watts(inverter_w, aux_w)
    if grid_connected is False:
        grid_dir = "idle"
    elif grid_w is None:
        grid_dir = "idle"
    elif grid_w > FLOW_DEADBAND_W:
        grid_dir = "import"
    elif grid_w < -FLOW_DEADBAND_W:
        grid_dir = "export"
    else:
        grid_dir = "idle"
    if battery_w is None:
        battery_dir = "idle"
    elif battery_w > FLOW_DEADBAND_W:
        battery_dir = "discharge"
    elif battery_w < -FLOW_DEADBAND_W:
        battery_dir = "charge"
    else:
        battery_dir = "idle"
    return {
        "solar_to_inverter": bool(solar is not None and solar > FLOW_DEADBAND_W),
        "battery": battery_dir,
        "grid": grid_dir,
        "inverter_to_house": bool(house is not None and house > FLOW_DEADBAND_W),
        "inverter_to_aux": bool(aux_w is not None and aux_w > FLOW_DEADBAND_W),
    }


def create_blueprint(
    *,
    static_dir: Path,
    get_state: Callable[[str], dict | None],
    get_all_states: Callable[[], list],
    is_ws_connected: Callable[[], bool],
    invoke_service: Callable[[str, str, dict], tuple],
    map_path: Path = MAP_FILE,
) -> Blueprint:
    bp = Blueprint("energy", __name__)

    def _map() -> dict:
        return load_map(map_path)

    def _states_index() -> dict:
        indexed = {}
        for item in get_all_states() or []:
            if isinstance(item, dict) and item.get("entity_id"):
                indexed[item["entity_id"]] = item
        return indexed

    @bp.route("/energia")
    def energia_page():
        return send_from_directory(str(static_dir), "index.html")

    @bp.route("/api/energy/map", methods=["GET"])
    def energy_map():
        return jsonify(_map())

    @bp.route("/api/energy/state", methods=["GET"])
    def energy_state():
        wanted = set(mapped_entities(_map()))
        states = [s for s in (get_all_states() or []) if isinstance(s, dict) and s.get("entity_id") in wanted]
        have = {s["entity_id"] for s in states}
        for eid in wanted - have:
            one = get_state(eid)
            if isinstance(one, dict) and one.get("entity_id") == eid:
                states.append(one)
        return jsonify({"ha_ws": bool(is_ws_connected()), "states": states})

    @bp.route("/api/energy/flow", methods=["GET"])
    def energy_flow():
        m = _map()
        indexed = _states_index()
        for eid in flow_entity_ids(m):
            if eid not in indexed:
                one = get_state(eid)
                if isinstance(one, dict):
                    indexed[eid] = one
        return jsonify(build_flow(indexed, m))

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
        status, result = invoke_service(domain, service, payload)
        if status != 200:
            err = result.get("error") if isinstance(result, dict) else "Could not call Home Assistant service"
            body_out = {"ok": False, "error": err}
            return jsonify(body_out), status
        log.info("energy control %s -> HTTP %s", would_call, status)
        return jsonify({"ok": True, "called": would_call})

    return bp
