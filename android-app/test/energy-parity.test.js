"use strict";
// Comprueba que el port JS de build_flow da lo mismo que hadomotics/energy.py.
const test = require("node:test");
const assert = require("node:assert");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const energy = require("../src/energy/flow.js");

const ADDON = path.resolve(__dirname, "../../hadomotics");
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/energy_states.json"), "utf8"));

function python(states, map) {
  const code = `import json,sys; sys.path.insert(0, ${JSON.stringify(ADDON)})
import energy
d=json.load(sys.stdin)
print(json.dumps(energy.build_flow(d['states'], d['map'])))`;
  try {
    return JSON.parse(execFileSync("python3", ["-c", code], { input: JSON.stringify({ states, map }) }).toString());
  } catch (e) {
    return null;
  }
}

function close(a, b, p) {
  if (typeof a === "number" && typeof b === "number") return assert.ok(Math.abs(a - b) < 1e-9, `${p}: ${a} vs ${b}`);
  if (a && typeof a === "object") { Object.keys(b).forEach((k) => close(a[k], b[k], `${p}.${k}`)); return; }
  assert.strictEqual(a, b, p);
}

test("build_flow JS == energy.py (mapa real del add-on y estados de ejemplo)", (t) => {
  const map = JSON.parse(fs.readFileSync(path.join(ADDON, "energy_map.json"), "utf8"));
  const py = python(fixture, map);
  if (!py) return t.skip("python3/flask no disponible");
  close(energy.buildFlow(fixture, map), py, "flow");
});

test("build_flow JS == energy.py con valores raros (kW, sin unidad, unavailable)", (t) => {
  const map = { flow: { entities: { grid_power: "sensor.g", pv_power: "sensor.s", battery_power: "sensor.b", battery_soc: "sensor.soc", inverter_power: "sensor.i", aux_power: "sensor.a", grid_connected: "binary_sensor.gc" } } };
  const st = (v, u) => ({ state: v, attributes: u ? { unit_of_measurement: u } : {} });
  const cases = [
    { "sensor.g": st("1.5"), "sensor.s": st("2", "kW"), "sensor.b": st("-300", "W"), "sensor.soc": st("55"), "sensor.i": st("900", "W"), "sensor.a": st("unavailable"), "binary_sensor.gc": st("on") },
    { "sensor.g": st("-250", "W"), "sensor.s": st("unknown"), "sensor.b": st("0.5"), "sensor.i": st("abc"), "binary_sensor.gc": st("off") },
  ];
  for (const c of cases) {
    const py = python(c, map);
    if (!py) return t.skip("python3/flask no disponible");
    close(energy.buildFlow(c, map), py, "flow");
  }
});
