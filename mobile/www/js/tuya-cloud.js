/* Tuya Cloud client (HMAC-SHA256). Runs on the tablet — no PC server. */
"use strict";

const TuyaCloud = (() => {
  const HOSTS = {
    eu: "https://openapi.tuyaeu.com",
    "eu-w": "https://openapi-weaz.tuyaeu.com",
    we: "https://openapi-weaz.tuyaeu.com",
    us: "https://openapi.tuyaus.com",
    "us-e": "https://openapi-ueaz.tuyaus.com",
    cn: "https://openapi.tuyacn.com",
    in: "https://openapi.tuyain.com",
  };

  const SWITCH_CODES = ["switch_1", "switch_2", "switch_3", "switch_4", "switch_led", "switch", "led_switch", "power"];
  const COVER_CODES = ["percent_control", "percent_state", "position", "curtain_percent"];
  const DOOR_CODES = ["doorcontact_state", "doorcontact", "door_contact", "door_state", "closed"];
  const DOOR_HINTS = ["garaje", "garage", "puerta", "porton", "door", "gate", "cancel"];

  const state = {
    accessId: "",
    accessSecret: "",
    region: "eu",
    token: "",
    tokenExpire: 0,
    devices: {},
    connected: false,
    demo: true,
    lastError: "",
  };

  function norm(s) {
    return String(s || "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "");
  }

  function isDoorLike(name) {
    const n = norm(name);
    return DOOR_HINTS.some((h) => n.includes(norm(h)));
  }

  function toHex(buf) {
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  async function sha256Hex(str) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str || ""));
    return toHex(buf);
  }

  async function hmacSha256Hex(secret, msg) {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const sig = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
    return toHex(sig).toUpperCase();
  }

  async function nativeRequest(url, method, headers, bodyStr) {
    const cap = window.Capacitor;
    if (cap && cap.isNativePlatform && cap.isNativePlatform()) {
      const Http = (cap.Plugins && cap.Plugins.CapacitorHttp) || window.CapacitorHttp;
      if (Http && Http.request) {
        const res = await Http.request({
          url,
          method,
          headers: headers || {},
          data: bodyStr ? JSON.parse(bodyStr) : undefined,
          connectTimeout: 15000,
          readTimeout: 15000,
        });
        return { status: res.status, data: res.data };
      }
    }
    const res = await fetch(url, { method, headers, body: bodyStr || undefined });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  }

  async function signedRequest(method, path, bodyObj, query) {
    const host = HOSTS[state.region] || HOSTS.eu;
    let qs = "";
    if (query) {
      const keys = Object.keys(query).sort();
      qs = keys.map((k) => `${k}=${query[k]}`).join("&");
    }
    const url = host + path + (qs ? `?${qs}` : "");
    const bodyStr = bodyObj ? JSON.stringify(bodyObj) : "";
    const now = Date.now().toString();
    const contentSha = await sha256Hex(bodyStr);
    const signPath = path + (qs ? `?${qs}` : "");
    let payload = state.token
      ? state.accessId + state.token + now
      : state.accessId + now;
    payload += `${method}\n${contentSha}\n\n${signPath}`;
    const sign = await hmacSha256Hex(state.accessSecret, payload);
    const headers = {
      client_id: state.accessId,
      sign,
      t: now,
      sign_method: "HMAC-SHA256",
      lang: "en",
    };
    if (state.token) headers.access_token = state.token;
    if (bodyStr) headers["Content-Type"] = "application/json";
    return nativeRequest(url, method, headers, bodyStr);
  }

  function seedDemo() {
    state.demo = true;
    state.connected = true;
    state.devices = {
      demo_switch: {
        id: "demo_switch",
        name: "Interruptor demo",
        category: "kg",
        status: { switch_1: false },
        online: true,
      },
      demo_light: {
        id: "demo_light",
        name: "Luz demo",
        category: "dj",
        status: { switch_led: true, bright_value: 400 },
        online: true,
      },
      demo_cover: {
        id: "demo_cover",
        name: "Persiana demo",
        category: "cl",
        status: { percent_control: 0, percent_state: 0, control: "stop" },
        online: true,
      },
      demo_climate: {
        id: "demo_climate",
        name: "Clima demo",
        category: "wk",
        status: { temp_current: 21.5, temp_set: 22, switch: true },
        online: true,
      },
    };
  }

  seedDemo();

  async function ensureToken() {
    if (state.token && Date.now() < state.tokenExpire - 60000) return;
    state.token = "";
    const res = await signedRequest("GET", "/v1.0/token", null, { grant_type: 1 });
    const data = res.data || {};
    if (!data.success || !data.result || !data.result.access_token) {
      throw new Error(data.msg || data.Payload || "No se pudo obtener token Tuya");
    }
    state.token = data.result.access_token;
    const expire = Number(data.result.expire_time || 7200);
    state.tokenExpire = Date.now() + expire * 1000;
  }

  function normalizeStatus(raw) {
    const out = {};
    if (Array.isArray(raw)) {
      raw.forEach((item) => {
        if (item && item.code != null) out[String(item.code)] = item.value;
      });
      return out;
    }
    if (raw && typeof raw === "object") {
      if (Array.isArray(raw.result)) return normalizeStatus(raw.result);
      if (raw.status) return normalizeStatus(raw.status);
      Object.keys(raw).forEach((k) => {
        if (!["success", "t", "tid", "code", "msg"].includes(k)) out[k] = raw[k];
      });
    }
    return out;
  }

  async function configure(cfg) {
    state.accessId = (cfg.access_id || "").trim();
    state.accessSecret = (cfg.access_secret || "").trim() || state.accessSecret;
    state.region = (cfg.region || "eu").trim();
    state.token = "";
    state.lastError = "";
    if (!state.accessId || !state.accessSecret) {
      seedDemo();
      return publicStatus();
    }
    state.demo = false;
    try {
      await ensureToken();
      state.connected = true;
      await syncDevices();
    } catch (err) {
      state.lastError = String(err.message || err);
      state.connected = false;
      seedDemo();
      state.lastError = String(err.message || err);
    }
    return publicStatus();
  }

  async function syncDevices() {
    if (state.demo) return listDevices();
    await ensureToken();
    const res = await signedRequest("GET", "/v1.0/iot-01/associated-users/devices", null, { size: 50 });
    const data = res.data || {};
    if (!data.success) throw new Error(data.msg || "No se pudieron listar dispositivos");
    const result = data.result || {};
    const arr = result.devices || result.list || [];
    const map = {};
    arr.forEach((d) => {
      if (!d || !d.id) return;
      map[d.id] = {
        id: d.id,
        name: d.name || d.id,
        category: d.category || "",
        online: !!d.online,
        status: normalizeStatus(d.status || []),
      };
    });
    state.devices = map;
    state.connected = true;
    return listDevices();
  }

  async function refreshStatuses() {
    if (state.demo) return listDevices();
    if (!state.accessId) return listDevices();
    try {
      await ensureToken();
      const ids = Object.keys(state.devices).slice(0, 20);
      if (!ids.length) return syncDevices();
      for (const id of ids) {
        try {
          const res = await signedRequest("GET", `/v1.0/iot-03/devices/${id}/status`);
          const st = normalizeStatus(res.data);
          if (Object.keys(st).length && state.devices[id]) state.devices[id].status = st;
        } catch (_) { /* keep cached */ }
      }
    } catch (err) {
      state.lastError = String(err.message || err);
      state.connected = false;
    }
    return listDevices();
  }

  async function command(deviceId, commands) {
    if (state.demo) {
      const d = state.devices[deviceId];
      if (!d) throw new Error("Unknown demo device");
      commands.forEach((c) => {
        d.status[c.code] = c.value;
        if (c.code === "percent_control") d.status.percent_state = c.value;
      });
      return { ok: true, via: "demo", device_id: deviceId };
    }
    await ensureToken();
    const payload = { commands };
    let res = await signedRequest("POST", `/v1.0/iot-03/devices/${deviceId}/commands`, payload);
    let data = res.data || {};
    if (!data.success) {
      res = await signedRequest("POST", `/v1.0/devices/${deviceId}/commands`, payload);
      data = res.data || {};
    }
    if (!data.success) throw new Error(data.msg || "Tuya command failed");
    const d = state.devices[deviceId];
    if (d) {
      commands.forEach((c) => {
        d.status[c.code] = c.value;
      });
    }
    return { ok: true, via: "cloud", device_id: deviceId, tuya: data };
  }

  function listDevices() {
    return Object.values(state.devices).map((d) => ({
      id: d.id,
      name: d.name,
      category: d.category,
      online: d.online,
      status: d.status,
      codes: Object.keys(d.status || {}),
    }));
  }

  function publicStatus() {
    return {
      demo: state.demo,
      connected: state.connected,
      region: state.region,
      device_count: Object.keys(state.devices).length,
      last_error: state.lastError,
      prefer_local: false,
    };
  }

  function publicConfig() {
    return {
      access_id: state.accessId,
      access_secret: state.accessSecret ? "********" : "",
      region: state.region,
      uid: "",
      prefer_local: false,
    };
  }

  function inferCode(device, domain) {
    const status = device.status || {};
    const codes = Object.keys(status);
    if (["cover", "curtain", "garage", "door"].includes(domain)) {
      for (const c of COVER_CODES) if (c in status) return c;
    }
    if (["light", "switch", "button"].includes(domain)) {
      for (const c of SWITCH_CODES) if (c in status) return c;
    }
    return codes[0] || null;
  }

  function resolveEntity(entityId, domainHint) {
    const eid = (entityId || "").trim();
    if (!eid) throw new Error("Sin entity_id");
    const parts = eid.split(".");
    if (parts[0] === "tuya" && parts[1]) return { id: parts[1], code: parts[2] || null };
    if (state.devices[eid]) return { id: eid, code: null };
    const slug = norm(parts[parts.length - 1]);
    const domain = parts.length > 1 ? parts[0] : domainHint || "";
    for (const d of Object.values(state.devices)) {
      const nd = norm(d.name);
      if (slug === nd || (slug && nd && (nd.includes(slug) || slug.includes(nd)))) {
        return { id: d.id, code: inferCode(d, domain) };
      }
    }
    throw new Error("No hay dispositivo Tuya para " + eid);
  }

  function valueIsOpen(v) {
    const s = String(v).toLowerCase();
    if (["open", "opened", "on", "true", "1"].includes(s)) return true;
    if (["closed", "close", "off", "false", "0", "stop"].includes(s)) return false;
    return !!v;
  }

  function deviceIsOn(d) {
    const status = d.status || {};
    for (const c of DOOR_CODES) {
      if (c in status) {
        if (c === "closed") return !valueIsOpen(status[c]);
        return valueIsOpen(status[c]);
      }
    }
    const door = isDoorLike(d.name);
    for (const c of SWITCH_CODES) {
      if (c in status) {
        const val = typeof status[c] === "string" ? valueIsOpen(status[c]) : !!status[c];
        return door ? !val : val;
      }
    }
    const pos = status.percent_state != null ? status.percent_state : status.percent_control;
    if (typeof pos === "number") return door ? !(pos > 0) : pos > 0;
    return false;
  }

  function toHaState(d, code, value) {
    const attrs = { friendly_name: `${d.name} ${code}`, device_id: d.id, code };
    if (DOOR_CODES.includes(code)) {
      let open = valueIsOpen(value);
      if (code === "closed") open = !open;
      return { state: open ? "open" : "closed", attributes: attrs };
    }
    if (COVER_CODES.includes(code) || (typeof value === "number" && String(code).includes("percent"))) {
      const pos = Number(value) || 0;
      attrs.current_position = pos;
      let open = pos > 0;
      if (isDoorLike(d.name)) open = !open;
      return { state: open ? "open" : "closed", attributes: attrs };
    }
    if (typeof value === "boolean" || value === 0 || value === 1) {
      let on = !!value;
      if (isDoorLike(d.name)) on = !on;
      return { state: isDoorLike(d.name) ? (on ? "open" : "closed") : on ? "on" : "off", attributes: attrs };
    }
    return { state: String(value), attributes: attrs };
  }

  function haStyleStates() {
    const states = [];
    Object.values(state.devices).forEach((d) => {
      const status = d.status || {};
      Object.keys(status).forEach((code) => {
        const ha = toHaState(d, code, status[code]);
        states.push({ entity_id: `tuya.${d.id}.${code}`, state: ha.state, attributes: ha.attributes });
      });
      states.push({
        entity_id: `tuya.${d.id}`,
        state: deviceIsOn(d) ? "on" : "off",
        attributes: { friendly_name: d.name, device_id: d.id },
      });
      const slug = norm(d.name);
      if (slug) {
        const domain = COVER_CODES.some((c) => c in status) || isDoorLike(d.name) ? "cover" : "switch";
        const code = inferCode(d, domain);
        const ha = code && code in status
          ? toHaState(d, code, status[code])
          : { state: deviceIsOn(d) ? "on" : "off", attributes: { device_id: d.id } };
        states.push({ entity_id: `${domain}.${slug}`, state: ha.state, attributes: ha.attributes });
      }
    });
    return states;
  }

  async function setCover(deviceId, position, code) {
    position = Math.max(0, Math.min(100, parseInt(position, 10) || 0));
    const d = state.devices[deviceId];
    const status = (d && d.status) || {};
    let use = code;
    if (!use || use === "percent_state") {
      use = COVER_CODES.find((c) => c !== "percent_state" && c in status) || "percent_control";
    }
    if (use === "position" && !("position" in status)) use = "percent_control";
    return command(deviceId, [{ code: use, value: position }]);
  }

  async function toggle(deviceId, code) {
    const d = state.devices[deviceId];
    if (!d) throw new Error("Unknown device");
    const status = d.status || {};
    let use = code;
    if (!use) use = SWITCH_CODES.find((c) => c in status);
    if (!use) throw new Error("No switch code");
    return command(deviceId, [{ code: use, value: !status[use] }]);
  }

  return {
    configure,
    syncDevices,
    refreshStatuses,
    command,
    setCover,
    toggle,
    listDevices,
    publicStatus,
    publicConfig,
    resolveEntity,
    haStyleStates,
    seedDemo,
    get state() { return state; },
  };
})();
