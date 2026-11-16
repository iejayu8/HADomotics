"""Seguridad: mapa de entidades, validación de la alarma y capa de dibujo de los planos."""
import json
import os
import subprocess
import sys

import pytest

HERE = os.path.dirname(__file__)
sys.path.insert(0, os.path.join(HERE, "..", "hadomotics"))

import security  # noqa: E402

ALARM = {
    "entity_id": "alarm_control_panel.alarmo",
    "state": "disarmed",
    "attributes": {"code_format": None, "code_arm_required": False, "supported_features": 14},
}


def test_map_entities_match_lovelace_dashboard():
    m = security.load_map()
    ents = security.mapped_entities(m)
    assert m["alarm"]["entity"] == "alarm_control_panel.alarmo"
    assert m["siren"]["entity"] == "siren.heiman_warningdevice_ef_3_0"
    assert len(m["zones"]) == 12
    assert all(z["entity"].startswith("input_boolean.notificacion_alarma_") for z in m["zones"])
    presence = [p["entity"] for p in m["presence"]]
    for i in range(1, 8):
        assert f"binary_sensor.sensormovimiento{i}" in presence
    # sensormovimiento8 no existe en Home Assistant: no se inventa.
    assert "binary_sensor.sensormovimiento8" not in ents
    assert "binary_sensor.reolink_persona" in presence


def test_presence_positions_are_fractions_or_null():
    for p in security.load_map()["presence"]:
        assert p["floor"] in {"planta_baja", "planta_1"}
        pos = p["position"]
        assert pos is None or (len(pos) == 2 and all(0 <= v <= 1 for v in pos))


def test_overlays_reference_real_evse_power_and_threshold():
    ov = security.load_overlays()
    pb = next(f for f in ov["floors"] if f["key"] == "planta_baja")
    cable = pb["evse_cable"]
    assert cable["power_entity"] == "sensor.evse_charging_power"
    assert cable["state_entity"] == "sensor.evse_charging_operational_state"
    assert cable["threshold_w"] == 100
    # El límite configurado no indica carga real.
    assert "number.evse_charging_power_limit" not in json.dumps(ov)
    assert security.overlay_entities(ov) == ["sensor.evse_charging_power", "sensor.evse_charging_operational_state"]
    p1 = next(f for f in ov["floors"] if f["key"] == "planta_1")
    assert p1["image_hd"]["match_size"] == [1315, 652]
    assert os.path.exists(os.path.join(HERE, "..", "hadomotics", p1["image_hd"]["src"]))


def test_validate_alarm_modes_follow_supported_features():
    m = security.load_map()
    body = {"entity_id": "alarm_control_panel.alarmo", "service": "alarm_arm_away"}
    assert security.validate_alarm(m, body, ALARM) == ("alarm_control_panel", "alarm_arm_away", {"entity_id": "alarm_control_panel.alarmo"})
    assert security.validate_alarm(m, dict(body, service="alarm_control_panel.alarm_arm_night"), ALARM)[1] == "alarm_arm_night"
    assert security.validate_alarm(m, dict(body, service="alarm_disarm"), ALARM)[1] == "alarm_disarm"
    with pytest.raises(ValueError):  # ARM_HOME (bit 1) no está en supported_features=14
        security.validate_alarm(m, dict(body, service="alarm_arm_home"), ALARM)
    with pytest.raises(ValueError):
        security.validate_alarm(m, dict(body, service="alarm_trigger"), ALARM)
    with pytest.raises(ValueError):
        security.validate_alarm(m, dict(body, entity_id="alarm_control_panel.otra"), ALARM)
    with pytest.raises(ValueError):
        security.validate_alarm(m, body, None)


def test_validate_alarm_code_rules():
    m = security.load_map()
    coded = {"entity_id": "alarm_control_panel.alarmo", "state": "armed_away",
             "attributes": {"code_format": "number", "code_arm_required": False, "supported_features": 14}}
    with pytest.raises(ValueError):
        security.validate_alarm(m, {"entity_id": coded["entity_id"], "service": "alarm_disarm"}, coded)
    out = security.validate_alarm(m, {"entity_id": coded["entity_id"], "service": "alarm_disarm", "code": "1234"}, coded)
    assert out[2]["code"] == "1234"
    # Armar sin código cuando code_arm_required es False
    assert "code" not in security.validate_alarm(m, {"entity_id": coded["entity_id"], "service": "alarm_arm_night"}, coded)[2]
    coded["attributes"]["code_arm_required"] = True
    with pytest.raises(ValueError):
        security.validate_alarm(m, {"entity_id": coded["entity_id"], "service": "alarm_arm_night"}, coded)


def test_security_and_plan_node_suite():
    script = os.path.join(HERE, "security_panel.test.js")
    proc = subprocess.run(["node", "--test", script], capture_output=True, text=True)
    assert proc.returncode == 0, proc.stdout + proc.stderr
