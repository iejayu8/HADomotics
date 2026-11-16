/* Cliente de Tuya Cloud OpenAPI (IoT Core / Smart Home) con las credenciales
 * PROPIAS del usuario (Access ID + Access Secret de su proyecto Cloud, con su
 * cuenta Smart Life / Tuya vinculada). Nada de claves en el repositorio.
 *
 * - Token: GET /v1.0/token?grant_type=1 y renovación GET /v1.0/token/{refresh_token}.
 * - Dispositivos de las cuentas vinculadas: GET /v1.0/iot-01/associated-users/devices
 *   (paginado con last_row_key). Incluye subdispositivos Zigbee de una pasarela Tuya.
 * - Estado por lotes (20 por llamada): GET /v1.0/iot-03/devices/status?device_ids=…
 * - Especificación (rangos, escalas, enums): GET /v1.0/iot-03/devices/{id}/specification
 * - Órdenes: POST /v1.0/iot-03/devices/{id}/commands  {commands:[{code, value}]}
 * - Escenas «tap-to-run»: GET /v1.1/homes/{home_id}/scenes,
 *   POST /v1.0/homes/{home_id}/scenes/{scene_id}/trigger
 *
 * El transporte HTTP se inyecta (CapacitorHttp nativo en Android, sin CORS;
 * un servidor simulado en los tests y en el modo demo). Cuenta las llamadas para
 * respetar la cuota mensual (la edición Trial de IoT Core da ~26.000 llamadas/mes).
 * Los mensajes de error nunca incluyen el secreto ni el token. */
