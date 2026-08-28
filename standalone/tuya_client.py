"""Tuya Cloud + LAN adapter for HADomotics Standalone.

Cloud is always available (OpenAPI via tinytuya.Cloud).
LAN (same Wi-Fi) is used first when we have IP + local_key, with a short timeout,
then we fall back to Cloud.
"""
from __future__ import annotations

import logging
import re
import threading
import time
import unicodedata
from typing import Any, Optional

log = logging.getLogger("hadomotics.tuya")

try:
    import tinytuya
except ImportError:  # pragma: no cover
    tinytuya = None

# Tuya boolean-ish codes we treat as on/off
_SWITCH_CODES = (
    "switch_1", "switch_2", "switch_3", "switch_4",
    "switch_led", "switch", "led_switch", "power",
)
_COVER_CODES = ("percent_control", "percent_state", "position", "curtain_percent")
_TEMP_CODES = ("temp_current", "current_temperature", "va_temperature")
_SETPOINT_CODES = ("temp_set", "temperature", "set_temp")
_BRIGHT_CODES = ("bright_value", "bright_value_v2", "brightness")
_DOOR_CODES = (
    "doorcontact_state", "doorcontact", "door_contact",
    "door_state", "closed", "switch_type",
)
_DOOR_NAME_HINTS = (
    "garaje", "garage", "puerta", "porton", "portón", "door", "gate", "cancel",
)
_CAT_DOMAIN = {
    "cl": "cover", "clkg": "cover", "ckqdkg": "cover",
    "dj": "light", "dd": "light", "fwd": "light",
    "cz": "switch", "kg": "switch", "pc": "switch", "tdq": "switch",
    "wk": "climate", "kt": "climate",
}


def _is_private_ip(ip: str) -> bool:
    if not ip:
        return False
    parts = ip.split(".")
    if len(parts) != 4:
        return False
    try:
        a, b = int(parts[0]), int(parts[1])
    except ValueError:
        return False
    return a == 10 or (a == 192 and b == 168) or (a == 172 and 16 <= b <= 31) or a == 127


def _norm(s: str) -> str:
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode("ascii")
    s = s.lower()
    return re.sub(r"[^a-z0-9]+", "_", s).strip("_")


def _tuya_err(obj: Any) -> str:
    if not isinstance(obj, dict):
        return ""
    if obj.get("success") is False:
        return str(obj.get("msg") or obj.get("Payload") or obj.get("error") or obj)
    if "Err" in obj or "Error" in obj:
        return str(obj.get("Payload") or obj.get("Error") or obj)
    code = obj.get("code")
    if code not in (None, 0, 200, "0", "200") and obj.get("success") is False:
        return str(obj.get("msg") or obj)
    return ""


