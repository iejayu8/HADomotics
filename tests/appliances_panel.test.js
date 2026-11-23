"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..", "hadomotics");
const TYPES = JSON.parse(fs.readFileSync(path.join(ROOT, "appliance_types.json"), "utf8"));

function stubEl() {
  const el = {
    style: {}, dataset: {}, className: "", innerHTML: "", textContent: "", children: [],
    addEventListener() {}, removeEventListener() {}, setAttribute() {},
    appendChild(c) { el.children.push(c); return c; },
    querySelector() { return stubEl(); }, querySelectorAll() { return []; },
    contains() { return false; }, remove() {},
    classList: { contains() { return false; }, toggle() {}, add() {}, remove() {} },
  };
  return el;
}

function load() {
  const byId = {};
  const sandbox = {
    console, Intl, Date, Math, JSON, encodeURIComponent,
    setTimeout() { return 1; }, clearTimeout() {},
    fetch: async () => ({ ok: false, json: async () => ({}) }),
    location: { pathname: "/" },
    document: {
      addEventListener() {}, activeElement: null,
      body: { appendChild(e) { byId[e.id] = e; return e; } },
      getElementById(id) { return byId[id] || null; },
      createElement() { return stubEl(); },
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const f of ["element_icons.js", "appliances.js"]) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, "static", "js", f), "utf8"), sandbox);
  }
  const A = sandbox.HADomoticsAppliances;
  A._internals.setTypes(JSON.parse(JSON.stringify(TYPES)));
  return { A, I: A._internals, Icons: sandbox.HADomoticsIcons };
}

const s = (state, attributes = {}) => ({ state: String(state), attributes });

// Elementos como los añadiría el usuario (entidad principal + roles detectados).
const FRIDGE = {
  id: "e1", type: "fridge", label: "Nevera", entity_id: "sensor.cocina_nevera_temperatura_del_frigorifico",
  appliance_entities: {
    temp_cooler: "sensor.cocina_nevera_temperatura_del_frigorifico", temp_freezer: "sensor.cocina_nevera_temperatura_del_congelador",
    set_cooler: "number.cocina_nevera_temperatura_del_frigorifico", power_cool: "switch.cocina_nevera_power_cool",
    door_cooler: "binary_sensor.cocina_nevera_puerta_del_frigorifico",
  },
};
const DISH = {
  id: "e2", type: "dishwasher", label: "Lavavajillas", entity_id: "sensor.cocina_lavavajillas_estado_de_operacion",
  appliance_entities: {
    operation_state: "sensor.cocina_lavavajillas_estado_de_operacion", remote_start: "binary_sensor.cocina_lavavajillas_inicio_remoto",
    selected_program: "select.cocina_lavavajillas_programa_seleccionado", active_program: "select.cocina_lavavajillas_programa_activo",
    stop: "button.cocina_lavavajillas_detener_programa", finish_time: "sensor.cocina_lavavajillas_hora_de_finalizacion_del_programa",
  },
};
// Robot con solo la entidad principal: el rol «vacuum» sale de entity_id.
const ROBOT = { id: "e3", type: "vacuum", label: "Roborock", entity_id: "vacuum.qrevo_edge_2_pro",
  appliance_entities: { battery: "sensor.qrevo_edge_2_pro_bateria" } };

function idleStates() {
  const progs = { options: ["dishcare_dishwasher_program_eco_50", "dishcare_dishwasher_program_quick_65"] };
  return {
    "sensor.cocina_nevera_temperatura_del_frigorifico": s(3, { unit_of_measurement: "°C" }),
    "sensor.cocina_nevera_temperatura_del_congelador": s(-19, { unit_of_measurement: "°C" }),
    "number.cocina_nevera_temperatura_del_frigorifico": s(3, { min: 1, max: 7, step: 1, unit_of_measurement: "°C" }),
    "binary_sensor.cocina_nevera_puerta_del_frigorifico": s("off"),
    "switch.cocina_nevera_power_cool": s("off"),
    "sensor.cocina_lavavajillas_estado_de_operacion": s("ready"),
    "binary_sensor.cocina_lavavajillas_inicio_remoto": s("on"),
    "select.cocina_lavavajillas_programa_seleccionado": s("dishcare_dishwasher_program_eco_50", progs),
    "select.cocina_lavavajillas_programa_activo": s("unknown", progs),
    "button.cocina_lavavajillas_detener_programa": s("unknown"),
    "sensor.cocina_lavavajillas_hora_de_finalizacion_del_programa": s("unavailable"),
    "vacuum.qrevo_edge_2_pro": s("docked", { fan_speed: "balanced", fan_speed_list: ["quiet", "balanced", "turbo"] }),
    "sensor.qrevo_edge_2_pro_bateria": s(100, { unit_of_measurement: "%", device_class: "battery" }),
  };
}
const act = (kind, id) => TYPES.kinds[kind].actions.find((a) => a.id === id);

