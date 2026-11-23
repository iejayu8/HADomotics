/* HADomotics — iconos de los elementos del plano (SVG propios, sin dependencias).
 *
 * Todos con el mismo estilo: rejilla 24×24, trazo 1,8 redondeado, sin relleno,
 * color = currentColor. Algunos cambian con el estado (persiana según su
 * posición, luz con rayos al encenderse, puertas abiertas/cerradas).
 *
 * - resolve(el, stateObj) elige el icono: el que se haya elegido en el
 *   formulario (campo svg_icon) o, en «Automático», según el tipo, el dominio,
 *   la device_class y el nombre/entidad (persiana, garaje, depuradora, Día…).
 * - svg(key, info) devuelve el <svg>.
 * - stateClass(el, stateObj) → "on" | "off" | "unavailable" | "" para el estilo.
 */
"use strict";

(function () {
  const ON_STATES = new Set([
    "on", "open", "opening", "home", "active", "heating", "cooling", "heat", "cool", "auto", "dry", "fan_only",
    "heat_cool", "true", "playing", "cleaning", "returning", "run", "delayedstart", "unlocked", "armed_home",
    "armed_away", "armed_night", "armed_vacation", "armed_custom_bypass", "triggered", "detected",
  ]);
  const OFF_STATES = new Set([
    "off", "closed", "closing", "not_home", "idle", "false", "paused", "standby", "docked", "locked", "disarmed",
    "ready", "inactive", "finished", "clear",
  ]);

  // Cada icono: (info) => contenido SVG. info = { on, pos }.
  const ICONS = {
    persiana: (i) => {
      // Marco de ventana, cajón arriba y lamas según lo cerrada que esté.
      const closed = i.pos == null ? 0.6 : Math.max(0, Math.min(1, (100 - i.pos) / 100));
      const n = Math.round(closed * 5);
      let s = '<rect x="3.5" y="3" width="17" height="18" rx="1.5"/><path d="M3.5 6.5h17"/>';
      for (let k = 0; k < n; k++) s += `<path d="M6 ${9 + k * 2.4}h12"/>`;
      if (n === 0) s += '<path d="M12 9v4"/><circle cx="12" cy="14.2" r=".9"/>';
      return s;
    },
    garaje_interior: (i) =>
      // Garaje (tejado) con puerta seccional; abierta = paneles recogidos arriba.
      '<path d="M2.5 10 12 4l9.5 6"/><path d="M5 8.5V20.5M19 8.5V20.5"/>' +
      (i.on
        ? '<path d="M7.5 11.5h9v2.5h-9z"/><path d="M12 19.5v-3.5M10.3 17.7 12 16l1.7 1.7"/>'
        : '<path d="M7.5 11.5h9v9h-9z"/><path d="M7.5 14.5h9M7.5 17.5h9"/>'),
    puerta_exterior: (i) =>
      // Cancela de calle: dos pilares y barrotes; abierta = hoja recogida.
      '<path d="M3.5 5v15.5M20.5 5v15.5"/><path d="M2.5 20.5h19"/>' +
      (i.on
        ? '<path d="M3.5 8h4.5M3.5 18h4.5M6 8v10"/><path d="M11 13h7M15.5 10.5 18 13l-2.5 2.5"/>'
        : '<path d="M3.5 8h17M3.5 18h17"/><path d="M7.25 6.5v11.5M10.75 6.5v11.5M14.25 6.5v11.5M17.75 6.5v11.5"/>'),
    puerta: (i) =>
      i.on
        ? '<path d="M4 20.5h16"/><path d="M6 20.5V3.5h9"/><path d="M15 3.5l-5 2v15"/><path d="M12.5 12.5h.01"/>'
        : '<path d="M4 20.5h16"/><path d="M6.5 20.5V4a.5.5 0 0 1 .5-.5h10a.5.5 0 0 1 .5.5v16.5"/><path d="M14.5 12h.01"/>',
    ventana: () => '<rect x="4" y="3.5" width="16" height="17" rx="1.5"/><path d="M12 3.5v17M4 12h16"/>',
    luz: (i) =>
      '<path d="M12 5a5 5 0 0 0-3 9c.6.5 1 1.1 1 1.9v.6h4v-.6c0-.8.4-1.4 1-1.9A5 5 0 0 0 12 5z"/>' +
      '<path d="M10 19.5h4M10.5 21.5h3"/>' +
      (i.on ? '<path d="M12 1.5v1.2M4.6 4.6l.9.9M19.4 4.6l-.9.9M2.5 10h1.3M20.2 10h1.3"/>' : ""),
    modo_dia: () =>
      '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>',
    modo_noche: () =>
      '<path d="M19.5 14.5A8 8 0 1 1 9.5 4.5a6.3 6.3 0 0 0 10 10z"/><path d="M17 3v3M15.5 4.5h3"/>',
    escena: () =>
      '<path d="M11 3.5l1.7 4.3 4.3 1.7-4.3 1.7L11 15.5l-1.7-4.3L5 9.5l4.3-1.7z"/>' +
      '<path d="M18 14l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/>',
    aerotermia: () =>
      // Unidad exterior de bomba de calor: ventilador y rejilla.
      '<rect x="2.5" y="5" width="19" height="13" rx="2"/><circle cx="9" cy="11.5" r="4"/>' +
      '<path d="M9 9.5v4M7 11.5h4"/><path d="M15.5 8.5h3.5M15.5 11.5h3.5M15.5 14.5h3.5"/><path d="M6 18v2.5M18 18v2.5"/>',
    termometro: () => '<path d="M10 5a2 2 0 0 1 4 0v8.8a4 4 0 1 1-4 0z"/><path d="M12 10v6.5"/>',
    humedad: () => '<path d="M12 3.5s-6 6.6-6 10.5a6 6 0 0 0 12 0c0-3.9-6-10.5-6-10.5z"/><path d="M9.5 14.5a2.5 2.5 0 0 0 2.5 2.5"/>',
    energia: () => '<path d="M13 2.5 5.5 13.5H12l-1 8 7.5-11H12z"/>',
    depuradora: () =>
      // Piscina: escalera y agua.
      '<path d="M8 3.5v11M15.5 3.5v11M8 7h7.5M8 10.5h7.5"/>' +
      '<path d="M2.5 17c1.6 1.2 3.2 1.2 4.8 0s3.2-1.2 4.7 0 3.2 1.2 4.7 0 3.2-1.2 4.8 0"/>' +
      '<path d="M2.5 20.5c1.6 1.2 3.2 1.2 4.8 0s3.2-1.2 4.7 0 3.2 1.2 4.7 0 3.2-1.2 4.8 0"/>',
    interruptor: () => '<path d="M12 3v8"/><path d="M7.2 6.3a7 7 0 1 0 9.6 0"/>',
    enchufe: () =>
      '<circle cx="12" cy="12" r="8.5"/><circle cx="9" cy="12" r="1.1"/><circle cx="15" cy="12" r="1.1"/><path d="M12 3.5v2.2M12 18.3v2.2"/>',
    sensor: () => '<path d="M4.5 16.5a8 8 0 1 1 15 0"/><path d="M12 16.5l3.5-4.5"/><circle cx="12" cy="16.5" r="1"/>',
    movimiento: () =>
      '<circle cx="12" cy="14" r="1.6"/><path d="M8.5 10.5a5 5 0 0 1 7 0M6 8a8.5 8.5 0 0 1 12 0"/><path d="M12 15.6v5"/>',
    camara: () =>
      '<path d="M3 8a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M16 10.5l5-3v9l-5-3"/>',
    alarma: () => '<path d="M12 3l7.5 3v5.5c0 4.5-3.2 8-7.5 9.5-4.3-1.5-7.5-5-7.5-9.5V6z"/><path d="M9 12l2 2 4-4"/>',
    sirena: () =>
      '<path d="M7 17v-5a5 5 0 0 1 10 0v5"/><path d="M5 17h14v3.5H5z"/><path d="M12 2.5v1.5M4.2 6l1.1 1.1M19.8 6l-1.1 1.1"/>',
    cargador: () =>
      '<path d="M5 20.5V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v15.5"/><path d="M3.5 20.5h13"/>' +
      '<path d="M15 9h2a2 2 0 0 1 2 2v4a1.5 1.5 0 0 0 3 0V8l-2.5-2.5"/><path d="M10.5 6.5 8.5 10h3l-2 3.5"/>',
    ventilador: () =>
      '<circle cx="12" cy="12" r="1.5"/><path d="M12 10.5C12 6 9 4 7 6s0 4.5 3.7 5.3"/><path d="M13.5 12c4.5 0 6.5-3 4.5-5s-4.5 0-5.3 3.7"/>' +
      '<path d="M12 13.5c0 4.5 3 6.5 5 4.5s0-4.5-3.7-5.3"/><path d="M10.5 12C6 12 4 15 6 17s4.5 0 5.3-3.7"/>',
    cerradura: (i) => '<rect x="5.5" y="11" width="13" height="9.5" rx="1.5"/>' +
      (i.on ? '<path d="M8.5 11V8a3.5 3.5 0 0 1 6.8-1.2"/>' : '<path d="M8.5 11V8a3.5 3.5 0 0 1 7 0v3"/>') +
      '<path d="M12 15v2"/>',
    altavoz: () => '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>',
    indicador: () => '<circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="2.5"/>',
    generico: () =>
      '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/>' +
      '<rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
    nevera: () =>
      '<rect x="6" y="2.5" width="12" height="19" rx="2"/><path d="M6 9.5h12"/><path d="M9 5v2.5M9 12v4"/>',
    lavavajillas: () =>
      '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M4 7.5h16"/>' +
      '<circle cx="7.5" cy="5.25" r=".7"/><circle cx="10.5" cy="5.25" r=".7"/>' +
      '<path d="M8 12.5c1.2-1 2.8-1 4 0s2.8 1 4 0"/><path d="M8 16.5c1.2-1 2.8-1 4 0s2.8 1 4 0"/>',
    robot: () =>
      '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.2"/><path d="M5.6 7.6a8 8 0 0 1 12.8 0"/><circle cx="12" cy="5.4" r=".8"/>',
  };

  // Nombres para el selector del formulario (orden de la lista).
  const LABELS = {
    persiana: "Persiana", garaje_interior: "Puerta de garaje (interior)", puerta_exterior: "Puerta exterior / cancela",
    puerta: "Puerta", ventana: "Ventana", luz: "Luz", modo_dia: "Modo día", modo_noche: "Modo noche", escena: "Escena",
    aerotermia: "Aerotermia / clima", termometro: "Temperatura", humedad: "Humedad", energia: "Energía",
    depuradora: "Depuradora de piscina", interruptor: "Interruptor", enchufe: "Enchufe", sensor: "Sensor",
    movimiento: "Movimiento", camara: "Cámara", alarma: "Alarma", sirena: "Sirena", cargador: "Cargador del coche",
    ventilador: "Ventilador", cerradura: "Cerradura", altavoz: "Altavoz", indicador: "Indicador", generico: "Genérico",
    nevera: "Nevera", lavavajillas: "Lavavajillas", robot: "Robot aspirador / friegasuelos",
  };

  const APPLIANCE_ICON = { fridge: "nevera", dishwasher: "lavavajillas", vacuum: "robot" };

  function norm(s) {
    return " " + String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, " ").trim() + " ";
  }
  const has = (text, words) => words.some((w) => text.includes(` ${w} `) || (w.endsWith("*") && text.includes(` ${w.slice(0, -1)}`)));

  /** Icono automático según tipo, dominio, device_class y nombre. */
  function autoKey(el, s) {
    const type = (el && el.type) || "";
    if (APPLIANCE_ICON[type]) return APPLIANCE_ICON[type];
    const eid = String((el && el.entity_id) || "");
    const domain = eid.split(".")[0];
    const dc = String((s && s.attributes && s.attributes.device_class) || "");
    const t = norm(`${(el && el.label) || ""} ${eid.replace(/[._]/g, " ")}`);
    const exterior = has(t, ["exterior", "calle", "cancela", "verja", "portal", "gate"]);

    if (has(t, ["depuradora", "piscina", "pool"])) return "depuradora";
    if (has(t, ["noche", "night"])) return "modo_noche";
    if (has(t, ["dia", "day", "manana"]) && ["scene", "script", "automation", "input_boolean", ""].includes(domain)) return "modo_dia";
    if (has(t, ["garaje", "garage"]) || dc === "garage") {
      if (domain === "light" && !has(t, ["puerta"])) return "luz";
      return exterior ? "puerta_exterior" : "garaje_interior";
    }
    if (dc === "gate" || (has(t, ["puerta", "door"]) && exterior) || has(t, ["cancela", "verja"])) return "puerta_exterior";
    if (type === "cover" || domain === "cover") {
      if (dc === "door") return "puerta";
      if (dc === "window") return "ventana";
      return "persiana";
    }
    if (domain === "vacuum") return "robot";
    if (type === "light" || domain === "light" || has(t, ["luz", "luces", "lampara", "light", "foco", "aplique"])) return "luz";
    if (type === "climate" || domain === "climate" || domain === "water_heater" || has(t, ["aerotermia"])) return "aerotermia";
    if (domain === "alarm_control_panel" || has(t, ["alarma", "alarmo"])) return "alarma";
    if (domain === "siren" || has(t, ["sirena"])) return "sirena";
    if (domain === "lock") return "cerradura";
    if (domain === "fan" || has(t, ["ventilador"])) return "ventilador";
    if (domain === "media_player") return "altavoz";
    if (type === "camera" || domain === "camera") return "camara";
    if (has(t, ["cargador", "charger", "evse", "wallbox"])) return "cargador";
    if (has(t, ["enchufe", "plug", "socket"])) return "enchufe";
    if (["sensor", "binary_sensor"].includes(domain) || type === "sensor" || type === "indicator") {
      if (dc === "temperature") return "termometro";
      if (dc === "humidity" || dc === "moisture") return "humedad";
      if (["power", "energy", "current", "voltage", "apparent_power"].includes(dc)) return "energia";
      if (["motion", "occupancy", "presence"].includes(dc)) return "movimiento";
      if (["door", "garage_door", "opening"].includes(dc)) return "puerta";
      if (dc === "window") return "ventana";
      return type === "indicator" ? "indicador" : "sensor";
    }
    if (domain === "scene" || domain === "script") return "escena";
    if (["switch", "input_boolean", "button", "input_button", "automation"].includes(domain)) return "interruptor";
    if (type === "button") return "interruptor";
    if (type === "indicator") return "indicador";
    return "generico";
  }

  function resolve(el, s) {
    const chosen = el && el.svg_icon;
    if (chosen && chosen !== "auto" && ICONS[chosen]) return chosen;
    return autoKey(el, s);
  }

  /** "on" | "off" | "unavailable" | "" (sin entidad o estado no binario). */
  function stateClass(el, s) {
    if (!el || !el.entity_id || !s) return "";
    const st = String(s.state || "").toLowerCase();
    if (st === "unavailable") return "unavailable";
    if (ON_STATES.has(st)) return "on";
    if (OFF_STATES.has(st)) return "off";
    return "";
  }

  function infoFor(el, s) {
    const st = String((s && s.state) || "").toLowerCase();
    const pos = s && s.attributes && typeof s.attributes.current_position === "number"
      ? s.attributes.current_position
      : st === "open" ? 100 : st === "closed" ? 0 : null;
    return { on: ON_STATES.has(st), pos };
  }

  function svg(key, info) {
    const draw = ICONS[key] || ICONS.generico;
    return '<svg class="el-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + draw(info || {}) + "</svg>";
  }

  /** SVG del elemento con su estado actual. */
  function forElement(el, s) {
    return svg(resolve(el, s), infoFor(el, s));
  }

  window.HADomoticsIcons = { ICONS, LABELS, keys: Object.keys(LABELS), autoKey, resolve, stateClass, svg, forElement, infoFor };
})();
