"use strict";
// Módulos configurables en la app: persistencia, rutas 404, sin motor de alarma ni
// servicio nativo con Seguridad desactivada, y el modo demo respeta la elección.
const test = require("node:test");
const assert = require("node:assert");
const { MemoryStore, SecureStore } = require("../src/core/store.js");
const { Hub, normalizeModules, validModules } = require("../src/backend/hub.js");
const { createApi, moduleForPath } = require("../src/backend/api.js");
const { MockTuyaServer } = require("../src/tuya/mock-server.js");

async function setup({ store, settings } = {}) {
  let now = 1_800_000_000_000;
  store = store || new MemoryStore();
  if (settings) await store.set("settings", settings);
  const secure = new SecureStore(null);
  const notes = [];
  const server = new MockTuyaServer({ now: () => now });
  const native = { configured: [], configure: async (o) => native.configured.push(JSON.parse(o.json)) };
  class FixedMock { constructor() { return server; } }
  const hub = new Hub({ store, secure, http: server.handler(), now: () => now, notify: async (n) => notes.push(n), MockServer: FixedMock, native });
  await hub.init();
  const api = createApi({ hub, store, secure, now: () => now });
  const call = (method, path, body) => api.handle({ method, path, body });
  return { hub, call, store, server, notes, native, advance: (ms) => { now += ms; } };
}
const ALL = { dispositivos: true, energia: true, seguridad: true };

test("normalizeModules / validModules", () => {
  assert.deepStrictEqual(normalizeModules(undefined), ALL);
  assert.deepStrictEqual(normalizeModules({ energia: false }), { dispositivos: true, energia: false, seguridad: true });
  assert.deepStrictEqual(normalizeModules({ dispositivos: false, energia: false, seguridad: false }), ALL);
  assert.strictEqual(validModules({ dispositivos: false, energia: false, seguridad: false }), false);
  assert.strictEqual(validModules({ dispositivos: true }), false); // faltan claves
  assert.strictEqual(validModules({ dispositivos: false, energia: false, seguridad: true }), true);
});

test("instalación de 0.1.1 (sin «modules»): los tres activos y sin asistente de módulos", async () => {
  const { call } = await setup({ settings: { version: 1, mode: "demo", onboarded: true } });
  assert.deepStrictEqual((await call("GET", "/api/modules")).body, { modules: ALL });
  const st = (await call("GET", "/api/standalone/status")).body;
  assert.deepStrictEqual(st.modules, ALL);
  assert.strictEqual(st.modules_chosen, false);
  assert.strictEqual(st.onboarded, true);
});

test("primer arranque: no se puede guardar sin al menos un módulo", async () => {
  const { call } = await setup();
  assert.strictEqual((await call("GET", "/api/standalone/status")).body.modules_chosen, false);
  const r = await call("PUT", "/api/standalone/settings", { modules: { dispositivos: false, energia: false, seguridad: false } });
  assert.strictEqual(r.status, 400);
  assert.strictEqual((await call("PUT", "/api/standalone/settings", { modules: { energia: true } })).status, 400);
  assert.strictEqual((await call("PUT", "/api/standalone/settings", { modules: "todo" })).status, 400);
});

test("la elección se guarda y sobrevive a reiniciar la app", async () => {
  const a = await setup();
  const m = { dispositivos: false, energia: true, seguridad: false };
  assert.strictEqual((await a.call("PUT", "/api/standalone/settings", { modules: m })).status, 200);
  const b = await setup({ store: a.store });
  assert.deepStrictEqual((await b.call("GET", "/api/modules")).body.modules, m);
  assert.strictEqual((await b.call("GET", "/api/standalone/status")).body.modules_chosen, true);
});

test("rutas de módulos desactivados -> 404; plantas siguen disponibles", async () => {
  const { call } = await setup();
  await call("PUT", "/api/standalone/settings", { modules: { dispositivos: false, energia: false, seguridad: true } });
  for (const p of ["/api/energy/map", "/api/energy/state", "/api/energy/flow"]) {
    const r = await call("GET", p);
    assert.strictEqual(r.status, 404, p);
    assert.strictEqual(r.body.module, "energia");
  }
  assert.strictEqual((await call("POST", "/api/energy/control", { entity_id: "switch.x" })).status, 404);
  assert.strictEqual((await call("GET", "/api/floors/planta_baja/elements")).status, 404);
  assert.strictEqual((await call("PUT", "/api/elements/colors", {})).status, 404);
  assert.strictEqual((await call("GET", "/api/floors")).status, 200);
  assert.strictEqual((await call("GET", "/api/security/map")).status, 200);
  assert.strictEqual(moduleForPath("/api/floors/x/elements/y"), "dispositivos");
  assert.strictEqual(moduleForPath("/api/floors/x"), null);
});

