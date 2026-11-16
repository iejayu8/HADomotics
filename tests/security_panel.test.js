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

test("presence: three states, full text only for aria/title and the dropdown", () => {
  const { sec } = load();
  const now = new Date().toISOString();
  assert.equal(sec.presenceState({ state: "on" }), "on");
  assert.equal(sec.presenceState({ state: "off" }), "off");
  assert.equal(sec.presenceState({ state: "unavailable" }), "na");
  assert.equal(sec.presenceState({ state: "unknown" }), "na");
  assert.equal(sec.presenceState(undefined), "na");
  assert.match(sec.presenceText({ name: "Cocina / comedor" }, { state: "on", last_changed: now }), /^Cocina \/ comedor: Detección · \d{2}:\d{2}$/);
  assert.match(sec.presenceText({ name: "Estar" }, { state: "off", last_changed: now }), /^Estar: Sin detección · \d{2}:\d{2}$/);
  assert.equal(sec.presenceText({ name: "Baño" }, { state: "unavailable" }), "Baño: No disponible");
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
  assert.match(secSrc, /e\.key !== "Escape"/);
  const navStart = html.indexOf('id="appNav"');
  const nav = html.slice(navStart, html.indexOf("</nav>", navStart));
  const order = [...nav.matchAll(/data-app="(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(order, ["seguridad", "dispositivos", "energia"]);
});

test("Detecciones: discreet button next to Zonas, one popover at a time, three colours", () => {
  const html = fs.readFileSync(path.join(STATIC, "index.html"), "utf8");
  const secSrc = fs.readFileSync(path.join(STATIC, "seguridad", "js", "security.js"), "utf8");
  const css = fs.readFileSync(path.join(STATIC, "seguridad", "css", "security.css"), "utf8");
  const tools = html.slice(html.indexOf('class="sec-tools"'), html.indexOf('id="secCanvasWrapper"'));
  assert.ok(tools.indexOf('id="secZonesBtn"') > 0);
  assert.ok(tools.indexOf('id="secZonesBtn"') < tools.indexOf('id="secDetBtn"'));
  assert.match(tools, /class="sec-det-btn sec-tool-btn" id="secDetBtn"[^>]*aria-haspopup="dialog"/);
  assert.match(html, /id="secDetPop"[^>]*role="dialog"/);
  assert.match(html, /id="secDetClose"[^>]*aria-label="Cerrar"/);
  // En el plano solo el nombre; el estado completo en aria-label/title.
  assert.match(secSrc, /<span class="tag" aria-hidden="true">\$\{esc\(p\.name\)\}<\/span>/);
  assert.match(secSrc, /d\.setAttribute\("aria-label", full\)/);
  assert.doesNotMatch(secSrc, /PERSONA/);
  // Abrir uno cierra el otro; botón otra vez, X, Esc y clic fuera cierran.
  assert.match(secSrc, /if \(open\) Object\.keys\(POPS\)\.forEach\(\(other\) => \{ if \(other !== name\) setPopOpen\(other, false\); \}\)/);
  assert.match(secSrc, /setPopOpen\(name, !isOpen\(name\)\)/);
  assert.match(secSrc, /card && card\.contains\(e\.target\)/);
  for (const v of ["--pres-on: #ef4444", "--pres-off: #22c55e", "--pres-na: #64748b"]) assert.ok(css.includes(v), v);
  assert.match(css, /\.presence\.on \.dot \{[^}]*var\(--pres-on\)/);
  assert.match(css, /\.presence\.off \.dot \{[^}]*var\(--pres-off\)/);
  assert.match(css, /\.presence\.unavailable \.dot \{[^}]*var\(--pres-na\)/);
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

// ---------------------------------------------------------------------------
// 3.5.1 — editar en Seguridad y elementos fuera del plano
// ---------------------------------------------------------------------------

test("explicitly placed elements (outside true/false) skip the legacy clamp and relocation", () => {
  const { plan } = load();
  const floors = [{ id: "a", name: "PlantaBaja", order: 1 }];
  const crop = plan.cropFor(floors[0], floors, 1425, 736, OVERLAYS);
  const dia = { entity_id: "scene.dia", x: 40, y: 760, width: 60, height: 40, outside: true };
  assert.deepEqual({ ...plan.placeInCrop(dia, crop) }, { x: 40, y: 760, moved: false });
  const inside = { entity_id: "scene.dia", x: 300, y: 300, width: 60, height: 40, outside: false };
  assert.deepEqual({ ...plan.placeInCrop(inside, crop) }, { x: 300, y: 300, moved: false });
  // Sin el campo: elemento antiguo, se sigue recolocando como en 3.5.0.
  assert.equal(plan.placeInCrop({ entity_id: "scene.dia", x: 40, y: 760, width: 60, height: 40 }, crop).moved, true);
});

test("outside detection uses the centre of the rotated visual box", () => {
  const { plan } = load();
  const drawing = { x: 100, y: 100, w: 800, h: 400 };
  const box = plan.visualBox({ width: 200, height: 20, rotation: 90 }, 0, 0);
  assert.ok(Math.abs(box.w - 20) < 1e-9 && Math.abs(box.h - 200) < 1e-9);
  assert.equal(plan.isOutside({ x: 120, y: 120, w: 20, h: 20 }, drawing), false);
  assert.equal(plan.isOutside({ x: 60, y: 300, w: 30, h: 30 }, drawing), true);
  assert.equal(plan.isOutside({ x: 85, y: 300, w: 40, h: 20 }, drawing), false); // centro dentro
  assert.equal(plan.isOutside({ x: 300, y: 520, w: 40, h: 40 }, drawing), true);
});

test("clampBox keeps a box inside the visible rect with the smallest move", () => {
  const { plan } = load();
  const r = { x: 0, y: 0, w: 100, h: 50 };
  assert.deepEqual({ ...plan.clampBox({ x: -20, y: 10, w: 10, h: 10 }, r) }, { x: 0, y: 10, w: 10, h: 10 });
  assert.deepEqual({ ...plan.clampBox({ x: 95, y: 45, w: 10, h: 10 }, r) }, { x: 90, y: 40, w: 10, h: 10 });
  assert.deepEqual({ ...plan.clampBox({ x: 30, y: 20, w: 10, h: 10 }, r) }, { x: 30, y: 20, w: 10, h: 10 });
});

test("computeFit makes room for outside elements without shrinking the drawing below 85%", () => {
  const { plan } = load();
  const drawing = { x: 0, y: 0, w: 1000, h: 500 };
  // Sin extras: ajuste normal, centrado.
  let f = plan.computeFit({ aw: 1000, ah: 1000, drawing });
  assert.equal(f.scale, 1);
  assert.equal(f.oy, 250);
  // Extra debajo con sitio vertical: misma escala, el conjunto se centra.
  f = plan.computeFit({ aw: 1000, ah: 1000, drawing, extras: [{ x: 50, y: 600, w: 80, h: 60 }] });
  assert.equal(f.scale, 1);
  assert.ok(f.oy + 660 * f.scale <= 1000 && f.oy >= 0);
  // Extra a la izquierda sin sitio: se reduce, pero nunca por debajo del 85%.
  f = plan.computeFit({ aw: 1000, ah: 1000, drawing, extras: [{ x: -600, y: 100, w: 50, h: 50 }] });
  assert.ok(Math.abs(f.scale - 0.85) < 1e-9);
  // En edición (minRatio 0) cabe todo.
  f = plan.computeFit({ aw: 1000, ah: 1000, drawing, extras: [{ x: -600, y: 100, w: 50, h: 50 }], minRatio: 0 });
  assert.ok(f.ox + -600 * f.scale >= -0.5 && f.ox + 1000 * f.scale <= 1000.5);
});

test("Seguridad drop: fractions of the image plus the outside flag", () => {
  const { sec } = load();
  const drawing = { x: 68, y: 20, w: 1290, h: 690 };
  const out = sec.dropRecord(20.7, 139, 1425, 736, drawing);
  assert.equal(out.outside, true);
  assert.equal(out.x, Math.round((20.7 / 1425) * 1e5) / 1e5);
  assert.equal(sec.dropRecord(464, 395, 1425, 736, drawing).outside, false);
  assert.equal(sec.dropRecord(-100, 395, 1425, 736, drawing).x < 0, true);
});

test("sources: Seguridad pencil next to the floor chips, admin-only save, free drag", () => {
  const html = fs.readFileSync(path.join(STATIC, "index.html"), "utf8");
  const dock = html.slice(html.indexOf('id="secDock"'), html.indexOf("</div>", html.indexOf('id="secEditBtn"')));
  assert.ok(dock.indexOf('id="secFloorSwitcher"') < dock.indexOf('id="secEditBtn"'));
  assert.match(html, /id="secEditBtn"[^>]*aria-pressed="false"/);
  const css = fs.readFileSync(path.join(STATIC, "seguridad", "css", "security.css"), "utf8");
  assert.match(css, /\.sec-edit-btn\s*\{[^}]*order:\s*2/);
  const js = fs.readFileSync(path.join(STATIC, "seguridad", "js", "security.js"), "utf8");
  assert.match(js, /\/api\/security\/positions/);
  assert.match(js, /method:\s*"PUT"/);
  const app = fs.readFileSync(path.join(STATIC, "js", "app.js"), "utf8");
  const dragCode = app.slice(app.indexOf("function finishElementDrop"), app.indexOf("function finishElementDrop") + 4000);
  assert.ok(!/Math\.max\(0,/.test(dragCode), "drag must allow positions outside the image");
  assert.match(app, /outside:\s*/);
});
