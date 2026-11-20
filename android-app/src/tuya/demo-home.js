/* Casa de demostración: dispositivos con las categorías y DPs estándar de Tuya
 * (WiFi y Zigbee detrás de una pasarela). La usan el modo demo de la app y los
 * tests. NO son dispositivos reales ni credenciales reales. */
(function (root) {
  "use strict";
  if (!root.HDX && typeof require === "function") require("../core/umd.js");
  const HDX = root.HDX;

  function devices() {
    const gw = "demo_gw_zigbee";
    const base = (id, name, category, status, extra) => Object.assign({
      id, name, category, online: true, owner_id: "demo_home", product_name: name,
      status: Object.keys(status).map((code) => ({ code, value: status[code] })),
    }, extra || {});
    const zb = { sub: true, gateway_id: gw };
    return [
      base(gw, "Pasarela Zigbee", "wg2", {}, {}),
      base("demo_luz_salon", "Luz salón", "dj", { switch_led: true, bright_value_v2: 700 }),
      base("demo_luz_cocina", "Luz cocina", "dj", { switch_led: false, bright_value_v2: 400 }),
      base("demo_depuradora", "Depuradora", "cz", { switch_1: false, cur_power: 0, cur_voltage: 2301, cur_current: 0, add_ele: 1520 }),
      base("demo_regleta", "Regleta oficina", "pc", { switch_1: true, switch_2: false, switch_usb1: true }),
      base("demo_persiana_salon", "Persiana salón", "cl", { control: "stop", percent_control: 60, percent_state: 60 }),
      base("demo_garaje", "Puerta garaje", "ckmkzq", { switch_1: false, doorcontact_state: false }),
      base("demo_pir_entrada", "PIR entrada", "pir", { pir: "none", battery_percentage: 90 }, zb),
      base("demo_pir_salon", "PIR salón", "pir", { pir: "none", battery_percentage: 75 }, zb),
      base("demo_pir_pasillo", "PIR pasillo arriba", "pir", { pir: "none", battery_percentage: 64 }, zb),
      base("demo_puerta", "Puerta principal", "mcs", { doorcontact_state: false, battery_percentage: 88 }, zb),
      base("demo_sirena", "Sirena", "sgbj", { alarm_switch: false, alarm_volume: "high", alarm_ringtone: "1", alarm_time: 60 }, zb),
      base("demo_temp", "Temperatura salón", "wsdcg", { va_temperature: 215, va_humidity: 48, battery_percentage: 80 }, zb),
      base("demo_cargador", "Cargador coche", "qccdz", { work_state: "charger_charging", power_total: 7200, forward_energy_total: 123456 }),
      base("demo_contador", "Contador general", "zndb", { forward_energy_total: 845210, phase_a: phaseA(230.4, 9.8, 2.25) }),
      base("demo_camara", "Cámara jardín", "sp", { basic_indicator: true }),
    ];
  }

  /** Codifica phase_a como hacen los contadores Tuya (V/10, A/1000, kW/1000). */
  function phaseA(v, a, kw) {
    const V = Math.round(v * 10), A = Math.round(a * 1000), P = Math.round(kw * 1000);
    const bytes = [V >> 8 & 255, V & 255, A >> 16 & 255, A >> 8 & 255, A & 255, P >> 16 & 255, P >> 8 & 255, P & 255];
    const bin = String.fromCharCode.apply(null, bytes);
    return typeof btoa === "function" ? btoa(bin) : Buffer.from(bin, "binary").toString("base64");
  }

  const SPECS = {
    dj: { functions: [{ code: "bright_value_v2", type: "Integer", values: '{"min":10,"max":1000,"scale":0,"step":1}' }], status: [] },
    sgbj: { functions: [
      { code: "alarm_volume", type: "Enum", values: '{"range":["low","middle","high","mute"]}' },
      { code: "alarm_ringtone", type: "Enum", values: '{"range":["1","2","3","4","5"]}' },
    ], status: [] },
    qccdz: { functions: [], status: [{ code: "power_total", type: "Integer", values: '{"unit":"kW","min":0,"max":50000,"scale":3,"step":1}' }] },
    cz: { functions: [], status: [{ code: "cur_power", type: "Integer", values: '{"unit":"W","min":0,"max":50000,"scale":1,"step":1}' }] },
  };

  const SCENES = [{ scene_id: "demo_scene_dia", name: "Escena día" }, { scene_id: "demo_scene_noche", name: "Escena noche" }];

  const api = { devices, phaseA, SPECS, SCENES, DEMO_ACCESS_ID: "demo-access-id", DEMO_SECRET: "demo-secret-no-real-0123456789ab" };
  HDX.define("demoHome", () => api);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
