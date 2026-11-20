/* Traduce dispositivos Tuya (categoría + DPs estándar) a entidades con la misma
 * forma que los estados de Home Assistant ({entity_id, state, attributes, …}).
 * Así el frontend del add-on (Dispositivos, Seguridad, Energía) funciona sin
 * cambios. Y al revés: servicio estilo HA (switch.turn_on, cover.set_cover_position…)
 * -> órdenes Tuya [{code, value}].
 *
 * Los entity_id se guardan en un registro (dispositivo+clave -> entity_id) la
 * primera vez, como el registro de entidades de HA: si renombras el dispositivo
 * en Smart Life, los elementos colocados en el plano siguen funcionando. */
(function (root) {
  "use strict";
  if (!root.HDX && typeof require === "function") require("../core/umd.js");
  const HDX = root.HDX;

  const SWITCH_CATS = new Set(["kg", "cz", "pc", "tdq", "dlq", "qjdcz", "znrb", "kfj", "bh", "cs", "jsq", "fs", "cn", "xxj"]);
  const LIGHT_CATS = new Set(["dj", "dd", "xdd", "fwd", "dc", "tgq", "tgkg", "fsd", "gyd", "sxd", "tyndj"]);
  const COVER_CATS = new Set(["cl", "clkg", "mc", "ckmkzq", "jdcljqr"]);
  const BIN_SENSORS = {
    pir: { code: ["pir"], on: ["pir", "presence", true], device_class: "motion" },
    hps: { code: ["presence_state"], on: ["presence", "peaceful", "small_move", "large_move"], device_class: "occupancy" },
    mcs: { code: ["doorcontact_state"], on: [true, "open"], device_class: "door" },
    ywbj: { code: ["smoke_sensor_status", "smoke_sensor_state"], on: ["alarm", "1", 1, true], device_class: "smoke" },
    rqbj: { code: ["gas_sensor_status", "gas_sensor_state"], on: ["alarm", "1", 1, true], device_class: "gas" },
    sj: { code: ["watersensor_state"], on: ["alarm", true], device_class: "moisture" },
    cobj: { code: ["co_status", "co_state"], on: ["alarm", "1", 1, true], device_class: "carbon_monoxide" },
    sos: { code: ["sos_state"], on: [true], device_class: "safety" },
  };
  // Escalas por defecto de DPs numéricos habituales (si no hay especificación).
  const SENSOR_DPS = {
    cur_power: { suffix: "power", unit: "W", device_class: "power", scale: 1 },
    cur_voltage: { suffix: "voltage", unit: "V", device_class: "voltage", scale: 1 },
    cur_current: { suffix: "current", unit: "mA", device_class: "current", scale: 0 },
    add_ele: { suffix: "energy", unit: "kWh", device_class: "energy", scale: 3 },
    forward_energy_total: { suffix: "energy", unit: "kWh", device_class: "energy", scale: 2 },
    va_temperature: { suffix: "temperature", unit: "°C", device_class: "temperature", scale: 1 },
    temp_current: { suffix: "temperature", unit: "°C", device_class: "temperature", scale: 1 },
    va_humidity: { suffix: "humidity", unit: "%", device_class: "humidity", scale: 0 },
    humidity_value: { suffix: "humidity", unit: "%", device_class: "humidity", scale: 0 },
    battery_percentage: { suffix: "battery", unit: "%", device_class: "battery", scale: 0 },
    battery_value: { suffix: "battery", unit: "%", device_class: "battery", scale: 0 },
    bright_value_sensor: { suffix: "illuminance", unit: "lx", device_class: "illuminance", scale: 0 },
    power_total: { suffix: "charging_power", unit: "kW", device_class: "power", scale: 3 },
  };
  const EVSE_STATE = {
    charger_charging: "Charging",
    charger_insert: "SuspendedEV",
    charger_wait: "SuspendedEVSE",
    charger_pause: "SuspendedEVSE",
    charger_end: "Finishing",
    charger_free: "Available",
    charger_free_fault: "Faulted",
    charger_fault: "Faulted",
  };

  function slug(s) {
    return String(s || "")
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "tuya";
  }

  /** Registro persistente dispositivo+clave -> entity_id (único). */
  class EntityRegistry {
    constructor(data) {
      this.map = Object.assign({}, (data && data.map) || {});
    }
    idFor(deviceId, key, domain, baseName) {
      const k = `${deviceId}:${key}`;
      if (this.map[k]) return this.map[k];
      const used = new Set(Object.values(this.map));
      const base = `${domain}.${slug(baseName)}`;
      let id = base;
      for (let i = 2; used.has(id); i++) id = `${base}_${i}`;
      this.map[k] = id;
      return id;
    }
    toJSON() { return { map: this.map }; }
  }

  function specIndex(spec) {
    const idx = {};
    const add = (arr) => (arr || []).forEach((f) => {
      let values = f.values;
      if (typeof values === "string") { try { values = JSON.parse(values); } catch (_) { values = {}; } }
      idx[f.code] = Object.assign({}, idx[f.code] || {}, { type: f.type, values: values || {} });
    });
    if (spec) { add(spec.status); add(spec.functions); }
    return idx;
  }

  function scaled(raw, dp, specVals) {
    const n = Number(raw);
    if (!isFinite(n)) return null;
    const scale = specVals && typeof specVals.scale === "number" ? specVals.scale : (dp ? dp.scale : 0);
    const v = n / Math.pow(10, scale || 0);
    return Math.round(v * 1000) / 1000;
  }

  /** phase_a de contadores Tuya (zndb): base64 -> V(2B,/10) A(3B,/1000) kW(3B,/1000). */
  function decodePhase(b64) {
    try {
      const bin = typeof atob === "function" ? atob(b64) : Buffer.from(b64, "base64").toString("binary");
      const b = Array.from(bin, (c) => c.charCodeAt(0));
      if (b.length < 8) return null;
      return {
        voltage: ((b[0] << 8) | b[1]) / 10,
        current: ((b[2] << 16) | (b[3] << 8) | b[4]) / 1000,
        power_w: (((b[5] << 16) | (b[6] << 8) | b[7]) / 1000) * 1000,
      };
    } catch (_) { return null; }
  }

  function boolState(v) { return v === true || v === "true" || v === 1 || v === "1" ? "on" : "off"; }

  /**
   * Convierte un dispositivo Tuya en entidades.
   * dev: {id, name, category, online, status:{code:value}, spec?, home_id?}
   * Devuelve [{entity_id, state, attributes}] con attributes.tuya = {device_id, …}.
   */
  function mapDevice(dev, registry, now) {
    const st = dev.status || {};
    const spec = specIndex(dev.spec);
    const name = dev.name || dev.id;
    const cat = dev.category || "";
    const ts = new Date(now || Date.now()).toISOString();
    const avail = dev.online === false ? "unavailable" : null;
    const out = [];
    const used = new Set();
    const push = (key, domain, label, state, attrs, tuya) => {
      const entity_id = registry.idFor(dev.id, key, domain, label);
      out.push({
        entity_id,
        state: avail || state,
        attributes: Object.assign({ friendly_name: label }, attrs || {}, {
          tuya: Object.assign({ device_id: dev.id, category: cat, key }, tuya || {}),
        }),
        last_changed: ts,
        last_updated: ts,
        context: { id: "", parent_id: null, user_id: null },
      });
    };
    const switchCodes = Object.keys(st).filter((c) => /^switch(_\d+)?$/.test(c) || c === "switch_usb1");

    if (BIN_SENSORS[cat]) {
      const b = BIN_SENSORS[cat];
      const code = b.code.find((c) => c in st);
      if (code) {
        used.add(code);
        push(code, "binary_sensor", name, b.on.includes(st[code]) ? "on" : "off", { device_class: b.device_class }, { code });
      }
    }
    if (LIGHT_CATS.has(cat)) {
      const sw = ["switch_led", "switch_led_1", "switch_1", "led_switch"].find((c) => c in st);
      if (sw) {
        used.add(sw);
        const bc = ["bright_value_v2", "bright_value", "bright_value_1"].find((c) => c in st);
        const attrs = { supported_color_modes: [bc ? "brightness" : "onoff"] };
        const tuya = { code: sw };
        if (bc) {
          used.add(bc);
          const vals = (spec[bc] && spec[bc].values) || {};
          const min = typeof vals.min === "number" ? vals.min : (bc === "bright_value" ? 25 : 10);
          const max = typeof vals.max === "number" ? vals.max : (bc === "bright_value" ? 255 : 1000);
          attrs.brightness = Math.round(((Number(st[bc]) - min) / (max - min)) * 255);
          Object.assign(tuya, { brightness_code: bc, min, max });
        }
        push(sw, "light", name, boolState(st[sw]), attrs, tuya);
      }
    }
    if (COVER_CATS.has(cat)) {
      if (cat === "ckmkzq") {
        const sw = switchCodes[0] || "switch_1";
        used.add(sw); used.add("doorcontact_state");
        const open = "doorcontact_state" in st ? !!st.doorcontact_state : !!st[sw];
        push("garage", "cover", name, open ? "open" : "closed", { device_class: "garage", supported_features: 3 }, { kind: "garage", code: sw });
      } else {
        const pos = ["percent_state", "percent_control", "position"].find((c) => c in st);
        const ctl = ["control", "mach_operate"].find((c) => c in st) || "control";
        [pos, ctl, "percent_control", "control_back_mode", "work_state"].forEach((c) => c && used.add(c));
        const p = pos ? Number(st[pos]) : null;
        push("cover", "cover", name, p === null ? "unknown" : p > 0 ? "open" : "closed",
          { current_position: p, supported_features: 15, device_class: "curtain" },
          { kind: "position", control_code: ctl, position_code: "percent_control" in st ? "percent_control" : pos });
      }
    }
    if (cat === "sgbj") {
      used.add("alarm_switch");
      push("siren", "siren", name, boolState(st.alarm_switch), { available_tones: ((spec.alarm_ringtone || {}).values || {}).range }, { code: "alarm_switch" });
      ["alarm_volume", "alarm_ringtone"].forEach((code) => {
        if (!(code in st)) return;
        used.add(code);
        const opts = ((spec[code] || {}).values || {}).range || [String(st[code])];
        push(code, "select", `${name} ${code === "alarm_volume" ? "nivel" : "tono"}`, String(st[code]), { options: opts }, { code });
      });
      if ("alarm_time" in st) used.add("alarm_time");
    }
    if (cat === "qccdz") {
      // Cargador de coche eléctrico Tuya: potencia real y estado tipo OCPP para el cable del plano.
      const pcode = ["power_total", "charge_power", "cur_power"].find((c) => c in st);
      if (pcode) {
        used.add(pcode);
        const dp = SENSOR_DPS[pcode] || SENSOR_DPS.power_total;
        const v = scaled(st[pcode], dp, spec[pcode] && spec[pcode].values);
        const unit = (spec[pcode] && spec[pcode].values && spec[pcode].values.unit) || dp.unit;
        push("charging_power", "sensor", `${name} potencia de carga`, v === null ? "unknown" : String(v), { unit_of_measurement: unit, device_class: "power" }, { code: pcode });
      }
      if ("work_state" in st) {
        used.add("work_state");
        push("evse_state", "sensor", `${name} estado`, EVSE_STATE[st.work_state] || String(st.work_state), {}, { code: "work_state" });
      }
    }
    if (cat === "zndb" || cat === "dlq") {
      ["phase_a", "phase_b", "phase_c"].forEach((ph) => {
        if (!(ph in st)) return;
        used.add(ph);
        const d = decodePhase(st[ph]);
        if (d) push(`${ph}_power`, "sensor", `${name} ${ph} potencia`, String(d.power_w), { unit_of_measurement: "W", device_class: "power" }, { code: ph, decode: "phase_power" });
      });
    }
    if (cat === "wk" || cat === "wkf" || cat === "wkcz") {
      const sw = "switch" in st ? "switch" : null;
      if ("temp_set" in st) {
        used.add("temp_set"); if (sw) used.add(sw);
        const sv = scaled(st.temp_set, { scale: 0 }, spec.temp_set && spec.temp_set.values);
        push("climate", "climate", name, sw && !st[sw] ? "off" : "heat", { temperature: sv, current_temperature: scaled(st.temp_current, SENSOR_DPS.temp_current, spec.temp_current && spec.temp_current.values) }, { code: sw || "switch", temp_code: "temp_set", scale: (spec.temp_set && spec.temp_set.values && spec.temp_set.values.scale) || 0 });
      }
    }
    if (cat === "sp") {
      // Cámaras: la detección de personas/movimiento llega por eventos (servicio de mensajes),
      // no por el estado. Se expone el sensor si el DP existe; si no, solo la cámara.
      const code = ["movement_detect_pic", "motion_record", "human_detect"].find((c) => c in st);
      push("person", "binary_sensor", `${name} persona`, "off", { device_class: "occupancy", source: "events" }, { code: code || "event", events: true });
      Object.keys(st).forEach((c) => used.add(c));
    }
    // Interruptores (enchufes, regletas, relés, automáticos…)
    if (SWITCH_CATS.has(cat) || (!out.length && switchCodes.length)) {
      switchCodes.forEach((c, i) => {
        if (used.has(c)) return;
        used.add(c);
        const label = switchCodes.length > 1 ? `${name} ${i + 1}` : name;
        push(c, "switch", label, boolState(st[c]), {}, { code: c });
      });
    }
    // Sensores numéricos estándar (potencia, energía, temperatura, batería…)
    Object.keys(SENSOR_DPS).forEach((code) => {
      if (!(code in st) || used.has(code)) return;
      used.add(code);
      const dp = SENSOR_DPS[code];
      const sv = spec[code] && spec[code].values;
      const v = scaled(st[code], dp, sv);
      push(code, "sensor", `${name} ${dp.suffix}`, v === null ? "unknown" : String(v), {
        unit_of_measurement: (sv && sv.unit) || dp.unit, device_class: dp.device_class, state_class: "measurement",
      }, { code });
    });
    return out;
  }

  /** Escena «tap-to-run» de Tuya como scene.* */
  function mapScene(scene, homeId, registry, now) {
    const ts = new Date(now || Date.now()).toISOString();
    const entity_id = registry.idFor(`scene-${scene.scene_id || scene.id}`, "scene", "scene", scene.name || scene.scene_id);
    return {
      entity_id, state: "scening",
      attributes: { friendly_name: scene.name || "Escena", tuya: { scene_id: scene.scene_id || scene.id, home_id: homeId } },
      last_changed: ts, last_updated: ts, context: { id: "" },
    };
  }

  /**
   * Servicio estilo HA -> {device_id, commands} | {scene} | null (no soportado).
   * entity: estado actual (con attributes.tuya).
   */
  function commandsFor(entity, domain, service, data) {
    const t = (entity && entity.attributes && entity.attributes.tuya) || {};
    const d = data || {};
    const on = service === "turn_on" || service === "open_cover" || (service === "toggle" && entity.state !== "on" && entity.state !== "open");
    if (t.scene_id) {
      if (service === "turn_on" || service === "toggle") return { scene: { home_id: t.home_id, scene_id: t.scene_id } };
      return null;
    }
    if (!t.device_id) return null;
    const cmd = (code, value) => ({ device_id: t.device_id, commands: [{ code, value }] });
    const entDomain = String(entity.entity_id).split(".")[0];
    if (entDomain === "switch" || entDomain === "siren") {
      if (!["turn_on", "turn_off", "toggle"].includes(service)) return null;
      return cmd(t.code, on);
    }
    if (entDomain === "light") {
      if (service === "turn_on" && d.brightness != null && t.brightness_code) {
        const v = Math.round(t.min + (Math.max(0, Math.min(255, Number(d.brightness))) / 255) * (t.max - t.min));
        return { device_id: t.device_id, commands: [{ code: t.code, value: true }, { code: t.brightness_code, value: v }] };
      }
      if (!["turn_on", "turn_off", "toggle"].includes(service)) return null;
      return cmd(t.code, on);
    }
    if (entDomain === "select") {
      if (service !== "select_option") return null;
      const opts = (entity.attributes && entity.attributes.options) || [];
      if (!opts.includes(d.option)) return null;
      return cmd(t.code, d.option);
    }
    if (entDomain === "cover") {
      if (t.kind === "garage") {
        const open = entity.state === "open";
        if (service === "open_cover") return cmd(t.code, true);
        if (service === "close_cover") return cmd(t.code, false);
        if (service === "toggle") return cmd(t.code, !open);
        return null;
      }
      if (service === "open_cover") return cmd(t.control_code, "open");
      if (service === "close_cover") return cmd(t.control_code, "close");
      if (service === "stop_cover") return cmd(t.control_code, "stop");
      if (service === "toggle") return cmd(t.control_code, entity.state === "open" ? "close" : "open");
      if (service === "set_cover_position" && t.position_code) {
        const p = Math.max(0, Math.min(100, Math.round(Number(d.position))));
        if (!isFinite(p)) return null;
        return cmd(t.position_code, p);
      }
      return null;
    }
    if (entDomain === "climate") {
      if (service === "turn_on" || service === "turn_off") return cmd(t.code, service === "turn_on");
      if (service === "set_temperature" && d.temperature != null) return cmd(t.temp_code, Math.round(Number(d.temperature) * Math.pow(10, t.scale || 0)));
      return null;
    }
    return null;
  }

  /** Estado optimista tras una orden (se corrige con el siguiente sondeo/mensaje). */
  function optimisticState(entity, domain, service, data) {
    const s = entity.state;
    const dom = String(entity.entity_id).split(".")[0];
    if (["switch", "light", "siren", "input_boolean"].includes(dom)) {
      if (service === "turn_on") return "on";
      if (service === "turn_off") return "off";
      if (service === "toggle") return s === "on" ? "off" : "on";
    }
    if (dom === "cover") {
      if (service === "open_cover") return "open";
      if (service === "close_cover") return "closed";
      if (service === "toggle") return s === "open" ? "closed" : "open";
      if (service === "set_cover_position") return Number(data && data.position) > 0 ? "open" : "closed";
    }
    if (dom === "select" && service === "select_option") return String(data && data.option);
    return s;
  }

  const api = { mapDevice, mapScene, commandsFor, optimisticState, EntityRegistry, slug, decodePhase, specIndex, EVSE_STATE };
  HDX.define("tuyaMapper", () => api);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
