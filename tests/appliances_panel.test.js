"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..", "hadomotics");
const MAP = JSON.parse(fs.readFileSync(path.join(ROOT, "appliances_map.json"), "utf8"));

function stubEl() {
  const el = {
    style: {}, dataset: {}, className: "", innerHTML: "", textContent: "",
    children: [],
    addEventListener() {}, removeEventListener() {}, setAttribute() {},
    appendChild(c) { el.children.push(c); return c; },
    querySelector() { return stubEl(); },
    querySelectorAll() { return []; },
    contains() { return false; },
    remove() {},
    classList: { contains() { return false; }, toggle() {}, add() {}, remove() {} },
  };
  return el;
}

function load() {
  const byId = {};
  const sandbox = {
    console, Intl, Date, Math, JSON,
    setTimeout() { return 1; }, clearTimeout() {},
    fetch: async () => ({ ok: false, json: async () => ({}) }),
    location: { pathname: "/" },
    document: {
      addEventListener() {},
      activeElement: null,
      body: { appendChild(e) { byId[e.id] = e; return e; } },
      getElementById(id) { return byId[id] || null; },
      createElement() { return stubEl(); },
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "static", "js", "appliances.js"), "utf8"), sandbox);
  const A = sandbox.HADomoticsAppliances;
  A._internals.setMap(JSON.parse(JSON.stringify(MAP)));
  return { A, I: A._internals, sandbox };
}

const s = (state, attributes = {}) => ({ state: String(state), attributes });

// Estados reales leídos de HA el 23/11/2026 (lavavajillas listo, Roborock en la base).
function idleStates() {
  return {
    "sensor.cocina_nevera_temperatura_del_frigorifico": s(3, { unit_of_measurement: "°C" }),
    "sensor.cocina_nevera_temperatura_del_congelador": s(-19, { unit_of_measurement: "°C" }),
    "number.cocina_nevera_temperatura_del_frigorifico": s(3, { min: 1, max: 7, step: 1, unit_of_measurement: "°C" }),
    "number.cocina_nevera_temperatura_del_congelador": s(-19, { min: -23, max: -15, step: 1, unit_of_measurement: "°C" }),
    "binary_sensor.cocina_nevera_puerta_del_frigorifico": s("off"),
    "binary_sensor.cocina_nevera_puerta_del_congelador": s("off"),
    "switch.cocina_nevera_power_cool": s("off"),
    "sensor.cocina_lavavajillas_estado_de_operacion": s("ready"),
    "binary_sensor.cocina_lavavajillas_inicio_remoto": s("on"),
    "select.cocina_lavavajillas_programa_seleccionado": s("dishcare_dishwasher_program_eco_50", {
      options: ["dishcare_dishwasher_program_eco_50", "dishcare_dishwasher_program_quick_65"] }),
    "select.cocina_lavavajillas_programa_activo": s("unknown", {
      options: ["dishcare_dishwasher_program_eco_50", "dishcare_dishwasher_program_quick_65"] }),
    "button.cocina_lavavajillas_detener_programa": s("unknown"),
    "sensor.cocina_lavavajillas_hora_de_finalizacion_del_programa": s("unavailable"),
    "vacuum.qrevo_edge_2_pro": s("docked", { fan_speed: "balanced", fan_speed_list: ["quiet", "balanced", "turbo"] }),
    "sensor.qrevo_edge_2_pro_bateria": s(100, { unit_of_measurement: "%" }),
    "sensor.qrevo_edge_2_pro_error_de_aspirador": s("none"),
    "sensor.qrevo_edge_2_pro_dock_error_en_la_base": s("ok"),
    "binary_sensor.qrevo_edge_2_pro_dock_caja_de_agua_limpia": s("off"),
    "binary_sensor.qrevo_edge_2_pro_dock_caja_de_agua_sucia": s("off"),
  };
}

const app = (I, id) => MAP.appliances.find((a) => a.id === id);
const act = (id, actionId) => MAP.appliances.find((a) => a.id === id).actions.find((x) => x.id === actionId);

test("badges: temperatures, dishwasher state, battery and vacuum state in Spanish", () => {
  const { I } = load();
  I.setStates(idleStates());
  assert.equal(I.badgeText(app(I, "nevera")), "3 °C · -19 °C");
  assert.equal(I.badgeText(app(I, "lavavajillas")), "Listo");
  assert.equal(I.badgeText(app(I, "roborock")), "100 % · En la base");
  assert.deepEqual(I.activeAlerts(app(I, "nevera")), []);
  assert.equal(I.isRunning(app(I, "roborock")), false);
});

test("remaining time comes from the program end timestamp", () => {
  const { I } = load();
  const now = Date.parse("2026-11-23T18:00:00Z");
  assert.match(I.remaining("2026-11-23T19:37:00Z", now), /^1 h 37 min/);
  assert.equal(I.remaining("2026-11-23T17:00:00Z", now), null);
  assert.equal(I.remaining("unavailable", now), null);
});

test("alerts: open fridge door, vacuum error and dock error", () => {
  const { I } = load();
  const st = idleStates();
  st["binary_sensor.cocina_nevera_puerta_del_frigorifico"] = s("on");
  st["sensor.qrevo_edge_2_pro_error_de_aspirador"] = s("main_brush_jammed");
  I.setStates(st);
  assert.deepEqual(Array.from(I.activeAlerts(app(I, "nevera"))), ["Puerta del frigorífico abierta"]);
  assert.deepEqual(Array.from(I.activeAlerts(app(I, "roborock"))), ["Error de la aspiradora"]);
});

