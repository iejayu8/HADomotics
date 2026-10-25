"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const JS_DIR = path.join(__dirname, "..", "hadomotics", "static", "energia", "js");
const ENTITY = "input_select.carga_dia_domingo";
const ATTRS = { options: ["casa", "fuera"] };

function loadPanel() {
  const errors = [];
  const timers = new Map();
  let timerId = 1;
  const sandbox = {
    console: {
      error(...args) { errors.push(args.map(String).join(" ")); },
      log() {},
      debug() {},
    },
    localStorage: {
      getItem() { return "0"; },
      setItem() {},
    },
    document: {
      addEventListener() {},
      getElementById() { return null; },
      querySelectorAll() { return []; },
    },
    location: { pathname: "/energia" },
    fetch: async () => ({ ok: false, json: async () => ({}) }),
    setInterval(fn, ms) {
      const id = timerId++;
      timers.set(id, { fn, ms });
      return id;
    },
    clearInterval(id) { timers.delete(id); },
    setTimeout(fn, ms) {
      const id = timerId++;
      timers.set(id, { fn, ms, timeout: true });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(JS_DIR, "transport.js"), "utf8"), sandbox, { filename: "transport.js" });
  vm.runInContext(fs.readFileSync(path.join(JS_DIR, "energy.js"), "utf8"), sandbox, { filename: "energy.js" });
  return {
    errors,
    timers,
    EnergyTransport: sandbox.EnergyTransport,
    api: sandbox.HADomoticsEnergy,
  };
}

function state(value, lastUpdated) {
  return {
    entity_id: ENTITY,
    state: value,
    attributes: ATTRS,
    last_updated: lastUpdated,
  };
}

test("Madrid clock and weekday ignore the device timezone", () => {
  const { api } = loadPanel();
  assert.equal(api.madridClock(new Date("2026-10-25T14:17:02.000Z")), "15:17:02");
  assert.equal(api.madridClock(new Date("2026-10-25T14:17:03.000Z")), "15:17:03");
  assert.equal(api.madridClock(new Date("2026-07-15T14:17:03.000Z")), "16:17:03");
  assert.equal(api.madridClock(new Date("2026-01-15T23:30:00.000Z")), "00:30:00");

  // 22:30Z del sábado es ya domingo en Madrid (00:30 CEST).
  assert.equal(api.madridWeekdayIndex(new Date("2026-10-24T22:30:00.000Z")), 6);
  // 23:30Z del domingo es ya lunes en Madrid (00:30 CET). En América sigue siendo domingo.
  assert.equal(api.madridWeekdayIndex(new Date("2026-10-25T23:30:00.000Z")), 0);
  assert.equal(api.madridWeekdayIndex(new Date("2026-10-25T14:17:03.000Z")), 6);

  const line = api.callLogLine({
    ts: "2026-10-25T14:17:02.000Z",
    dry_run: false,
    domain: "input_select",
    service: "select_option",
    entity_id: ENTITY,
    data: { option: "casa" },
    result: "enviado como usuario",
  });
  assert.match(line, /^15:17:02 input_select\.select_option input_select\.carga_dia_domingo \{"option":"casa"\} → enviado como usuario$/);
  assert.doesNotMatch(line, /^14:17:02/);
});

test("an older snapshot cannot overwrite a newer state", () => {
  const { api } = loadPanel();
  const store = {};
  api.applyStates(store, [state("fuera", "2026-10-25T14:00:00.000Z")]);
  api.applyStates(store, [state("casa", "2026-10-25T14:17:03.000Z")]);
  api.applyStates(store, [state("fuera", "2026-10-25T14:00:00.000Z")]);
  assert.equal(store[ENTITY].state, "casa");
  assert.equal(store[ENTITY].last_updated, "2026-10-25T14:17:03.000Z");
});

test("optimistic select survives the pre-call snapshot and yields to Home Assistant", () => {
  const { api } = loadPanel();
  const store = {};
  api.applyStates(store, [state("fuera", "2026-10-25T14:00:00.000Z")]);
  store[ENTITY] = api.optimisticEntity(store[ENTITY], ENTITY, "select", "casa");
  assert.equal(store[ENTITY].state, "casa");
  assert.equal(store[ENTITY]._optimistic, true);

  api.applyStates(store, [state("fuera", "2026-10-25T14:00:00.000Z")]);
  assert.equal(store[ENTITY].state, "casa");
  assert.equal(store[ENTITY]._optimistic, true);

  api.applyStates(store, [state("casa", "2026-10-25T14:17:03.000Z")]);
  assert.equal(store[ENTITY].state, "casa");
  assert.equal(store[ENTITY]._optimistic, undefined);

  api.applyStates(store, [state("fuera", "2026-10-25T14:17:04.000Z")]);
  assert.equal(store[ENTITY].state, "fuera");
});

