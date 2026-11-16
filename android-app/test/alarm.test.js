"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { AlarmEngine, ALARM_ENTITY, hashCode, verifyCode } = require("../src/alarm/engine.js");

// Zonas como las de la casa auditada: exterior + planta baja (Noche) y planta 1 (solo Ausente).
const CFG = {
  exit_delay: { armed_night: 10, armed_away: 30 },
  entry_delay: 0,
  trigger_time: 180,
  siren: { entity: "siren.sirena" },
  zones: [
    { id: "entrada", name: "Entrada", night: true, sensors: ["binary_sensor.puerta"] },
    { id: "salon", name: "Entrada sofá", night: true, sensors: ["binary_sensor.pir_salon"] },
    { id: "pasillo_arriba", name: "Pasillo arriba", night: false, sensors: ["binary_sensor.pir_pasillo"] },
  ],
};
const T0 = 1_800_000_000_000;
const types = (acts) => acts.map((a) => a.type + (a.type === "siren" ? (a.on ? ":on" : ":off") : ""));

function armed(mode) {
  const e = new AlarmEngine(CFG);
  ["binary_sensor.puerta", "binary_sensor.pir_salon", "binary_sensor.pir_pasillo"].forEach((s) => e.onSensor(s, "off", T0));
  e.command(mode === "armed_night" ? "alarm_arm_night" : "alarm_arm_away", T0, "Xavi");
  e.tick(T0 + 31000);
  return e;
}

test("retardo de salida: arming -> armed_night a los 10 s", () => {
  const e = new AlarmEngine(CFG);
  e.command("alarm_arm_night", T0, "Xavi");
  assert.strictEqual(e.s.state, "arming");
  assert.deepStrictEqual(e.tick(T0 + 9000), []);
  e.tick(T0 + 10000);
  assert.strictEqual(e.s.state, "armed_night");
  assert.strictEqual(e.entities(T0)[0].attributes.changed_by, "Xavi");
});

test("Noche = alarma_modo_noche: solo zonas «noche»; Ausente = todas; Desarmar = ninguna", () => {
  const n = armed("armed_night");
  assert.deepStrictEqual(n.s.zones, { entrada: true, salon: true, pasillo_arriba: false });
  const a = armed("armed_away");
  assert.deepStrictEqual(a.s.zones, { entrada: true, salon: true, pasillo_arriba: true });
  const acts = a.command("alarm_disarm", T0 + 40000, "Xavi");
  assert.deepStrictEqual(a.s.zones, { entrada: false, salon: false, pasillo_arriba: false });
  assert.ok(types(acts).includes("siren:off"), "desarmar apaga la sirena (alarma_desactivar)");
});

test("detección durante el retardo de salida no dispara", () => {
  const e = new AlarmEngine(CFG);
  e.onSensor("binary_sensor.pir_salon", "off", T0);
  e.command("alarm_arm_away", T0);
  assert.deepStrictEqual(e.onSensor("binary_sensor.pir_salon", "on", T0 + 5000), []);
  assert.strictEqual(e.s.state, "arming");
});

test("zona desactivada en el momento de la detección: no dispara (Filter_Notification_Zone)", () => {
  const e = armed("armed_night");
  assert.deepStrictEqual(e.onSensor("binary_sensor.pir_pasillo", "on", T0 + 40000), []);
  assert.strictEqual(e.s.state, "armed_night");
});

test("zona cambiada a mano: se respeta en la siguiente detección", () => {
  const e = armed("armed_night");
  e.setZone("pasillo_arriba", true, T0 + 35000);
  const acts = e.onSensor("binary_sensor.pir_pasillo", "on", T0 + 40000, "PIR pasillo");
  assert.strictEqual(e.s.state, "triggered");
  assert.ok(types(acts).includes("siren:on"));
  const n = acts.find((a) => a.type === "notify" && a.critical);
  assert.match(n.body, /Detectada presencia en: Pasillo arriba - PIR pasillo/);
});

test("disparo sin sirena si «Sirena con la alarma» está off", () => {
  const e = armed("armed_away");
  e.setSirenEnabled(false, T0 + 32000);
  const acts = e.onSensor("binary_sensor.pir_salon", "on", T0 + 40000);
  assert.strictEqual(e.s.state, "triggered");
  assert.ok(!types(acts).includes("siren:on"));
  assert.ok(acts.some((a) => a.type === "notify" && a.critical));
});

test("avisos críticos: como mucho uno por zona y minuto", () => {
  const e = armed("armed_away");
  const a1 = e.onSensor("binary_sensor.pir_salon", "on", T0 + 40000);
  e.onSensor("binary_sensor.pir_salon", "off", T0 + 41000);
  const a2 = e.onSensor("binary_sensor.pir_salon", "on", T0 + 50000);
  e.onSensor("binary_sensor.pir_salon", "off", T0 + 51000);
  const a3 = e.onSensor("binary_sensor.pir_salon", "on", T0 + 101000);
  const crit = (acts) => acts.filter((a) => a.type === "notify" && a.critical).length;
  assert.deepStrictEqual([crit(a1), crit(a2), crit(a3)], [1, 0, 1]);
  // otra zona sí avisa enseguida
  assert.strictEqual(crit(e.onSensor("binary_sensor.puerta", "on", T0 + 52000)), 1);
});

