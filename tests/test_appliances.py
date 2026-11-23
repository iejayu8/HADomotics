"""Electrodomésticos como tipos de elemento (3.8.0): tipos, roles, descubrimiento y lista blanca."""
import json
import os
import re
import sys

HERE = os.path.dirname(__file__)
ROOT = os.path.join(HERE, "..", "hadomotics")
sys.path.insert(0, ROOT)

import appliances  # noqa: E402

# Registro real (solo lectura) de los tres aparatos de Xavi el 23/11/2026, recortado.
DEVICES = [
    {"id": "fr", "name": "Nevera", "config_entries": ["st"]},
    {"id": "dw", "name": "Lavavajillas", "config_entries": ["hc"]},
    {"id": "rb", "name": "Qrevo Edge 2 Pro", "config_entries": ["ro"]},
    {"id": "dk", "name": "Qrevo Edge 2 Pro Dock", "config_entries": ["ro"]},
]
ENTITIES = [
    {"entity_id": "sensor.cocina_nevera_temperatura_del_frigorifico", "device_id": "fr", "translation_key": "cooler_temperature"},
    {"entity_id": "number.cocina_nevera_temperatura_del_frigorifico", "device_id": "fr", "translation_key": "cooler_temperature"},
    {"entity_id": "number.cocina_nevera_temperatura_del_congelador", "device_id": "fr", "translation_key": "freezer_temperature"},
    {"entity_id": "switch.cocina_nevera_power_cool", "device_id": "fr", "translation_key": "power_cool"},
    {"entity_id": "select.cocina_lavavajillas_programa_activo", "device_id": "dw", "translation_key": "active_program"},
    {"entity_id": "select.cocina_lavavajillas_programa_seleccionado", "device_id": "dw", "translation_key": "selected_program"},
    {"entity_id": "vacuum.qrevo_edge_2_pro", "device_id": "rb", "translation_key": "roborock"},
    {"entity_id": "select.qrevo_edge_2_pro_modo_de_limpieza", "device_id": "rb", "translation_key": "cleaning_mode"},
    {"entity_id": "sensor.qrevo_edge_2_pro_dock_error_en_la_base", "device_id": "dk", "translation_key": "dock_error"},
    {"entity_id": "button.qrevo_edge_2_pro_restablecer_filtro", "device_id": "rb", "translation_key": "reset", "disabled_by": "integration"},
]


def test_three_kinds_without_fixed_entity_ids():
    types = appliances.load_types()
    assert set(types["kinds"]) == {"fridge", "dishwasher", "vacuum"}
    txt = json.dumps(types)
    # Ningún entity_id: solo roles con dominio y pistas de búsqueda.
    assert not re.search(r'"[a-z_]+\.[a-z0-9_]{3,}"', txt), re.findall(r'"[a-z_]+\.[a-z0-9_]{3,}"', txt)[:5]
    for kind in types["kinds"].values():
        roles = kind["roles"]
        for section in ("badge", "alerts", "status", "controls", "actions"):
            for item in kind.get(section, []):
                assert item["role"] in roles, item
                for cond in item.get("enabled_when", []):
                    assert cond["role"] in roles
                if item.get("option_from"):
                    assert item["option_from"] in roles
        for act in kind.get("actions", []):
            assert roles[act["role"]]["domain"] == act["domain"], act
    assert not os.path.exists(os.path.join(ROOT, "appliances_map.json"))
    assert not re.search(r"token|password|secret|access_token", txt, re.I)


def test_sanitize_keeps_known_roles_with_the_right_domain():
    got = appliances.sanitize_entities("fridge", {
        "set_cooler": "number.a", "set_freezer": "select.b", "power_cool": " switch.c ", "x": "switch.d",
        "temp_cooler": "sensor.Mayus", "door_cooler": 3,
    })
    assert got == {"set_cooler": "number.a", "power_cool": "switch.c"}
    assert appliances.sanitize_entities("button", {"a": "b.c"}) == {}


