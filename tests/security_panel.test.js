"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const STATIC = path.join(__dirname, "..", "hadomotics", "static");
const OVERLAYS = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "hadomotics", "plan_overlays.json"), "utf8"));

function load() {
  const sandbox = {
    console,
    Intl,
    Date,
    setTimeout() { return 1; },
    clearTimeout() {},
    setInterval() { return 1; },
    clearInterval() {},
    requestAnimationFrame() { return 1; },
    fetch: async () => ({ ok: false, json: async () => ({}) }),
    location: { pathname: "/" },
    document: {
      addEventListener() {},
      getElementById() { return null; },
      querySelector() { return null; },
      createElementNS() { return { setAttribute() {}, appendChild() {}, style: {}, dataset: {} }; },
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(STATIC, "js", "plan_overlays.js"), "utf8"), sandbox);
  vm.runInContext(fs.readFileSync(path.join(STATIC, "seguridad", "js", "security.js"), "utf8"), sandbox);
  return { plan: sandbox.HADomoticsPlan, sec: sandbox.HADomoticsSecurity };
}

const PB = OVERLAYS.floors.find((f) => f.key === "planta_baja");
const CABLE = PB.evse_cable;

test("floors are matched by name, then by order", () => {
  const { plan } = load();
  const floors = [
    { id: "a", name: "PlantaBaja", order: 1 },
    { id: "b", name: "Planta1", order: 2 },
  ];
  assert.equal(plan.configFor(floors[0], floors, OVERLAYS).key, "planta_baja");
  assert.equal(plan.configFor(floors[1], floors, OVERLAYS).key, "planta_1");
  assert.equal(plan.configFor({ id: "x", name: "Planta Baja" }, [], OVERLAYS).key, "planta_baja");
  const renamed = [{ id: "a", name: "Abajo", order: 1 }, { id: "b", name: "Arriba", order: 2 }];
  assert.equal(plan.configFor(renamed[0], renamed, OVERLAYS).key, "planta_baja");
  assert.equal(plan.configFor(renamed[1], renamed, OVERLAYS).key, "planta_1");
  assert.equal(plan.configFor({ id: "z", name: "Sótano" }, [{ id: "z", name: "Sótano" }, { id: "y", name: "PlantaBaja" }, { id: "w", name: "Planta1" }].map((f, i) => ({ ...f, order: i })), OVERLAYS), null);
});

test("EVSE charging uses real power (W/kW) or the Charging state, not the limit", () => {
  const { plan } = load();
  const st = (power, unit, op) => ({
    "sensor.evse_charging_power": { state: String(power), attributes: { unit_of_measurement: unit } },
    "sensor.evse_charging_operational_state": { state: op, attributes: {} },
    "number.evse_charging_power_limit": { state: "7400", attributes: { unit_of_measurement: "W" } },
  });
  assert.equal(plan.evseCharging(st(0, "W", "Available"), CABLE).charging, false);
  assert.equal(plan.evseCharging(st(80, "W", "SuspendedEV"), CABLE).charging, false);
  assert.equal(plan.evseCharging(st(100, "W", "Preparing"), CABLE).charging, false);
  assert.equal(plan.evseCharging(st(101, "W", "Preparing"), CABLE).charging, true);
  assert.equal(plan.evseCharging(st(7.2, "kW", "Available"), CABLE).charging, true);
  assert.equal(plan.evseCharging(st(7.2, "kW", "Available"), CABLE).watts, 7200);
  assert.equal(plan.evseCharging(st(0.05, "kW", "SuspendedEVSE"), CABLE).charging, false);
  assert.equal(plan.evseCharging(st("unavailable", "W", "Charging"), CABLE).charging, true);
  assert.equal(plan.evseCharging({}, CABLE).charging, false);
});

test("alarm modes follow the dashboard and Alarmo supported_features", () => {
  const { sec } = load();
  const alarmo = { state: "disarmed", attributes: { supported_features: 14, code_format: null, code_arm_required: false } };
  assert.deepEqual([...sec.availableModes(alarmo, ["disarmed", "armed_night", "armed_away"])], ["disarmed", "armed_night", "armed_away"]);
  assert.deepEqual([...sec.availableModes(alarmo, ["disarmed", "armed_home", "armed_away"])], ["disarmed", "armed_away"]);
  assert.deepEqual([...sec.availableModes({ attributes: { supported_features: 1 } }, null)], ["disarmed", "armed_home"]);
});

test("alarm code is asked only when Alarmo requires it", () => {
  const { sec } = load();
  const none = { attributes: { code_format: null } };
  const num = { attributes: { code_format: "number", code_arm_required: false } };
  const numArm = { attributes: { code_format: "number", code_arm_required: true } };
  assert.equal(sec.needsCode("alarm_disarm", none), false);
  assert.equal(sec.needsCode("alarm_arm_away", none), false);
  assert.equal(sec.needsCode("alarm_disarm", num), true);
  assert.equal(sec.needsCode("alarm_arm_away", num), false);
  assert.equal(sec.needsCode("alarm_arm_away", numArm), true);
});

