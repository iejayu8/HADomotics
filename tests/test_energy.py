"""Tests del módulo Energía (Carga / Solar / Batería / flujo)."""

import json
import os
import sys
import tempfile

import pytest

os.environ.setdefault("DATA_DIR", tempfile.mkdtemp(prefix="hadomotics_energy_test_"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "hadomotics"))

import energy  # noqa: E402

STATES = {
    "input_boolean.carga_instantanea_tesla": {"entity_id": "input_boolean.carga_instantanea_tesla", "state": "off", "attributes": {}},
    "input_number.carga_umbral_solar_kwh": {"entity_id": "input_number.carga_umbral_solar_kwh", "state": "15.0",
                                            "attributes": {"min": 0, "max": 60, "step": 0.5}},
    "input_select.carga_dia_lunes": {"entity_id": "input_select.carga_dia_lunes", "state": "fuera",
                                     "attributes": {"options": ["casa", "fuera"]}},
    "sensor.carga_decision_noche": {"entity_id": "sensor.carga_decision_noche", "state": "cargar_noche", "attributes": {}},
    "number.evse_charging_power_limit": {"entity_id": "number.evse_charging_power_limit", "state": "0",
                                         "attributes": {"min": 0, "max": 22000}},
    "sensor.no_mapeado": {"entity_id": "sensor.no_mapeado", "state": "1", "attributes": {}},
}


def _state(entity_id, value, unit=None, **attrs):
    attributes = dict(attrs)
    if unit:
        attributes["unit_of_measurement"] = unit
    return {"entity_id": entity_id, "state": value, "attributes": attributes}


@pytest.fixture()
def calls():
    return []


@pytest.fixture()
def client(calls):
    from flask import Flask
    from pathlib import Path

    def invoke(domain, service, payload):
        calls.append((domain, service, payload))
        return 200, {"ok": True}

    app = Flask(__name__)
    app.register_blueprint(energy.create_blueprint(
        static_dir=Path(__file__).resolve().parents[1] / "hadomotics" / "static",
        get_state=lambda e: STATES.get(e),
        get_all_states=lambda: list(STATES.values()),
        is_ws_connected=lambda: True,
        invoke_service=invoke,
    ))
    app.config["TESTING"] = True
    with app.test_client() as c:
        yield c


def test_map_entities_and_controls():
    m = energy.load_map()
    ents = energy.mapped_entities(m)
    assert "sensor.batmovil_state_of_charge" in ents
    assert "sensor.helios_forecast_energy_day_2" in ents
    assert "sensor.inverter_battery" in ents
    assert "sensor.inverter_external_consumption" in ents
    assert "sensor.inverter_output_l1_power" in ents
    ctl = energy.controls(m)
    assert all(e.split(".")[0] in ("input_boolean", "input_number", "input_select", "automation") for e in ctl)
    assert {e for e in ctl if e.startswith("automation.")} == {
        "automation.carga_coche_dinamica_por_excedente",
        "automation.carga_coche_programa_nocturno",
        "automation.carga_coche_toda_la_noche",
    }
    assert "number.evse_charging_power_limit" not in ctl
    assert not any(e.startswith(("number.inverter", "switch.inverter", "select.inverter")) for e in ctl)
    for legacy in ("input_number.carga_soc_manual", "input_number.carga_capacidad_kwh", "sensor.carga_forecast_proximo_casa"):
        assert legacy not in ents


def test_energia_page(client):
    r = client.get("/energia")
    assert r.status_code == 200
    assert b"static/energia/js/energy.js" in r.data
    assert "Dispositivos".encode() in r.data
    assert "Energía".encode() in r.data


def test_dry_run_default_in_client():
    text = open(os.path.join(os.path.dirname(__file__), "..", "hadomotics", "static", "energia", "js", "energy.js"), encoding="utf-8").read()
    assert 'hadomotics.energy.dryrun' in text
    assert 'localStorage.getItem(LS.dry) !== "0"' in text


def test_energy_panel_ui_node():
    import subprocess
    script = os.path.join(os.path.dirname(__file__), "energy_panel.test.js")
    proc = subprocess.run(["node", "--test", script], capture_output=True, text=True)
    assert proc.returncode == 0, proc.stdout + "\n" + proc.stderr


def test_map_endpoint(client):
    r = client.get("/api/energy/map")
    assert r.status_code == 200
    assert {s["id"] for s in r.get_json()["screens"]} == {"coche", "solar", "bateria"}


