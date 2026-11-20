"use strict";

// Módulos configurables: modules.js (normalizar y ocultar) y que Energía y
// Seguridad no arranquen nada (ni fetch ni temporizadores) si están desactivados.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const STATIC = path.join(__dirname, "..", "hadomotics", "static");
const read = (rel) => fs.readFileSync(path.join(STATIC, rel), "utf8");

function fakeDom() {
  const els = {};
  const classes = new Set();
  const el = (id) => (els[id] = els[id] || { id, hidden: false, disabled: false });
  ["appDispositivos", "appEnergia", "appSeguridad", "navDispositivos", "navEnergia", "navSeguridad"].forEach(el);
  return {
    els,
    classes,
    document: {
      body: { classList: { toggle(c, on) { if (on) classes.add(c); else classes.delete(c); }, add(c) { classes.add(c); } } },
      getElementById: (id) => els[id] || null,
      addEventListener() {},
      querySelector() { return null; },
      querySelectorAll() { return []; },
    },
  };
}

function sandbox(modules, extra) {
  const calls = { fetch: [], intervals: 0, timeouts: 0, domReady: [] };
  const dom = fakeDom();
  dom.document.addEventListener = (ev, fn) => { if (ev === "DOMContentLoaded") calls.domReady.push(fn); };
  const sb = Object.assign({
    console, Intl, Date, URL, Promise,
    setTimeout() { calls.timeouts++; return 1; },
    clearTimeout() {},
    setInterval() { calls.intervals++; return 1; },
    clearInterval() {},
    requestAnimationFrame() { return 1; },
    localStorage: { getItem() { return null; }, setItem() {} },
    location: { pathname: "/api/hassio_ingress/abc/", hash: "" },
    document: dom.document,
    fetch: async (url) => {
      calls.fetch.push(String(url));
      if (String(url).endsWith("/api/modules")) {
        return modules === "404" ? { ok: false, status: 404, json: async () => ({}) } : { ok: true, json: async () => ({ modules }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    },
  }, extra || {});
  sb.window = sb;
  vm.createContext(sb);
  vm.runInContext(read("js/modules.js"), sb);
  return { sb, calls, dom };
}

test("normalize: missing = on, strings understood, all off = all on", () => {
  const { sb } = sandbox({});
  const M = sb.HDModules;
  assert.deepEqual({ ...M.normalize(undefined) }, { dispositivos: true, energia: true, seguridad: true });
  assert.deepEqual({ ...M.normalize({ energia: false }) }, { dispositivos: true, energia: false, seguridad: true });
  assert.deepEqual({ ...M.normalize({ dispositivos: "false", energia: "off", seguridad: "1" }) }, { dispositivos: false, energia: false, seguridad: true });
  assert.deepEqual({ ...M.normalize({ dispositivos: false, energia: false, seguridad: false }) }, { dispositivos: true, energia: true, seguridad: true });
});

test("firstEnabled prefers the requested view, then Dispositivos > Seguridad > Energía", () => {
  const { sb } = sandbox({});
  const M = sb.HDModules;
  assert.equal(M.firstEnabled({ dispositivos: true, energia: true, seguridad: true }, "energia"), "energia");
  assert.equal(M.firstEnabled({ dispositivos: false, energia: true, seguridad: true }, "dispositivos"), "seguridad");
  assert.equal(M.firstEnabled({ dispositivos: false, energia: true, seguridad: false }), "energia");
});

test("loads /api/modules under the ingress root and hides disabled panes and buttons", async () => {
  const { sb, calls, dom } = sandbox({ dispositivos: false, energia: false, seguridad: true });
  const mods = await sb.HDModules.ready;
  assert.deepEqual(calls.fetch, ["/api/hassio_ingress/abc/api/modules"]);
  assert.deepEqual({ ...mods }, { dispositivos: false, energia: false, seguridad: true });
  assert.equal(dom.els.navDispositivos.hidden, true);
  assert.equal(dom.els.navEnergia.hidden, true);
  assert.equal(dom.els.navSeguridad.hidden, false);
  assert.equal(dom.els.appDispositivos.hidden, true);
  assert.equal(dom.els.appEnergia.hidden, true);
  assert.ok(dom.classes.has("hd-single-module"));
  assert.ok(dom.classes.has("hd-mod-off-energia"));
  assert.ok(dom.classes.has("hd-modules-ready"));
  assert.equal(sb.HDModules.isEnabled("seguridad"), true);
  assert.equal(sb.HDModules.isEnabled("energia"), false);
});

test("two modules: tab bar stays, only the disabled one is hidden", async () => {
  const { sb, dom } = sandbox({ dispositivos: true, energia: false, seguridad: true });
  await sb.HDModules.ready;
  assert.equal(dom.classes.has("hd-single-module"), false);
  assert.equal(dom.els.navEnergia.hidden, true);
  assert.equal(dom.els.navDispositivos.hidden, false);
});

test("an older backend without /api/modules shows everything", async () => {
  const { sb, dom } = sandbox("404");
  const mods = await sb.HDModules.ready;
  assert.deepEqual({ ...mods }, { dispositivos: true, energia: true, seguridad: true });
  assert.equal(dom.els.navEnergia.hidden, false);
  assert.equal(dom.classes.has("hd-single-module"), false);
});

test("Energía disabled: init fetches nothing and starts no timers", async () => {
  const { sb, calls } = sandbox({ dispositivos: true, energia: false, seguridad: true });
  vm.runInContext(read("energia/js/transport.js"), sb);
  vm.runInContext(read("energia/js/energy.js"), sb);
  await sb.HDModules.ready;
  const before = calls.intervals;
  for (const fn of calls.domReady) await fn();
  assert.deepEqual(calls.fetch.filter((u) => u.includes("/api/energy")), []);
  assert.equal(calls.intervals, before);
});

test("Energía enabled: init does ask for its map", async () => {
  const { sb, calls } = sandbox({ dispositivos: false, energia: true, seguridad: false });
  vm.runInContext(read("energia/js/transport.js"), sb);
  vm.runInContext(read("energia/js/energy.js"), sb);
  for (const fn of calls.domReady) await fn();
  assert.ok(calls.fetch.some((u) => u.endsWith("/api/energy/map")));
});

test("Seguridad disabled: ensureStarted never loads the alarm nor polls", async () => {
  const { sb, calls } = sandbox({ dispositivos: true, energia: true, seguridad: false });
  vm.runInContext(read("js/plan_overlays.js"), sb);
  vm.runInContext(read("seguridad/js/security.js"), sb);
  await sb.HDModules.ready;
  const before = calls.intervals;
  sb.HADomoticsSecurity.ensureStarted();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls.fetch.filter((u) => u.includes("/api/security")), []);
  assert.equal(calls.intervals, before);
  assert.equal(sb.HADomoticsSecurity.started, false);
});

test("CSS hides disabled buttons and the tab bar with a single module", () => {
  const css = read("css/style.css");
  assert.match(css, /\.app-nav button\[hidden\]\s*\{\s*display:\s*none !important;/);
  assert.match(css, /body\.hd-single-module \.app-nav\s*\{\s*display:\s*none;/);
});
