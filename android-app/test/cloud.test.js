"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { TuyaCloud, TuyaError } = require("../src/tuya/cloud.js");
const { MockTuyaServer } = require("../src/tuya/mock-server.js");
const demo = require("../src/tuya/demo-home.js");

function setup(opts) {
  let now = 1_800_000_000_000;
  const server = new MockTuyaServer(Object.assign({ now: () => now }, opts || {}));
  const calls = [];
  const cloud = new TuyaCloud({
    accessId: demo.DEMO_ACCESS_ID, secret: demo.DEMO_SECRET, region: "eu",
    http: server.handler(), now: () => now, onCall: (p) => calls.push(p),
  });
  return { server, cloud, calls, advance: (ms) => { now += ms; } };
}

test("token + listado paginado de dispositivos (subdispositivos Zigbee incluidos)", async () => {
  const { cloud, server } = setup({ pageSize: 5 });
  const list = await cloud.listDevices();
  assert.strictEqual(list.length, demo.devices().length);
  assert.ok(list.some((d) => d.sub && d.gateway_id === "demo_gw_zigbee"));
  assert.ok(server.calls.filter((c) => c.path.endsWith("/devices")).length >= 4, "paginó con last_row_key");
});

test("firma incorrecta -> error 1004 (el servidor simulado verifica como el real)", async () => {
  let now = 1_800_000_000_000;
  const server = new MockTuyaServer({ now: () => now });
  const cloud = new TuyaCloud({ accessId: demo.DEMO_ACCESS_ID, secret: "otro-secreto", http: server.handler(), now: () => now });
  await assert.rejects(() => cloud.listDevices(), (e) => e instanceof TuyaError && e.code === 1004 && !e.message.includes("otro-secreto"));
});

test("estado por lotes de 20", async () => {
  const many = Array.from({ length: 45 }, (_, i) => ({ id: "d" + i, name: "D" + i, category: "kg", online: true, status: [{ code: "switch_1", value: i % 2 === 0 }] }));
  const { cloud, server } = setup({ devices: many });
  const st = await cloud.getStatuses(many.map((d) => d.id));
  assert.strictEqual(Object.keys(st).length, 45);
  assert.strictEqual(st.d4.switch_1, true);
  assert.strictEqual(server.calls.filter((c) => c.path === "/v1.0/iot-03/devices/status").length, 3);
});

test("órdenes y escenas", async () => {
  const { cloud, server } = setup();
  await cloud.sendCommands("demo_depuradora", [{ code: "switch_1", value: true }]);
  assert.deepStrictEqual(server.commands[0], { id: "demo_depuradora", commands: [{ code: "switch_1", value: true }] });
  await assert.rejects(() => cloud.sendCommands("demo_depuradora", [{ code: "no_existe", value: 1 }]), /2008/);
  const scenes = await cloud.listScenes("demo_home");
  await cloud.triggerScene("demo_home", scenes[0].scene_id);
  assert.deepStrictEqual(server.commands.at(-1), { scene: "demo_scene_dia" });
});

test("token caducado: renueva con refresh_token y reintenta", async () => {
  const { cloud, server, advance } = setup({ expireTime: 120 });
  await cloud.getStatuses(["demo_luz_salon"]);
  const firstToken = cloud.token.access;
  advance(100 * 1000); // dentro del margen de 60 s -> renueva
  await cloud.getStatuses(["demo_luz_salon"]);
  assert.notStrictEqual(cloud.token.access, firstToken);
  assert.ok(server.calls.some((c) => /^\/v1\.0\/token\/ref/.test(c.path)), "usó /v1.0/token/{refresh_token}");
});

test("token invalidado en el servidor (1010): pide otro y reintenta una vez", async () => {
  const { cloud, server } = setup();
  await cloud.getStatuses(["demo_luz_salon"]);
  server.tokens.clear();
  const st = await cloud.getStatuses(["demo_luz_salon"]);
  assert.strictEqual(st.demo_luz_salon.switch_led, true);
});

test("cuenta las llamadas (para la cuota mensual)", async () => {
  const { cloud, calls } = setup();
  await cloud.listDevices();
  assert.ok(calls.length >= 2);
  assert.strictEqual(calls[0], "/v1.0/token");
});