class TuyaAdapter:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.access_id = ""
        self.access_secret = ""
        self.uid = ""
        self.region = "eu"
        self.prefer_local = True
        self._cloud_api = None
        self._devices: dict[str, dict] = {}
        self._last_sync = 0.0
        self._last_status = 0.0
        self.demo = True
        self.connected = False
        self.last_error = ""
        self._seed_demo()

    # ------------------------------------------------------------------
    def configure(self, cfg: dict) -> dict:
        with self._lock:
            self.access_id = (cfg.get("access_id") or "").strip()
            self.access_secret = (cfg.get("access_secret") or "").strip()
            self.uid = (cfg.get("uid") or "").strip()
            self.region = (cfg.get("region") or "eu").strip().lower()
            self.prefer_local = bool(cfg.get("prefer_local", True))
            self._cloud_api = None
            self.connected = False
            self.last_error = ""
            if not self.access_id or not self.access_secret:
                self.demo = True
                self._seed_demo()
                return self.public_status()
            self.demo = False
        err = self._connect_cloud()
        if err:
            with self._lock:
                self.last_error = err
                self.demo = True
                self._seed_demo()
            return self.public_status()
        self.sync_devices(force=True)
        return self.public_status()

    def public_status(self) -> dict:
        with self._lock:
            return {
                "demo": self.demo,
                "connected": self.connected,
                "region": self.region,
                "prefer_local": self.prefer_local,
                "uid_set": bool(self.uid),
                "access_id_set": bool(self.access_id),
                "device_count": len(self._devices),
                "last_error": self.last_error,
                "last_sync": self._last_sync,
            }

    def public_config(self) -> dict:
        with self._lock:
            secret = self.access_secret
            masked = (secret[:3] + "…" + secret[-3:]) if len(secret) > 8 else ("" if not secret else "•••")
            return {
                "access_id": self.access_id,
                "access_secret_masked": masked,
                "uid": self.uid,
                "region": self.region,
                "prefer_local": self.prefer_local,
                "demo": self.demo,
            }

    # ------------------------------------------------------------------
    def _seed_demo(self) -> None:
        now = time.time()
        self._devices = {
            "demo_switch": {
                "id": "demo_switch",
                "name": "Interruptor demo",
                "category": "cz",
                "online": True,
                "ip": "",
                "local_key": "",
                "version": "3.3",
                "status": {"switch_1": True},
                "codes": ["switch_1"],
                "source": "demo",
            },
            "demo_light": {
                "id": "demo_light",
                "name": "Luz demo",
                "category": "dj",
                "online": True,
                "ip": "",
                "local_key": "",
                "version": "3.3",
                "status": {"switch_led": False, "bright_value": 80},
                "codes": ["switch_led", "bright_value"],
                "source": "demo",
            },
            "demo_cover": {
                "id": "demo_cover",
                "name": "Persiana demo",
                "category": "cl",
                "online": True,
                "ip": "",
                "local_key": "",
                "version": "3.3",
                "status": {"percent_control": 0, "percent_state": 0},
                "codes": ["percent_control", "percent_state"],
                "source": "demo",
            },
            "demo_climate": {
                "id": "demo_climate",
                "name": "Clima demo",
                "category": "wk",
                "online": True,
                "ip": "",
                "local_key": "",
                "version": "3.3",
                "status": {"temp_current": 21.5, "temp_set": 22, "switch": True},
                "codes": ["temp_current", "temp_set", "switch"],
                "source": "demo",
            },
        }
        self._last_sync = now
        self.connected = True  # demo is "online"

    def _connect_cloud(self) -> str:
        if tinytuya is None:
            return "tinytuya no está instalado"
        try:
            # apiDeviceID must be a Device ID, never a user UID (that yielded 0 devices).
            cloud = tinytuya.Cloud(
                apiRegion=self.region,
                apiKey=self.access_id,
                apiSecret=self.access_secret,
            )
            cloud.use_old_device_list = False
            if getattr(cloud, "error", None):
                return _tuya_err(cloud.error) or str(cloud.error)
            if not getattr(cloud, "token", None):
                return "No se pudo obtener token Tuya (Access ID/Secret o región incorrectos)"
            with self._lock:
                self._cloud_api = cloud
                self.connected = True
                self.last_error = ""
            log.info("Tuya Cloud token OK (region=%s host=%s)", self.region, getattr(cloud, "urlhost", ""))
            return ""
        except Exception as exc:
            log.warning("Tuya Cloud connect failed: %s", exc)
            return str(exc)

    def _get_cloud(self):
        with self._lock:
            return self._cloud_api

    # ------------------------------------------------------------------
    def sync_devices(self, force: bool = False) -> list[dict]:
        if self.demo:
            return self.list_devices()
        if not force and time.time() - self._last_sync < 45:
            return self.list_devices()
        cloud = self._get_cloud()
        if cloud is None:
            err = self._connect_cloud()
            if err:
                return self.list_devices()
            cloud = self._get_cloud()
        try:
            devices_in, fetch_err = self._fetch_raw_devices(cloud)
            if fetch_err and not devices_in:
                log.warning("Tuya list empty: %s", fetch_err)
                with self._lock:
                    self._devices = {}
                    self._last_sync = time.time()
                    self.connected = True
                    self.last_error = fetch_err
                return self.list_devices()
            new_map: dict[str, dict] = {}
            for d in devices_in:
                if not isinstance(d, dict):
                    continue
                did = d.get("id") or d.get("devId") or d.get("device_id")
                if not did:
                    continue
                status = self._normalize_status(d.get("status") or [])
                if not status:
                    status = self._live_status(cloud, did, None)
                mapping = d.get("mapping")
                code_to_dp: dict[str, str] = {}
                if isinstance(mapping, dict):
                    for dp_id, info in mapping.items():
                        if isinstance(info, dict) and info.get("code"):
                            code_to_dp[str(info["code"])] = str(dp_id)
                codes = list(status.keys()) or list(code_to_dp.keys())
                raw_ip = d.get("ip") or d.get("ip_addr") or ""
                prev = self._devices.get(did) or {}
                lan_ip = prev.get("ip") or ""
                if _is_private_ip(raw_ip):
                    lan_ip = raw_ip
                new_map[did] = {
                    "id": did,
                    "name": d.get("name") or did,
                    "category": d.get("category") or "",
                    "online": bool(d.get("online", True)),
                    "ip": lan_ip if _is_private_ip(lan_ip) else "",
                    "local_key": d.get("key") or d.get("local_key") or "",
                    "version": str(d.get("version") or d.get("protocol_version") or "3.3"),
                    "status": status,
                    "codes": codes,
                    "code_to_dp": code_to_dp or (prev.get("code_to_dp") or {}),
                    "source": "cloud",
                }
            with self._lock:
                self._devices = new_map
                self._last_sync = time.time()
                self.connected = True
                self.last_error = "" if new_map else (fetch_err or "0 dispositivos. Vincula la cuenta Smart Life al proyecto Cloud y revisa la región.")
            log.debug("Tuya sync: %d devices", len(new_map))
            if force and self.prefer_local:
                self._scan_lan_ips()
        except Exception as exc:
            log.warning("sync_devices failed: %s", exc)
            with self._lock:
                self.last_error = str(exc)
                self.connected = False
        return self.list_devices()

    def refresh_statuses(self) -> list[dict]:
        """Update DP values for already-known devices without re-listing the catalog."""
        if self.demo:
            return self.list_devices()
        cloud = self._get_cloud()
        if cloud is None:
            return self.list_devices()
        with self._lock:
            ids = list(self._devices.keys())
        if not ids:
            return self.sync_devices()
        updated: dict[str, dict] = {}
        try:
            raw = cloud.cloudrequest(
                "/v1.0/iot-03/devices/status",
                query={"device_ids": ",".join(ids[:20])},
            )
            rows = []
            if isinstance(raw, dict) and isinstance(raw.get("result"), list):
                rows = raw["result"]
            elif isinstance(raw, dict) and isinstance(raw.get("result"), dict):
                maybe = raw["result"].get("list") or raw["result"].get("devices") or []
                if isinstance(maybe, list):
                    rows = maybe
            for row in rows:
                if not isinstance(row, dict):
                    continue
                did = row.get("id") or row.get("device_id")
                st = self._normalize_status(row.get("status") or row)
                if did and st:
                    updated[did] = st
        except Exception:
            pass
        if len(updated) < max(1, len(ids) // 2):
            for did in ids:
                st = self._live_status(cloud, did, None)
                if st:
                    updated[did] = st
        with self._lock:
            for did, st in updated.items():
                if did in self._devices and st:
                    self._devices[did]["status"] = st
            self._last_status = time.time()
        return self.list_devices()

    def _extract_device_dicts(self, raw: Any) -> tuple[list[dict], str]:
        err = _tuya_err(raw)
        if err:
            return [], err
        if isinstance(raw, list):
            return [x for x in raw if isinstance(x, dict)], ""
        if not isinstance(raw, dict):
            return [], f"respuesta inesperada: {type(raw).__name__}"
        result = raw.get("result")
        if isinstance(result, list):
            return [x for x in result if isinstance(x, dict)], ""
        if isinstance(result, dict):
            for key in ("devices", "list"):
                val = result.get(key)
                if isinstance(val, list):
                    return [x for x in val if isinstance(x, dict)], ""
        if isinstance(raw.get("devices"), list):
            return [x for x in raw["devices"] if isinstance(x, dict)], ""
        return [], ""

    def _fetch_raw_devices(self, cloud) -> tuple[list[dict], str]:
        last_err = "Tuya devolvió 0 dispositivos"
        # 1) All devices linked to the Cloud project
        try:
            cloud.use_old_device_list = False
            raw = cloud.getdevices(verbose=True)
            devs, err = self._extract_device_dicts(raw)
            if devs:
                return devs, ""
            last_err = err or last_err
        except Exception as exc:
            last_err = str(exc)
            log.warning("getdevices verbose failed: %s", exc)

        try:
            cloud.use_old_device_list = False
            raw = cloud.getdevices()
            devs, err = self._extract_device_dicts(raw)
            if devs:
                return devs, ""
            last_err = err or last_err
        except Exception as exc:
            last_err = str(exc)

        uid = self.uid
        if uid:
            for label, raw in (
                ("users/uid/devices", None),
                ("iot-03 by uid", None),
            ):
                try:
                    if label.startswith("users"):
                        raw = cloud.cloudrequest("users/%s/devices" % uid)
                    else:
                        raw = cloud._get_all_devices(uid=uid)
                    devs, err = self._extract_device_dicts(raw)
                    if devs:
                        return devs, ""
                    last_err = err or last_err
                except Exception as exc:
                    last_err = str(exc)
                    log.warning("%s failed: %s", label, exc)

        hint = (
            f"{last_err}. "
            "Comprueba: 1) Data Center del proyecto Cloud = región (España suele ser eu o eu-w), "
            "2) Cloud → proyecto → Devices / Link Tuya App Account (cuenta Smart Life), "
            "3) el UID es el de esa cuenta vinculada, no un entity_id de Home Assistant."
        )
        return [], hint

    def resolve_entity(self, entity_id: str, domain_hint: str = "") -> tuple[str, Optional[str]]:
        """Map tuya.<id>.<code> or leftover HA entity_ids (cover.foo) to a Tuya device."""
        eid = (entity_id or "").strip()
        if not eid:
            raise ValueError("Sin entity_id en el elemento")
        parts = eid.split(".")
        if parts[0] == "tuya" and len(parts) >= 2:
            return parts[1], parts[2] if len(parts) > 2 else None
        with self._lock:
            if eid in self._devices:
                return eid, None
            have = bool(self._devices)
        if not self.demo and not have:
            self.sync_devices()
        slug = parts[-1]
        nslug = _norm(slug)
        domain = parts[0] if len(parts) > 1 else domain_hint
        with self._lock:
            devices = list(self._devices.values())
        for d in devices:
            nd = _norm(d.get("name") or "")
            nid = _norm(d.get("id") or "")
            if nslug in (nid, nd) or (nslug and nd and (nslug in nd or nd in nslug)):
                return d["id"], self._infer_code(d, domain)
        names = ", ".join((d.get("name") or d["id"]) for d in devices[:15]) or "(ningún dispositivo Tuya)"
        raise ValueError(
            f"No hay dispositivo Tuya para '{eid}'. Sincronizados: {names}. "
            "En Edit Mode asigna entity_id = tuya.<deviceId>.<codigo>"
        )

    @staticmethod
    def _infer_code(device: dict, domain: str) -> Optional[str]:
        status = device.get("status") or {}
        codes = device.get("codes") or list(status.keys())
        if domain in ("cover", "curtain", "garage", "door"):
            for c in _DOOR_CODES:
                if c in codes or c in status:
                    return c
            for c in _COVER_CODES:
                if c in codes or c in status:
                    return c
        if domain in ("light", "switch", "button"):
            if TuyaAdapter._is_door_like(device.get("name") or ""):
                for c in _DOOR_CODES:
                    if c in codes or c in status:
                        return c
            for c in _SWITCH_CODES:
                if c in codes or c in status:
                    return c
        for c in _SWITCH_CODES:
            if c in status or c in codes:
                return c
        return codes[0] if codes else None

    def _scan_lan_ips(self) -> None:
        if tinytuya is None:
            return
        try:
            found = tinytuya.deviceScan(timeout=2.5)
        except Exception as exc:
            log.debug("LAN scan skipped: %s", exc)
            return
        if not isinstance(found, dict):
            return
        with self._lock:
            for did, info in found.items():
                if did in self._devices and isinstance(info, dict):
                    ip = info.get("ip") or info.get("address")
                    if ip:
                        self._devices[did]["ip"] = ip
                    ver = info.get("version")
                    if ver:
                        self._devices[did]["version"] = str(ver)
                    self._devices[did]["source"] = "lan" if ip else self._devices[did].get("source")

    @staticmethod
    def _normalize_status(status: Any) -> dict:
        if _tuya_err(status):
            return {}
        out: dict[str, Any] = {}
        if isinstance(status, dict):
            if "result" in status:
                return TuyaAdapter._normalize_status(status.get("result"))
            if "dps" in status and isinstance(status["dps"], dict):
                for k, v in status["dps"].items():
                    out[str(k)] = v
                return out
            # skip tinytuya error-shaped leftovers
            if "Err" in status or "Error" in status:
                return {}
            for k, v in status.items():
                if k in ("dps", "success", "t", "tid", "code", "msg"):
                    continue
                out[str(k)] = v
            return out
        if isinstance(status, list):
            for item in status:
                if not isinstance(item, dict):
                    continue
                code = item.get("code") or item.get("dp_id") or item.get("dpId")
                if code is None:
                    continue
                out[str(code)] = item.get("value")
        return out

    def _live_status(self, cloud, device_id: str, raw_status=None) -> dict:
        status = self._normalize_status(raw_status or [])
        for getter in (
            lambda: cloud.getstatus(device_id),
            lambda: cloud.cloudrequest("devices/%s/status" % device_id),
        ):
            try:
                st = getter()
                err = _tuya_err(st)
                if err:
                    log.debug("status %s: %s", device_id, err)
                    continue
                parsed = self._normalize_status(st)
                if parsed:
                    return parsed
            except Exception as exc:
                log.debug("status fetch %s: %s", device_id, exc)
        return status

    def _code_to_dp(self, cloud, device_id: str, mapping=None) -> dict:
        code_to_dp: dict[str, str] = {}
        if isinstance(mapping, dict):
            for dp_id, info in mapping.items():
                if isinstance(info, dict) and info.get("code"):
                    code_to_dp[str(info["code"])] = str(dp_id)
        if code_to_dp:
            return code_to_dp
        try:
            spec = cloud.getdps(device_id)
            result = spec.get("result") if isinstance(spec, dict) else None
            if isinstance(result, dict):
                for bucket in (result.get("status") or [], result.get("functions") or []):
                    if not isinstance(bucket, list):
                        continue
                    for item in bucket:
                        if not isinstance(item, dict):
                            continue
                        code = item.get("code")
                        dp_id = item.get("dp_id")
                        if code is not None and dp_id is not None:
                            code_to_dp[str(code)] = str(dp_id)
        except Exception as exc:
            log.debug("getdps %s: %s", device_id, exc)
        return code_to_dp

    def list_devices(self) -> list[dict]:
        with self._lock:
            return [self._public_device(d) for d in self._devices.values()]

    @staticmethod
    def _public_device(d: dict) -> dict:
        return {
            "id": d["id"],
            "name": d["name"],
            "category": d.get("category", ""),
            "online": d.get("online", True),
            "ip": d.get("ip") or "",
            "has_local_key": bool(d.get("local_key")),
            "source": d.get("source", "cloud"),
            "status": d.get("status") or {},
            "codes": d.get("codes") or list((d.get("status") or {}).keys()),
        }

    def get_device(self, device_id: str) -> Optional[dict]:
        with self._lock:
            d = self._devices.get(device_id)
            return dict(d) if d else None

    # ------------------------------------------------------------------
    def ha_style_states(self) -> list[dict]:
        """Expose Tuya DPs as HA-like state objects so the existing UI works."""
        states = []
        with self._lock:
            devices = list(self._devices.values())
        for d in devices:
            status = d.get("status") or {}
            for code, value in status.items():
                eid = f"tuya.{d['id']}.{code}"
                ha_state, attrs = self._to_ha_state(d, code, value, status)
                states.append({
                    "entity_id": eid,
                    "state": ha_state,
                    "attributes": attrs,
                })
            # also a device-level entity
            states.append({
                "entity_id": f"tuya.{d['id']}",
                "state": "on" if self._device_is_on(status, d) else "off",
                "attributes": {
                    "friendly_name": d.get("name"),
                    "device_id": d["id"],
                    "category": d.get("category"),
                    "source": d.get("source"),
                    "online": d.get("online", True),
                    **{f"dp_{k}": v for k, v in status.items()},
                },
            })
            slug = _norm(d.get("name") or "")
            domain = _CAT_DOMAIN.get(d.get("category") or "", "")
            if "percent_control" in status or "percent_state" in status or self._is_door_like(d.get("name") or ""):
                if self._is_door_like(d.get("name") or "") or domain != "light":
                    if "percent_control" in status or "percent_state" in status:
                        domain = "cover"
            if self._is_door_like(d.get("name") or "") and domain in ("", "switch"):
                domain = "cover" if ("percent_control" in status or "percent_state" in status) else "switch"
            if slug and domain:
                primary_code = self._infer_code(d, domain)
                if primary_code and primary_code in status:
                    ha_state, attrs = self._to_ha_state(d, primary_code, status[primary_code], status)
                else:
                    ha_state, attrs = ("on" if self._device_is_on(status, d) else "off"), {
                        "friendly_name": d.get("name"),
                        "device_id": d["id"],
                        "code": primary_code,
                    }
                states.append({
                    "entity_id": f"{domain}.{slug}",
                    "state": ha_state,
                    "attributes": attrs,
                })
        return states

    @staticmethod
    def _is_door_like(name: str) -> bool:
        n = _norm(name)
        return any(_norm(h) in n for h in _DOOR_NAME_HINTS)

    @staticmethod
    def _value_is_open(value: Any) -> bool:
        s = str(value).strip().lower()
        if s in ("open", "opened", "on", "true", "1"):
            return True
        if s in ("closed", "close", "off", "false", "0", "stop"):
            return False
        return bool(value)

    def _device_is_on(self, status: dict, device: Optional[dict] = None) -> bool:
        for c in _DOOR_CODES:
            if c not in status:
                continue
            v = status[c]
            if c == "closed":
                return not self._value_is_open(v)
            return self._value_is_open(v)
        name = (device or {}).get("name") or ""
        door = self._is_door_like(name)
        for c in _SWITCH_CODES:
            if c in status:
                raw = status[c]
                val = self._value_is_open(raw) if isinstance(raw, str) else bool(raw)
                return (not val) if door else val
        pos = status.get("percent_state", status.get("percent_control"))
        if isinstance(pos, (int, float)):
            is_open = pos > 0
            return (not is_open) if door else is_open
        return False

    @staticmethod
    def _to_ha_state(device: dict, code: str, value: Any, status: dict) -> tuple[str, dict]:
        name = device.get("name") or device.get("id")
        attrs = {
            "friendly_name": f"{name} {code}",
            "device_id": device["id"],
            "code": code,
            "source": device.get("source"),
        }
        if code in _DOOR_CODES:
            is_open = TuyaAdapter._value_is_open(value)
            if code == "closed":
                is_open = not is_open
            attrs["device_class"] = "garage"
            return ("open" if is_open else "closed"), attrs
        if code in _COVER_CODES or (isinstance(value, (int, float)) and "percent" in code):
            pos = int(value) if isinstance(value, (int, float)) else 0
            attrs["current_position"] = pos
            attrs["device_class"] = "garage" if TuyaAdapter._is_door_like(name) else "shutter"
            is_open = pos > 0
            if TuyaAdapter._is_door_like(name):
                is_open = not is_open
            return ("open" if is_open else "closed"), attrs
        if code in _TEMP_CODES or code in _SETPOINT_CODES:
            attrs["unit_of_measurement"] = "°C"
            if "temp_set" in status:
                attrs["temperature"] = status.get("temp_set")
            if "temp_current" in status:
                attrs["current_temperature"] = status.get("temp_current")
            return str(value), attrs
        if isinstance(value, bool) or (value in (0, 1) and code in _SWITCH_CODES):
            on = bool(value)
            if TuyaAdapter._is_door_like(name):
                on = not on
                return ("open" if on else "closed"), attrs
            return ("on" if on else "off"), attrs
        return str(value), attrs

    # ------------------------------------------------------------------
    def command(self, device_id: str, commands: list[dict]) -> dict:
        if self.demo:
            return self._demo_command(device_id, commands)
        dev = self.get_device(device_id)
        if not dev:
            self.sync_devices(force=True)
            dev = self.get_device(device_id)
        if not dev:
            raise ValueError(f"Unknown Tuya device: {device_id}")

        used = None
        last_err = None
        can_lan = (
            self.prefer_local
            and _is_private_ip(dev.get("ip") or "")
            and dev.get("local_key")
            and self._lan_dps_ready(dev, commands)
        )
        last_err = None
        tuya_res = None
        used = None
        try:
            tuya_res = self._cloud_command(device_id, commands)
            used = "cloud"
        except Exception as persist:
            last_err = persist
            log.warning("Cloud failed (%s): %s", dev.get("name"), persist)
        if used is None and can_lan:
            try:
                self._local_command(dev, commands)
                used = "lan"
            except Exception as persist:
                last_err = persist
                log.warning("LAN failed (%s): %s", dev.get("name"), persist)
        if used is None:
            raise RuntimeError(str(last_err) or "Tuya command failed")
        log.info("OK %s %s via %s", dev.get("name"), commands, used)

        with self._lock:
            d = self._devices.get(device_id)
            if d:
                st = dict(d.get("status") or {})
                for cmd in commands:
                    code = cmd.get("code")
                    if code is not None:
                        st[str(code)] = cmd.get("value")
                d["status"] = st
                d["source"] = used
                live = st
            else:
                live = {}
        return {
            "ok": True,
            "via": used,
            "device_id": device_id,
            "tuya": tuya_res,
            "status": live,
        }

    @staticmethod
    def _lan_dps_ready(dev: dict, commands: list[dict]) -> bool:
        mapping = dev.get("code_to_dp") or {}
        for cmd in commands:
            code = str(cmd.get("code"))
            dp = code if code.isdigit() else mapping.get(code)
            if not dp or not str(dp).isdigit():
                return False
        return True

    def _cloud_command(self, device_id: str, commands: list[dict]):
        cloud = self._get_cloud()
        if cloud is None:
            raise RuntimeError("Tuya Cloud not connected")
        payload = {"commands": commands}
        attempts = [
            ("iot-03/sendcommand", lambda: cloud.sendcommand(device_id, payload)),
            ("v1.0/devices/commands", lambda: cloud.cloudrequest(
                "/v1.0/devices/%s/commands" % device_id, action="POST", post=payload
            )),
        ]
        last_err = "Cloud command failed"
        for label, send in attempts:
            try:
                res = send()
                err = _tuya_err(res)
                if err:
                    last_err = "%s: %s" % (label, err)
                    continue
                if not (isinstance(res, dict) and res.get("success") is True):
                    last_err = "%s: %s" % (label, res)
                    continue
                return res
            except Exception as persist:
                last_err = "%s: %s" % (label, persist)
        raise RuntimeError(last_err)

    def _local_command(self, dev: dict, commands: list[dict]) -> None:
        if tinytuya is None:
            raise RuntimeError("tinytuya missing")
        code_to_dp = dev.get("code_to_dp") or {}
        d = tinytuya.Device(
            dev_id=dev["id"],
            address=dev["ip"],
            local_key=dev["local_key"],
            version=float(dev.get("version") or 3.3),
        )
        d.set_socketTimeout(2.0)
        d.set_socketPersistent(False)
        for cmd in commands:
            code = str(cmd.get("code"))
            value = cmd.get("value")
            dp = code if code.isdigit() else code_to_dp.get(code)
            if not dp or not str(dp).isdigit():
                raise RuntimeError("LAN needs numeric DP, got %s (map=%s)" % (code, code_to_dp))
            d.set_value(int(dp), value, nowait=False)

    def _demo_command(self, device_id: str, commands: list[dict]) -> dict:
        with self._lock:
            d = self._devices.get(device_id)
            if not d:
                raise ValueError("Unknown demo device: %s" % device_id)
            st = dict(d.get("status") or {})
            for cmd in commands:
                code = str(cmd.get("code"))
                st[code] = cmd.get("value")
                if code == "percent_control":
                    st["percent_state"] = cmd.get("value")
            d["status"] = st
        return {"ok": True, "via": "demo", "device_id": device_id}

    def toggle(self, device_id: str, code: Optional[str] = None) -> dict:
        dev = self.get_device(device_id)
        if not dev:
            self.sync_devices(force=True)
            dev = self.get_device(device_id)
        if not dev:
            raise ValueError("Unknown device %s" % device_id)
        status = dev.get("status") or {}
        if not code:
            code = next((c for c in _SWITCH_CODES if c in status), None)
            if not code:
                for k, v in status.items():
                    if isinstance(v, bool) or v in (0, 1):
                        code = k
                        break
        if not code:
            raise ValueError("No switch code on device")
        current = status.get(code)
        new_val = not bool(current)
        return self.command(device_id, [{"code": code, "value": new_val}])

    def _cover_variants(self, dev: dict, position: int, code: Optional[str]) -> list:
        status = dev.get("status") or {}
        codes = set(dev.get("codes") or []) | set(status.keys()) | set((dev.get("code_to_dp") or {}).keys())
        position = int(position)
        variants = []
        if "percent_control" in codes or code == "percent_control":
            variants.append([{"code": "percent_control", "value": position}])
        if "control" in codes:
            if position >= 99:
                variants.append([{"code": "control", "value": "open"}])
            elif position <= 1:
                variants.append([{"code": "control", "value": "close"}])
            else:
                variants.append([{"code": "percent_control", "value": position}])
        if "position" in codes:
            variants.append([{"code": "position", "value": position}])
        if not variants:
            variants.append([{"code": code or "percent_control", "value": position}])
        seen = []
        out = []
        for v in variants:
            key = str(v)
            if key in seen:
                continue
            seen.append(key)
            out.append(v)
        return out

    def set_cover(self, device_id: str, position: int, code: Optional[str] = None) -> dict:
        position = max(0, min(100, int(position)))
        dev = self.get_device(device_id)
        if not dev:
            self.sync_devices(force=True)
            dev = self.get_device(device_id)
        if not dev:
            raise ValueError("Unknown device %s" % device_id)
        last_err = None
        for cmds in self._cover_variants(dev, position, code):
            try:
                return self.command(device_id, cmds)
            except Exception as persist:
                last_err = persist
                log.warning("FAIL %s %s: %s", dev.get("name"), cmds, persist)
        raise RuntimeError(str(last_err) or "Cover command failed")


adapter = TuyaAdapter()
