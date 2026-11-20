"""Módulos configurables del add-on (Dispositivos / Energía / Seguridad)."""

import json
import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

import pytest

os.environ.setdefault("DATA_DIR", tempfile.mkdtemp(prefix="hadomotics_test_"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "hadomotics"))

ADDON = Path(__file__).resolve().parent.parent / "hadomotics"


@pytest.fixture()
def srv(tmp_path, monkeypatch):
    import server

    monkeypatch.setattr(server, "DATA_DIR", tmp_path)
    monkeypatch.setattr(server, "IMAGES_DIR", tmp_path / "images")
    monkeypatch.setattr(server, "CONFIG_FILE", tmp_path / "config.yaml")
    (tmp_path / "images").mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("ALLOW_DIRECT_ACCESS", "false")
    monkeypatch.delenv("CORS_ORIGINS", raising=False)
    monkeypatch.setattr(server, "_modules_warned", False)
    server._state_cache.clear()
    server.app.config["TESTING"] = True
    return server


def _options(srv, **opts):
    (srv.DATA_DIR / "options.json").write_text(json.dumps(opts))


@pytest.fixture()
def client(srv):
    with patch.object(srv, "ingress_user_is_admin", return_value=True):
        with srv.app.test_client() as c:
            c.environ_base["REMOTE_ADDR"] = srv.INGRESS_SOURCE_IP
            c.environ_base["HTTP_X_REMOTE_USER_ID"] = "admin-user"
            yield c


def test_missing_options_mean_all_modules_on(srv, client):
    # Instalación anterior a 3.6.0: options.json sin «modules» (o sin fichero).
    assert client.get("/api/modules").get_json() == {
        "modules": {"dispositivos": True, "energia": True, "seguridad": True}
    }
    _options(srv, log_level="info")
    assert srv.enabled_modules() == {"dispositivos": True, "energia": True, "seguridad": True}


def test_partial_options_default_missing_keys_to_true(srv):
    _options(srv, modules={"energia": False})
    assert srv.enabled_modules() == {"dispositivos": True, "energia": False, "seguridad": True}


def test_string_values_are_understood(srv):
    assert srv.normalize_modules({"dispositivos": "false", "energia": "off", "seguridad": "true"}) == {
        "dispositivos": False, "energia": False, "seguridad": True,
    }


def test_all_disabled_turns_all_on_and_warns_once(srv, caplog):
    off = {"dispositivos": False, "energia": False, "seguridad": False}
    with caplog.at_level("WARNING"):
        assert srv.normalize_modules(off) == {"dispositivos": True, "energia": True, "seguridad": True}
        srv.normalize_modules(off)
    warnings = [r for r in caplog.records if "All modules are disabled" in r.getMessage()]
    assert len(warnings) == 1


def test_modules_endpoint_is_an_ingress_read(srv):
    _options(srv, modules={"dispositivos": False, "energia": False, "seguridad": True})
    with patch.object(srv, "ingress_user_is_admin", return_value=False):
        with srv.app.test_client() as c:
            c.environ_base["REMOTE_ADDR"] = srv.INGRESS_SOURCE_IP
            c.environ_base["HTTP_X_REMOTE_USER_ID"] = "family-user"
            r = c.get("/api/modules")
    assert r.status_code == 200
    assert r.get_json()["modules"] == {"dispositivos": False, "energia": False, "seguridad": True}


def test_modules_endpoint_still_requires_auth(srv):
    with srv.app.test_client() as c:
        c.environ_base["REMOTE_ADDR"] = "192.168.1.50"
        assert c.get("/api/modules").status_code == 401


@pytest.mark.parametrize("path", ["/energia", "/api/energy/map", "/api/energy/state", "/api/energy/flow"])
def test_energy_routes_404_when_disabled(srv, client, path):
    _options(srv, modules={"dispositivos": True, "energia": False, "seguridad": True})
    r = client.get(path)
    assert r.status_code == 404
    assert r.get_json()["module"] == "energia"


def test_energy_control_404_when_disabled(srv, client):
    _options(srv, modules={"energia": False})
    with patch.object(srv.requests, "post") as post:
        r = client.post("/api/energy/control", json={"entity": "switch.x", "service": "turn_on"})
    assert r.status_code == 404
    post.assert_not_called()


@pytest.mark.parametrize("path", ["/seguridad", "/api/security/map", "/api/security/state"])
def test_security_routes_404_when_disabled(srv, client, path):
    _options(srv, modules={"seguridad": False})
    r = client.get(path)
    assert r.status_code == 404
    assert r.get_json()["module"] == "seguridad"


def test_security_alarm_post_never_reaches_ha_when_disabled(srv, client):
    _options(srv, modules={"seguridad": False})
    with patch.object(srv.requests, "post") as post:
        r = client.post("/api/security/alarm", json={"mode": "armed_away"})
        r2 = client.post("/api/security/control", json={"entity": "switch.x", "on": True})
        r3 = client.put("/api/security/positions", json={})
    assert (r.status_code, r2.status_code, r3.status_code) == (404, 404, 404)
    post.assert_not_called()


def test_devices_element_routes_404_but_floors_stay_for_security(srv, client):
    _options(srv, modules={"dispositivos": False, "energia": False, "seguridad": True})
    assert client.get("/api/floors/floor1/elements").status_code == 404
    assert client.post("/api/floors/floor1/elements", json={"type": "button"}).status_code == 404
    assert client.put("/api/elements/colors", json={}).status_code == 404
    # Seguridad dibuja los mismos planos: la lista de plantas sigue disponible.
    assert client.get("/api/floors").status_code == 200
    assert client.get("/api/floors/floor1").status_code == 200
    assert client.get("/api/plan/overlays").status_code == 200
    assert client.get("/api/security/map").status_code == 200


def test_enabled_modules_still_work(srv, client):
    _options(srv, modules={"dispositivos": True, "energia": True, "seguridad": False})
    assert client.get("/api/energy/map").status_code == 200
    assert client.get("/api/floors/floor1/elements").status_code == 200


def test_config_yaml_declares_modules_with_defaults_on():
    import yaml

    cfg = yaml.safe_load((ADDON / "config.yaml").read_text())
    assert cfg["options"]["modules"] == {"dispositivos": True, "energia": True, "seguridad": True}
    assert cfg["schema"]["modules"] == {"dispositivos": "bool?", "energia": "bool?", "seguridad": "bool?"}


@pytest.mark.parametrize("lang", ["en", "es"])
def test_translations_describe_modules(lang):
    import yaml

    tr = yaml.safe_load((ADDON / "translations" / f"{lang}.yaml").read_text())["configuration"]
    assert set(tr["modules"]["fields"]) == {"dispositivos", "energia", "seguridad"}
    for key in ("log_level", "allow_direct_access", "cors_origins"):
        assert tr[key]["name"]


def test_frontend_loads_modules_before_the_module_scripts():
    html = (ADDON / "static" / "index.html").read_text()
    pos = html.index("static/js/modules.js")
    for script in ("static/js/app.js", "static/energia/js/energy.js", "static/seguridad/js/security.js"):
        assert pos < html.index(script)