test("fin del tiempo de disparo: sirena off y vuelve al modo armado", () => {
  const e = armed("armed_night");
  e.onSensor("binary_sensor.pir_salon", "on", T0 + 40000);
  const acts = e.tick(T0 + 40000 + 180000);
  assert.ok(types(acts).includes("siren:off"));
  assert.strictEqual(e.s.state, "armed_night");
});

test("retardo de entrada: pending y, si no se desarma, disparo", () => {
  const e = new AlarmEngine(Object.assign({}, CFG, { zones: CFG.zones.map((z) => z.id === "entrada" ? Object.assign({}, z, { entry_delay: 20 }) : z) }));
  e.onSensor("binary_sensor.puerta", "off", T0);
  e.command("alarm_arm_away", T0);
  e.tick(T0 + 30000);
  e.onSensor("binary_sensor.puerta", "on", T0 + 40000);
  assert.strictEqual(e.s.state, "pending");
  e.tick(T0 + 59000);
  assert.strictEqual(e.s.state, "pending");
  const acts = e.tick(T0 + 60000);
  assert.strictEqual(e.s.state, "triggered");
  assert.ok(types(acts).includes("siren:on"));
});

test("desarmar durante pending: no dispara", () => {
  const e = new AlarmEngine(Object.assign({}, CFG, { entry_delay: 20 }));
  e.onSensor("binary_sensor.puerta", "off", T0);
  e.command("alarm_arm_away", T0);
  e.tick(T0 + 30000);
  e.onSensor("binary_sensor.puerta", "on", T0 + 40000);
  e.command("alarm_disarm", T0 + 45000);
  e.tick(T0 + 70000);
  assert.strictEqual(e.s.state, "disarmed");
});

test("primera lectura de un sensor (arranque) no dispara aunque esté en on", () => {
  const e = new AlarmEngine(CFG, { state: "armed_away", armed_mode: "armed_away", zones: { salon: true } });
  assert.deepStrictEqual(e.onSensor("binary_sensor.pir_salon", "on", T0), []);
  assert.strictEqual(e.s.state, "armed_away");
});

test("vigilancia: sensor 5 min sin conexión -> aviso una vez", () => {
  const e = new AlarmEngine(CFG);
  e.onSensor("binary_sensor.pir_salon", "off", T0);
  e.onSensor("binary_sensor.pir_salon", "unavailable", T0 + 1000);
  assert.strictEqual(e.tick(T0 + 200000).length, 0);
  const acts = e.tick(T0 + 301000);
  assert.strictEqual(acts.filter((a) => a.type === "notify").length, 1);
  assert.strictEqual(e.tick(T0 + 400000).length, 0);
});

test("estado persistente: se reconstruye igual (reinicio de la app)", () => {
  const e = armed("armed_away");
  const e2 = new AlarmEngine(CFG, JSON.parse(JSON.stringify(e.toJSON())));
  assert.strictEqual(e2.s.state, "armed_away");
  assert.deepStrictEqual(e2.s.zones, e.s.zones);
});

test("entidad de alarma con forma de Alarmo (modos Noche/Ausente, sin Casa)", () => {
  const e = new AlarmEngine(CFG);
  const a = e.entities(T0)[0];
  assert.strictEqual(a.entity_id, ALARM_ENTITY);
  assert.strictEqual(a.attributes.supported_features, 14);
  assert.strictEqual(a.attributes.code_format, null);
  assert.throws(() => e.command("alarm_arm_home", T0));
});

test("código: solo hash con sal (PBKDF2); verificación", async () => {
  const h = await hashCode("1234");
  assert.ok(!JSON.stringify(h).includes("1234"));
  assert.strictEqual(await verifyCode("1234", h), true);
  assert.strictEqual(await verifyCode("1235", h), false);
  assert.strictEqual(await verifyCode("", h), false);
  const e = new AlarmEngine(Object.assign({}, CFG, { code_hash: h }));
  assert.strictEqual(e.entities(T0)[0].attributes.code_format, "number");
});

test("resumen para el servicio nativo: incluye el modo destino durante el retardo de salida", () => {
  const e = new AlarmEngine(CFG);
  e.command("alarm_arm_away", T0, "Xavi");
  const snap = e.nativeSnapshot();
  assert.strictEqual(snap.state, "arming");
  assert.strictEqual(snap.target, "armed_away");
  assert.ok(snap.until > T0);
  assert.strictEqual(snap.zones.length, 3);
  assert.ok(!JSON.stringify(snap).includes("hash"));
});
