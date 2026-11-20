"use strict";
// Integración: API del add-on emulada sobre el Hub (Tuya simulado) y el almacén en memoria.
const test = require("node:test");
const assert = require("node:assert");
const { MemoryStore, SecureStore } = require("../src/core/store.js");
const { Hub, pollInterval } = require("../src/backend/hub.js");
const { createApi } = require("../src/backend/api.js");
const { MockTuyaServer } = require("../src/tuya/mock-server.js");

async function setup(mode) {
  let now = 1_800_000_000_000;
  const store = new MemoryStore();
  const secure = new SecureStore(null);
  const notes = [];
  const server = new MockTuyaServer({ now: () => now });
  const native = { configured: [], configure: async (o) => native.configured.push(JSON.parse(o.json)) };
  class FixedMock { constructor() { return server; } }
  const hub = new Hub({ store, secure, http: server.handler(), now: () => now, notify: async (n) => notes.push(n), MockServer: FixedMock, native });
  await hub.init();
  const api = createApi({ hub, store, secure, now: () => now });
  const call = (method, path, body, files) => api.handle({ method, path, body, files });
  if (mode === "demo") await call("POST", "/api/standalone/demo", { enabled: true });
  return { hub, api, call, store, secure, server, notes, native, advance: (ms) => { now += ms; }, now: () => now };
}

test("arranque sin configurar: una planta por defecto y estados de la alarma", async () => {
  const { call } = await setup();
  const floors = await call("GET", "/api/floors");
  assert.strictEqual(floors.body[0].name, "Planta baja");
  const st = await call("GET", "/api/ha/states");
  assert.ok(st.body.some((s) => s.entity_id === "alarm_control_panel.hadomotics"));
  const status = await call("GET", "/api/standalone/status");
  assert.strictEqual(status.body.mode, "unconfigured");
});

test("modo demo: descubre la casa simulada y la expone como estados HA", async () => {
  const { call } = await setup("demo");
  const st = (await call("GET", "/api/ha/states")).body;
  assert.ok(st.find((s) => s.entity_id === "light.luz_salon"));
  assert.ok(st.find((s) => s.entity_id === "scene.escena_dia"));
  const devs = (await call("GET", "/api/standalone/devices")).body;
  assert.ok(devs.find((d) => d.id === "demo_pir_salon" && d.sub));
});

test("credenciales: formato validado, van al almacén seguro y nunca se devuelven", async () => {
  const { call, secure, hub } = await setup();
  assert.strictEqual((await call("POST", "/api/standalone/credentials", { access_id: "x", access_secret: "y" })).status, 400);
  const r = await call("POST", "/api/standalone/credentials", { access_id: "abcdefghij1234567890", access_secret: "s".repeat(32), region: "eu" });
  // No hay red en los tests: el transporte simulado rechaza otro client_id -> 502, pero quedan guardadas.
  assert.strictEqual(await secure.get("tuya_access_id"), "abcdefghij1234567890");
  assert.ok(!JSON.stringify(r.body).includes("s".repeat(32)));
  const s = await call("GET", "/api/standalone/settings");
  assert.ok(!JSON.stringify(s.body).includes("s".repeat(32)));
  const b = await call("GET", "/api/backup");
  assert.ok(!JSON.stringify(b.body).includes("s".repeat(32)));
  assert.strictEqual(hub.settings.mode, "tuya");
  await call("DELETE", "/api/standalone/credentials");
  assert.strictEqual(await secure.get("tuya_access_secret"), null);
});

