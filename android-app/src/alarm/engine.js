/* Motor de alarma integrado en la app (sustituye a Alarmo + Node-RED, sin HA).
 *
 * Réplica de la lógica auditada en AUDITORIA_ALARMA_NODERED.md (16/11/2026):
 *  - Modos: Desarmada / Noche / Ausente (Alarmo: armed_night, armed_away; sin armed_home).
 *  - Retardo de salida por modo (Alarmo: 10 s en Noche) -> estado «arming».
 *  - Al quedar armada (Node-RED «Control desde dashboard»):
 *      Noche   = alarma_modo_noche: todo off + sirena off, luego zonas marcadas «noche» on
 *      Ausente = alarma_modo_dia: todas las zonas on
 *      Desarmar = alarma_desactivar: todas las zonas off + sirena off
 *  - Zonas = interruptores (input_boolean) que se pueden cambiar a mano en cualquier momento.
 *  - Detección (Filter_Notification_Zone): un sensor pasa a «on" -> se mira, EN ESE MOMENTO,
 *    si su zona está activa. Solo entonces dispara (o pasa a «pending» si hay retardo de entrada).
 *  - Disparo (Trigger_Security_Alarm): aviso «Detectada presencia en: <zona> - <sensor>»,
 *    sirena si «Sirena con la alarma» está on (duración configurable), avisos críticos como
 *    mucho uno por zona y minuto. Tras el tiempo de disparo vuelve al modo armado.
 *  - Vigilancia de sensores: aviso si un sensor lleva 5 min sin conexión.
 *
 * Es puro y determinista: el tiempo entra como parámetro y devuelve acciones
 * ({type:"siren"|"notify"|"changed"}), así se prueba sin dispositivos. El código
 * de la alarma NO se guarda nunca: solo un hash con sal (lo verifica el backend). */