def test_state_only_mapped(client):
    j = client.get("/api/energy/state").get_json()
    ids = {s["entity_id"] for s in j["states"]}
    assert j["ha_ws"] is True
    assert "sensor.carga_decision_noche" in ids
    assert "sensor.no_mapeado" not in ids


@pytest.mark.parametrize("body", [
    {"entity_id": "number.evse_charging_power_limit", "service": "number.set_value", "data": {"value": 5000}},
    {"entity_id": "sensor.carga_decision_noche", "service": "input_boolean.turn_on"},
    {"entity_id": "input_boolean.carga_instantanea_tesla", "service": "homeassistant.restart"},
    {"entity_id": "input_boolean.carga_instantanea_tesla", "service": "input_number.set_value", "data": {"value": 1}},
    {"entity_id": "input_number.carga_umbral_solar_kwh", "service": "input_number.set_value", "data": {"value": 999}},
    {"entity_id": "input_number.carga_umbral_solar_kwh", "service": "input_number.set_value", "data": {"value": "x"}},
    {"entity_id": "input_select.carga_dia_lunes", "service": "input_select.select_option", "data": {"option": "oficina"}},
    {"entity_id": "input_boolean.carga_instantanea_tesla", "service": "input_boolean.turn_on", "data": {"x": 1}},
    {"entity_id": "automation.carga_instantanea_tesla_override", "service": "automation.turn_off"},
    {"entity_id": "automation.carga_coche_programa_nocturno", "service": "input_boolean.turn_off"},
])
def test_control_rejected(client, calls, body):
    r = client.post("/api/energy/control", json=body)
    assert r.status_code == 400
    assert calls == []


def test_control_dry_run_does_not_call(client, calls):
    r = client.post("/api/energy/control", json={
        "entity_id": "input_number.carga_umbral_solar_kwh", "service": "input_number.set_value",
        "data": {"value": 18}, "dry_run": True})
    assert r.status_code == 200
    j = r.get_json()
    assert j["dry_run"] is True
    assert j["would_call"] == {"service": "input_number.set_value",
                               "data": {"value": 18.0, "entity_id": "input_number.carga_umbral_solar_kwh"}}
    assert calls == []


@pytest.mark.parametrize("body,domain,service,payload", [
    ({"entity_id": "input_boolean.carga_instantanea_tesla", "service": "input_boolean.turn_on"},
     "input_boolean", "turn_on", {"entity_id": "input_boolean.carga_instantanea_tesla"}),
    ({"entity_id": "automation.carga_coche_programa_nocturno", "service": "automation.turn_off"},
     "automation", "turn_off", {"entity_id": "automation.carga_coche_programa_nocturno"}),
    ({"entity_id": "input_select.carga_dia_lunes", "service": "input_select.select_option", "data": {"option": "casa"}},
     "input_select", "select_option", {"option": "casa", "entity_id": "input_select.carga_dia_lunes"}),
])
def test_control_calls_ha(client, calls, body, domain, service, payload):
    r = client.post("/api/energy/control", json=body)
    assert r.status_code == 200, r.get_json()
    assert calls == [(domain, service, payload)]


def test_grid_kw_converts_to_watts_and_keeps_sign():
    assert energy.power_watts(_state("sensor.inverter_external_consumption", "0.02", "kW")) == pytest.approx(20.0)
    assert energy.power_watts(_state("sensor.inverter_external_consumption", "-1.5", "kW")) == pytest.approx(-1500.0)
    assert energy.power_watts(_state("sensor.inverter_output_l1_power", "1012", "W")) == pytest.approx(1012.0)
    assert energy.power_watts(_state("sensor.inverter_external_consumption", "0.02"), kw_if_small=True) == pytest.approx(20.0)
    assert energy.power_watts(_state("sensor.inverter_pv_power", "unavailable", "W")) is None
    assert energy.power_watts(_state("sensor.inverter_pv_power", "unknown", "W")) is None
    assert energy.power_watts(None) is None


def test_autarky_and_house_from_capture():
    # Casa view snapshot: load 15.9 kWh, import 6.9 kWh, inverter 1012 W, EV 0 W.
    assert energy.autarky_percent(15.9, 6.9) == pytest.approx((15.9 - 6.9) / 15.9 * 100.0)
    assert energy.autarky_percent(0, 1) is None
    assert energy.autarky_percent(None, 1) is None
    assert energy.house_watts(1012, 0) == 1012
    assert energy.house_watts(2500, 1800) == 700
    assert energy.house_watts(100, 500) == 0
    assert energy.house_watts(None, 10) is None
    assert energy.house_watts(1000, None) == 1000


