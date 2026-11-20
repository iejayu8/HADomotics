/* «Adaptador Tuya directo»: hace de Home Assistant dentro del móvil.
 * Mantiene los estados (forma HA), sondea Tuya Cloud respetando la cuota, recibe
 * los cambios push del servicio nativo (Pulsar), ejecuta servicios estilo HA como
 * órdenes Tuya y aloja el motor de alarma. El frontend del add-on no sabe que no
 * hay HA: le hablamos con la misma API (/api/...). */
(function (root) {
  "use strict";
  if (!root.HDX && typeof require === "function") require("../core/umd.js");
  const HDX = root.HDX;
  const cloudMod = HDX.tuyaCloud || require("../tuya/cloud.js");
  const mapper = HDX.tuyaMapper || require("../tuya/mapper.js");
  const alarmMod = HDX.alarmEngine || require("../alarm/engine.js");
  const energy = HDX.energyFlow || require("../energy/flow.js");

  const SPEC_CATS = new Set(["dj", "dd", "xdd", "fwd", "dc", "sgbj", "qccdz", "cz", "pc", "kg", "wk", "wkf", "cl", "zndb", "dlq"]);
  const SECURITY_CLASSES = new Set(["motion", "occupancy", "door", "window", "opening"]);

  const DEFAULT_SETTINGS = {
    version: 1,
    mode: "unconfigured", // unconfigured | demo | tuya
    onboarded: false,
    tuya: { region: "eu", configured: false },
    poll: { foreground_s: 60, budget_month: 24000 },
    alarm: {
      name: "Panel de Alarma",
      exit_delay: { armed_night: 10, armed_away: 30 },
      entry_delay: 0,
      trigger_time: 180,
      code_hash: null,
      code_arm_required: false,
      zones: [],
      siren: { entity: null },
      watchdog_minutes: 5,
    },
    energy: {},
    evse: { enabled: false },
    background: { enabled: false, pulsar: false, poll_s: 180 },
  };

  /** Módulos de la app. Falta (instalación de 0.1.1 o anterior) = activo; todos apagados = todos activos. */
  const MODULE_KEYS = ["dispositivos", "energia", "seguridad"];
  function normalizeModules(raw) {
    const src = raw && typeof raw === "object" ? raw : {};
    const out = {};
    MODULE_KEYS.forEach((k) => { out[k] = src[k] === undefined || src[k] === null ? true : !!src[k]; });
    if (!MODULE_KEYS.some((k) => out[k])) MODULE_KEYS.forEach((k) => { out[k] = true; });
    return out;
  }
  /** Lo que llega del asistente o de Ajustes: los tres valores y al menos uno activo. */
  function validModules(m) {
    return !!m && typeof m === "object" && MODULE_KEYS.every((k) => typeof m[k] === "boolean") && MODULE_KEYS.some((k) => m[k]);
  }

  function deepMerge(a, b) {
    const out = Array.isArray(a) ? a.slice() : Object.assign({}, a);
    Object.keys(b || {}).forEach((k) => {
      const v = b[k];
      if (v && typeof v === "object" && !Array.isArray(v) && a && typeof a[k] === "object" && !Array.isArray(a[k]) && a[k] !== null) out[k] = deepMerge(a[k], v);
      else out[k] = v;
    });
    return out;
  }

  function monthKey(ms) { const d = new Date(ms); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`; }

  /** Intervalo de sondeo para no pasarse de la cuota mensual (con un 20 % de reserva para órdenes). */
  function pollInterval({ now, budget, used, devices, minSeconds }) {
    const callsPerPoll = Math.max(1, Math.ceil((devices || 1) / 20));
    const d = new Date(now);
    const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
    const secondsLeft = Math.max(60, (end - now) / 1000);
    const remaining = Math.max(0, budget * 0.8 - used);
    if (remaining <= callsPerPoll) return Infinity; // sin cuota: solo push / manual
    const s = secondsLeft / (remaining / callsPerPoll);
    return Math.max(minSeconds || 30, Math.ceil(s));
  }

  class Hub {
    /**
     * deps: store (KV), secure (SecureStore), http (transporte), now, native (plugin
     * HDAlarmService opcional), notify(fn), MockServer (modo demo), log
     */
    constructor(deps) {
      this.d = deps;
      this.now = deps.now || (() => Date.now());
      this.log = deps.log || (() => {});
      this.settings = deepMerge(DEFAULT_SETTINGS, {});
      this.registry = new mapper.EntityRegistry();
      this.devices = {};
      this.specs = {};
      this.scenes = [];
      this.states = {};
      this.listeners = new Set();
      this.cloud = null;
      this.mock = null;
      this.budget = { month: monthKey(this.now()), calls: 0 };
      this.lastError = "";
      this.lastPoll = 0;
      this.connected = false;
      this.alarm = new alarmMod.AlarmEngine(this.settings.alarm);
    }

    async init() {
      const st = this.d.store;
      this.settings = deepMerge(DEFAULT_SETTINGS, (await st.get("settings")) || {});
      this.registry = new mapper.EntityRegistry(await st.get("registry"));
      this.devices = (await st.get("devices")) || {};
      this.specs = (await st.get("specs")) || {};
      this.scenes = (await st.get("scenes")) || [];
      const b = await st.get("budget");
      if (b && b.month === monthKey(this.now())) this.budget = b;
      this.alarm = new alarmMod.AlarmEngine(this.settings.alarm, await st.get("alarm_state"));
      await this.connect();
      this.rebuild();
      return this;
    }

    modules() { return normalizeModules(this.settings.modules); }
    moduleOn(k) { return this.modules()[k]; }

    async saveSettings(patch) {
      if (patch && patch.modules !== undefined && !validModules(patch.modules)) throw new Error("Elige al menos un módulo");
      // Apagar Seguridad no puede servir para saltarse el código: primero hay que desarmar.
      if (patch && patch.modules && !patch.modules.seguridad && this.moduleOn("seguridad") && this.alarm.s.state !== "disarmed") {
        throw new Error("Desarma la alarma antes de desactivar Seguridad");
      }
      this.settings = deepMerge(this.settings, patch || {});
      if (patch && patch.alarm && Array.isArray(patch.alarm.zones)) this.settings.alarm.zones = patch.alarm.zones;
      if (patch && patch.energy && Array.isArray(patch.energy.controls)) this.settings.energy.controls = patch.energy.controls;
      await this.d.store.set("settings", this.settings);
      this.alarm.setConfig(this.settings.alarm);
      await this._persistAlarm();
      this.rebuild();
      await this.syncNative();
      return this.settings;
    }

    _countCall() {
      const m = monthKey(this.now());
      if (this.budget.month !== m) this.budget = { month: m, calls: 0 };
      this.budget.calls++;
      if (this.budget.calls % 10 === 0) this.d.store.set("budget", this.budget);
    }

    /** Crea el cliente: demo (servidor simulado) o Tuya real con las claves del almacén seguro. */
    async connect() {
      this.cloud = null;
      this.connected = false;
      const mode = this.settings.mode;
      const common = { now: this.now, onCall: () => this._countCall(), log: this.log };
      if (mode === "demo") {
        const MockServer = this.d.MockServer || (HDX.mockTuya || require("../tuya/mock-server.js")).MockTuyaServer;
        const demo = HDX.demoHome || require("../tuya/demo-home.js");
        this.mock = this.mock || new MockServer({ now: this.now });
        this.cloud = new cloudMod.TuyaCloud(Object.assign({ accessId: demo.DEMO_ACCESS_ID, secret: demo.DEMO_SECRET, http: this.mock.handler() }, common));
      } else if (mode === "tuya") {
        const id = await this.d.secure.get("tuya_access_id");
        const secret = await this.d.secure.get("tuya_access_secret");
        if (!id || !secret) { this.lastError = "Faltan las claves de Tuya (Ajustes → Tuya)"; return false; }
        this.cloud = new cloudMod.TuyaCloud(Object.assign({ accessId: id, secret, region: this.settings.tuya.region, http: this.d.http }, common));
      } else {
        return false;
      }
      try {
        await this.cloud.ensureToken();
        this.connected = true;
        this.lastError = "";
      } catch (e) {
        this.lastError = String(e.message || e);
      }
      return this.connected;
    }

    /** Descubre dispositivos (+ especificaciones necesarias + escenas). */
    async discover() {
      if (!this.cloud) throw new Error("Tuya no está configurado");
      const list = await this.cloud.listDevices();
      const devices = {};
      for (const raw of list) {
        devices[raw.id] = {
          id: raw.id, name: raw.name || raw.id, category: raw.category || "", online: raw.online !== false,
          status: cloudMod.statusArrayToMap(raw.status), home_id: raw.owner_id || null,
          sub: !!raw.sub, gateway_id: raw.gateway_id || null, product_name: raw.product_name || "",
        };
        if (SPEC_CATS.has(devices[raw.id].category) && !this.specs[raw.id]) {
          try { this.specs[raw.id] = await this.cloud.getSpecification(raw.id); } catch (e) { this.log("spec " + raw.id + ": " + e.message); }
        }
      }
      const homes = [...new Set(Object.values(devices).map((d) => d.home_id).filter(Boolean))];
      const scenes = [];
      for (const h of homes) {
        try { (await this.cloud.listScenes(h)).forEach((s) => scenes.push(Object.assign({ home_id: h }, s))); } catch (e) { this.log("scenes: " + e.message); }
      }
      this.devices = devices;
      this.scenes = scenes;
      await Promise.all([this.d.store.set("devices", devices), this.d.store.set("specs", this.specs), this.d.store.set("scenes", scenes)]);
      this.rebuild();
      await this.d.store.set("registry", this.registry.toJSON());
      await this.syncNative();
      return Object.values(devices);
    }

    /** Sondeo de estados (lotes de 20). */
    async poll() {
      if (!this.cloud) return false;
      const ids = Object.keys(this.devices);
      if (!ids.length) return false;
      try {
        const st = await this.cloud.getStatuses(ids);
        Object.keys(st).forEach((id) => { if (this.devices[id]) { this.devices[id].status = Object.assign({}, this.devices[id].status, st[id]); this.devices[id].online = true; } });
        this.connected = true;
        this.lastError = "";
      } catch (e) {
        this.lastError = String(e.message || e);
        this.connected = false;
      }
      this.lastPoll = this.now();
      if (this.mock && this.settings.mode === "demo" && this.d.simulate) this.mock.simulate();
      this.rebuild();
      await this.d.store.set("devices", this.devices);
      return this.connected;
    }

    /** Cambio push (Pulsar en el servicio nativo, o un mensaje de prueba). */
    applyPush(deviceId, statusList, online) {
      const dev = this.devices[deviceId];
      if (!dev) return false;
      if (Array.isArray(statusList)) statusList.forEach((s) => { if (s && s.code != null) dev.status[s.code] = s.value; });
      if (online !== undefined) dev.online = !!online;
      this.rebuild();
      return true;
    }

    nextPollSeconds() {
      return pollInterval({
        now: this.now(), budget: Number(this.settings.poll.budget_month) || 24000, used: this.budget.calls,
        devices: Object.keys(this.devices).length, minSeconds: Number(this.settings.poll.foreground_s) || 60,
      });
    }

    /** Recalcula todas las entidades y avisa de los cambios (y al motor de alarma). */
    rebuild() {
      const now = this.now();
      const next = {};
      Object.values(this.devices).forEach((dev) => {
        mapper.mapDevice(Object.assign({}, dev, { spec: this.specs[dev.id] }), this.registry, now).forEach((e) => { next[e.entity_id] = e; });
      });
      this.scenes.forEach((s) => { const e = mapper.mapScene(s, s.home_id, this.registry, now); next[e.entity_id] = e; });
      const mods = this.modules();
      // Sensores de seguridad -> motor de alarma (detección por cambio de estado).
      // Con Seguridad desactivada el motor no recibe nada ni publica sus entidades.
      const alarmActions = [];
      if (mods.seguridad) {
        Object.values(next).forEach((e) => {
          if (!/^binary_sensor\./.test(e.entity_id)) return;
          const prev = this.states[e.entity_id];
          if (!prev || prev.state !== e.state) alarmActions.push(...this.alarm.onSensor(e.entity_id, e.state, now, e.attributes.friendly_name));
        });
        alarmActions.push(...this.alarm.tick(now));
        this.alarm.entities(now).forEach((e) => { next[e.entity_id] = e; });
      }
      // Energía: sensor virtual «Casa» si no hay inversor (solo con Energía activa)
      if (mods.energia) {
        const emap = energy.buildEnergyMap(this.settings, next);
        if (emap.flow.entities.inverter_power === "sensor.hd_consumo_casa") { const v = energy.virtualHouse(next, emap); next[v.entity_id] = v; }
      }
      // conservar last_changed si el estado no cambió; emitir cambios
      const changed = [];
      Object.values(next).forEach((e) => {
        const prev = this.states[e.entity_id];
        if (prev && prev.state === e.state && !/^alarm_control_panel|^input_boolean\.hd_/.test(e.entity_id)) { e.last_changed = prev.last_changed; }
        if (!prev || prev.state !== e.state || JSON.stringify(prev.attributes) !== JSON.stringify(e.attributes)) changed.push(e);
      });
      this.states = next;
      changed.forEach((e) => this._emit({ type: "state_changed", state: e }));
      if (alarmActions.length) this._runAlarmActions(alarmActions);
      return changed.length;
    }

    tick() {
      if (!this.moduleOn("seguridad")) return; // sin Seguridad no hay motor de alarma
      const acts = this.alarm.tick(this.now());
      if (acts.length) { this._runAlarmActions(acts); this.rebuild(); }
      else {
        const a = this.alarm.entities(this.now())[0];
        if (a.attributes.delay !== null) { this.states[a.entity_id] = a; this._emit({ type: "state_changed", state: a }); }
      }
    }

    async _runAlarmActions(actions) {
      if (!this.moduleOn("seguridad")) return;
      let dirty = false;
      for (const a of actions) {
        if (a.type === "changed") dirty = true;
        if (a.type === "notify" && this.d.notify) { try { await this.d.notify(a); } catch (e) { this.log("notify: " + e.message); } }
        if (a.type === "siren") {
          try { await this.callService("siren", a.on ? "turn_on" : "turn_off", { entity_id: a.entity_id }, "alarma"); } catch (e) { this.lastError = "Sirena: " + e.message; }
        }
      }
      if (dirty) {
        this.alarm.entities(this.now()).forEach((e) => {
          const prev = this.states[e.entity_id];
          this.states[e.entity_id] = e;
          if (!prev || prev.state !== e.state) this._emit({ type: "state_changed", state: e });
        });
        await this._persistAlarm();
        await this.syncNative();
      }
    }

    async _persistAlarm() { await this.d.store.set("alarm_state", this.alarm.toJSON()); }

    allStates() { return Object.values(this.states); }
    getState(id) { return this.states[id] || null; }

    subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
    _emit(msg) { this.listeners.forEach((fn) => { try { fn(msg); } catch (_) { /* oyente roto */ } }); }

    /** Servicio estilo HA. Entidades propias (alarma, zonas) o órdenes Tuya. */
    async callService(domain, service, data, user) {
      const now = this.now();
      const ids = [].concat((data && data.entity_id) || []);
      if (!ids.length) throw new Error("entity_id requerido");
      for (const id of ids) {
        if (!this.moduleOn("seguridad") && (domain === "alarm_control_panel" || /^input_boolean\.hd_zona_/.test(id) || id === alarmMod.SIREN_ENABLE)) throw new Error("El módulo Seguridad está desactivado");
        if (domain === "alarm_control_panel") {
          if (id !== alarmMod.ALARM_ENTITY) throw new Error("entidad de alarma desconocida");
          await this._runAlarmActions(this.alarm.command(service, now, user || "app"));
          this.rebuild();
          continue;
        }
        const zm = /^input_boolean\.hd_zona_(.+)$/.exec(id);
        if (zm) {
          const cur = this.states[id] && this.states[id].state === "on";
          const on = service === "turn_on" ? true : service === "turn_off" ? false : !cur;
          await this._runAlarmActions(this.alarm.setZone(zm[1], on, now));
          continue;
        }
        if (id === alarmMod.SIREN_ENABLE) {
          const cur = this.states[id] && this.states[id].state === "on";
          const on = service === "turn_on" ? true : service === "turn_off" ? false : !cur;
          await this._runAlarmActions(this.alarm.setSirenEnabled(on, now));
          continue;
        }
        const ent = this.states[id];
        if (!ent) throw new Error(`entidad desconocida: ${id}`);
        const plan = mapper.commandsFor(ent, domain, service, data);
        if (!plan) throw new Error(`servicio ${domain}.${service} no soportado para ${id}`);
        if (!this.cloud) throw new Error("Tuya no está conectado");
        if (plan.scene) await this.cloud.triggerScene(plan.scene.home_id, plan.scene.scene_id);
        else {
          await this.cloud.sendCommands(plan.device_id, plan.commands);
          const dev = this.devices[plan.device_id];
          if (dev) plan.commands.forEach((c) => { dev.status[c.code] = c.value; if (c.code === "percent_control") dev.status.percent_state = c.value; });
        }
      }
      this.rebuild();
      return true;
    }

    /** Mapa de Seguridad (misma forma que security_map.json) a partir de los ajustes. */
    securityMap(floors, positions) {
      const a = this.settings.alarm;
      const zoneOf = {};
      (a.zones || []).forEach((z) => (z.sensors || []).forEach((e) => { zoneOf[e] = z; }));
      const keys = (floors || []).map((f) => f.id);
      const presence = [];
      const sensors = this.allStates().filter((s) => /^binary_sensor\./.test(s.entity_id) && SECURITY_CLASSES.has((s.attributes || {}).device_class));
      sensors.forEach((s, i) => {
        const p = positions && positions[s.entity_id];
        const valid = p && keys.includes(p.floor);
        const item = {
          entity: s.entity_id,
          name: (s.attributes || {}).friendly_name || s.entity_id,
          floor: valid ? p.floor : keys[0] || null,
          position: valid ? [p.x, p.y] : [0.06 + (i % 8) * 0.11, 0.06 + Math.floor(i / 8) * 0.1],
          zone: zoneOf[s.entity_id] ? zoneOf[s.entity_id].name : null,
        };
        if (valid) { item.outside = !!p.outside; item.custom = true; }
        if (/door|window|opening/.test((s.attributes || {}).device_class)) item.exterior = true;
        presence.push(item);
      });
      const out = {
        _doc: "Generado por la app HADomotics Android (sin Home Assistant) a partir de Ajustes → Alarma.",
        alarm: { entity: alarmMod.ALARM_ENTITY, name: a.name || "Panel de Alarma", modes: ["disarmed", "armed_night", "armed_away"] },
        zones: (a.zones || []).map((z) => ({ entity: alarmMod.zoneEntity(z.id), name: z.name })),
        presence,
        user: { admin: true },
      };
      const sirenId = a.siren && a.siren.entity;
      if (sirenId) {
        const extra = [{ entity: alarmMod.SIREN_ENABLE, name: "Sirena con la alarma" }];
        const dev = this.states[sirenId] && this.states[sirenId].attributes.tuya && this.states[sirenId].attributes.tuya.device_id;
        this.allStates().forEach((s) => {
          if (!/^select\./.test(s.entity_id) || !s.attributes.tuya || s.attributes.tuya.device_id !== dev) return;
          extra.push({ entity: s.entity_id, name: s.attributes.tuya.code === "alarm_volume" ? "Nivel" : "Tono" });
        });
        out.siren = { entity: sirenId, name: "Sirena", extra };
      }
      return out;
    }

    /** Capa del plano: plantas por id (+ coche y cable del cargador si se configuró). */
    overlays(floors) {
      const ev = this.settings.evse || {};
      return {
        _doc: "Generado por la app (sin recortes ni imágenes HD propias de la casa de Xavi).",
        floors: (floors || []).map((f, i) => {
          const o = { key: f.id, match: [f.name], order_fallback: i };
          if (ev.enabled && ev.floor_id === f.id && ev.power_entity) {
            o.tesla = { src: "static/plans/tesla_model_y.webp", x: num(ev.x, 0.6), y: num(ev.y, 0.2), w: num(ev.w, 0.27), h: num(ev.h, 0.24), port: [0.0922, 0.1835] };
            o.evse_cable = { from: [num(ev.from_x, 0.58), num(ev.from_y, 0.45)], power_entity: ev.power_entity, state_entity: ev.state_entity || null, threshold_w: num(ev.threshold_w, 100) };
          }
          return o;
        }),
      };
    }

    energyMap() { return energy.buildEnergyMap(this.settings, this.states); }

    status() {
      return {
        mode: this.settings.mode, onboarded: !!this.settings.onboarded, modules: this.modules(), modules_chosen: validModules(this.settings.modules), connected: this.connected, last_error: this.lastError,
        devices: Object.keys(this.devices).length, entities: Object.keys(this.states).length, budget: this.budget,
        budget_month: this.settings.poll.budget_month, next_poll_s: this.nextPollSeconds(), last_poll: this.lastPoll,
        secure_storage: !!(this.d.secure && this.d.secure.available), native: !!this.d.native,
        alarm: this.alarm.s.state, alarm_log: this.alarm.s.log.slice(-15),
      };
    }

    /** Lo que necesita el servicio nativo (sin secretos: los lee él del Keystore). */
    async syncNative() {
      if (!this.d.native) return;
      const sensors = [];
      const security = this.moduleOn("seguridad");
      const snap = this.alarm.nativeSnapshot();
      if (security) snap.zones.forEach((z) => z.sensors.forEach((eid) => {
        const s = this.states[eid];
        const t = s && s.attributes.tuya;
        if (t && t.device_id) sensors.push({ entity_id: eid, device_id: t.device_id, code: t.code, zone: z.id, label: s.attributes.friendly_name, category: t.category });
      }));
      const siren = this.settings.alarm.siren && this.states[this.settings.alarm.siren.entity];
      const payload = {
        // Seguridad desactivada: el servicio en segundo plano no arranca (background.enabled = false).
        mode: this.settings.mode, region: this.settings.tuya.region,
        background: security ? this.settings.background : Object.assign({}, this.settings.background, { enabled: false, pulsar: false }),
        alarm: snap, sensors,
        siren: security && siren && siren.attributes.tuya ? { device_id: siren.attributes.tuya.device_id, code: siren.attributes.tuya.code } : null,
        device_ids: Object.keys(this.devices),
      };
      try { await this.d.native.configure({ json: JSON.stringify(payload) }); } catch (e) { this.log("native: " + e.message); }
    }

    /** Eventos que el servicio nativo resolvió mientras la app estaba en segundo plano. */
    async applyNativeEvents(events) {
      const now = this.now();
      for (const ev of events || []) {
        if (ev.type === "status" && ev.device_id) this.applyPush(ev.device_id, ev.status, ev.online);
        if (ev.type === "triggered" && this.alarm.s.state !== "triggered") {
          // El servicio ya sonó la sirena y avisó: solo reflejamos el estado.
          this.alarm.s.state = "triggered";
          this.alarm.s.until = Number(ev.until) || now + this.settings.alarm.trigger_time * 1000;
          this.alarm.s.siren_on = !!ev.siren;
          this.alarm.s.last_trigger = ev.last_trigger || this.alarm.s.last_trigger;
          this.alarm._touch(alarmMod.ALARM_ENTITY, now);
        }
      }
      await this._persistAlarm();
      this.rebuild();
    }
  }

  function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }

  const api = { Hub, DEFAULT_SETTINGS, pollInterval, deepMerge, monthKey, normalizeModules, validModules, MODULE_KEYS };
  HDX.define("hub", () => api);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