test("Dispositivos: plantas, imagen, elementos (también fuera del plano) y servicios", async () => {
  const { call, server } = await setup("demo");
  const f = (await call("POST", "/api/floors", { name: "Planta 1" })).body;
  const blob = new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" });
  blob.name = "plano.png";
  const up = await call("POST", `/api/floors/${f.id}/image`, null, { image: blob });
  assert.strictEqual(up.status, 200);
  const img = await call("GET", `/api/images/${up.body.image}`);
  assert.ok(img.blob);
  assert.strictEqual((await call("GET", "/api/images/otra.png")).status, 404);
  const el = (await call("POST", `/api/floors/${f.id}/elements`, { entity_id: "switch.depuradora", label: "Depuradora" })).body;
  const moved = await call("PUT", `/api/floors/${f.id}/elements/${el.id}`, { x: -40, y: 10, outside: true });
  assert.strictEqual(moved.body.outside, true);
  const r = await call("POST", "/api/ha/services/switch/toggle", { entity_id: "switch.depuradora" });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body[0].state, "on");
  assert.deepStrictEqual(server.commands.at(-1), { id: "demo_depuradora", commands: [{ code: "switch_1", value: true }] });
  const sc = await call("POST", "/api/ha/services/scene/turn_on", { entity_id: "scene.escena_noche" });
  assert.strictEqual(sc.status, 200);
  assert.deepStrictEqual(server.commands.at(-1), { scene: "demo_scene_noche" });
  assert.strictEqual((await call("POST", "/api/ha/services/alarm_control_panel/alarm_disarm", { entity_id: "alarm_control_panel.hadomotics" })).status, 403);
});

test("copia de seguridad compatible con el add-on (ida y vuelta)", async () => {
  const { call } = await setup("demo");
  const fid = (await call("GET", "/api/floors")).body[0].id;
  const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }); blob.name = "a.png";
  await call("POST", `/api/floors/${fid}/image`, null, { image: blob });
  await call("POST", `/api/floors/${fid}/elements`, { entity_id: "light.luz_salon" });
  const b = (await call("GET", "/api/backup")).body;
  assert.strictEqual(b.floors[0].image_base64, "AQID");
  assert.strictEqual(b.standalone.app, "hadomotics-android");
  const other = await setup();
  assert.strictEqual((await other.call("POST", "/api/restore", b)).status, 200);
  const fl = (await other.call("GET", `/api/floors/${fid}`)).body;
  assert.strictEqual(fl.elements[0].entity_id, "light.luz_salon");
  assert.ok(fl.image);
  // Un backup del add-on (sin bloque standalone) también se importa
  delete b.standalone;
  assert.strictEqual((await other.call("POST", "/api/restore", b)).status, 200);
});

