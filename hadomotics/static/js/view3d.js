/*
 * HADomotics — vista 3D neón del plano (beta, 3.9.0).
 *
 * Idea inspirada en NeonPlan 3D (https://github.com/Mastershort/neonplan3d, MIT): casa vista
 * en perspectiva sobre fondo azul noche, paredes que brillan en cian, suelo con rejilla y los
 * dispositivos como chinchetas en pie con su etiqueta. No hay código de NeonPlan aquí: NeonPlan
 * usa three.js con paredes dibujadas en su editor; HADomotics parte de una imagen del plano, así
 * que esta vista es CSS 3D sobre el mismo DOM (los elementos siguen siendo los mismos <div>, con
 * sus clics, estados y paneles) y las «paredes» neón salen de los bordes de la imagen.
 *
 * Sin dependencias ni red: funciona igual por ingress y sin conexión.
 */
(function () {
  "use strict";

  const KEY = "hadomotics.view3d";
  const DEFAULTS = { on: false, tilt: 52, spin: -18, zoom: 1 };
  const TILT_MIN = 0;
  const TILT_MAX = 68;
  const EDGE_MAX_PX = 1100; // resolución máxima del mapa de bordes (rendimiento en tablets)
  const WALL_LAYERS = 6; // capas apiladas del mapa de bordes = paredes «extruidas»

  let prefs = load();
  let editing = false;
  let lastFit = null;
  let edgeKey = "";
  let edgeUrl = "";
  let dragged = false;
  let onChange = () => {};

  function load() {
    try {
      const p = JSON.parse(window.localStorage.getItem(KEY) || "{}");
      return sanitize(Object.assign({}, DEFAULTS, p));
    } catch (e) {
      return Object.assign({}, DEFAULTS);
    }
  }

  function save() {
    try { window.localStorage.setItem(KEY, JSON.stringify(prefs)); } catch (e) { /* modo privado */ }
  }

  function sanitize(p) {
    const n = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
    let spin = n(p.spin, DEFAULTS.spin) % 360;
    if (spin > 180) spin -= 360;
    if (spin < -180) spin += 360;
    return {
      on: p.on === true,
      tilt: Math.min(TILT_MAX, Math.max(TILT_MIN, n(p.tilt, DEFAULTS.tilt))),
      spin,
      zoom: Math.min(1.6, Math.max(0.5, n(p.zoom, DEFAULTS.zoom))),
    };
  }

  /** ¿Se ve ahora en 3D? Solo en modo vista: editar siempre es en 2D. */
  function active() { return prefs.on && !editing; }

  /**
   * Transformación del contenedor del plano. En 2D es la de siempre (translate + scale desde la
   * esquina). En 3D se gira alrededor del centro del dibujo y se reduce un poco (zoom) para que la
   * perspectiva quepa, manteniendo ese centro en el mismo punto de la pantalla.
   */
  function transformFor(fit) {
    const ox = fit.ox, oy = fit.oy, s = fit.scale;
    if (!active() || !fit.drawing) return `translate(${ox}px, ${oy}px) scale(${s})`;
    const d = fit.drawing;
    const cx = d.x + d.w / 2;
    const cy = d.y + d.h / 2;
    const v = view3dGeometry(fit);
    const s2 = v.scale;
    const tx = ox + cx * s - cx * s2;
    const ty = oy + cy * s - cy * s2 + d.h * s * 0.03; // un poco más abajo: el fondo se aleja
    return `translate(${r(tx)}px, ${r(ty)}px) scale3d(${r(s2)}, ${r(s2)}, ${r(s2)}) translate(${r(cx)}px, ${r(cy)}px) ` +
      `rotateX(${prefs.tilt}deg) rotateZ(${r(v.spin)}deg) translate(${r(-cx)}px, ${r(-cy)}px)`;
  }

  /**
   * Giro real y escala de la vista 3D. En pantallas verticales un plano apaisado se gira 90° de
   * entrada para aprovechar el alto. La escala se calcula con la huella de la casa girada e
   * inclinada (no con la del plano 2D), y luego se aplica el zoom del usuario.
   */
  function view3dGeometry(fit) {
    const d = fit.drawing;
    const aw = fit.aw || d.w * fit.scale;
    const ah = fit.ah || d.h * fit.scale;
    const portrait = ah > aw * 1.15;
    const autoSpin = portrait && d.w > d.h * 1.15 ? 90 : 0;
    const spin = prefs.spin + autoSpin;
    const a = (spin * Math.PI) / 180;
    const t = (prefs.tilt * Math.PI) / 180;
    const fw = Math.abs(d.w * Math.cos(a)) + Math.abs(d.h * Math.sin(a));
    const fd = Math.abs(d.w * Math.sin(a)) + Math.abs(d.h * Math.cos(a));
    const H = wallHeight(d);
    const fh = fd * Math.cos(t) + H * Math.sin(t) * 2.5; // + sitio para chinchetas y etiquetas
    const fitScale = Math.min(aw / (fw * 1.08), ah / (fh * 1.12));
    return { spin, autoSpin, scale: fitScale * prefs.zoom };
  }

  function r(v) { return Math.round(v * 1000) / 1000; }

  // -------------------------------------------------------------------------
  // Mapa de bordes neón (Sobel sobre la luminancia de la imagen del plano)
  // -------------------------------------------------------------------------

  /**
   * Devuelve un Uint8ClampedArray RGBA con los bordes en cian. `rgba` es la imagen (w×h).
   * Solo bordes fuertes: paredes y contornos; las texturas suaves del suelo no salen.
   */
  function edgeMap(rgba, w, h, threshold) {
    const lum = new Float32Array(w * h);
    for (let i = 0, p = 0; i < lum.length; i++, p += 4) {
      lum[i] = 0.2126 * rgba[p] + 0.7152 * rgba[p + 1] + 0.0722 * rgba[p + 2];
    }
    const out = new Uint8ClampedArray(w * h * 4);
    const t = threshold == null ? 110 : threshold;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const gx = -lum[i - w - 1] - 2 * lum[i - 1] - lum[i + w - 1] + lum[i - w + 1] + 2 * lum[i + 1] + lum[i + w + 1];
        const gy = -lum[i - w - 1] - 2 * lum[i - w] - lum[i - w + 1] + lum[i + w - 1] + 2 * lum[i + w] + lum[i + w + 1];
        const m = Math.sqrt(gx * gx + gy * gy);
        if (m < t) continue;
        const a = Math.min(255, (m - t) * 2.2 + 90);
        const o = i * 4;
        out[o] = 70; out[o + 1] = 230; out[o + 2] = 255; out[o + 3] = a;
      }
    }
    return out;
  }

  function buildEdges(img, crop) {
    const nw = img.naturalWidth, nh = img.naturalHeight;
    if (!nw || !nh) return "";
    const bw = parseFloat(img.dataset.baseWidth) || nw;
    const bh = parseFloat(img.dataset.baseHeight) || nh;
    const d = crop || { x: 0, y: 0, w: bw, h: bh };
    // Recorte en píxeles de la imagen real (puede ser la versión HD).
    const kx = nw / bw, ky = nh / bh;
    const k = Math.min(1, EDGE_MAX_PX / Math.max(d.w * kx, d.h * ky));
    const w = Math.max(2, Math.round(d.w * kx * k));
    const h = Math.max(2, Math.round(d.h * ky * k));
    try {
      const c = document.createElement("canvas");
      c.width = w; c.height = h;
      const g = c.getContext("2d", { willReadFrequently: true });
      g.drawImage(img, d.x * kx, d.y * ky, d.w * kx, d.h * ky, 0, 0, w, h);
      const src = g.getImageData(0, 0, w, h);
      const edges = edgeMap(src.data, w, h);
      g.clearRect(0, 0, w, h);
      g.putImageData(new ImageData(edges, w, h), 0, 0);
      return c.toDataURL("image/png");
    } catch (e) {
      // Imagen de otro origen o sin canvas: la vista 3D sigue, sin paredes neón interiores.
      return "";
    }
  }

  // -------------------------------------------------------------------------
  // Escena: rejilla, paredes exteriores y capas de bordes
  // -------------------------------------------------------------------------

  function clearScene(container) {
    container.querySelectorAll(":scope > .np3d-layer").forEach((e) => e.remove());
  }

  function layer(container, cls, d, extra) {
    const el = document.createElement("div");
    el.className = `np3d-layer ${cls}`;
    el.setAttribute("aria-hidden", "true");
    el.style.left = `${d.x}px`;
    el.style.top = `${d.y}px`;
    el.style.width = `${d.w}px`;
    el.style.height = `${d.h}px`;
    if (extra) Object.assign(el.style, extra);
    container.insertBefore(el, container.firstChild);
    return el;
  }

  function wallHeight(d) { return Math.max(16, Math.min(d.w, d.h) * 0.06); }

  function renderScene(container, img, drawing) {
    clearScene(container);
    if (!active() || !drawing) return;
    const d = drawing;
    const H = wallHeight(d);
    container.style.setProperty("--np-wall", `${H}px`);
    // Paredes exteriores: cuatro paneles de cristal cian que se levantan del contorno.
    layer(container, "np3d-wall np3d-wall-n", { x: d.x, y: d.y, w: d.w, h: H });
    layer(container, "np3d-wall np3d-wall-s", { x: d.x, y: d.y + d.h - H, w: d.w, h: H });
    layer(container, "np3d-wall np3d-wall-w", { x: d.x, y: d.y, w: H, h: d.h });
    layer(container, "np3d-wall np3d-wall-e", { x: d.x + d.w - H, y: d.y, w: H, h: d.h });
    // Bordes del dibujo apilados a varias alturas: dan volumen a paredes y muebles.
    const key = `${img.currentSrc || img.src}|${d.x},${d.y},${d.w},${d.h}`;
    if (key !== edgeKey) {
      edgeKey = key;
      edgeUrl = buildEdges(img, d);
    }
    if (edgeUrl) {
      for (let i = WALL_LAYERS; i >= 0; i--) {
        layer(container, "np3d-edges", d, {
          backgroundImage: `url("${edgeUrl}")`,
          transform: `translateZ(${r((H * i) / WALL_LAYERS)}px)`,
          opacity: String(i === 0 ? 1 : i === WALL_LAYERS ? 0.85 : 0.32),
        });
      }
    }
    // Suelo con rejilla, más grande que la casa.
    const m = Math.max(d.w, d.h) * 0.6;
    layer(container, "np3d-grid", { x: d.x - m, y: d.y - m, w: d.w + 2 * m, h: d.h + 2 * m });
  }

  /** Llamado por fitFloorPlan después de colocar el plano. */
  function afterFit(container, img, fit) {
    lastFit = { container, img, fit };
    document.body.classList.toggle("neon-3d", active());
    container.style.setProperty("--np-tilt", `${prefs.tilt}deg`);
    const v = fit.drawing ? view3dGeometry(fit) : { spin: prefs.spin, scale: fit.scale };
    container.style.setProperty("--np-spin", `${r(v.spin)}deg`);
    // Tamaño de chinchetas y etiquetas constante en pantalla (como --fp-inv en 2D).
    container.style.setProperty("--np-k", String(r(Math.min(3.5, Math.max(1, 1 / v.scale)))));
    renderScene(container, img, fit.drawing);
    syncButtons();
  }

  function refit() {
    if (lastFit) {
      lastFit.container.style.transform = transformFor(lastFit.fit);
      afterFit(lastFit.container, lastFit.img, lastFit.fit);
    }
    onChange();
  }

  // -------------------------------------------------------------------------
  // Controles: botón 2D/3D en el dock, giro e inclinación, arrastre horizontal
  // -------------------------------------------------------------------------

  function setOn(on) { prefs.on = !!on; save(); refit(); }
  function rotate(deg) { prefs = sanitize(Object.assign({}, prefs, { spin: prefs.spin + deg })); save(); refit(); }
  function tilt(deg) { prefs = sanitize(Object.assign({}, prefs, { tilt: prefs.tilt + deg })); save(); refit(); }
  function zoomBy(f) { prefs = sanitize(Object.assign({}, prefs, { zoom: prefs.zoom * f })); save(); refit(); }
  function reset() { prefs = Object.assign({}, DEFAULTS, { on: true }); save(); refit(); }

  function setEditing(on) {
    editing = !!on;
    document.body.classList.toggle("neon-3d", active());
    syncButtons();
  }

  function syncButtons() {
    const b = document.getElementById("btnToggle3d");
    if (b) {
      b.classList.toggle("active", prefs.on);
      b.setAttribute("aria-pressed", String(prefs.on));
      b.title = prefs.on ? "Volver al plano 2D" : "Ver en 3D neón";
      const t = b.querySelector(".np3d-btn-text");
      if (t) t.textContent = prefs.on ? "2D" : "3D";
    }
    const c = document.getElementById("np3dControls");
    if (c) c.hidden = !active();
  }

  function install(opts) {
    onChange = (opts && opts.onChange) || onChange;
    const toolbar = document.querySelector(".editor-toolbar");
    if (toolbar && !document.getElementById("btnToggle3d")) {
      const b = document.createElement("button");
      b.type = "button";
      b.id = "btnToggle3d";
      b.className = "toolbar-btn np3d-toggle view-only";
      b.innerHTML = '<span class="material-icons">view_in_ar</span><span class="np3d-btn-text">3D</span>';
      b.addEventListener("click", () => setOn(!prefs.on));
      toolbar.appendChild(b);
    }
    const wrapper = document.getElementById("canvasWrapper");
    if (wrapper && !document.getElementById("np3dControls")) {
      const c = document.createElement("div");
      c.id = "np3dControls";
      c.className = "np3d-controls";
      c.hidden = true;
      const btn = (icon, title, fn) => {
        const e = document.createElement("button");
        e.type = "button";
        e.title = title;
        e.setAttribute("aria-label", title);
        e.innerHTML = `<span class="material-icons">${icon}</span>`;
        e.addEventListener("click", (ev) => { ev.stopPropagation(); fn(); });
        c.appendChild(e);
      };
      btn("rotate_left", "Girar a la izquierda", () => rotate(-30));
      btn("rotate_right", "Girar a la derecha", () => rotate(30));
      btn("expand_less", "Más inclinado", () => tilt(8));
      btn("expand_more", "Más cenital", () => tilt(-8));
      btn("zoom_in", "Acercar", () => zoomBy(1.12));
      btn("zoom_out", "Alejar", () => zoomBy(1 / 1.12));
      btn("center_focus_strong", "Vista inicial", reset);
      wrapper.appendChild(c);
      installDrag(wrapper);
    }
    syncButtons();
  }

  /** Arrastre horizontal con el dedo o el ratón = girar la casa. El vertical sigue cambiando de planta. */
  function installDrag(wrapper) {
    let start = null;
    wrapper.addEventListener("pointerdown", (e) => {
      if (!active() || (e.pointerType === "mouse" && e.button !== 0)) return;
      if (e.target.closest && e.target.closest("button, .np3d-controls")) return;
      start = { x: e.clientX, y: e.clientY, spin: prefs.spin, id: e.pointerId, moving: false };
    });
    wrapper.addEventListener("pointermove", (e) => {
      if (!start || e.pointerId !== start.id) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (!start.moving && Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy)) {
        start.moving = true;
        if (lastFit) lastFit.container.classList.add("np3d-dragging");
      }
      if (!start.moving) return;
      prefs.spin = sanitize(Object.assign({}, prefs, { spin: start.spin + dx * 0.35 })).spin;
      if (lastFit) {
        lastFit.container.style.transform = transformFor(lastFit.fit);
        lastFit.container.style.setProperty("--np-spin", `${r(view3dGeometry(lastFit.fit).spin)}deg`);
      }
    });
    const end = (e) => {
      if (!start || e.pointerId !== start.id) return;
      if (start.moving) {
        if (lastFit) lastFit.container.classList.remove("np3d-dragging");
        dragged = true;
        setTimeout(() => { dragged = false; }, 350);
        save();
      }
      start = null;
    };
    wrapper.addEventListener("pointerup", end);
    wrapper.addEventListener("pointercancel", end);
    // Soltar después de girar no debe abrir el panel del elemento bajo el dedo.
    wrapper.addEventListener("click", (e) => {
      if (dragged) { e.preventDefault(); e.stopPropagation(); }
    }, true);
  }

  window.HADomotics3D = {
    active,
    transformFor,
    afterFit,
    setEditing,
    setOn,
    rotate,
    tilt,
    zoomBy,
    reset,
    install,
    wasDragged: () => dragged,
    prefs: () => Object.assign({}, prefs),
    _internals: { edgeMap, sanitize, wallHeight, view3dGeometry, DEFAULTS, setPrefs: (p) => { prefs = sanitize(Object.assign({}, prefs, p)); } },
  };
})();
