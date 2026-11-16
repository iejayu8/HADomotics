/* HADomotics — capa de dibujo común de los planos (Dispositivos y Seguridad).
 *
 * - Reconoce la planta (planta baja / planta 1) por nombre normalizado u orden.
 * - Dibuja elementos fijos del plano (Tesla Model Y gris y cable del cargador)
 *   en un SVG con pointer-events: none, en coordenadas de la imagen.
 * - Anima el cable (flujo verde hacia el coche) cuando el EVSE carga.
 * - Sustituye la imagen de Planta 1 por su versión HD si es la misma imagen
 *   (mismo tamaño), manteniendo el sistema de coordenadas original.
 */
"use strict";

(function () {
  const SVG_NS = "http://www.w3.org/2000/svg";
  const TESLA_PORT = [51, 21];
  let overlaysPromise = null;
  let overlays = { floors: [] };

  function panelRoot() {
    if (window.HADomotics && typeof window.HADomotics.panelRoot === "function") {
      return window.HADomotics.panelRoot();
    }
    return window.location.pathname.replace(/\/+$/, "");
  }

  function load() {
    if (!overlaysPromise) {
      overlaysPromise = fetch(panelRoot() + "/api/plan/overlays", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : { floors: [] }))
        .catch(() => ({ floors: [] }))
        .then((j) => {
          overlays = j && Array.isArray(j.floors) ? j : { floors: [] };
          return overlays;
        });
    }
    return overlaysPromise;
  }

  function norm(s) {
    return String(s || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]/g, "");
  }

  /** Configuración de capa para una planta (por nombre; si no, por orden). */
  function configFor(floor, allFloors, cfg) {
    const data = cfg || overlays;
    if (!floor || !data || !Array.isArray(data.floors)) return null;
    const n = norm(floor.name);
    const byName = data.floors.find((f) => (f.match || []).some((m) => n === norm(m)));
    if (byName) return byName;
    if (Array.isArray(allFloors) && allFloors.length) {
      const sorted = [...allFloors].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      const idx = sorted.findIndex((f) => f.id === floor.id);
      const fallbackCandidates = data.floors.filter((f) => f.order_fallback === idx);
      // Solo por orden si ninguna otra planta coincide ya por nombre con ese bloque.
      if (fallbackCandidates.length === 1) {
        const c = fallbackCandidates[0];
        const taken = sorted.some((f) => f.id !== floor.id && (c.match || []).some((m) => norm(f.name) === norm(m)));
        if (!taken) return c;
      }
    }
    return null;
  }

  function toNumberW(stateObj) {
    if (!stateObj) return null;
    const v = parseFloat(stateObj.state);
    if (!isFinite(v)) return null;
    const unit = String((stateObj.attributes && stateObj.attributes.unit_of_measurement) || "W").toLowerCase();
    if (unit === "kw") return v * 1000;
    if (unit === "mw") return v * 1e6;
    return v;
  }

  /** ¿Está cargando? Estado "Charging" o potencia real > umbral (W, kW convertido). */
  function evseCharging(states, cable) {
    if (!cable || !states) return { charging: false, watts: null };
    const watts = toNumberW(states[cable.power_entity]);
    const st = states[cable.state_entity];
    const opState = st ? String(st.state) : "";
    const threshold = typeof cable.threshold_w === "number" ? cable.threshold_w : 100;
    const charging = opState === "Charging" || (watts !== null && watts > threshold);
    return { charging, watts, opState };
  }

  function el(name, attrs) {
    const e = document.createElementNS(SVG_NS, name);
    Object.keys(attrs || {}).forEach((k) => e.setAttribute(k, attrs[k]));
    return e;
  }

  /** Tesla Model Y visto desde arriba, morro a la derecha (puerta del garaje),
   *  trasera a la izquierda. Puerto de carga: trasera izquierda (lado superior). */
  function teslaSvg(color) {
    const g = el("g", { class: "plan-tesla" });
    const body = color || "#8f949b";
    // Sombra suave en el suelo
    g.appendChild(el("rect", { x: "6", y: "16", width: "466", height: "170", rx: "70", fill: "rgba(0,0,0,0.18)" }));
    // Ruedas asomando
    [[70, 10], [70, 168], [372, 10], [372, 168]].forEach(([x, y]) => {
      g.appendChild(el("rect", { x: String(x), y: String(y), width: "64", height: "18", rx: "6", fill: "#2b2e33" }));
    });
    // Carrocería: trasera recta redondeada, morro más afilado
    g.appendChild(el("path", {
      d: "M28 40 C28 22 46 16 70 16 L360 16 C420 16 462 40 470 72 L472 96 L470 120 C462 152 420 176 360 176 L70 176 C46 176 28 170 28 152 Z",
      fill: body, stroke: "#4a4e55", "stroke-width": "3",
    }));
    // Retrovisores
    g.appendChild(el("ellipse", { cx: "322", cy: "10", rx: "16", ry: "8", fill: body, stroke: "#4a4e55", "stroke-width": "2" }));
    g.appendChild(el("ellipse", { cx: "322", cy: "182", rx: "16", ry: "8", fill: body, stroke: "#4a4e55", "stroke-width": "2" }));
    // Techo panorámico de cristal (luna trasera + techo + parabrisas)
    g.appendChild(el("path", {
      d: "M78 44 C70 44 64 52 64 62 L64 130 C64 140 70 148 78 148 L318 148 C340 148 352 136 356 120 L362 96 L356 72 C352 56 340 44 318 44 Z",
      fill: "#3b4552", stroke: "#2a3039", "stroke-width": "2",
    }));
    g.appendChild(el("path", { d: "M100 52 L300 52", stroke: "rgba(255,255,255,0.25)", "stroke-width": "4", "stroke-linecap": "round" }));
    // Capó
    g.appendChild(el("path", { d: "M380 40 C420 48 446 70 450 96 C446 122 420 144 380 152", fill: "none", stroke: "#6f747b", "stroke-width": "2" }));
    // Pilotos traseros y faros
    g.appendChild(el("rect", { x: "30", y: "34", width: "8", height: "30", rx: "3", fill: "#b23a3a" }));
    g.appendChild(el("rect", { x: "30", y: "128", width: "8", height: "30", rx: "3", fill: "#b23a3a" }));
    g.appendChild(el("path", { d: "M448 50 L462 72", stroke: "#e6eef7", "stroke-width": "5", "stroke-linecap": "round" }));
    g.appendChild(el("path", { d: "M448 142 L462 120", stroke: "#e6eef7", "stroke-width": "5", "stroke-linecap": "round" }));
    // Tapa del puerto de carga (trasera izquierda)
    g.appendChild(el("rect", { x: "40", y: "16", width: "22", height: "10", rx: "3", fill: "#5c6168", stroke: "#2b2e33", "stroke-width": "1.5", class: "plan-tesla-port" }));
    return g;
  }

  /** Dibuja la capa dentro del contenedor del plano (mismo sistema de coordenadas que los elementos). */
  function render(container, floor, allFloors, width, height) {
    if (!container) return null;
    const old = container.querySelector(":scope > svg.plan-overlay");
    if (old) old.remove();
    const cfg = configFor(floor, allFloors);
    if (!cfg || !width || !height) return null;
    const svg = el("svg", {
      class: "plan-overlay",
      viewBox: `0 0 ${width} ${height}`,
      width: String(width),
      height: String(height),
      "aria-hidden": "true",
      focusable: "false",
    });
    svg.style.position = "absolute";
    svg.style.left = "0";
    svg.style.top = "0";
    svg.style.pointerEvents = "none";
    svg.dataset.floorKey = cfg.key;

    if (cfg.tesla) {
      const t = cfg.tesla;
      const x = t.x * width, y = t.y * height, w = t.w * width, h = t.h * height;
      const car = el("svg", {
        x: String(x), y: String(y), width: String(w), height: String(h),
        viewBox: "0 0 478 192", preserveAspectRatio: "none", class: "plan-tesla-box",
      });
      car.appendChild(teslaSvg(t.color));
      svg.appendChild(car);
    }
    if (cfg.evse_cable && cfg.tesla) {
      const c = cfg.evse_cable;
      const t = cfg.tesla;
      const x1 = c.from[0] * width, y1 = c.from[1] * height;
      // Puerto de carga: tapa trasera izquierda del dibujo (x 40-62, y 16-26 de 478x192).
      const x2 = (t.x + (TESLA_PORT[0] / 478) * t.w) * width;
      const y2 = (t.y + (TESLA_PORT[1] / 192) * t.h) * height;
      // Curva suave: sale de la pared del cargador hacia el coche y llega al
      // puerto (trasera izquierda) por detrás del coche.
      const k = Math.max(20, Math.hypot(x2 - x1, y2 - y1) * 0.25);
      const d = `M${x1.toFixed(1)} ${y1.toFixed(1)} C${(x1 + k).toFixed(1)} ${(y1 - k * 0.3).toFixed(1)}, ${(x2 - k).toFixed(1)} ${(y2 + k * 0.9).toFixed(1)}, ${x2.toFixed(1)} ${y2.toFixed(1)}`;
      const g = el("g", { class: "evse-cable idle" });
      g.appendChild(el("path", { d, class: "evse-cable-base", fill: "none" }));
      g.appendChild(el("path", { d, class: "evse-cable-flow", fill: "none" }));
      g.appendChild(el("circle", { cx: x1.toFixed(1), cy: y1.toFixed(1), r: "7", class: "evse-wallbox" }));
      g.appendChild(el("circle", { cx: x2.toFixed(1), cy: y2.toFixed(1), r: "4", class: "evse-plug" }));
      svg.appendChild(g);
    }
    container.insertBefore(svg, container.firstChild ? container.firstChild.nextSibling : null);
    return svg;
  }

  /** Actualiza la animación del cable con los estados actuales. */
  function update(container, floor, allFloors, states) {
    if (!container) return null;
    const svg = container.querySelector(":scope > svg.plan-overlay");
    const cfg = configFor(floor, allFloors);
    if (!svg || !cfg || !cfg.evse_cable) return null;
    const g = svg.querySelector(".evse-cable");
    if (!g) return null;
    const res = evseCharging(states || {}, cfg.evse_cable);
    g.classList.toggle("charging", res.charging);
    g.classList.toggle("idle", !res.charging);
    return res;
  }

  /** Si hay versión HD de esta imagen (mismo tamaño que la original), la carga
   *  conservando las medidas originales como sistema de coordenadas. */
  function maybeUseHd(img, floor, allFloors) {
    const cfg = configFor(floor, allFloors);
    if (!img || !cfg || !cfg.image_hd || img.dataset.hdApplied === "1") return false;
    const ms = cfg.image_hd.match_size || [];
    if (img.naturalWidth !== ms[0] || img.naturalHeight !== ms[1]) return false;
    img.dataset.baseWidth = String(img.naturalWidth);
    img.dataset.baseHeight = String(img.naturalHeight);
    img.dataset.hdApplied = "1";
    img.src = panelRoot() + "/" + cfg.image_hd.src.replace(/^\/+/, "");
    return true;
  }

  window.HADomoticsPlan = {
    load,
    configFor,
    evseCharging,
    render,
    update,
    maybeUseHd,
    _norm: norm,
    get overlays() { return overlays; },
  };
})();
