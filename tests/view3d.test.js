"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..", "hadomotics");
const SRC = fs.readFileSync(path.join(ROOT, "static", "js", "view3d.js"), "utf8");

function load(stored) {
  const store = new Map(stored ? [["hadomotics.view3d", JSON.stringify(stored)]] : []);
  const classes = new Set();
  const sandbox = {
    console, Math, JSON, Number, String, Object, Array, Uint8ClampedArray, Float32Array, setTimeout,
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) },
    document: {
      body: { classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)), contains: (c) => classes.has(c) } },
      getElementById: () => null,
      querySelector: () => null,
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  return { V: sandbox.HADomotics3D, store, classes };
}

const FIT = { ox: 10, oy: 20, scale: 0.5, drawing: { x: 100, y: 50, w: 1200, h: 600 }, aw: 1400, ah: 800 };

test("off by default: the 2D transform is exactly the classic one", () => {
  const { V } = load();
  assert.equal(V.active(), false);
  assert.equal(V.transformFor(FIT), "translate(10px, 20px) scale(0.5)");
});

test("3D rotates around the drawing centre with a uniform scale3d (pins stay upright)", () => {
  const { V } = load({ on: true, tilt: 50, spin: -20, zoom: 1 });
  assert.equal(V.active(), true);
  const t = V.transformFor(FIT);
  assert.match(t, /scale3d\(([\d.]+), \1, \1\)/);
  assert.match(t, /translate\(700px, 350px\) rotateX\(50deg\) rotateZ\(-20deg\) translate\(-700px, -350px\)$/);
});

test("editing always shows 2D, and coming back restores 3D", () => {
  const { V, classes } = load({ on: true });
  V.setEditing(true);
  assert.equal(V.active(), false);
  assert.equal(classes.has("neon-3d"), false);
  assert.equal(V.transformFor(FIT), "translate(10px, 20px) scale(0.5)");
  V.setEditing(false);
  assert.equal(V.active(), true);
  assert.equal(classes.has("neon-3d"), true);
});

test("preferences are sanitised and saved", () => {
  const { V, store } = load({ on: true, tilt: 500, spin: 400, zoom: 99 });
  assert.deepEqual(JSON.parse(JSON.stringify(V.prefs())), { on: true, tilt: 68, spin: 40, zoom: 1.6 });
  V.setOn(false);
  assert.equal(JSON.parse(store.get("hadomotics.view3d")).on, false);
  const bad = load();
  assert.equal(bad.V._internals.sanitize({ on: "yes", tilt: "x" }).on, false);
  assert.equal(bad.V._internals.sanitize({ tilt: "x" }).tilt, 52);
});

test("portrait screens turn a landscape plan 90° and the fit uses the turned footprint", () => {
  const { V } = load({ on: true, spin: 0, tilt: 50, zoom: 1 });
  const I = V._internals;
  const land = I.view3dGeometry(FIT);
  assert.equal(land.autoSpin, 0);
  const port = I.view3dGeometry({ ...FIT, aw: 390, ah: 700 });
  assert.equal(port.autoSpin, 90);
  assert.equal(port.spin, 90);
  // Girado, el lado largo (1200) va a lo alto: la escala la limita el ancho corto (600).
  assert.ok(port.scale > 390 / (1200 * 1.08));
  assert.ok(port.scale <= 390 / (600 * 1.08) + 1e-9);
});

test("edge map lights strong edges in cyan and leaves flat areas transparent", () => {
  const { V } = load();
  const w = 8, h = 6;
  const img = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = x < 4 ? 20 : 240; // pared vertical entre x=3 y x=4
    img.set([v, v, v, 255], (y * w + x) * 4);
  }
  const out = V._internals.edgeMap(img, w, h);
  const a = (x, y) => out[(y * w + x) * 4 + 3];
  assert.ok(a(3, 2) > 0 && a(4, 2) > 0);
  assert.equal(a(1, 2), 0);
  assert.equal(a(6, 2), 0);
  assert.deepEqual(Array.from(out.slice((2 * w + 3) * 4, (2 * w + 3) * 4 + 3)), [70, 230, 255]);
});

test("wired into the panel: served locally, loaded before app.js, hooked into fit and view mode", () => {
  const index = fs.readFileSync(path.join(ROOT, "static", "index.html"), "utf8");
  assert.ok(index.indexOf("static/js/view3d.js") > 0);
  assert.ok(index.indexOf("static/js/view3d.js") < index.indexOf("static/js/app.js"));
  const app = fs.readFileSync(path.join(ROOT, "static", "js", "app.js"), "utf8");
  assert.match(app, /HD3\.transformFor\(fit3d\)/);
  assert.match(app, /HADomotics3D\.setEditing\(!enabled\)/);
  assert.match(app, /HADomotics3D\.install\(/);
  // Sin librerías ni CDN: todo es CSS 3D y canvas.
  assert.doesNotMatch(SRC, /https?:\/\/(?!github\.com\/Mastershort)/);
  assert.doesNotMatch(SRC, /import |require\(/);
  const css = fs.readFileSync(path.join(ROOT, "static", "css", "style.css"), "utf8");
  assert.match(css, /body\.neon-3d \.element-overlay\.view-mode \.el-icon \{[^}]*pointer-events: auto/);
});