test("Seguridad: mapa generado, armar/desarmar con código, zonas, sirena y disparo", async () => {
  const t = await setup("demo");
  const { call, server, notes } = t;
  const put = await call("PUT", "/api/standalone/settings", {
    alarm: {
      code: "2468", code_arm_required: false, exit_delay: { armed_night: 0, armed_away: 0 },
      siren: { entity: "siren.sirena" },
      zones: [
        { id: "entrada", name: "Entrada", night: true, sensors: ["binary_sensor.puerta_principal", "binary_sensor.pir_entrada"] },
        { id: "arriba", name: "Pasillo arriba", night: false, sensors: ["binary_sensor.pir_pasillo_arriba"] },
      ],
    },
  });
  assert.strictEqual(put.status, 200);
  const settings = (await call("GET", "/api/standalone/settings")).body;
  assert.strictEqual(settings.alarm.has_code, true);
  assert.ok(!JSON.stringify(settings).includes("2468"));
  const map = (await call("GET", "/api/security/map")).body;
  assert.strictEqual(map.alarm.entity, "alarm_control_panel.hadomotics");
  assert.deepStrictEqual(map.zones.map((z) => z.entity), ["input_boolean.hd_zona_entrada", "input_boolean.hd_zona_arriba"]);
  assert.ok(map.presence.find((p) => p.entity === "binary_sensor.pir_salon"));
  assert.ok(map.siren.extra.find((x) => /^select\..*nivel/.test(x.entity)));
  assert.ok(map.siren.extra.find((x) => /^select\..*tono/.test(x.entity)));
  // posiciones: guardar dentro y fuera del plano
  const fk = (await call("GET", "/api/plan/overlays")).body.floors[0].key;
  assert.strictEqual((await call("PUT", "/api/security/positions", { entity_id: "binary_sensor.pir_salon", floor: fk, x: 1.3, y: 0.2, outside: true })).status, 200);
  assert.strictEqual((await call("PUT", "/api/security/positions", { entity_id: "binary_sensor.pir_salon", floor: "nada", x: 0.3, y: 0.2 })).status, 400);
  const p = (await call("GET", "/api/security/map")).body.presence.find((x) => x.entity === "binary_sensor.pir_salon");
  assert.deepStrictEqual([p.position, p.outside], [[1.3, 0.2], true]);
  // armar en Noche (sin código porque code_arm_required = false)
  assert.strictEqual((await call("POST", "/api/security/alarm", { entity_id: "alarm_control_panel.hadomotics", service: "alarm_arm_night" })).status, 200);
  let st = (await call("GET", "/api/security/state")).body.states;
  const s = (id) => st.find((x) => x.entity_id === id).state;
  assert.strictEqual(s("alarm_control_panel.hadomotics"), "armed_night");
  assert.strictEqual(s("input_boolean.hd_zona_entrada"), "on");
  assert.strictEqual(s("input_boolean.hd_zona_arriba"), "off");
  // detección en zona apagada: nada; en zona encendida: disparo + sirena real (orden Tuya)
  server.setStatus("demo_pir_pasillo", "pir", "pir");
  await t.hub.poll();
  assert.strictEqual(t.hub.alarm.s.state, "armed_night");
  server.setStatus("demo_pir_entrada", "pir", "pir");
  await t.hub.poll();
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(t.hub.alarm.s.state, "triggered");
  assert.ok(server.commands.some((c) => c.id === "demo_sirena" && c.commands[0].value === true), "sirena encendida por Tuya");
  assert.ok(notes.some((n) => n.critical && /Entrada - PIR entrada/.test(n.body)));
  // desarmar exige código
  assert.strictEqual((await call("POST", "/api/security/alarm", { entity_id: "alarm_control_panel.hadomotics", service: "alarm_disarm" })).status, 400);
  assert.strictEqual((await call("POST", "/api/security/alarm", { entity_id: "alarm_control_panel.hadomotics", service: "alarm_disarm", code: "0000" })).body.error, "código incorrecto");
  assert.strictEqual((await call("POST", "/api/security/alarm", { entity_id: "alarm_control_panel.hadomotics", service: "alarm_disarm", code: "2468" })).status, 200);
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(server.commands.some((c) => c.id === "demo_sirena" && c.commands[0].value === false), "sirena apagada al desarmar");
  // zonas y sirena por /api/security/control (lista blanca)
  assert.strictEqual((await call("POST", "/api/security/control", { entity_id: "input_boolean.hd_zona_arriba", service: "turn_on" })).status, 200);
  assert.strictEqual((await call("POST", "/api/security/control", { entity_id: "switch.depuradora", service: "turn_on" })).status, 400);
  assert.strictEqual((await call("POST", "/api/security/control", { entity_id: "siren.sirena", service: "turn_on" })).status, 400);
  assert.strictEqual((await call("POST", "/api/security/control", { entity_id: "siren.sirena", service: "turn_on", confirm: true })).status, 200);
  assert.strictEqual((await call("POST", "/api/security/control", { entity_id: "select.sirena_nivel", service: "select_option", option: "low" })).status, 200);
  assert.strictEqual((await call("POST", "/api/security/control", { entity_id: "select.sirena_nivel", service: "select_option", option: "x" })).status, 400);
  // el servicio nativo recibe la configuración sin secretos
  const last = t.native.configured.at(-1);
  assert.ok(last.sensors.find((x) => x.device_id === "demo_pir_entrada" && x.zone === "entrada"));
  assert.ok(!JSON.stringify(t.native.configured).includes("2468"));
  assert.ok(!JSON.stringify(t.native.configured).includes("demo-secret"));
});