def test_build_flow_night_snapshot():
    m = energy.load_map()
    ents = m["flow"]["entities"]
    states = {
        ents["pv_power"]: _state(ents["pv_power"], "0", "W"),
        ents["pv1_power"]: _state(ents["pv1_power"], "0", "W"),
        ents["pv2_power"]: _state(ents["pv2_power"], "0", "W"),
        ents["pv3_power"]: _state(ents["pv3_power"], "0", "W"),
        ents["pv_daily"]: _state(ents["pv_daily"], "23.1", "kWh"),
        ents["battery_soc"]: _state(ents["battery_soc"], "76", "%"),
        ents["battery_power"]: _state(ents["battery_power"], "1022", "W"),
        ents["battery_state"]: _state(ents["battery_state"], "discharging"),
        ents["battery_charge_daily"]: _state(ents["battery_charge_daily"], "11.3", "kWh"),
        ents["battery_discharge_daily"]: _state(ents["battery_discharge_daily"], "4.3", "kWh"),
        ents["grid_power"]: _state(ents["grid_power"], "0.02", "kW"),
        ents["grid_connected"]: _state(ents["grid_connected"], "on"),
        ents["grid_import_daily"]: _state(ents["grid_import_daily"], "6.9", "kWh"),
        ents["grid_export_daily"]: _state(ents["grid_export_daily"], "6", "kWh"),
        ents["inverter_power"]: _state(ents["inverter_power"], "1012", "W"),
        ents["inverter_voltage"]: _state(ents["inverter_voltage"], "235.6", "V"),
        ents["inverter_frequency"]: _state(ents["inverter_frequency"], "50", "Hz"),
        ents["inverter_state"]: _state(ents["inverter_state"], "Normal"),
        ents["aux_power"]: _state(ents["aux_power"], "0", "W"),
        ents["aux_connected"]: _state(ents["aux_connected"], "on"),
        ents["aux_daily"]: _state(ents["aux_daily"], "1.7", "kWh"),
        ents["load_daily"]: _state(ents["load_daily"], "15.9", "kWh"),
    }
    flow = energy.build_flow(states, m)
    assert flow["solar_w"] == 0
    assert flow["grid_w"] == pytest.approx(20.0)
    assert flow["battery_w"] == pytest.approx(1022)
    assert flow["house_w"] == pytest.approx(1012)
    assert flow["aux_w"] == 0
    assert flow["directions"]["solar_to_inverter"] is False
    assert flow["directions"]["battery"] == "discharge"
    assert flow["directions"]["grid"] == "import"
    assert flow["directions"]["inverter_to_house"] is True
    assert flow["directions"]["inverter_to_aux"] is False
    assert flow["autarky_pct"] == pytest.approx((15.9 - 6.9) / 15.9 * 100.0)
    assert flow["battery_remaining_wh"] == pytest.approx(0.76 * 7600)
    assert flow["colours"]["solar"] == "#e0af29"
    assert flow["colours"]["grid_export"] == "#11af0e"
    assert flow["colours"]["aux"] == "#00b54b"


def test_build_flow_unavailable_and_grid_off():
    m = energy.load_map()
    ents = m["flow"]["entities"]
    states = {
        ents["pv_power"]: _state(ents["pv_power"], "unavailable", "W"),
        ents["grid_power"]: _state(ents["grid_power"], "1.2", "kW"),
        ents["grid_connected"]: _state(ents["grid_connected"], "off"),
        ents["inverter_power"]: _state(ents["inverter_power"], "unavailable", "W"),
        ents["aux_power"]: _state(ents["aux_power"], "unknown", "W"),
        ents["battery_power"]: _state(ents["battery_power"], "-800", "W"),
    }
    flow = energy.build_flow(states, m)
    assert flow["solar_w"] is None
    assert flow["house_w"] is None
    assert flow["aux_w"] is None
    assert flow["grid_w"] == pytest.approx(1200)
    assert flow["directions"]["grid"] == "idle"
    assert flow["directions"]["battery"] == "charge"
    assert flow["directions"]["solar_to_inverter"] is False
    assert flow["autarky_pct"] is None


def test_flow_endpoint_uses_supplied_states(client):
    r = client.get("/api/energy/flow")
    assert r.status_code == 200
    body = r.get_json()
    assert "directions" in body
    assert "colours" in body
    assert body["solar_w"] is None
