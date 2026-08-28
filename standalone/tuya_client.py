"""Tuya Cloud + LAN adapter for HADomotics Standalone.

Cloud is always available (OpenAPI via tinytuya.Cloud).
LAN (same Wi-Fi) is used first when we have IP + local_key, with a short timeout,
then we fall back to Cloud.
"""
from __future__ import annotations

import logging
import threading
import time
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
            cloud = tinytuya.Cloud(
                apiRegion=self.region,
                apiKey=self.access_id,
                apiSecret=self.access_secret,
                apiDeviceID=self.uid or "dummy",
            )
            # Tiny ping: list devices
            res = cloud.getdevices()
            if isinstance(res, dict) and res.get("success") is False:
                return str(res.get("msg") or res.get("error") or "Cloud auth failed")
            with self._lock:
                self._cloud_api = cloud
                self.connected = True
                self.last_error = ""
            log.info("Tuya Cloud connected (region=%s)", self.region)
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
        if not force and time.time() - self._last_sync < 8:
            return self.list_devices()
        cloud = self._get_cloud()
        if cloud is None:
            err = self._connect_cloud()
            if err:
                return self.list_devices()
            cloud = self._get_cloud()
        try:
            raw = cloud.getdevices()
            devices_in = raw if isinstance(raw, list) else (raw.get("result") or raw.get("devices") or [])
            new_map: dict[str, dict] = {}
            for d in devices_in:
                if not isinstance(d, dict):
                    continue
                did = d.get("id") or d.get("devId") or d.get("device_id")
                if not did:
                    continue
                status = self._normalize_status(d.get("status") or [])
                # fetch live status
                try:
                    st = cloud.getstatus(did)
                    status = self._normalize_status(st) or status
                except Exception:
                    pass
                codes = list(status.keys())
                new_map[did] = {
                    "id": did,
                    "name": d.get("name") or did,
                    "category": d.get("category") or "",
                    "online": bool(d.get("online", True)),
                    "ip": d.get("ip") or d.get("ip_addr") or "",
                    "local_key": d.get("key") or d.get("local_key") or "",
                    "version": str(d.get("version") or d.get("protocol_version") or "3.3"),
                    "status": status,
                    "codes": codes,
                    "source": "cloud",
                }
            with self._lock:
                self._devices = new_map
                self._last_sync = time.time()
                self.connected = True
                self.last_error = ""
            # optional LAN scan to fill IPs
            if self.prefer_local:
                self._scan_lan_ips()
        except Exception as exc:
            log.warning("sync_devices failed: %s", exc)
            with self._lock:
                self.last_error = str(exc)
                self.connected = False
        return self.list_devices()

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
        out: dict[str, Any] = {}
        if isinstance(status, dict):
            if "result" in status:
                return TuyaAdapter._normalize_status(status.get("result"))
            if "dps" in status and isinstance(status["dps"], dict):
                for k, v in status["dps"].items():
                    out[str(k)] = v
            else:
                for k, v in status.items():
                    if k in ("dps", "success", "t", "tid"):
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
        self.sync_devices()
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
                "state": "on" if self._device_is_on(status) else "off",
                "attributes": {
                    "friendly_name": d.get("name"),
                    "device_id": d["id"],
                    "category": d.get("category"),
                    "source": d.get("source"),
                    "online": d.get("online", True),
                    **{f"dp_{k}": v for k, v in status.items()},
                },
            })
        return states

    @staticmethod
    def _device_is_on(status: dict) -> bool:
        for c in _SWITCH_CODES:
            if c in status:
                return bool(status[c])
        pos = status.get("percent_control", status.get("percent_state"))
        if isinstance(pos, (int, float)):
            return pos > 0
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
        if code in _COVER_CODES or isinstance(value, (int, float)) and "percent" in code:
            pos = int(value) if isinstance(value, (int, float)) else 0
            attrs["current_position"] = pos
            attrs["device_class"] = "shutter"
            state = "open" if pos > 0 else "closed"
            return state, attrs
        if code in _TEMP_CODES or code in _SETPOINT_CODES:
            attrs["unit_of_measurement"] = "°C"
            if "temp_set" in status:
                attrs["temperature"] = status.get("temp_set")
            if "temp_current" in status:
                attrs["current_temperature"] = status.get("temp_current")
            return str(value), attrs
        if isinstance(value, bool):
            return ("on" if value else "off"), attrs
        if value in (0, 1) and code in _SWITCH_CODES:
            return ("on" if value else "off"), attrs
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
        if self.prefer_local and dev.get("ip") and dev.get("local_key"):
            try:
                self._local_command(dev, commands)
                used = "lan"
            except Exception as exc:
                last_err = exc
                log.info("LAN command failed, falling back to cloud: %s", exc)

        if used is None:
            cloud = self._get_cloud()
            if cloud is None:
                raise RuntimeError(last_err or "Tuya Cloud not connected")
            payload = {"commands": commands}
            res = cloud.sendcommand(device_id, payload)
            if isinstance(res, dict) and res.get("success") is False:
                raise RuntimeError(res.get("msg") or "Cloud command failed")
            used = "cloud"

        # optimistic local cache update
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
        return {"ok": True, "via": used, "device_id": device_id}

    def _local_command(self, dev: dict, commands: list[dict]) -> None:
        if tinytuya is None:
            raise RuntimeError("tinytuya missing")
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
            # tinytuya set_value wants numeric DP; try mapping code→id via status keys
            dp = code
            if not str(code).isdigit():
                # send via index if we only have names — cloud fallback will handle names
                raise RuntimeError(f"LAN needs numeric DP, got {code}")
            d.set_value(int(dp), value, nowait=False)

    def _demo_command(self, device_id: str, commands: list[dict]) -> dict:
        with self._lock:
            d = self._devices.get(device_id)
            if not d:
                raise ValueError(f"Unknown demo device: {device_id}")
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
            raise ValueError(f"Unknown device {device_id}")
        status = dev.get("status") or {}
        if not code:
            code = next((c for c in _SWITCH_CODES if c in status), None)
            if not code:
                # first boolean-like
                for k, v in status.items():
                    if isinstance(v, bool) or v in (0, 1):
                        code = k
                        break
        if not code:
            raise ValueError("No switch code on device")
        current = status.get(code)
        new_val = not bool(current)
        return self.command(device_id, [{"code": code, "value": new_val}])

    def set_cover(self, device_id: str, position: int, code: Optional[str] = None) -> dict:
        position = max(0, min(100, int(position)))
        dev = self.get_device(device_id)
        if not dev:
            self.sync_devices(force=True)
            dev = self.get_device(device_id)
        if not dev:
            raise ValueError(f"Unknown device {device_id}")
        status = dev.get("status") or {}
        if not code:
            code = next((c for c in _COVER_CODES if c in status), "percent_control")
        return self.command(device_id, [{"code": code, "value": position}])


adapter = TuyaAdapter()
