"""HADomotics — tipos de elemento de electrodoméstico (nevera, lavavajillas, robot).

Los electrodomésticos son elementos normales de Dispositivos: se añaden, colocan,
mueven y borran como el resto. No hay ninguno predefinido ni entity_ids fijos.
Cada elemento de estos tipos guarda:
- entity_id: su entidad principal (la que eligió el usuario);
- appliance_entities: {rol: entity_id} con la entidad de cada función, que se
  descubre por dispositivo de Home Assistant y se puede cambiar en el formulario.

Este módulo:
- GET /api/appliances/types       los tipos y sus roles (appliance_types.json)
- sanitize_entities()              limpia appliance_entities al guardar
- entity_scoped_services()         lista blanca number.set_value / select.select_option
                                   para el proxy, calculada a partir de los elementos
                                   configurados (nunca para entidades de Energía o
                                   Seguridad, como el límite del cargador o la sirena)
- device_candidates()              entidades del mismo aparato (registro de HA)
"""

from __future__ import annotations

import json
import logging
import re
from pathlib import Path
from typing import Iterable

from flask import Blueprint, jsonify

log = logging.getLogger("hadomotics.appliances")

HERE = Path(__file__).resolve().parent
TYPES_FILE = HERE / "appliance_types.json"
ENTITY_RE = re.compile(r"^[a-z_]+\.[a-z0-9_]+$")

# (dominio, servicio) que usan las ventanas de los aparatos.
ACTION_SERVICES = frozenset({
    ("button", "press"),
    ("number", "set_value"),
    ("select", "select_option"),
    ("switch", "turn_off"),
    ("switch", "turn_on"),
    ("vacuum", "locate"),
    ("vacuum", "pause"),
    ("vacuum", "return_to_base"),
    ("vacuum", "set_fan_speed"),
    ("vacuum", "start"),
})
# Servicios que el proxy solo permite con entidades de electrodomésticos configurados.
ENTITY_SCOPED = frozenset({("number", "set_value"), ("select", "select_option")})


def load_types(path: Path = TYPES_FILE) -> dict:
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def kinds(types: dict | None = None) -> dict:
    return (types or load_types()).get("kinds", {})


def _entity_strings(obj) -> Iterable[str]:
    if isinstance(obj, str):
        if ENTITY_RE.match(obj):
            yield obj
    elif isinstance(obj, dict):
        for v in obj.values():
            yield from _entity_strings(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from _entity_strings(v)


def protected_entities(base: Path = HERE) -> frozenset[str]:
    """Entidades de Energía y Seguridad (cargador, sirena, alarma…): nunca entran en
    la lista blanca de los electrodomésticos, aunque alguien las asigne a un rol."""
    out = {"number.evse_charging_power_limit"}
    for name in ("energy_map.json", "security_map.json"):
        try:
            with open(base / name, encoding="utf-8") as f:
                out.update(_entity_strings(json.load(f)))
        except Exception as exc:  # pragma: no cover - fichero ausente
            log.warning("Could not read %s: %s", name, type(exc).__name__)
    return frozenset(out)


def sanitize_entities(kind: str, data, types: dict | None = None) -> dict:
    """{rol: entity_id} válido para ese tipo: roles conocidos y dominio correcto."""
    spec = kinds(types).get(kind)
    if not spec or not isinstance(data, dict):
        return {}
    out = {}
    for role, rdef in spec.get("roles", {}).items():
        v = data.get(role)
        if isinstance(v, str):
            v = v.strip()
            if ENTITY_RE.match(v) and v.split(".")[0] == rdef.get("domain"):
                out[role] = v
    return out


def _role_services(spec: dict) -> dict[str, set[tuple[str, str]]]:
    """Rol -> servicios con lista blanca por entidad que usa ese rol."""
    out: dict[str, set[tuple[str, str]]] = {}
    for c in spec.get("controls", []):
        key = {"number": ("number", "set_value"), "select": ("select", "select_option")}.get(c.get("type"))
        if key:
            out.setdefault(c["role"], set()).add(key)
    for act in spec.get("actions", []):
        key = (act.get("domain"), act.get("service"))
        if key in ENTITY_SCOPED:
            out.setdefault(act["role"], set()).add(key)
    return out


def entity_scoped_services(config: dict, types: dict | None = None,
                           protected: frozenset[str] | None = None) -> dict[tuple[str, str], frozenset[str]]:
    """{(dominio, servicio): entidades} de los electrodomésticos configurados en el plano."""
    ks = kinds(types)
    deny = protected if protected is not None else protected_entities()
    out: dict[tuple[str, str], set[str]] = {}
    for floor in (config or {}).get("floors", []) or []:
        for el in floor.get("elements", []) or []:
            spec = ks.get(el.get("type"))
            if not spec:
                continue
            ents = sanitize_entities(el.get("type"), el.get("appliance_entities") or {}, types)
            for role, services in _role_services(spec).items():
                eid = ents.get(role)
                if not eid or eid in deny:
                    continue
                for key in services:
                    if eid.split(".")[0] == key[0]:
                        out.setdefault(key, set()).add(eid)
    return {k: frozenset(v) for k, v in out.items()}


def services_used(types: dict | None = None) -> set[tuple[str, str]]:
    out: set[tuple[str, str]] = set()
    for spec in kinds(types).values():
        for act in spec.get("actions", []):
            out.add((act.get("domain"), act.get("service")))
        for c in spec.get("controls", []):
            t = c.get("type")
            if t == "switch":
                out |= {("switch", "turn_on"), ("switch", "turn_off")}
            elif t == "number":
                out.add(("number", "set_value"))
            elif t == "select":
                out.add(("select", "select_option"))
            elif t == "fan_speed":
                out.add(("vacuum", "set_fan_speed"))
    return out


def device_candidates(entity_id: str, entities: list, devices: list) -> list[dict]:
    """Entidades del mismo aparato que entity_id, desde los registros de HA.

    El aparato es su dispositivo, los que cuelgan de él (via_device_id) y los de la
    misma integración cuyo nombre empieza igual (p. ej. «Qrevo Edge 2 Pro Dock»).
    Solo devuelve datos de registro no sensibles; las entidades desactivadas no.
    """
    by_entity = {e.get("entity_id"): e for e in entities or [] if isinstance(e, dict)}
    main = by_entity.get(entity_id)
    if not main or not main.get("device_id"):
        return []
    devs = {d.get("id"): d for d in devices or [] if isinstance(d, dict)}
    dev = devs.get(main["device_id"]) or {}
    name = str(dev.get("name_by_user") or dev.get("name") or "").strip().lower()
    entries = set(dev.get("config_entries") or [])
    ids = {main["device_id"]}
    for d in devs.values():
        if d.get("via_device_id") == main["device_id"]:
            ids.add(d.get("id"))
        dname = str(d.get("name_by_user") or d.get("name") or "").strip().lower()
        if name and dname.startswith(name) and entries & set(d.get("config_entries") or []):
            ids.add(d.get("id"))
    out = []
    for e in entities or []:
        if not isinstance(e, dict) or e.get("device_id") not in ids or e.get("disabled_by"):
            continue
        out.append({
            "entity_id": e.get("entity_id"),
            "translation_key": e.get("translation_key"),
            "device_id": e.get("device_id"),
            "platform": e.get("platform"),
        })
    return out


def create_blueprint(*, types_path: Path = TYPES_FILE) -> Blueprint:
    bp = Blueprint("appliances", __name__)

    @bp.route("/api/appliances/types", methods=["GET"])
    def appliance_types():
        return jsonify(load_types(types_path))

    return bp
