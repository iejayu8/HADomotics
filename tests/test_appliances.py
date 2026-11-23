"""Electrodomésticos (3.7.0): mapa de entidades, posiciones y servicios que puede llamar el panel."""
import json
import os
import re
import sys

import pytest

HERE = os.path.dirname(__file__)
ROOT = os.path.join(HERE, "..", "hadomotics")
sys.path.insert(0, ROOT)

import appliances  # noqa: E402
import security  # noqa: E402

# Entidades leídas (solo lectura) del registro de Home Assistant el 23/11/2026.
REAL_ENTITIES = {
    "nevera": {
        "sensor.cocina_nevera_temperatura_del_frigorifico", "sensor.cocina_nevera_temperatura_del_congelador",
        "number.cocina_nevera_temperatura_del_frigorifico", "number.cocina_nevera_temperatura_del_congelador",
        "switch.cocina_nevera_power_cool", "switch.cocina_nevera_power_freeze", "switch.cocina_nevera_cubitos_de_hielo",
        "binary_sensor.cocina_nevera_puerta_del_frigorifico", "binary_sensor.cocina_nevera_puerta_del_congelador",
        "sensor.cocina_nevera_potencia",
    },
    "lavavajillas": {
        "sensor.cocina_lavavajillas_estado_de_operacion", "sensor.cocina_lavavajillas_puerta",
        "sensor.cocina_lavavajillas_progreso_del_programa", "sensor.cocina_lavavajillas_hora_de_finalizacion_del_programa",
        "select.cocina_lavavajillas_programa_seleccionado", "select.cocina_lavavajillas_programa_activo",
        "button.cocina_lavavajillas_detener_programa", "switch.cocina_lavavajillas_energia",
        "switch.cocina_lavavajillas_media_carga", "switch.cocina_lavavajillas_extra_seco", "switch.cocina_lavavajillas_higiene",
        "binary_sensor.cocina_lavavajillas_inicio_remoto",
    },
    "roborock": {
        "vacuum.qrevo_edge_2_pro", "sensor.qrevo_edge_2_pro_bateria", "sensor.qrevo_edge_2_pro_estado",
        "sensor.qrevo_edge_2_pro_habitacion_actual", "sensor.qrevo_edge_2_pro_error_de_aspirador",
        "sensor.qrevo_edge_2_pro_progreso_de_la_limpieza", "select.qrevo_edge_2_pro_modo_de_limpieza",
        "sensor.qrevo_edge_2_pro_dock_error_en_la_base", "binary_sensor.qrevo_edge_2_pro_dock_caja_de_agua_limpia",
        "binary_sensor.qrevo_edge_2_pro_dock_caja_de_agua_sucia",
    },
}


def _by_id():
    return {a["id"]: a for a in appliances.load_map()["appliances"]}


def test_three_appliances_with_real_entities_only():
    m = appliances.load_map()
    by_id = _by_id()
    assert set(by_id) == {"nevera", "lavavajillas", "roborock"}
    assert {a["kind"] for a in m["appliances"]} == {"fridge", "dishwasher", "vacuum"}
    for ident, a in by_id.items():
        used = set(appliances.entities({"appliances": [a]}))
        assert used <= REAL_ENTITIES[ident], used - REAL_ENTITIES[ident]
    # Sin pausa del lavavajillas: Home Assistant no la expone (no se inventa).
    lav = json.dumps(by_id["lavavajillas"])
    assert "pause_program" not in lav and "resume" not in lav


def test_positions_are_fractions_on_a_known_floor_with_location_source():
    keys = {f["key"] for f in security.load_overlays()["floors"]}
    for a in appliances.load_map()["appliances"]:
        assert a["floor"] in keys
        assert len(a["position"]) == 2 and all(0 <= v <= 1 for v in a["position"])
        assert a["location"]["source"] in {"area_ha", "supuesto"}
        assert a["location"]["note"]
    by_id = _by_id()
    # Nevera y lavavajillas: área «cocina» de HA (cuadrante superior izquierdo de la planta baja).
    for ident in ("nevera", "lavavajillas"):
        assert by_id[ident]["location"] == {**by_id[ident]["location"], "area": "cocina", "source": "area_ha"}
        x, y = by_id[ident]["position"]
        assert x < 0.42 and y < 0.5
    # Roborock: sin área en HA, la base va al recibidor (supuesto, junto a la entrada).
    rb = by_id["roborock"]
    assert rb["location"]["source"] == "supuesto" and rb["location"]["area"] == "vestibulo"
    assert rb["position"][1] > 0.7


