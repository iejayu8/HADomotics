"""Tests del módulo Energía (Carga Tesla / Solar / Batería) del add-on HADomotics."""

import json
import os
import sys
import tempfile
from unittest.mock import MagicMock, patch

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


@pytest.fixture()
def client():
    from flask import Flask
    from pathlib import Path
    app = Flask(__name__)
    app.register_blueprint(energy.create_blueprint(
        static_dir=Path(__file__).resolve().parents[1] / "hadomotics" / "static",
        get_state=lambda e: STATES.get(e),
        get_all_states=lambda: list(STATES.values()),
        is_ws_connected=lambda: True,
        ha_base_url=lambda: "http://supervisor/core/api",
        ha_headers=lambda: {"Authorization": "Bearer x"},
        has_token=lambda: True,
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
    ctl = energy.controls(m)
    # Solo controles deliberados: helpers de carga. Nunca el cargador ni el inversor.
    assert all(e.split(".")[0] in ("input_boolean", "input_number", "input_select", "automation") for e in ctl)
    # Solo los 3 interruptores generales de automatizaciones de carga
    assert {e for e in ctl if e.startswith("automation.")} == {
        "automation.carga_coche_dinamica_por_excedente", "automation.carga_coche_programa_nocturno",
        "automation.carga_coche_toda_la_noche"}
    assert "number.evse_charging_power_limit" not in ctl
    assert not any(e.startswith(("number.inverter", "switch.inverter", "select.inverter")) for e in ctl)
    # Legado eliminado: no debe aparecer
    for legacy in ("input_number.carga_soc_manual", "input_number.carga_capacidad_kwh", "sensor.carga_forecast_proximo_casa"):
        assert legacy not in ents


def test_energia_page(client):
    r = client.get("/energia")
    assert r.status_code == 200
    assert b"static/energia/js/energy.js" in r.data


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
def test_control_rejected(client, body):
    with patch("energy.requests.post") as post:
        r = client.post("/api/energy/control", json=body)
        assert r.status_code == 400
        post.assert_not_called()


def test_control_dry_run_does_not_call(client):
    with patch("energy.requests.post") as post:
        r = client.post("/api/energy/control", json={
            "entity_id": "input_number.carga_umbral_solar_kwh", "service": "input_number.set_value",
            "data": {"value": 18}, "dry_run": True})
        assert r.status_code == 200
        j = r.get_json()
        assert j["dry_run"] is True
        assert j["would_call"] == {"service": "input_number.set_value",
                                   "data": {"value": 18.0, "entity_id": "input_number.carga_umbral_solar_kwh"}}
        post.assert_not_called()


@pytest.mark.parametrize("body,url,payload", [
    ({"entity_id": "input_boolean.carga_instantanea_tesla", "service": "input_boolean.turn_on"},
     "http://supervisor/core/api/services/input_boolean/turn_on", {"entity_id": "input_boolean.carga_instantanea_tesla"}),
    ({"entity_id": "automation.carga_coche_programa_nocturno", "service": "automation.turn_off"},
     "http://supervisor/core/api/services/automation/turn_off", {"entity_id": "automation.carga_coche_programa_nocturno"}),
    ({"entity_id": "input_select.carga_dia_lunes", "service": "input_select.select_option", "data": {"option": "casa"}},
     "http://supervisor/core/api/services/input_select/select_option", {"option": "casa", "entity_id": "input_select.carga_dia_lunes"}),
])
def test_control_calls_ha(client, body, url, payload):
    resp = MagicMock(status_code=200)
    with patch("energy.requests.post", return_value=resp) as post:
        r = client.post("/api/energy/control", json=body)
        assert r.status_code == 200, r.get_json()
        post.assert_called_once()
        assert post.call_args.args[0] == url
        assert post.call_args.kwargs["json"] == payload
