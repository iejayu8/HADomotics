/* Port a JavaScript de hadomotics/energy.py (build_flow y validación de controles),
 * para que la app sin HA dé exactamente los mismos números que el add-on en
 * GET /api/energy/flow. Un test compara ambas implementaciones con el mismo fixture. */
(function (root) {
  "use strict";
  if (!root.HDX && typeof require === "function") require("../core/umd.js");
  const HDX = root.HDX;

  const KW = new Set(["kw", "kilowatt", "kilowatts"]);
  const W = new Set(["w", "watt", "watts"]);
  const DEADBAND = 1.0;
  const GRID_BARE_KW_MAX = 100.0;
  const NULLISH = new Set(["", "unknown", "unavailable", "none", "None"]);
  const ALLOWED = {
    toggle: new Set(["input_boolean.turn_on", "input_boolean.turn_off", "automation.turn_on", "automation.turn_off", "switch.turn_on", "switch.turn_off"]),
    number: new Set(["input_number.set_value"]),
    select: new Set(["input_select.select_option"]),
  };

  function unit(s) {
    if (!s) return "";
    const a = s.attributes || {};
    return String(a.unit_of_measurement || s.unit_of_measurement || "").trim().toLowerCase();
  }
  function num(s) {
    if (!s) return null;
    const raw = s.state;
    if (raw === null || raw === undefined || NULLISH.has(String(raw))) return null;
    const v = Number(raw);
    return Number.isFinite(v) && String(raw).trim() !== "" ? v : null;
  }
  function powerW(s, kwIfSmall) {
    const v = num(s);
    if (v === null) return null;
    const u = unit(s);
    if (KW.has(u)) return v * 1000;
    if (W.has(u) || u === "") return kwIfSmall && u === "" && Math.abs(v) <= GRID_BARE_KW_MAX ? v * 1000 : v;
    if (u === "mw") return v * 1e6;
    return v;
  }
  function kwh(s) {
    const v = num(s);
    if (v === null) return null;
    const u = unit(s);
    if (u === "wh") return v / 1000;
    if (u === "mwh") return v * 1000;
    return v;
  }
  function autarky(load, imp) {
    if (load === null || imp === null || load <= 0) return null;
    return Math.max(0, Math.min(100, ((load - imp) / load) * 100));
  }
  function houseW(inv, aux) {
    if (inv === null) return null;
    if (aux === null) return inv;
    return Math.max(0, inv - aux);
  }
  function text(s) {
    if (!s) return null;
    const raw = s.state;
    if (raw === null || raw === undefined || NULLISH.has(String(raw))) return null;
    return String(raw);
  }
  function bool(s) {
    const r = text(s);
    if (r === null) return null;
    if (["on", "true", "True", "home"].includes(r)) return true;
    if (["off", "false", "False"].includes(r)) return false;
    return null;
  }

  function directions(solar, bat, grid, inv, aux, gridConnected) {
    const house = houseW(inv, aux);
    let g = "idle";
    if (gridConnected !== false && grid !== null) g = grid > DEADBAND ? "import" : grid < -DEADBAND ? "export" : "idle";
    let b = "idle";
    if (bat !== null) b = bat > DEADBAND ? "discharge" : bat < -DEADBAND ? "charge" : "idle";
    return {
      solar_to_inverter: solar !== null && solar > DEADBAND,
      battery: b,
      grid: g,
      inverter_to_house: house !== null && house > DEADBAND,
      inverter_to_aux: aux !== null && aux > DEADBAND,
    };
  }

  function buildFlow(states, energyMap) {
    const flow = (energyMap && energyMap.flow) || {};
    const ents = flow.entities || {};
    let capacity = Number(flow.battery_capacity_wh || 7600);
    if (!Number.isFinite(capacity)) capacity = 7600;
    const st = (k) => (ents[k] ? states[ents[k]] : undefined);
    const solar = powerW(st("pv_power"));
    const pv = [1, 2, 3].map((i) => ({ power_w: powerW(st(`pv${i}_power`)), voltage_v: num(st(`pv${i}_voltage`)), current_a: num(st(`pv${i}_current`)) }));
    const bat = powerW(st("battery_power"));
    const soc = num(st("battery_soc"));
    const grid = powerW(st("grid_power"), true);
    const inv = powerW(st("inverter_power"));
    const aux = powerW(st("aux_power"));
    const load = kwh(st("load_daily"));
    const imp = kwh(st("grid_import_daily"));
    const gc = bool(st("grid_connected"));
    return {
      solar_w: solar, pv, solar_daily_kwh: kwh(st("pv_daily")),
      battery_w: bat, battery_soc: soc, battery_state: text(st("battery_state")),
      battery_voltage_v: num(st("battery_voltage")), battery_current_a: num(st("battery_current")), battery_temp_c: num(st("battery_temp")),
      battery_daily_charge_kwh: kwh(st("battery_charge_daily")), battery_daily_discharge_kwh: kwh(st("battery_discharge_daily")),
      battery_remaining_wh: soc === null ? null : (Math.max(0, soc) / 100) * capacity, battery_capacity_wh: capacity,
      grid_w: grid, grid_connected: gc, grid_daily_import_kwh: imp, grid_daily_export_kwh: kwh(st("grid_export_daily")),
      inverter_w: inv, inverter_v: num(st("inverter_voltage")), inverter_hz: num(st("inverter_frequency")),
      inverter_temp_c: num(st("inverter_temp")), inverter_dc_temp_c: num(st("inverter_dc_temp")),
      inverter_state: text(st("inverter_state")), inverter_program: text(st("inverter_program")), inverter_pattern: text(st("inverter_pattern")),
      aux_w: aux, aux_connected: bool(st("aux_connected")), aux_daily_kwh: kwh(st("aux_daily")),
      house_w: houseW(inv, aux), load_daily_kwh: load, autarky_pct: autarky(load, imp),
      directions: directions(solar, bat, grid, inv, aux, gc),
      colours: Object.assign({}, flow.colours || {}),
    };
  }

  function* walkItems(m) {
    for (const sc of (m && m.screens) || []) for (const se of sc.sections || []) for (const it of se.items || []) yield it;
  }
  function mappedEntities(m) {
    const out = [];
    for (const it of walkItems(m)) if (it.entity && !out.includes(it.entity)) out.push(it.entity);
    Object.values((m.flow && m.flow.entities) || {}).forEach((e) => { if (typeof e === "string" && !out.includes(e)) out.push(e); });
    return out;
  }
  function controls(m) {
    const out = {};
    for (const it of walkItems(m)) if (ALLOWED[it.control] && it.entity) out[it.entity] = it.control;
    return out;
  }
  /** Igual que energy.validate_control: devuelve [domain, service, data] o lanza Error. */
  function validateControl(m, body, current) {
    const entity = String(body.entity_id || "");
    const full = String(body.service || "");
    const data = body.data || {};
    if (typeof data !== "object" || Array.isArray(data)) throw new Error("data debe ser un objeto");
    const ctl = controls(m)[entity];
    if (!ctl) throw new Error(`${entity || "(vacío)"} no es un control editable`);
    if (!entity.includes(".") || !ALLOWED[ctl].has(full) || full.split(".")[0] !== entity.split(".")[0]) throw new Error(`servicio ${full} no permitido para ${entity}`);
    const [domain, service] = full.split(".");
    const attrs = (current && current.attributes) || {};
    if (ctl === "toggle") {
      if (Object.keys(data).length) throw new Error("turn_on/turn_off no admite datos");
      return [domain, service, {}];
    }
    if (ctl === "number") {
      const keys = Object.keys(data);
      if (keys.length !== 1 || keys[0] !== "value") throw new Error("set_value requiere solo 'value'");
      const v = Number(data.value);
      if (!Number.isFinite(v)) throw new Error("value no es numérico");
      if (!current) throw new Error("estado actual no disponible: no se puede validar el rango");
      if ((attrs.min != null && v < Number(attrs.min)) || (attrs.max != null && v > Number(attrs.max))) throw new Error(`value fuera de rango [${attrs.min}, ${attrs.max}]`);
      return [domain, service, { value: v }];
    }
    const keys = Object.keys(data);
    if (keys.length !== 1 || keys[0] !== "option") throw new Error("select_option requiere solo 'option'");
    if (!current) throw new Error("estado actual no disponible: no se pueden validar las opciones");
    if (!(attrs.options || []).includes(data.option)) throw new Error(`opción no válida: ${data.option}`);
    return [domain, service, { option: data.option }];
  }

  /** Mapa de Energía generado desde los ajustes de la app (qué entidad es red, solar, batería…). */
  function buildEnergyMap(settings, states) {
    const e = (settings && settings.energy) || {};
    const ents = {};
    ["grid_power", "pv_power", "battery_power", "battery_soc", "inverter_power", "aux_power", "load_daily", "grid_import_daily", "grid_export_daily", "pv_daily"].forEach((k) => { if (e[k]) ents[k] = e[k]; });
    // Si no hay inversor, la «casa» es la suma de red + solar (+ batería): lo emulamos con un sensor virtual.
    if (!ents.inverter_power && (ents.grid_power || ents.pv_power)) ents.inverter_power = "sensor.hd_consumo_casa";
    const all = Object.values(states || {});
    const powerItems = all.filter((s) => /^sensor\./.test(s.entity_id) && (s.attributes || {}).device_class === "power")
      .map((s) => ({ entity: s.entity_id, label: (s.attributes || {}).friendly_name || s.entity_id }));
    const energyItems = all.filter((s) => /^sensor\./.test(s.entity_id) && (s.attributes || {}).device_class === "energy")
      .map((s) => ({ entity: s.entity_id, label: (s.attributes || {}).friendly_name || s.entity_id }));
    const switchItems = (e.controls || []).filter((id) => states && states[id]).map((id) => ({ entity: id, label: (states[id].attributes || {}).friendly_name || id, control: "toggle", confirm: true }));
    const screens = [{
      id: "consumo", title: "Consumo", icon: "bolt",
      sections: [
        { title: "Potencia ahora", items: powerItems.length ? powerItems : [{ entity: "sensor.hd_consumo_casa", label: "Casa" }] },
        { title: "Energía acumulada", items: energyItems },
      ].concat(switchItems.length ? [{ title: "Controles", items: switchItems }] : []),
    }];
    return { version: 1, standalone: true, screens, flow: { entities: ents, battery_capacity_wh: Number(e.battery_capacity_wh) || 7600, colours: {} } };
  }

  /** Sensor virtual «Casa»: red (+import) + solar - exportación + descarga de batería. */
  function virtualHouse(states, energyMap) {
    const ents = (energyMap.flow && energyMap.flow.entities) || {};
    const g = powerW(states[ents.grid_power], true) || 0;
    const s = powerW(states[ents.pv_power]) || 0;
    const b = powerW(states[ents.battery_power]) || 0;
    const v = Math.max(0, g + s + b);
    return { entity_id: "sensor.hd_consumo_casa", state: String(Math.round(v)), attributes: { friendly_name: "Casa (calculado)", unit_of_measurement: "W", device_class: "power" }, last_changed: new Date().toISOString(), last_updated: new Date().toISOString(), context: { id: "" } };
  }

  const api = { buildFlow, mappedEntities, controls, validateControl, buildEnergyMap, virtualHouse, powerW, kwh };
  HDX.define("energyFlow", () => api);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