test("types have no fixed entity ids and the three kinds have the 3.7.0 icons", () => {
  const { A } = load();
  assert.deepEqual(Array.from(A.kindList(), (k) => [k.id, k.icon]),
    [["fridge", "nevera"], ["dishwasher", "lavavajillas"], ["vacuum", "robot"]]);
  assert.equal(A.isAppliance("button"), false);
  assert.equal(A.isAppliance("vacuum"), true);
});

test("badges use the element's own entities", () => {
  const { A, I } = load();
  I.setStates(idleStates());
  A.update(idleStates());
  assert.equal(A.badgeText(FRIDGE), "3 °C · -19 °C");
  assert.equal(A.badgeText(DISH), "Listo");
  assert.equal(A.badgeText(ROBOT), "100 % · En la base");
  // Otro robot con otras entidades: nada fijo.
  const other = { type: "vacuum", entity_id: "vacuum.otro" };
  A.update({ "vacuum.otro": s("cleaning") });
  assert.equal(A.badgeText(other), "Limpiando");
  assert.deepEqual(Array.from(A.stateClasses(other)), ["running"]);
});

test("discovery matches roles by translation_key, device_class and entity suffix", () => {
  const { A } = load();
  const st = { "sensor.robot_x_bateria": s(50, { device_class: "battery" }) };
  const cands = [
    { entity_id: "vacuum.robot_x", translation_key: "roborock" },
    { entity_id: "sensor.robot_x_bateria", translation_key: null },
    { entity_id: "sensor.robot_x_estado", translation_key: "status" },
    { entity_id: "select.robot_x_modo", translation_key: "cleaning_mode" },
    { entity_id: "sensor.robot_x_error_en_la_base", translation_key: null },
    { entity_id: "select.robot_x_mapa", translation_key: "selected_map" },
  ];
  assert.deepEqual(JSON.parse(JSON.stringify(A.matchRoles("vacuum", cands, st))), {
    vacuum: "vacuum.robot_x", battery: "sensor.robot_x_bateria", status: "sensor.robot_x_estado",
    dock_error: "sensor.robot_x_error_en_la_base", clean_mode: "select.robot_x_modo",
  });
  const fr = A.matchRoles("fridge", [
    { entity_id: "number.n_t1", translation_key: "cooler_temperature" },
    { entity_id: "sensor.n_t1", translation_key: "cooler_temperature" },
    { entity_id: "switch.n_pc", translation_key: "power_cool" },
  ], {});
  assert.equal(fr.set_cooler, "number.n_t1");
  assert.equal(fr.temp_cooler, "sensor.n_t1");
  assert.equal(fr.power_cool, "switch.n_pc");
});

test("discover uses hass.entities/devices inside Home Assistant (dock included)", async () => {
  const { A } = load();
  const hass = {
    entities: {
      "vacuum.r": { entity_id: "vacuum.r", device_id: "d1", translation_key: "roborock" },
      "sensor.r_dock_error": { entity_id: "sensor.r_dock_error", device_id: "d2", translation_key: "dock_error" },
      "sensor.other_dock_error": { entity_id: "sensor.other_dock_error", device_id: "d9", translation_key: "dock_error" },
    },
    devices: { d1: { id: "d1", name: "R", config_entries: ["e"] }, d2: { id: "d2", name: "R Dock", config_entries: ["e"] },
      d9: { id: "d9", name: "Otro", config_entries: ["x"] } },
  };
  let fetched = false;
  A.configure({ hass: () => hass, fetchJson: async () => { fetched = true; return {}; } });
  const res = await A.discover("vacuum", "vacuum.r");
  assert.equal(fetched, false);
  assert.deepEqual(JSON.parse(JSON.stringify(res.roles)), { vacuum: "vacuum.r", dock_error: "sensor.r_dock_error" });
});