test("Seguridad desactivada: sin motor de alarma, sin servicio nativo y sin órdenes de alarma", async () => {
  const { hub, call, native, notes, advance } = await setup();
  await call("POST", "/api/standalone/demo", { enabled: true });
  await call("PUT", "/api/standalone/settings", { modules: { dispositivos: true, energia: true, seguridad: false }, background: { enabled: true, pulsar: true } });
  const ids = hub.allStates().map((s) => s.entity_id);
  assert.ok(!ids.includes("alarm_control_panel.hadomotics"));
  assert.ok(!ids.some((i) => /^input_boolean\.hd_/.test(i)));
  const last = native.configured[native.configured.length - 1];
  assert.strictEqual(last.background.enabled, false);
  assert.strictEqual(last.background.pulsar, false);
  assert.deepStrictEqual(last.sensors, []);
  assert.strictEqual(last.siren, null);
  assert.strictEqual((await call("POST", "/api/security/alarm", { entity_id: "alarm_control_panel.hadomotics", service: "alarm_arm_away" })).status, 404);
  await assert.rejects(hub.callService("alarm_control_panel", "alarm_arm_away", { entity_id: "alarm_control_panel.hadomotics" }), /Seguridad/);
  const before = notes.length;
  const pir = Object.values(hub.devices).find((d) => d.id === "demo_pir_salon");
  hub.applyPush(pir.id, [{ code: "pir", value: "pir" }]);
  advance(5000); hub.tick();
  assert.strictEqual(notes.length, before);
  // Las demás vistas siguen funcionando
  assert.strictEqual((await call("GET", "/api/energy/map")).status, 200);
  assert.strictEqual((await call("GET", "/api/floors/planta_baja/elements")).status, 200);
});

test("no se puede desactivar Seguridad con la alarma armada (no salta el código)", async () => {
  const { hub, call } = await setup();
  await call("POST", "/api/standalone/demo", { enabled: true });
  await hub.callService("alarm_control_panel", "alarm_arm_away", { entity_id: "alarm_control_panel.hadomotics" });
  assert.notStrictEqual(hub.alarm.s.state, "disarmed");
  const r = await call("PUT", "/api/standalone/settings", { modules: { dispositivos: true, energia: true, seguridad: false } });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(hub.moduleOn("seguridad"), true);
  await assert.rejects(hub.saveSettings({ modules: { dispositivos: true, energia: false, seguridad: false } }), /Desarma/);
});

test("Energía desactivada: no se calcula el sensor virtual «Casa»", async () => {
  const { hub, call } = await setup();
  await call("POST", "/api/standalone/demo", { enabled: true });
  await call("PUT", "/api/standalone/settings", { energy: { grid_power: "sensor.contador_general_phase_a_potencia" } });
  assert.ok(hub.getState("sensor.hd_consumo_casa"), "con Energía activa existe el sensor virtual");
  await call("PUT", "/api/standalone/settings", { modules: { dispositivos: true, energia: false, seguridad: true } });
  assert.strictEqual(hub.getState("sensor.hd_consumo_casa"), null);
});

test("modo demo respeta los módulos elegidos antes de activarlo", async () => {
  const { call } = await setup();
  const m = { dispositivos: false, energia: true, seguridad: false };
  await call("PUT", "/api/standalone/settings", { modules: m });
  const r = await call("POST", "/api/standalone/demo", { enabled: true });
  assert.strictEqual(r.body.mode, "demo");
  assert.deepStrictEqual((await call("GET", "/api/modules")).body.modules, m);
  assert.strictEqual((await call("GET", "/api/security/state")).status, 404);
  assert.strictEqual((await call("GET", "/api/energy/flow")).status, 200);
});
