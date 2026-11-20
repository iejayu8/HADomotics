"use strict";

// Dispositivos (modo edición): los elementos se arrastran con ratón, dedo o lápiz.
// Antes solo había «mousedown/mousemove/mouseup» y en tablets / WebView de Android
// el navegador no envía mousemove mientras el dedo arrastra: el elemento no se movía.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const STATIC = path.join(__dirname, "..", "hadomotics", "static");
const APP = fs.readFileSync(path.join(STATIC, "js", "app.js"), "utf8");
const CSS = fs.readFileSync(path.join(STATIC, "css", "style.css"), "utf8");

function stubEl() {
  const el = {
    style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {}, removeEventListener() {}, appendChild() {}, setAttribute() {}, removeAttribute() {},
    querySelector() { return null; }, querySelectorAll() { return []; }, closest() { return null; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 1000, height: 600, right: 1000, bottom: 600 }; },
    value: "", innerHTML: "", textContent: "", children: [],
  };
  return el;
}

/** Carga app.js en un entorno mínimo y devuelve los oyentes de documento. */
function load() {
  const listeners = {};
  const overlay = stubEl();
  const container = stubEl();
  container.querySelector = (sel) => (sel.includes("data-id") ? overlay : null);
  const puts = [];
  const sandbox = {
    console, Intl, Date, Math, JSON, Promise, URL,
    setTimeout() { return 1; }, clearTimeout() {}, setInterval() { return 1; }, clearInterval() {},
    requestAnimationFrame() { return 1; },
    fetch: async (url, opts) => { puts.push({ url, opts }); return { ok: true, status: 200, json: async () => ({}) }; },
    location: { pathname: "/", search: "", href: "http://x/" },
    localStorage: { getItem() { return null; }, setItem() {} },
    matchMedia() { return { matches: false, addEventListener() {} }; },
    innerWidth: 1280, innerHeight: 800,
    document: {
      readyState: "loading",
      body: stubEl(),
      documentElement: stubEl(),
      addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
      getElementById(id) { return id === "canvasContainer" ? container : stubEl(); },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      createElement() { return stubEl(); },
      createElementNS() { return stubEl(); },
    },
  };
  sandbox.window = sandbox;
  sandbox.addEventListener = () => {};
  vm.createContext(sandbox);
  vm.runInContext(APP, sandbox);
  return { sandbox, listeners, overlay, puts };
}

function fire(listeners, type, ev) {
  return Promise.all((listeners[type] || []).map((fn) => fn(Object.assign({ preventDefault() {} }, ev))));
}