test("discover falls back to the add-on endpoint outside Home Assistant", async () => {
  const { A } = load();
  const asked = [];
  A.configure({ hass: () => null, fetchJson: async (p) => { asked.push(p); return { entities: [
    { entity_id: "select.l_act", translation_key: "active_program" }] }; } });
  const res = await A.discover("dishwasher", "sensor.l_estado_de_operacion");
  assert.deepEqual(asked, ["/api/ha/device_entities?entity_id=sensor.l_estado_de_operacion"]);
  assert.equal(res.roles.active_program, "select.l_act");
  assert.equal(res.roles.operation_state, "sensor.l_estado_de_operacion");
});

test("actions run only after a press and confirmation, on the element's entities", async () => {
  const { A, I } = load();
  A.update(idleStates());
  const calls = [];
  let answer = false;
  A.configure({ call: async (d, sv, data) => { calls.push([d, sv, JSON.parse(JSON.stringify(data))]); }, confirm: () => answer });
  A.open(DISH); A.open(ROBOT); A.close();
  assert.equal(calls.length, 0);
  assert.equal(await I.runAction(DISH, act("dishwasher", "start")), false);
  answer = true;
  assert.equal(await I.runAction(DISH, act("dishwasher", "start")), true);
  assert.equal(await I.runAction(ROBOT, act("vacuum", "start")), true);
  assert.equal(await I.runAction(ROBOT, act("vacuum", "pause")), false);
  assert.deepEqual(calls, [
    ["select", "select_option", { entity_id: "select.cocina_lavavajillas_programa_activo", option: "dishcare_dishwasher_program_eco_50" }],
    ["vacuum", "start", { entity_id: "vacuum.qrevo_edge_2_pro" }],
  ]);
});

test("controls: setpoint within min/max, switch, missing roles are skipped", () => {
  const { A, I } = load();
  A.update(idleStates());
  const num = TYPES.kinds.fridge.controls.find((c) => c.role === "set_cooler");
  assert.deepEqual(JSON.parse(JSON.stringify(I.buildControlCall(FRIDGE, num, 4))),
    { domain: "number", service: "set_value", data: { entity_id: "number.cocina_nevera_temperatura_del_frigorifico", value: 4 } });
  const freezer = TYPES.kinds.fridge.controls.find((c) => c.role === "set_freezer");
  assert.equal(I.buildControlCall(FRIDGE, freezer, -20), null);
  assert.equal(I.stepNumber(s(7, { min: 1, max: 7, step: 1 }), 1), null);
  assert.equal(I.stepNumber(s(-19, { min: -23, max: -15, step: 1 }), -1), -20);
});

test("dishwasher start needs remote start and a selected program", () => {
  const { A, I } = load();
  const st = idleStates();
  A.update(st);
  assert.equal(I.actionState(DISH, act("dishwasher", "start")).ok, true);
  st["binary_sensor.cocina_lavavajillas_inicio_remoto"] = s("off");
  assert.equal(I.actionState(DISH, act("dishwasher", "start")).ok, false);
  st["binary_sensor.cocina_lavavajillas_inicio_remoto"] = s("on");
  st["sensor.cocina_lavavajillas_estado_de_operacion"] = s("run");
  assert.equal(I.actionState(DISH, act("dishwasher", "stop")).ok, true);
  assert.equal(I.actionState(DISH, act("dishwasher", "start")).ok, false);
});