test("embedded poll reads the live hass object and does not revert after 4s", async () => {
  const { EnergyTransport, api, timers } = loadPanel();
  const listeners = [];
  const staleHass = {
    connected: true,
    states: { [ENTITY]: state("fuera", "2026-10-25T14:00:00.000Z") },
    connection: {
      async subscribeEvents(cb) {
        listeners.push(cb);
        return () => {};
      },
    },
  };
  let current = staleHass;
  const transport = EnergyTransport.Embedded({
    entityIds: [ENTITY],
    getHass() { return current; },
  });
  const store = {};
  transport.on("states", (list) => api.applyStates(store, list));
  await transport.start();
  assert.equal(store[ENTITY].state, "fuera");
  assert.equal(listeners.length, 1);

  const updated = state("casa", "2026-10-25T14:17:03.000Z");
  current = {
    connected: true,
    states: { [ENTITY]: updated },
    connection: staleHass.connection,
  };
  listeners[0]({ data: { entity_id: ENTITY, new_state: updated } });
  assert.equal(store[ENTITY].state, "casa");

  const polls = [...timers.values()].filter((t) => t.ms === 4000);
  assert.equal(polls.length, 1);
  polls[0].fn();
  assert.equal(store[ENTITY].state, "casa");

  // El objeto hass capturado al arrancar sigue en «fuera». No debe usarse.
  api.applyStates(store, [staleHass.states[ENTITY]]);
  assert.equal(store[ENTITY].state, "casa");
  transport.stop();
  assert.equal([...timers.values()].filter((t) => t.ms === 4000).length, 0);
});

test("a failed state_changed subscription is logged and the live poll still updates", async () => {
  const { EnergyTransport, api, timers, errors } = loadPanel();
  let current = {
    connected: true,
    states: { [ENTITY]: state("fuera", "2026-10-25T14:00:00.000Z") },
    connection: {
      async subscribeEvents() {
        throw new Error("ws down");
      },
    },
  };
  const transport = EnergyTransport.Embedded({
    entityIds: [ENTITY],
    getHass() { return current; },
  });
  const store = {};
  transport.on("states", (list) => api.applyStates(store, list));
  await transport.start();
  assert.match(errors.join("\n"), /state_changed subscription failed/);
  assert.match(errors.join("\n"), /ws down/);

  current = {
    connected: true,
    states: { [ENTITY]: state("casa", "2026-10-25T14:17:03.000Z") },
    connection: current.connection,
  };
  const poll = [...timers.values()].find((t) => t.ms === 4000);
  poll.fn();
  assert.equal(store[ENTITY].state, "casa");
  transport.stop();
});

test("prompt refresh after a control applies the new hass state", async () => {
  const { EnergyTransport, api } = loadPanel();
  let current = {
    connected: true,
    states: { [ENTITY]: state("fuera", "2026-10-25T14:00:00.000Z") },
    connection: { async subscribeEvents() { return () => {}; } },
  };
  const transport = EnergyTransport.Embedded({
    entityIds: [ENTITY],
    getHass() { return current; },
  });
  const store = {};
  transport.on("states", (list) => api.applyStates(store, list));
  await transport.start();
  store[ENTITY] = api.optimisticEntity(store[ENTITY], ENTITY, "select", "casa");
  transport.refresh();
  assert.equal(store[ENTITY].state, "casa");

  current = {
    connected: true,
    states: { [ENTITY]: state("casa", "2026-10-25T14:17:03.000Z") },
    connection: current.connection,
  };
  transport.refresh();
  assert.equal(store[ENTITY].state, "casa");
  assert.equal(store[ENTITY].last_updated, "2026-10-25T14:17:03.000Z");
  transport.stop();
});

test("panel source keeps the live hass, Madrid clock and weekday", () => {
  const energy = fs.readFileSync(path.join(JS_DIR, "energy.js"), "utf8");
  const transport = fs.readFileSync(path.join(JS_DIR, "transport.js"), "utf8");
  assert.match(energy, /getHass:\s*embeddedHass/);
  assert.doesNotMatch(energy, /EnergyTransport\.Embedded\(\{[^}]*\bhass\s*:/);
  assert.match(energy, /applyStates\(states,\s*list\)/);
  assert.match(energy, /refreshStatesSoon\(\)/);
  assert.match(energy, /optimisticEntity\(states\[it\.entity\]/);
  assert.match(energy, /madridWeekdayIndex\(new Date\(\)\)/);
  assert.match(energy, /callLogLine/);
  assert.doesNotMatch(energy, /getDay\(\)/);
  assert.doesNotMatch(energy, /ts\.slice\(11/);
  assert.match(transport, /opts\.getHass/);
  assert.match(transport, /state_changed subscription failed/);
});