test("Dispositivos: el elemento usa eventos de puntero (no solo ratón)", () => {
  const render = APP.slice(APP.indexOf('div.addEventListener("pointerdown"'), APP.indexOf("cc.appendChild(div);"));
  assert.ok(render.length > 0, "el elemento debe escuchar pointerdown");
  assert.match(render, /resizeHandle\.addEventListener\("pointerdown"/);
  assert.doesNotMatch(APP, /addEventListener\("mouse(down|move|up)"/);
  assert.match(APP, /document\.addEventListener\("pointermove"/);
  assert.match(APP, /document\.addEventListener\("pointerup", endElementGesture\)/);
  assert.match(APP, /document\.addEventListener\("pointercancel", endElementGesture\)/);
});

test("Dispositivos: en edición el dedo no desplaza la página ni abre el menú de pulsación larga", () => {
  const rule = CSS.slice(CSS.indexOf(".element-overlay:not(.view-mode),"), CSS.indexOf(".element-overlay.view-mode {"));
  assert.match(rule, /touch-action:\s*none/);
  assert.match(rule, /-webkit-touch-callout:\s*none/);
});

test("Dispositivos: arrastre táctil mueve el elemento, ignora otros dedos y guarda al soltar", async () => {
  const { sandbox, listeners, overlay, puts } = load();
  vm.runInContext(`
    floorScale = 0.5;
    currentFloor = { id: "pb", elements: [{ id: "e1", x: 100, y: 100, width: 40, height: 40 }] };
    dragState = { pointerId: 7, elemId: "e1", startX: 10, startY: 10, origX: 100, origY: 100, moved: false };
    finishElementDrop = (el) => ({ x: el.x, y: el.y, outside: false });
    openElementProps = (el) => { globalThis.__opened = el.id; };
  `, sandbox);
  let prevented = false;
  await fire(listeners, "pointermove", { pointerId: 7, pointerType: "touch", clientX: 40, clientY: 25, preventDefault() { prevented = true; } });
  const el = vm.runInContext("currentFloor.elements[0]", sandbox);
  assert.equal(el.x, 160); // 30 px de pantalla / escala 0.5
  assert.equal(el.y, 130);
  assert.equal(overlay.style.left, "160px");
  assert.ok(prevented, "el gesto no debe desplazar la página");
  // Un segundo dedo no mueve ni termina el arrastre.
  await fire(listeners, "pointermove", { pointerId: 9, pointerType: "touch", clientX: 500, clientY: 500 });
  await fire(listeners, "pointerup", { pointerId: 9, pointerType: "touch" });
  assert.equal(el.x, 160);
  assert.ok(vm.runInContext("dragState", sandbox), "sigue arrastrando");
  await fire(listeners, "pointerup", { pointerId: 7, pointerType: "touch" });
  assert.equal(vm.runInContext("dragState", sandbox), null);
  const put = puts.find((p) => String(p.url).includes("/api/floors/pb/elements/e1"));
  assert.ok(put, "guarda la posición");
  assert.deepEqual(JSON.parse(put.opts.body), { x: 160, y: 130, outside: false });
  assert.equal(vm.runInContext("globalThis.__opened", sandbox), "e1", "abre las propiedades al soltar");
});

test("Dispositivos: un toque sin mover no guarda nada pero abre las propiedades", async () => {
  const { sandbox, listeners, puts } = load();
  vm.runInContext(`
    floorScale = 1;
    currentFloor = { id: "pb", elements: [{ id: "e1", x: 100, y: 100 }] };
    dragState = { pointerId: 1, elemId: "e1", startX: 10, startY: 10, origX: 100, origY: 100, moved: false };
    openElementProps = (el) => { globalThis.__opened = el.id; };
  `, sandbox);
  await fire(listeners, "pointerup", { pointerId: 1, pointerType: "touch" });
  assert.equal(puts.filter((p) => String(p.url).includes("/elements/")).length, 0);
  assert.equal(vm.runInContext("globalThis.__opened", sandbox), "e1");
});

test("Dispositivos: si el sistema cancela el gesto, se guarda lo movido", async () => {
  const { sandbox, listeners, puts } = load();
  vm.runInContext(`
    floorScale = 1;
    currentFloor = { id: "pb", elements: [{ id: "e1", x: 100, y: 100 }] };
    dragState = { pointerId: 3, elemId: "e1", startX: 0, startY: 0, origX: 100, origY: 100, moved: false };
    finishElementDrop = (el) => ({ x: el.x, y: el.y, outside: true });
    openElementProps = () => {};
  `, sandbox);
  await fire(listeners, "pointermove", { pointerId: 3, pointerType: "touch", clientX: 0, clientY: 300 });
  await fire(listeners, "pointercancel", { pointerId: 3, pointerType: "touch" });
  const put = puts.find((p) => String(p.url).includes("/elements/e1"));
  assert.deepEqual(JSON.parse(put.opts.body), { x: 100, y: 400, outside: true });
});

test("Dispositivos: redimensionar con el dedo", async () => {
  const { sandbox, listeners, puts } = load();
  vm.runInContext(`
    floorScale = 2;
    currentFloor = { id: "pb", elements: [{ id: "e1", x: 0, y: 0, width: 40, height: 40 }] };
    resizeState = { pointerId: 4, elemId: "e1", startX: 0, startY: 0, origW: 40, origH: 40 };
  `, sandbox);
  await fire(listeners, "pointermove", { pointerId: 4, pointerType: "touch", clientX: 40, clientY: 20 });
  await fire(listeners, "pointerup", { pointerId: 4, pointerType: "touch" });
  const put = puts.find((p) => String(p.url).includes("/elements/e1"));
  assert.deepEqual(JSON.parse(put.opts.body), { width: 60, height: 50 });
});

test("Dispositivos: el segundo arrastre parte de la posición actual, no de la del último render", () => {
  const down = APP.slice(APP.indexOf('div.addEventListener("pointerdown"'), APP.indexOf("const resizeHandle"));
  assert.match(down, /origX: Number\.isFinite\(parseFloat\(div\.style\.left\)\) \? parseFloat\(div\.style\.left\) : pos\.x/);
  assert.match(down, /origY: Number\.isFinite\(parseFloat\(div\.style\.top\)\) \? parseFloat\(div\.style\.top\) : pos\.y/);
  // Las propiedades se abren al soltar (abrirlas al tocar reajusta el plano bajo el dedo).
  assert.doesNotMatch(down, /openElementProps\(/);
});