test("Energía: mapa generado, flujo con sensor virtual «Casa» y cable del cargador", async () => {
  const { call } = await setup("demo");
  await call("PUT", "/api/standalone/settings", {
    energy: { grid_power: "sensor.contador_general_phase_a_potencia", controls: ["switch.depuradora"] },
    evse: { enabled: true, floor_id: "planta_baja", power_entity: "sensor.cargador_coche_potencia_de_carga", state_entity: "sensor.cargador_coche_estado" },
  });
  const map = (await call("GET", "/api/energy/map")).body;
  assert.strictEqual(map.flow.entities.inverter_power, "sensor.hd_consumo_casa");
  const flow = (await call("GET", "/api/energy/flow")).body;
  assert.strictEqual(flow.grid_w, 2250);
  assert.strictEqual(flow.house_w, 2250);
  assert.strictEqual(flow.directions.grid, "import");
  const ctl = await call("POST", "/api/energy/control", { entity_id: "switch.depuradora", service: "switch.turn_on", dry_run: true });
  assert.strictEqual(ctl.body.dry_run, true);
  const ov = (await call("GET", "/api/plan/overlays")).body;
  assert.strictEqual(ov.floors[0].evse_cable.power_entity, "sensor.cargador_coche_potencia_de_carga");
  assert.strictEqual(ov.floors[0].tesla.src, "static/plans/tesla_model_y.webp");
});

test("cuota: el intervalo de sondeo se adapta a lo que queda del mes", () => {
  const start = Date.UTC(2026, 10, 1);
  const s1 = pollInterval({ now: start, budget: 24000, used: 0, devices: 15, minSeconds: 60 });
  assert.ok(s1 >= 125 && s1 <= 140, String(s1)); // ~19200 llamadas / 30 días
  assert.strictEqual(pollInterval({ now: start, budget: 24000, used: 19500, devices: 15, minSeconds: 60 }), Infinity);
  const s2 = pollInterval({ now: start, budget: 1e9, used: 0, devices: 15, minSeconds: 60 });
  assert.strictEqual(s2, 60);
});

test("eventos del servicio nativo (disparo en segundo plano) se reflejan al volver", async () => {
  const t = await setup("demo");
  await t.hub.applyNativeEvents([{ type: "status", device_id: "demo_luz_cocina", status: [{ code: "switch_led", value: true }] }, { type: "triggered", siren: true, last_trigger: { zone: "z", zone_name: "Z", label: "PIR" } }]);
  assert.strictEqual(t.hub.getState("light.luz_cocina").state, "on");
  assert.strictEqual(t.hub.getState("alarm_control_panel.hadomotics").state, "triggered");
});

test("modo demo con planos: siembra dos plantas, escenas fuera del plano, zonas y cargador", async () => {
  let now = 1_800_000_000_000;
  const { MemoryStore, SecureStore } = require("../src/core/store.js");
  const store = new MemoryStore();
  const server = new MockTuyaServer({ now: () => now });
  class FixedMock { constructor() { return server; } }
  const hub = new Hub({ store, secure: new SecureStore(null), now: () => now, MockServer: FixedMock });
  await hub.init();
  const png = new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" });
  const api = createApi({ hub, store, now: () => now, demoAssets: async () => ({ pb: png, p1: png }) });
  const r = await api.handle({ method: "POST", path: "/api/standalone/demo", body: { enabled: true } });
  assert.strictEqual(r.body.seeded, true);
  const floors = (await api.handle({ method: "GET", path: "/api/floors" })).body;
  assert.deepStrictEqual(floors.map((f) => f.name), ["Planta baja", "Planta 1"]);
  const pb = (await api.handle({ method: "GET", path: "/api/floors/planta_baja" })).body;
  assert.ok(pb.elements.filter((e) => e.outside).length === 2);
  pb.elements.forEach((e) => assert.ok(hub.getState(e.entity_id), "existe " + e.entity_id));
  assert.strictEqual(hub.settings.alarm.zones.length, 3);
  const again = await api.handle({ method: "POST", path: "/api/standalone/demo", body: { enabled: true } });
  assert.strictEqual(again.body.seeded, false, "no pisa planos existentes");
});