test("icons: Xavi's elements get specific icons in one style", () => {
  const { Icons } = load();
  const r = (type, entity_id, label, dc) => Icons.resolve({ type, entity_id, label }, { state: "off", attributes: { device_class: dc } });
  assert.equal(r("cover", "cover.persiana_comedor_2", "Persiana comedor derecha", "blind"), "persiana");
  assert.equal(r("cover", "cover.puerta_garaje_door", "Puerta garaje", "garage"), "garaje_interior");
  assert.equal(r("cover", "script.abrir_cerrar_puerta_exterior", "Puerta exterior"), "puerta_exterior");
  assert.equal(r("custom", "scene.dia", "Día"), "modo_dia");
  assert.equal(r("custom", "scene.noche", "Noche"), "modo_noche");
  assert.equal(r("climate", "climate.152832118008732_climate", "Clima"), "aerotermia");
  assert.equal(r("button", "switch.depuradora", "Depuradora"), "depuradora");
  assert.equal(r("light", "switch.luz_entrada", "Luz Entrada"), "luz");
  assert.equal(r("light", "light.luz_patio", "Luz Patio"), "luz");
  assert.equal(r("button", "switch.enchufe_tv", "Enchufe TV"), "enchufe");
  assert.equal(r("sensor", "sensor.evse_charging_power", "Cargador", "power"), "cargador");
  assert.equal(r("custom", "alarm_control_panel.alarmo", "Alarma"), "alarma");
  assert.equal(r("fridge", "sensor.x", "Lo que sea"), "nevera");
  assert.equal(r("vacuum", "vacuum.x", "Robot"), "robot");
  // Elegido a mano gana; un valor antiguo desconocido no.
  assert.equal(Icons.resolve({ type: "button", entity_id: "switch.x", svg_icon: "ventilador" }, null), "ventilador");
  assert.equal(Icons.resolve({ type: "button", entity_id: "switch.x", svg_icon: "switch" }, null), "interruptor");
  // Mismo estilo en todos: viewBox 24, trazo 1,8, currentColor, sin relleno.
  for (const k of Icons.keys) {
    const svg = Icons.svg(k, { on: true, pos: 40 });
    assert.match(svg, /viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"/);
    assert.doesNotMatch(svg, /fill="#|stroke="#|<image|href=/, k);
  }
});

test("icons follow the state: blinds by position, light rays, garage open/closed", () => {
  const { Icons } = load();
  const blind = (pos) => (Icons.svg("persiana", { pos }).match(/M6 /g) || []).length;
  assert.equal(blind(0), 5);
  assert.equal(blind(100), 0);
  assert.ok(blind(50) > 0 && blind(50) < 5);
  assert.notEqual(Icons.svg("luz", { on: true }), Icons.svg("luz", { on: false }));
  assert.notEqual(Icons.svg("garaje_interior", { on: true }), Icons.svg("garaje_interior", { on: false }));
  assert.notEqual(Icons.svg("garaje_interior", {}), Icons.svg("puerta_exterior", {}));
  const cls = (st) => Icons.stateClass({ entity_id: "light.x" }, st && { state: st });
  assert.equal(cls("on"), "on");
  assert.equal(cls("off"), "off");
  assert.equal(cls("unavailable"), "unavailable");
  assert.equal(cls(null), "");
});

test("app.js renders element icons from element_icons.js and opens appliances on tap", () => {
  const appJs = fs.readFileSync(path.join(ROOT, "static", "js", "app.js"), "utf8");
  assert.doesNotMatch(appJs, /material-icons el-icon/);
  assert.match(appJs, /HA_APPL\(\)\.open\(el\)/);
  assert.match(appJs, /call: callAddonOrHass/);
  assert.doesNotMatch(appJs, /appliances\/positions|appliances\/map/);
  // Regresión: si los estados llegan antes que la planta, el panel también los recibe.
  const upd = appJs.slice(appJs.indexOf("function updateElementStates()"));
  assert.ok(upd.indexOf("HADomoticsAppliances.update(entityStates)") < upd.indexOf("if (!currentFloor"));
  const ren = appJs.slice(appJs.indexOf("function renderElements("), appJs.indexOf("function renderElements(") + 400);
  assert.match(ren, /HADomoticsAppliances\.update\(entityStates\)/);
});