def test_every_panel_service_is_allowed_by_the_addon_proxy(tmp_path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    import server as srv

    m = appliances.load_map()
    used = appliances.services_used(m)
    assert used <= appliances.ACTION_SERVICES
    scoped = appliances.entity_scoped_services(m)
    assert srv.APPLIANCE_ENTITY_SERVICES == scoped
    for domain, service in used:
        if (domain, service) in appliances.ENTITY_SCOPED:
            assert not srv._service_allowed(domain, service)
            for eid in scoped[(domain, service)]:
                assert srv._entity_service_allowed(domain, service, {"entity_id": eid})
        else:
            assert srv._service_allowed(domain, service), (domain, service)
    assert scoped[("number", "set_value")] == {
        "number.cocina_nevera_temperatura_del_frigorifico", "number.cocina_nevera_temperatura_del_congelador"}
    assert scoped[("select", "select_option")] == {
        "select.cocina_lavavajillas_programa_seleccionado", "select.cocina_lavavajillas_programa_activo",
        "select.qrevo_edge_2_pro_modo_de_limpieza"}
    # Lo que no usan los aparatos sigue bloqueado.
    assert not srv._service_allowed("vacuum", "send_command")
    assert not srv._entity_service_allowed("number", "set_value", {"entity_id": "number.evse_charging_power_limit"})
    assert not srv._entity_service_allowed("number", "set_value", {"entity_id": [
        "number.cocina_nevera_temperatura_del_frigorifico", "number.evse_charging_power_limit"]})
    assert not srv._entity_service_allowed("select", "select_option", {})


def test_actions_target_their_own_domain_and_need_a_press():
    for a in appliances.load_map()["appliances"]:
        for act in a.get("actions", []):
            assert act["entity"].split(".")[0] == act["domain"], act
            # Ninguna acción se lanza sola: no hay campos de ejecución automática.
            assert not {"auto", "on_open", "autostart"} & set(act)
    lav = _by_id()["lavavajillas"]
    start = next(x for x in lav["actions"] if x["id"] == "start")
    assert start["entity"] == "select.cocina_lavavajillas_programa_activo"
    assert start["option_from"] == "select.cocina_lavavajillas_programa_seleccionado"
    assert start["confirm"] and next(x for x in lav["actions"] if x["id"] == "stop")["confirm"]
    rb = {x["id"]: x["service"] for x in _by_id()["roborock"]["actions"]}
    assert rb == {"start": "start", "pause": "pause", "home": "return_to_base", "locate": "locate"}


def test_program_labels_cover_every_option():
    labels = appliances.load_map()["labels"]["dishwasher_program"]
    for p in ("eco_50", "auto_2", "intensiv_70", "quick_65", "machine_care", "pre_rinse"):
        assert f"dishcare_dishwasher_program_{p}" in labels


def test_merge_and_validate_positions():
    m = appliances.load_map()
    ov = security.load_overlays()
    assert appliances.merge_positions(m, {}, ov) == m
    merged = appliances.merge_positions(m, {"roborock": {"floor": "planta_baja", "x": 0.5, "y": 0.6}, "nevera": {"floor": "sotano", "x": 0, "y": 0}}, ov)
    rb = next(a for a in merged["appliances"] if a["id"] == "roborock")
    nev = next(a for a in merged["appliances"] if a["id"] == "nevera")
    assert rb["position"] == [0.5, 0.6] and rb["custom"] is True
    assert "custom" not in nev
    ident, rec = appliances.validate_position(m, ov, {"id": "nevera", "floor": "planta_baja", "x": 0.123456, "y": 0.2})
    assert ident == "nevera" and rec == {"floor": "planta_baja", "x": 0.12346, "y": 0.2}
    for bad in ({"id": "horno", "floor": "planta_baja", "x": 0, "y": 0},
                {"id": "nevera", "floor": "sotano", "x": 0, "y": 0},
                {"id": "nevera", "floor": "planta_baja", "x": 3, "y": 0},
                {"id": "nevera", "floor": "planta_baja", "x": True, "y": 0}):
        with pytest.raises(ValueError):
            appliances.validate_position(m, ov, bad)


def test_map_has_no_secrets_and_is_shipped_in_the_image():
    txt = open(os.path.join(ROOT, "appliances_map.json"), encoding="utf-8").read()
    assert not re.search(r"token|password|secret|access_token", txt, re.I)
    docker = open(os.path.join(ROOT, "Dockerfile"), encoding="utf-8").read()
    assert "appliances.py" in docker and "appliances_map.json" in docker
    index = open(os.path.join(ROOT, "static", "index.html"), encoding="utf-8").read()
    assert index.index("static/js/appliances.js") < index.index("static/js/app.js")