def _cfg(*elements):
    return {"floors": [{"id": "f", "elements": list(elements)}]}


def test_scoped_services_come_from_configured_elements_only():
    assert appliances.entity_scoped_services(_cfg()) == {}
    fridge = {"type": "fridge", "entity_id": "sensor.n", "appliance_entities": {
        "set_cooler": "number.n_frigo", "set_freezer": "number.n_congelador", "power_cool": "switch.n_pc"}}
    dish = {"type": "dishwasher", "appliance_entities": {
        "selected_program": "select.l_sel", "active_program": "select.l_act", "stop": "button.l_stop"}}
    robot = {"type": "vacuum", "appliance_entities": {"clean_mode": "select.r_modo", "vacuum": "vacuum.r"}}
    other = {"type": "button", "entity_id": "number.no", "appliance_entities": {"set_cooler": "number.no"}}
    got = appliances.entity_scoped_services(_cfg(fridge, dish, robot, other), protected=frozenset())
    assert got == {
        ("number", "set_value"): {"number.n_frigo", "number.n_congelador"},
        ("select", "select_option"): {"select.l_sel", "select.l_act", "select.r_modo"},
    }


def test_protected_energy_and_security_entities_never_enter_the_scope():
    prot = appliances.protected_entities()
    assert "number.evse_charging_power_limit" in prot
    assert "select.heiman_warningdevice_ef_3_0_tono_de_sirena_predeterminado" in prot
    assert "siren.heiman_warningdevice_ef_3_0" in prot
    evil = {"type": "fridge", "appliance_entities": {"set_cooler": "number.evse_charging_power_limit"}}
    evil2 = {"type": "dishwasher", "appliance_entities": {
        "selected_program": "select.heiman_warningdevice_ef_3_0_tono_de_sirena_predeterminado"}}
    assert appliances.entity_scoped_services(_cfg(evil, evil2)) == {}


def test_device_candidates_use_the_device_and_its_dock():
    rb = [c["entity_id"] for c in appliances.device_candidates("vacuum.qrevo_edge_2_pro", ENTITIES, DEVICES)]
    assert rb == ["vacuum.qrevo_edge_2_pro", "select.qrevo_edge_2_pro_modo_de_limpieza",
                  "sensor.qrevo_edge_2_pro_dock_error_en_la_base"]
    fr = [c["entity_id"] for c in appliances.device_candidates("switch.cocina_nevera_power_cool", ENTITIES, DEVICES)]
    assert len(fr) == 4 and all("nevera" in e for e in fr)
    assert appliances.device_candidates("sensor.no_existe", ENTITIES, DEVICES) == []
    # Solo datos de registro no sensibles.
    assert set(appliances.device_candidates("vacuum.qrevo_edge_2_pro", ENTITIES, DEVICES)[0]) == {
        "entity_id", "translation_key", "device_id", "platform"}


def test_every_panel_service_is_allowed_by_the_addon_proxy(tmp_path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    import server as srv

    used = appliances.services_used()
    assert used <= appliances.ACTION_SERVICES
    for domain, service in used - appliances.ENTITY_SCOPED:
        assert srv._service_allowed(domain, service), (domain, service)
    for key in appliances.ENTITY_SCOPED:
        assert not srv._service_allowed(*key)
    assert not srv._service_allowed("vacuum", "send_command")


def test_shipped_in_the_image_and_loaded_by_the_panel():
    docker = open(os.path.join(ROOT, "Dockerfile"), encoding="utf-8").read()
    assert "appliances.py" in docker and "appliance_types.json" in docker and "appliances_map.json" not in docker
    index = open(os.path.join(ROOT, "static", "index.html"), encoding="utf-8").read()
    order = [index.index(f"static/js/{n}.js") for n in ("element_icons", "appliances", "app")]
    assert order == sorted(order)
    for kind in ("fridge", "dishwasher", "vacuum"):
        assert f'<option value="{kind}">' in index
