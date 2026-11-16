/* Servidor Tuya Cloud SIMULADO (en memoria). Comprueba la firma de cada petición
 * igual que el servidor real (misma especificación) y responde con el formato
 * oficial de la OpenAPI. Lo usan los tests y el «modo demo» de la app: así el modo
 * demo ejercita el mismo cliente (firma, token, paginación, lotes, órdenes) que con
 * una cuenta real. No se conecta a ningún sitio. */
(function (root) {
  "use strict";
  if (!root.HDX && typeof require === "function") require("../core/umd.js");
  const HDX = root.HDX;
  const sign = HDX.tuyaSign || require("./sign.js");
  const demo = HDX.demoHome || require("./demo-home.js");

  class MockTuyaServer {
    constructor(o) {
      const opt = o || {};
      this.accessId = opt.accessId || demo.DEMO_ACCESS_ID;
      this.secret = opt.secret || demo.DEMO_SECRET;
      this.devices = JSON.parse(JSON.stringify(opt.devices || demo.devices()));
      this.specs = opt.specs || demo.SPECS;
      this.scenes = opt.scenes || demo.SCENES;
      this.pageSize = opt.pageSize || 100;
      this.now = opt.now || (() => Date.now());
      this.tokens = new Map();
      this.calls = [];
      this.commands = [];
      this.failNext = null; // {code, msg} para simular errores
      this.tokenSeq = 0;
      this.expireTime = opt.expireTime || 7200;
    }

    handler() { return (req) => this.handle(req); }

    _status(dev, code) {
      const s = dev.status.find((x) => x.code === code);
      return s ? s.value : undefined;
    }

    setStatus(devId, code, value) {
      const dev = this.devices.find((d) => d.id === devId);
      if (!dev) throw new Error("no device " + devId);
      const s = dev.status.find((x) => x.code === code);
      if (s) s.value = value; else dev.status.push({ code, value });
    }

    async handle(req) {
      const u = new URL(req.url);
      const path = u.pathname;
      const query = {};
      u.searchParams.forEach((v, k) => { query[k] = v; });
      const h = req.headers || {};
      this.calls.push({ method: req.method, path, query });
      const fail = (code, msg) => ({ status: 200, data: { success: false, code, msg, t: this.now() } });
      const ok = (result) => ({ status: 200, data: { success: true, result, t: this.now() } });
      if (this.failNext) { const f = this.failNext; this.failNext = null; return fail(f.code, f.msg); }
      if (h.client_id !== this.accessId) return fail(1005, "clientId is invalid");
      const isToken = path.startsWith("/v1.0/token");
      const access = isToken ? "" : h.access_token || "";
      const expected = await sign.signRequest({
        clientId: this.accessId, secret: this.secret, accessToken: access, t: h.t, nonce: h.nonce || "",
        method: req.method, path, query, body: req.body || "",
      });
      if (expected.sign !== h.sign) return fail(1004, "sign invalid");
      if (Math.abs(Number(h.t) - this.now()) > 15 * 60000) return fail(1013, "request time is invalid");
      if (isToken) {
        const parts = path.split("/");
        if (parts.length === 4 && parts[3]) {
          const rt = parts[3];
          const prev = [...this.tokens.values()].find((t) => t.refresh === rt);
          if (!prev) return fail(1012, "token invalid");
        } else if (query.grant_type !== "1") return fail(1106, "permission deny");
        const tok = { access: "tok" + (++this.tokenSeq), refresh: "ref" + this.tokenSeq, exp: this.now() + this.expireTime * 1000 };
        this.tokens.set(tok.access, tok);
        return ok({ access_token: tok.access, refresh_token: tok.refresh, expire_time: this.expireTime, uid: "demo_uid" });
      }
      const tok = this.tokens.get(access);
      if (!tok || tok.exp < this.now()) return fail(1010, "token invalid");
      let body = {};
      if (req.body) { try { body = JSON.parse(req.body); } catch (_) { return fail(1109, "param is illegal"); } }

      if (req.method === "GET" && path === "/v1.0/iot-01/associated-users/devices") {
        const size = Math.min(Number(query.size) || 20, this.pageSize);
        const start = query.last_row_key ? Number(query.last_row_key) : 0;
        const list = this.devices.slice(start, start + size).map((d) => JSON.parse(JSON.stringify(d)));
        const next = start + size;
        return ok({ devices: list, has_more: next < this.devices.length, last_row_key: next < this.devices.length ? String(next) : "" });
      }
      if (req.method === "GET" && path === "/v1.0/iot-03/devices/status") {
        const ids = String(query.device_ids || "").split(",").filter(Boolean);
        if (ids.length > 20) return fail(1109, "param is illegal");
        return ok(ids.map((id) => this.devices.find((d) => d.id === id)).filter(Boolean).map((d) => ({ id: d.id, status: JSON.parse(JSON.stringify(d.status)) })));
      }
      let m = path.match(/^\/v1\.0\/iot-03\/devices\/([^/]+)\/specification$/);
      if (m && req.method === "GET") {
        const dev = this.devices.find((d) => d.id === decodeURIComponent(m[1]));
        if (!dev) return fail(2009, "device not exist");
        const s = this.specs[dev.category] || { functions: [], status: [] };
        return ok({ category: dev.category, functions: s.functions, status: s.status });
      }
      m = path.match(/^\/v1\.0\/iot-03\/devices\/([^/]+)\/commands$/);
      if (m && req.method === "POST") {
        const dev = this.devices.find((d) => d.id === decodeURIComponent(m[1]));
        if (!dev) return fail(2009, "device not exist");
        if (!dev.online) return fail(2001, "device is offline");
        const cmds = body.commands || [];
        for (const c of cmds) {
          if (this._status(dev, c.code) === undefined) return fail(2008, "command or value not support");
        }
        cmds.forEach((c) => {
          this.setStatus(dev.id, c.code, c.value);
          if (c.code === "percent_control") this.setStatus(dev.id, "percent_state", c.value);
          if (dev.category === "ckmkzq" && c.code === "switch_1") this.setStatus(dev.id, "doorcontact_state", !!c.value);
        });
        this.commands.push({ id: dev.id, commands: cmds });
        return ok(true);
      }
      m = path.match(/^\/v1\.1\/homes\/([^/]+)\/scenes$/);
      if (m && req.method === "GET") return ok(this.scenes);
      m = path.match(/^\/v1\.0\/homes\/([^/]+)\/scenes\/([^/]+)\/trigger$/);
      if (m && req.method === "POST") {
        this.commands.push({ scene: decodeURIComponent(m[2]) });
        return ok(true);
      }
      return fail(1108, "uri path invalid");
    }

    /** Pequeña simulación para el modo demo: movimiento, carga del coche, consumo. */
    simulate(rand) {
      const r = rand || Math.random;
      ["demo_pir_entrada", "demo_pir_salon", "demo_pir_pasillo"].forEach((id) => {
        this.setStatus(id, "pir", r() < 0.15 ? "pir" : "none");
      });
      const charging = this._status(this.devices.find((d) => d.id === "demo_cargador"), "work_state") === "charger_charging";
      if (r() < 0.05) this.setStatus("demo_cargador", "work_state", charging ? "charger_insert" : "charger_charging");
      const nowCharging = this._status(this.devices.find((d) => d.id === "demo_cargador"), "work_state") === "charger_charging";
      this.setStatus("demo_cargador", "power_total", nowCharging ? 6900 + Math.round(r() * 600) : 0);
      const dep = this._status(this.devices.find((d) => d.id === "demo_depuradora"), "switch_1");
      this.setStatus("demo_depuradora", "cur_power", dep ? 7200 + Math.round(r() * 300) : 0);
      const houseKw = 0.4 + r() * 0.6 + (nowCharging ? 7 : 0) + (dep ? 0.75 : 0);
      this.setStatus("demo_contador", "phase_a", demo.phaseA(229 + r() * 3, houseKw * 1000 / 230, houseKw));
    }
  }

  const api = { MockTuyaServer };
  HDX.define("mockTuya", () => api);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