(function (root) {
  "use strict";
  if (!root.HDX && typeof require === "function") require("../core/umd.js");
  const HDX = root.HDX;

  const ALARM_ENTITY = "alarm_control_panel.hadomotics";
  const SIREN_ENABLE = "input_boolean.hd_alarma_sirena";
  const ARMED = new Set(["armed_night", "armed_away"]);
  const SERVICE_MODE = { alarm_arm_night: "armed_night", alarm_arm_away: "armed_away", alarm_disarm: "disarmed" };
  const NOTIFY_RATE_MS = 60000;

  function zoneEntity(id) { return `input_boolean.hd_zona_${id}`; }

  function defaults(cfg) {
    const c = Object.assign({
      name: "Panel de Alarma",
      exit_delay: { armed_night: 10, armed_away: 30 },
      entry_delay: 0,
      trigger_time: 180,
      code_hash: null,
      code_arm_required: false,
      zones: [],
      siren: { entity: null },
      watchdog_minutes: 5,
    }, cfg || {});
    c.exit_delay = Object.assign({ armed_night: 10, armed_away: 30 }, c.exit_delay || {});
    c.zones = (c.zones || []).filter((z) => z && z.id);
    return c;
  }

  class AlarmEngine {
    constructor(config, saved) {
      this.setConfig(config);
      const s = saved || {};
      this.s = {
        state: s.state || "disarmed",
        armed_mode: s.armed_mode || null, // modo armado vigente (para volver tras el disparo)
        target: s.target || null, // modo al que se está armando
        until: s.until || 0, // fin de retardo de salida/entrada o del disparo
        zones: Object.assign({}, s.zones || {}),
        siren_enabled: s.siren_enabled !== undefined ? !!s.siren_enabled : true,
        siren_on: !!s.siren_on,
        changed_by: s.changed_by || null,
        last_changed: s.last_changed || {},
        last_notify: s.last_notify || {},
        sensors: s.sensors || {}, // entity -> último estado visto
        unavailable_since: s.unavailable_since || {},
        warned: s.warned || {},
        last_trigger: s.last_trigger || null,
        log: (s.log || []).slice(-50),
      };
      this._fillZones();
    }

    _fillZones() {
      if (!this.s) return;
      this.cfg.zones.forEach((z) => { if (!(z.id in this.s.zones)) this.s.zones[z.id] = false; });
    }

    setConfig(config) {
      this.cfg = defaults(config);
      this.sensorZone = {};
      this.cfg.zones.forEach((z) => (z.sensors || []).forEach((e) => { this.sensorZone[e] = z; }));
      this._fillZones();
    }

    toJSON() { return this.s; }

    _touch(entity, now) { this.s.last_changed[entity] = new Date(now).toISOString(); }

    _setState(st, now, actions) {
      if (this.s.state === st) return;
      this.s.state = st;
      this._touch(ALARM_ENTITY, now);
      this._log(now, `estado -> ${st}`);
      actions.push({ type: "changed", entity_id: ALARM_ENTITY, state: st });
    }

    _log(now, text) {
      this.s.log.push({ t: new Date(now).toISOString(), text });
      if (this.s.log.length > 50) this.s.log.shift();
    }

    _setZone(id, on, now, actions) {
      if (!!this.s.zones[id] === !!on) return;
      this.s.zones[id] = !!on;
      this._touch(zoneEntity(id), now);
      actions.push({ type: "changed", entity_id: zoneEntity(id), state: on ? "on" : "off" });
    }

    _siren(on, now, actions, reason) {
      if (!this.cfg.siren || !this.cfg.siren.entity) {
        this.s.siren_on = false;
        return;
      }
      if (this.s.siren_on === on && !on && reason !== "desactivar") return;
      this.s.siren_on = on;
      actions.push({ type: "siren", entity_id: this.cfg.siren.entity, on, duration: this.cfg.trigger_time, reason: reason || "" });
    }

    /** Escenas de Node-RED al cambiar de modo (alarma_modo_noche / _dia / _desactivar). */
    _applyModeScript(mode, now, actions) {
      if (mode === "disarmed" || mode === "armed_night") {
        this.cfg.zones.forEach((z) => this._setZone(z.id, false, now, actions));
        this._siren(false, now, actions, "desactivar");
      }
      if (mode === "armed_night") this.cfg.zones.forEach((z) => { if (z.night) this._setZone(z.id, true, now, actions); });
      if (mode === "armed_away") this.cfg.zones.forEach((z) => this._setZone(z.id, true, now, actions));
    }

    /** Orden de modo (servicio estilo HA). El código ya lo ha comprobado el backend. */
    command(service, now, user) {
      const actions = [];
      const mode = SERVICE_MODE[service];
      if (!mode) throw new Error(`servicio ${service} no permitido`);
      this.s.changed_by = user || null;
      if (mode === "disarmed") {
        this.s.target = null;
        this.s.armed_mode = null;
        this.s.until = 0;
        this._setState("disarmed", now, actions);
        this._applyModeScript("disarmed", now, actions);
        actions.push({ type: "notify", title: "Alarma desarmada", body: user ? `por ${user}` : "", critical: false, tag: "alarm-mode" });
        return actions;
      }
      const delay = Math.max(0, Number(this.cfg.exit_delay[mode] || 0));
      if (delay > 0) {
        this.s.target = mode;
        this.s.until = now + delay * 1000;
        this._setState("arming", now, actions);
      } else {
        this._armNow(mode, now, actions);
      }
      return actions;
    }

    _armNow(mode, now, actions) {
      this.s.target = null;
      this.s.armed_mode = mode;
      this.s.until = 0;
      this._setState(mode, now, actions);
      this._applyModeScript(mode, now, actions);
      actions.push({ type: "notify", title: mode === "armed_night" ? "Alarma en modo Noche" : "Alarma en modo Ausente", body: "", critical: false, tag: "alarm-mode" });
    }

    setZone(id, on, now) {
      const actions = [];
      if (!this.cfg.zones.some((z) => z.id === id)) throw new Error("zona desconocida");
      this._setZone(id, on, now, actions);
      return actions;
    }

    setSirenEnabled(on, now) {
      const actions = [];
      if (this.s.siren_enabled !== !!on) {
        this.s.siren_enabled = !!on;
        this._touch(SIREN_ENABLE, now);
        actions.push({ type: "changed", entity_id: SIREN_ENABLE, state: on ? "on" : "off" });
      }
      return actions;
    }

    /** Cambio de estado de un sensor (sondeo, mensaje push o servicio nativo). */
    onSensor(entityId, state, now, label) {
      const actions = [];
      const prev = this.s.sensors[entityId];
      this.s.sensors[entityId] = state;
      // Vigilancia: sin conexión
      if (state === "unavailable" || state === "unknown") {
        if (!this.s.unavailable_since[entityId]) this.s.unavailable_since[entityId] = now;
      } else {
        delete this.s.unavailable_since[entityId];
        delete this.s.warned[entityId];
      }
      // Primera vez que se ve el sensor (arranque): solo se anota, no dispara.
      if (prev === undefined || state !== "on" || prev === "on") return actions;
      const zone = this.sensorZone[entityId];
      if (!zone) return actions;
      const st = this.s.state;
      if (!(ARMED.has(st) || st === "pending" || st === "triggered")) return actions;
      if (!this.s.zones[zone.id]) {
        this._log(now, `detección ignorada (zona ${zone.name} desactivada): ${label || entityId}`);
        return actions;
      }
      this.s.last_trigger = { zone: zone.id, zone_name: zone.name, entity_id: entityId, label: label || entityId, t: new Date(now).toISOString() };
      const entry = Number(zone.entry_delay != null ? zone.entry_delay : this.cfg.entry_delay) || 0;
      if (ARMED.has(st) && entry > 0) {
        this.s.until = now + entry * 1000;
        this._setState("pending", now, actions);
        actions.push({ type: "notify", title: "Entrada detectada", body: `${zone.name} - ${label || entityId}: desarma en ${entry} s`, critical: false, tag: "alarm-pending" });
        return actions;
      }
      if (st === "pending") return actions; // ya cuenta el retardo de entrada
      this._trigger(zone, label || entityId, now, actions);
      return actions;
    }

    _trigger(zone, label, now, actions) {
      const first = this.s.state !== "triggered";
      if (first) {
        this.s.until = now + Math.max(1, Number(this.cfg.trigger_time) || 180) * 1000;
        this._setState("triggered", now, actions);
        if (this.s.siren_enabled) this._siren(true, now, actions, "disparo");
      }
      const last = this.s.last_notify[zone.id] || 0;
      if (now - last >= NOTIFY_RATE_MS) {
        this.s.last_notify[zone.id] = now;
        actions.push({ type: "notify", title: "¡ALARMA!", body: `Detectada presencia en: ${zone.name} - ${label}`, critical: true, tag: `alarm-${zone.id}` });
      }
    }

    /** Temporizadores: fin de retardo de salida/entrada, fin del disparo y vigilancia. */
    tick(now) {
      const actions = [];
      const st = this.s.state;
      if (st === "arming" && this.s.until && now >= this.s.until) this._armNow(this.s.target || "armed_away", now, actions);
      if (st === "pending" && this.s.until && now >= this.s.until) {
        const lt = this.s.last_trigger || {};
        const zone = this.cfg.zones.find((z) => z.id === lt.zone) || { id: "?", name: "?" };
        this._trigger(zone, lt.label || "?", now, actions);
      }
      if (st === "triggered" && this.s.until && now >= this.s.until) {
        this._siren(false, now, actions, "fin del disparo");
        const back = this.s.armed_mode || "armed_away";
        this.s.until = 0;
        this._setState(back, now, actions);
      }
      const limit = Math.max(1, Number(this.cfg.watchdog_minutes) || 5) * 60000;
      Object.keys(this.s.unavailable_since).forEach((e) => {
        if (!this.sensorZone[e] || this.s.warned[e]) return;
        if (now - this.s.unavailable_since[e] >= limit) {
          this.s.warned[e] = now;
          actions.push({ type: "notify", title: "Sensor sin conexión", body: `${e} lleva ${Math.round(limit / 60000)} min sin conexión`, critical: false, tag: `watchdog-${e}` });
        }
      });
      return actions;
    }

    /** Estados estilo HA de las entidades propias de la alarma. */
    entities(now) {
      const iso = (e) => this.s.last_changed[e] || new Date(now).toISOString();
      const feats = 2 | 4 | 8; // ARM_AWAY + ARM_NIGHT + TRIGGER (como Alarmo de Xavi: 14)
      const out = [{
        entity_id: ALARM_ENTITY,
        state: this.s.state,
        attributes: {
          friendly_name: this.cfg.name,
          code_format: this.cfg.code_hash ? "number" : null,
          code_arm_required: !!this.cfg.code_arm_required,
          supported_features: feats,
          changed_by: this.s.changed_by,
          next_state: this.s.target || (this.s.state === "pending" ? "triggered" : null),
          delay: this.s.until ? Math.max(0, Math.round((this.s.until - now) / 1000)) : null,
          last_trigger: this.s.last_trigger,
        },
        last_changed: iso(ALARM_ENTITY), last_updated: iso(ALARM_ENTITY), context: { id: "" },
      }];
      this.cfg.zones.forEach((z) => {
        const e = zoneEntity(z.id);
        out.push({ entity_id: e, state: this.s.zones[z.id] ? "on" : "off", attributes: { friendly_name: z.name, icon: "mdi:shield-home" }, last_changed: iso(e), last_updated: iso(e), context: { id: "" } });
      });
      out.push({ entity_id: SIREN_ENABLE, state: this.s.siren_enabled ? "on" : "off", attributes: { friendly_name: "Sirena con la alarma" }, last_changed: iso(SIREN_ENABLE), last_updated: iso(SIREN_ENABLE), context: { id: "" } });
      return out;
    }

    /** Resumen para el servicio nativo en segundo plano (sin secretos). */
    nativeSnapshot() {
      return {
        state: this.s.state,
        target: this.s.target || null,
        armed_mode: this.s.armed_mode,
        until: this.s.until,
        zones: this.cfg.zones.map((z) => ({ id: z.id, name: z.name, on: !!this.s.zones[z.id], sensors: z.sensors || [], entry_delay: z.entry_delay != null ? z.entry_delay : this.cfg.entry_delay })),
        siren_enabled: this.s.siren_enabled,
        trigger_time: this.cfg.trigger_time,
      };
    }
  }

  /** Hash del código con sal (PBKDF2-SHA256, WebCrypto). El código nunca se guarda. */
  async function hashCode(code, saltHex) {
    const c = globalThis.crypto;
    const salt = saltHex || Array.from(c.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
    const key = await c.subtle.importKey("raw", new TextEncoder().encode(String(code)), "PBKDF2", false, ["deriveBits"]);
    const bits = await c.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: new TextEncoder().encode(salt), iterations: 100000 }, key, 256);
    return { salt, hash: Array.from(new Uint8Array(bits), (b) => b.toString(16).padStart(2, "0")).join("") };
  }

  async function verifyCode(code, codeHash) {
    if (!codeHash) return true;
    if (typeof code !== "string" || !code) return false;
    const h = await hashCode(code, codeHash.salt);
    // comparación de longitud fija
    let diff = h.hash.length ^ codeHash.hash.length;
    for (let i = 0; i < h.hash.length; i++) diff |= h.hash.charCodeAt(i) ^ (codeHash.hash.charCodeAt(i) || 0);
    return diff === 0;
  }

  const api = { AlarmEngine, ALARM_ENTITY, SIREN_ENABLE, zoneEntity, hashCode, verifyCode, SERVICE_MODE };
  HDX.define("alarmEngine", () => api);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