test("presence text shows the last change in Madrid time", () => {
  const { sec } = load();
  const t = sec.presenceText({ name: "Cocina" }, { state: "on", last_changed: new Date().toISOString() });
  assert.match(t, /^Cocina: PERSONA · \d{2}:\d{2}$/);
  assert.equal(sec.presenceText({ name: "Baño" }, { state: "unavailable" }), "Baño: no disponible");
});

test("white-border crop only applies to the reference image size", () => {
  const { plan } = load();
  const floors = [{ id: "a", name: "PlantaBaja", order: 1 }, { id: "b", name: "Planta1", order: 2 }];
  const crop = plan.cropFor(floors[0], floors, 1425, 736, OVERLAYS);
  assert.ok(crop && crop.x > 0 && crop.y > 0 && crop.x + crop.w < 1425 && crop.y + crop.h < 736);
  // Otra imagen subida por el usuario: sin recorte, coordenadas intactas.
  assert.equal(plan.cropFor(floors[0], floors, 1600, 900, OVERLAYS), null);
  const p1 = plan.cropFor(floors[1], floors, 1315, 652, OVERLAYS);
  assert.ok(p1);
  assert.match(plan.clipInset(p1), /^inset\(\d+\.\d\dpx \d+\.\d\dpx \d+\.\d\dpx \d+\.\d\dpx\)$/);
});

test("elements outside the crop are shown at the nearest point inside", () => {
  const { plan } = load();
  const floors = [{ id: "a", name: "PlantaBaja", order: 1 }];
  const crop = plan.cropFor(floors[0], floors, 1425, 736, OVERLAYS);
  // Dentro: no se mueve.
  const clima = { x: 559, y: 356, width: 33, height: 31, rotation: 0 };
  assert.deepEqual({ ...plan.placeInCrop(clima, crop) }, { x: 559, y: 356, moved: false });
  // Recolocación explícita (Depuradora, en la esquina blanca).
  const dep = plan.placeInCrop({ entity_id: "switch.depuradora", x: 0, y: 5, width: 74, height: 60 }, crop);
  assert.equal(dep.moved, true);
  assert.ok(dep.x >= crop.x && dep.y >= crop.y);
  // Genérico, con giro de 90°: la caja visible queda dentro del recorte.
  const door = { entity_id: "cover.x", x: 1182, y: 354, width: 400, height: 30, rotation: 90 };
  const p = plan.placeInCrop(door, crop);
  const cx = p.x + door.width / 2;
  assert.ok(cx + door.height / 2 <= crop.x + crop.w + 0.01);
  // Sin recorte (modo edición): coordenadas guardadas.
  assert.deepEqual({ ...plan.placeInCrop(door, null) }, { x: 1182, y: 354, moved: false });
  assert.deepEqual([...plan.clampPoint(5, 400, crop, 0)], [crop.x, 400]);
});

test("Seguridad layout: alarm card + Zonas popover, same floor dock, nav order", () => {
  const html = fs.readFileSync(path.join(STATIC, "index.html"), "utf8");
  const secSrc = fs.readFileSync(path.join(STATIC, "seguridad", "js", "security.js"), "utf8");
  const pane = html.slice(html.indexOf('id="appSeguridad"'), html.indexOf('id="appNav"'));
  assert.match(pane, /id="secAlarmCard"/);
  assert.match(pane, /id="secZonesBtn"[^>]*aria-haspopup="dialog"/);
  assert.match(pane, /id="secZonesPop"[^>]*role="dialog"/);
  assert.match(pane, /class="sec-dock"[\s\S]*id="secFloorSwitcher"/);
  for (const gone of ["secOpen", "secSiren", "secPresence", "sec-side"]) assert.doesNotMatch(pane, new RegExp(gone));
  // Coche y cable solo en Dispositivos.
  assert.doesNotMatch(secSrc, /HADomoticsPlan\.render\(/);
  assert.match(secSrc, /e\.key === "Escape"/);
  const navStart = html.indexOf('id="appNav"');
  const nav = html.slice(navStart, html.indexOf("</nav>", navStart));
  const order = [...nav.matchAll(/data-app="(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(order, ["seguridad", "dispositivos", "energia"]);
});

test("sources: no stored alarm code, cable is non-interactive and respects reduced motion", () => {
  const secSrc = fs.readFileSync(path.join(STATIC, "seguridad", "js", "security.js"), "utf8");
  const css = fs.readFileSync(path.join(STATIC, "css", "style.css"), "utf8");
  const app = fs.readFileSync(path.join(STATIC, "js", "app.js"), "utf8");
  assert.doesNotMatch(secSrc, /localStorage|sessionStorage|document\.cookie/);
  assert.match(secSrc, /code\.value = ""/);
  assert.match(css, /svg\.plan-overlay \{[^}]*pointer-events: none/);
  assert.match(css, /@keyframes evse-flow \{\s*from \{ stroke-dashoffset: 24; \}\s*to \{ stroke-dashoffset: 0; \}/);
  assert.match(css, /prefers-reduced-motion: reduce\) \{\s*\.evse-cable\.charging \.evse-cable-flow \{ animation: none/);
  // Botones/escenas muestran su nombre en el plano
  assert.match(app, /type === "button" \|\| type === "custom"/);
  assert.match(app, /seguridad: \{ pane: "appSeguridad"/);
});
