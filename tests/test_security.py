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
    assert pb["image_hd"]["match_size"] == [1425, 736]
    for src in (p1["image_hd"]["src"], pb["image_hd"]["src"], pb["tesla"]["src"]):
        assert os.path.exists(os.path.join(HERE, "..", "hadomotics", src)), src
    # El coche y el cable solo en planta baja; el puerto, en la trasera izquierda.
    assert "tesla" not in p1 and "evse_cable" not in p1
    assert pb["tesla"]["port"][0] < 0.2 and pb["tesla"]["port"][1] < 0.5


def test_crop_rects_cover_the_drawing_and_relocations_fit():
    ov = security.load_overlays()
    for f in ov["floors"]:
        crop = f["crop"]
        x0, y0, x1, y1 = crop["rect"]
        assert 0 <= x0 < x1 <= 1 and 0 <= y0 < y1 <= 1
        # Solo se recortan bordes: al menos el 80 % de la imagen sigue visible.
        assert (x1 - x0) > 0.8 and (y1 - y0) > 0.75
        # Se aplica solo a la imagen de referencia (la HD conserva ese tamaño base).
        assert crop["match_size"] == f["reference_size"]
        w, h = f["reference_size"]
        for eid, (x, y) in f.get("relocate", {}).items():
            assert x0 * w <= x <= x1 * w and y0 * h <= y <= y1 * h, eid


def test_hd_images_keep_the_exact_aspect_ratio():
    from PIL import Image

    ov = security.load_overlays()
    for f in ov["floors"]:
        with Image.open(os.path.join(HERE, "..", "hadomotics", f["image_hd"]["src"])) as im:
            w, h = f["image_hd"]["match_size"]
            assert im.size == (2 * w, 2 * h)
    with Image.open(os.path.join(HERE, "..", "hadomotics", "static/plans/tesla_model_y.webp")) as car:
        assert car.mode == "RGBA"
        assert car.getpixel((0, 0))[3] == 0  # fondo transparente


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


# ---------------------------------------------------------------------------
# 3.5.1 — posiciones editables y elementos fuera del plano
# ---------------------------------------------------------------------------

def _map_and_overlays():
    base = os.path.join(HERE, "..", "hadomotics")
    return security.load_map(os.path.join(base, "security_map.json")), security.load_overlays(
        os.path.join(base, "plan_overlays.json")
    )


def test_merge_positions_defaults_unchanged_without_overrides():
    smap, ov = _map_and_overlays()
    assert security.merge_positions(smap, {}, ov) == smap
    assert security.merge_positions(smap, None, ov) == smap


def test_merge_positions_applies_custom_and_outside():
    smap, ov = _map_and_overlays()
    ent = smap["presence"][0]["entity"]
    merged = security.merge_positions(
        smap, {ent: {"floor": "planta_baja", "x": -0.05, "y": 0.4, "outside": True}}, ov
    )
    p = next(p for p in merged["presence"] if p["entity"] == ent)
    assert p["floor"] == "planta_baja" and p["position"] == [-0.05, 0.4]
    assert p["outside"] is True and p["custom"] is True
    # El original no se modifica.
    assert "custom" not in smap["presence"][0]
    # Registros inválidos se ignoran (la posición por defecto se mantiene).
    for bad in ({"floor": "x", "x": 0.1, "y": 0.1}, {"floor": "planta_baja", "x": 5, "y": 0.1}, "nope"):
        m = security.merge_positions(smap, {ent: bad}, ov)
        assert next(p for p in m["presence"] if p["entity"] == ent) == smap["presence"][0]


def test_validate_position_rules():
    smap, ov = _map_and_overlays()
    ent = smap["presence"][0]["entity"]
    e, rec = security.validate_position(smap, ov, {"entity_id": ent, "floor": "planta_1", "x": 1.234567, "y": -0.5, "outside": 1})
    assert e == ent and rec == {"floor": "planta_1", "x": 1.23457, "y": -0.5, "outside": True}
    bad = [
        {"entity_id": "binary_sensor.nope", "floor": "planta_1", "x": 0.1, "y": 0.1},
        {"entity_id": ent, "floor": "sotano", "x": 0.1, "y": 0.1},
        {"entity_id": ent, "floor": "planta_1", "x": 2.5, "y": 0.1},
        {"entity_id": ent, "floor": "planta_1", "x": -1.5, "y": 0.1},
        {"entity_id": ent, "floor": "planta_1", "x": float("nan"), "y": 0.1},
        {"entity_id": ent, "floor": "planta_1", "x": True, "y": 0.1},
        {"entity_id": ent, "floor": "planta_1", "x": "0.1", "y": 0.1},
    ]
    for body in bad:
        with pytest.raises(ValueError):
            security.validate_position(smap, ov, body)