test("Roborock: start only when idle/docked, pause only while cleaning", () => {
  const { I } = load();
  const st = idleStates();
  I.setStates(st);
  assert.equal(I.actionState(act("roborock", "start")).ok, true);
  assert.equal(I.actionState(act("roborock", "pause")).ok, false);
  assert.equal(I.actionState(act("roborock", "home")).ok, false);
  st["vacuum.qrevo_edge_2_pro"] = s("cleaning");
  assert.equal(I.actionState(act("roborock", "start")).ok, false);
  assert.equal(I.actionState(act("roborock", "pause")).ok, true);
  assert.equal(I.actionState(act("roborock", "home")).ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(I.buildActionCall(act("roborock", "home")))),
    { domain: "vacuum", service: "return_to_base", data: { entity_id: "vacuum.qrevo_edge_2_pro" } });
});

test("dishwasher start selects the chosen program as active program; needs remote start", () => {
  const { I } = load();
  const st = idleStates();
  I.setStates(st);
  const start = act("lavavajillas", "start");
  assert.equal(I.actionState(start).ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(I.buildActionCall(start))), {
    domain: "select", service: "select_option",
    data: { entity_id: "select.cocina_lavavajillas_programa_activo", option: "dishcare_dishwasher_program_eco_50" },
  });
  st["binary_sensor.cocina_lavavajillas_inicio_remoto"] = s("off");
  assert.equal(I.actionState(start).ok, false);
  st["binary_sensor.cocina_lavavajillas_inicio_remoto"] = s("on");
  st["sensor.cocina_lavavajillas_estado_de_operacion"] = s("run");
  assert.equal(I.actionState(start).ok, false);
  assert.equal(I.actionState(act("lavavajillas", "stop")).ok, true);
});

test("actions run only after a press and the confirmation", async () => {
  const { A, I } = load();
  I.setStates(idleStates());
  const calls = [];
  let answer = false;
  A.configure({ call: async (d, sv, data) => { calls.push([d, sv, data]); }, confirm: () => answer });
  // Cargar estados y abrir la ventana no llama a nada.
  A.update(null, idleStates());
  A.open("lavavajillas");
  A.open("roborock");
  A.close();
  assert.equal(calls.length, 0);
  assert.equal(await I.runAction(app(I, "lavavajillas"), act("lavavajillas", "start")), false);
  assert.equal(calls.length, 0);
  answer = true;
  assert.equal(await I.runAction(app(I, "lavavajillas"), act("lavavajillas", "start")), true);
  assert.equal(await I.runAction(app(I, "roborock"), act("roborock", "start")), true);
  // Deshabilitada: no se envía.
  assert.equal(await I.runAction(app(I, "roborock"), act("roborock", "pause")), false);
  assert.deepEqual(calls.map((c) => `${c[0]}.${c[1]}`), ["select.select_option", "vacuum.start"]);
});

test("a failed call is reported and does not throw", async () => {
  const { A, I } = load();
  I.setStates(idleStates());
  A.configure({ call: async () => { throw new Error("HTTP 403"); }, confirm: () => true });
  assert.equal(await I.runAction(app(I, "roborock"), act("roborock", "locate")), false);
});

test("controls: fridge setpoints stay within HA min/max, switches, selects and fan speed", () => {
  const { I } = load();
  const st = idleStates();
  assert.equal(I.stepNumber(st["number.cocina_nevera_temperatura_del_frigorifico"], 1), 4);
  assert.equal(I.stepNumber(s(7, { min: 1, max: 7, step: 1 }), 1), null);
  assert.equal(I.stepNumber(s(-23, { min: -23, max: -15, step: 1 }), -1), null);
  assert.equal(I.stepNumber(s(-19, { min: -23, max: -15, step: 1 }), -1), -20);
  const nev = app(I, "nevera");
  const num = nev.controls.find((c) => c.type === "number");
  const sw = nev.controls.find((c) => c.entity === "switch.cocina_nevera_power_cool");
  assert.deepEqual(JSON.parse(JSON.stringify(I.buildControlCall(num, 4))),
    { domain: "number", service: "set_value", data: { entity_id: num.entity, value: 4 } });
  assert.equal(I.buildControlCall(sw, true).service, "turn_on");
  assert.equal(I.buildControlCall(sw, false).service, "turn_off");
  const fan = app(I, "roborock").controls.find((c) => c.type === "fan_speed");
  assert.deepEqual(JSON.parse(JSON.stringify(I.buildControlCall(fan, "turbo"))),
    { domain: "vacuum", service: "set_fan_speed", data: { entity_id: "vacuum.qrevo_edge_2_pro", fan_speed: "turbo" } });
});

test("unavailable entities show 'No disponible' and disable actions", () => {
  const { I } = load();
  I.setStates({ "vacuum.qrevo_edge_2_pro": s("unavailable") });
  assert.equal(I.formatValue({ entity: "vacuum.qrevo_edge_2_pro", labels: "vacuum_state" }), "No disponible");
  assert.equal(I.actionState(act("roborock", "locate")).ok, false);
  assert.equal(I.badgeText(app(I, "roborock")), "");
});

test("the panel loads appliances.js before app.js and app.js uses callAddonOrHass", () => {
  const index = fs.readFileSync(path.join(ROOT, "static", "index.html"), "utf8");
  assert.ok(index.indexOf("static/js/appliances.js") < index.indexOf("static/js/app.js"));
  const appJs = fs.readFileSync(path.join(ROOT, "static", "js", "app.js"), "utf8");
  assert.match(appJs, /call: callAddonOrHass/);
  assert.match(appJs, /\/api\/appliances\/positions/);
});