(function (root) {
  "use strict";
  if (!root.HDX && typeof require === "function") require("../core/umd.js");
  const HDX = root.HDX;
  const sign = HDX.tuyaSign || require("./sign.js");

  const ENDPOINTS = {
    eu: "https://openapi.tuyaeu.com",
    "eu-w": "https://openapi-weaz.tuyaeu.com",
    us: "https://openapi.tuyaus.com",
    "us-e": "https://openapi-ueaz.tuyaus.com",
    cn: "https://openapi.tuyacn.com",
    in: "https://openapi.tuyain.com",
    sg: "https://openapi-sg.iotbing.com",
  };
  // Códigos de error de Tuya que significan «token caducado/no válido».
  const TOKEN_ERRORS = new Set([1010, 1011, 1012]);

  class TuyaError extends Error {
    constructor(code, msg, path) {
      super(`Tuya ${code || "?"}: ${msg || "error"}${path ? " (" + path + ")" : ""}`);
      this.code = code;
      this.path = path;
    }
  }

  function uuidHex() {
    const c = globalThis.crypto;
    if (c && c.randomUUID) return c.randomUUID().replace(/-/g, "");
    let s = "";
    for (let i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16);
    return s;
  }

  function redact(text, secrets) {
    let out = String(text == null ? "" : text);
    (secrets || []).forEach((s) => {
      if (s && s.length >= 4) out = out.split(s).join("***");
    });
    return out;
  }

  class TuyaCloud {
    /**
     * @param {object} o accessId, secret, region|endpoint, http(req)->{status,data},
     *   now()->ms, nonce()->string, onCall(path), log(msg)
     */
    constructor(o) {
      this.accessId = String(o.accessId || "").trim();
      this.secret = String(o.secret || "").trim();
      this.endpoint = o.endpoint || ENDPOINTS[o.region || "eu"] || ENDPOINTS.eu;
      this.http = o.http;
      this.now = o.now || (() => Date.now());
      this.nonce = o.nonce || uuidHex;
      this.onCall = o.onCall || (() => {});
      this.log = o.log || (() => {});
      this.token = null; // { access, refresh, expiresAt, uid }
      if (!this.accessId || !this.secret) throw new Error("Faltan Access ID / Access Secret");
      if (typeof this.http !== "function") throw new Error("Falta el transporte HTTP");
    }

    async _raw(method, path, query, bodyObj, withToken) {
      const body = bodyObj ? JSON.stringify(bodyObj) : "";
      const signed = await sign.signRequest({
        clientId: this.accessId,
        secret: this.secret,
        accessToken: withToken && this.token ? this.token.access : "",
        t: String(this.now()),
        nonce: this.nonce(),
        method,
        path,
        query,
        body,
      });
      const headers = Object.assign({ lang: "es" }, signed.headers);
      if (body) headers["Content-Type"] = "application/json";
      this.onCall(path);
      let res;
      try {
        res = await this.http({ url: this.endpoint + signed.url, method, headers, body });
      } catch (err) {
        throw new TuyaError("net", redact(err && err.message, [this.secret, this.token && this.token.access]), path);
      }
      let data = res && res.data;
      if (typeof data === "string") {
        try { data = JSON.parse(data); } catch (_) { data = { success: false, msg: "respuesta no JSON" }; }
      }
      return { status: res ? res.status : 0, data: data || {} };
    }

    async ensureToken() {
      const now = this.now();
      if (this.token && now < this.token.expiresAt - 60000) return this.token;
      let res;
      if (this.token && this.token.refresh) {
        res = await this._raw("GET", `/v1.0/token/${this.token.refresh}`, null, null, false);
        if (!res.data.success) this.token = null;
      }
      if (!this.token || !res || !res.data.success) {
        res = await this._raw("GET", "/v1.0/token", { grant_type: 1 }, null, false);
      }
      const d = res.data;
      if (!d.success || !d.result || !d.result.access_token) {
        this.token = null;
        throw new TuyaError(d.code, d.msg || "no se pudo obtener el token", "/v1.0/token");
      }
      this.token = {
        access: d.result.access_token,
        refresh: d.result.refresh_token,
        expiresAt: now + Number(d.result.expire_time || 7200) * 1000,
        uid: d.result.uid,
      };
      return this.token;
    }

    /** Petición de negocio firmada; reintenta una vez si el token caducó. */
    async request(method, path, query, body) {
      await this.ensureToken();
      let res = await this._raw(method, path, query, body, true);
      if (!res.data.success && TOKEN_ERRORS.has(Number(res.data.code))) {
        this.token = null;
        await this.ensureToken();
        res = await this._raw(method, path, query, body, true);
      }
      if (!res.data.success) throw new TuyaError(res.data.code, res.data.msg, path);
      return res.data.result;
    }

    /** Todos los dispositivos de las cuentas Smart Life/Tuya vinculadas al proyecto. */
    async listDevices() {
      const out = [];
      let lastRowKey = "";
      for (let page = 0; page < 50; page++) {
        const r = await this.request("GET", "/v1.0/iot-01/associated-users/devices", { size: 100, last_row_key: lastRowKey });
        const list = (r && (r.devices || r.list)) || [];
        list.forEach((d) => d && d.id && out.push(d));
        if (!r || !r.has_more || !r.last_row_key) break;
        lastRowKey = r.last_row_key;
      }
      return out;
    }

    /** Estado de varios dispositivos (lotes de 20). Devuelve {id: {code: value}}. */
    async getStatuses(ids) {
      const out = {};
      for (let i = 0; i < ids.length; i += 20) {
        const chunk = ids.slice(i, i + 20);
        const r = await this.request("GET", "/v1.0/iot-03/devices/status", { device_ids: chunk.join(",") });
        (Array.isArray(r) ? r : []).forEach((item) => {
          if (!item || !item.id) return;
          out[item.id] = statusArrayToMap(item.status);
        });
      }
      return out;
    }

    async getSpecification(id) {
      return this.request("GET", `/v1.0/iot-03/devices/${encodeURIComponent(id)}/specification`);
    }

    async sendCommands(id, commands) {
      if (!Array.isArray(commands) || !commands.length) throw new Error("sin órdenes");
      return this.request("POST", `/v1.0/iot-03/devices/${encodeURIComponent(id)}/commands`, null, { commands });
    }

    async listScenes(homeId) {
      const r = await this.request("GET", `/v1.1/homes/${encodeURIComponent(homeId)}/scenes`);
      return Array.isArray(r) ? r : [];
    }

    async triggerScene(homeId, sceneId) {
      return this.request("POST", `/v1.0/homes/${encodeURIComponent(homeId)}/scenes/${encodeURIComponent(sceneId)}/trigger`);
    }
  }

  function statusArrayToMap(raw) {
    const out = {};
    if (Array.isArray(raw)) raw.forEach((s) => { if (s && s.code != null) out[String(s.code)] = s.value; });
    else if (raw && typeof raw === "object") Object.assign(out, raw);
    return out;
  }

  const api = { TuyaCloud, TuyaError, ENDPOINTS, statusArrayToMap, redact };
  HDX.define("tuyaCloud", () => api);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
