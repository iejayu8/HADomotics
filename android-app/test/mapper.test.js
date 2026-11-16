"use strict";
const test = require("node:test");
const assert = require("node:assert");
const m = require("../src/tuya/mapper.js");
const demo = require("../src/tuya/demo-home.js");
const { statusArrayToMap } = require("../src/tuya/cloud.js");

function mapAll() {
  const reg = new m.EntityRegistry();
  const out = {};
  demo.devices().forEach((d) => {
    m.mapDevice(Object.assign({}, d, { status: statusArrayToMap(d.status), spec: demo.SPECS[d.category] }), reg, 0).forEach((e) => { out[e.entity_id] = e; });
  });
  return { out, reg };
}

test("casa demo -> entidades estilo HA", () => {
  const { out } = mapAll();
  assert.strictEqual(out["light.luz_salon"].state, "on");
  assert.strictEqual(out["light.luz_salon"].attributes.brightness, Math.round(((700 - 10) / 990) * 255));
  assert.strictEqual(out["switch.depuradora"].state, "off");
  assert.strictEqual(out["sensor.depuradora_voltage"].state, "230.1");
  assert.strictEqual(out["switch.regleta_oficina_1"].state, "on");
  assert.strictEqual(out["switch.regleta_oficina_2"].state, "off");
  assert.strictEqual(out["cover.persiana_salon"].attributes.current_position, 60);
  assert.strictEqual(out["cover.puerta_garaje"].state, "closed");
  assert.strictEqual(out["binary_sensor.pir_entrada"].attributes.device_class, "motion");
  assert.strictEqual(out["binary_sensor.puerta_principal"].attributes.device_class, "door");
  assert.strictEqual(out["siren.sirena"].state, "off");
  assert.deepStrictEqual(out["select.sirena_nivel"].attributes.options, ["low", "middle", "high", "mute"]);
  assert.ok(out["select.sirena_tono"]);
  assert.strictEqual(out["sensor.temperatura_salon_temperature"].state, "21.5");
  assert.strictEqual(out["sensor.cargador_coche_potencia_de_carga"].state, "7.2");
  assert.strictEqual(out["sensor.cargador_coche_potencia_de_carga"].attributes.unit_of_measurement, "kW");
  assert.strictEqual(out["sensor.cargador_coche_estado"].state, "Charging");
  assert.strictEqual(out["sensor.contador_general_phase_a_potencia"].state, "2250");
  assert.ok(out["binary_sensor.camara_jardin_persona"]);
});

test("registro estable: renombrar el dispositivo no cambia el entity_id", () => {
  const reg = new m.EntityRegistry();
  const dev = { id: "x1", name: "Luz A", category: "dj", status: { switch_led: true } };
  const a = m.mapDevice(dev, reg, 0)[0].entity_id;
  const b = m.mapDevice(Object.assign({}, dev, { name: "Otra" }), new m.EntityRegistry(JSON.parse(JSON.stringify(reg))), 0)[0].entity_id;
  assert.strictEqual(a, "light.luz_a");
  assert.strictEqual(b, a);
});

test("nombres repetidos -> ids únicos", () => {
  const reg = new m.EntityRegistry();
  const e1 = m.mapDevice({ id: "a", name: "Enchufe", category: "cz", status: { switch_1: true } }, reg, 0)[0].entity_id;
  const e2 = m.mapDevice({ id: "b", name: "Enchufe", category: "cz", status: { switch_1: true } }, reg, 0)[0].entity_id;
  assert.notStrictEqual(e1, e2);
});

test("dispositivo sin conexión -> unavailable", () => {
  const e = m.mapDevice({ id: "p", name: "PIR", category: "pir", online: false, status: { pir: "none" } }, new m.EntityRegistry(), 0);
  assert.strictEqual(e[0].state, "unavailable");
});

test("servicios HA -> órdenes Tuya", () => {
  const { out } = mapAll();
  assert.deepStrictEqual(m.commandsFor(out["switch.depuradora"], "switch", "toggle", {}), { device_id: "demo_depuradora", commands: [{ code: "switch_1", value: true }] });
  assert.deepStrictEqual(m.commandsFor(out["light.luz_salon"], "light", "turn_on", { brightness: 255 }).commands, [{ code: "switch_led", value: true }, { code: "bright_value_v2", value: 1000 }]);
  assert.deepStrictEqual(m.commandsFor(out["cover.persiana_salon"], "cover", "set_cover_position", { position: 25 }).commands, [{ code: "percent_control", value: 25 }]);
  assert.deepStrictEqual(m.commandsFor(out["cover.persiana_salon"], "cover", "stop_cover", {}).commands, [{ code: "control", value: "stop" }]);
  assert.deepStrictEqual(m.commandsFor(out["cover.puerta_garaje"], "cover", "toggle", {}).commands, [{ code: "switch_1", value: true }]);
  assert.deepStrictEqual(m.commandsFor(out["siren.sirena"], "siren", "turn_on", {}).commands, [{ code: "alarm_switch", value: true }]);
  assert.deepStrictEqual(m.commandsFor(out["select.sirena_nivel"], "select", "select_option", { option: "low" }).commands, [{ code: "alarm_volume", value: "low" }]);
  assert.strictEqual(m.commandsFor(out["select.sirena_nivel"], "select", "select_option", { option: "ensordecedor" }), null);
  assert.strictEqual(m.commandsFor(out["binary_sensor.pir_entrada"], "binary_sensor", "turn_on", {}), null);
});

test("escena Tuya", () => {
  const reg = new m.EntityRegistry();
  const s = m.mapScene({ scene_id: "s1", name: "Escena noche" }, "h1", reg, 0);
  assert.strictEqual(s.entity_id, "scene.escena_noche");
  assert.deepStrictEqual(m.commandsFor(s, "scene", "turn_on", {}), { scene: { home_id: "h1", scene_id: "s1" } });
});

test("decodificación phase_a de contadores", () => {
  const d = m.decodePhase(demo.phaseA(230.4, 9.8, 2.25));
  assert.deepStrictEqual(d, { voltage: 230.4, current: 9.8, power_w: 2250 });
});
