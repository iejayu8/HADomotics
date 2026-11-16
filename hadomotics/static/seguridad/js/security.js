/* HADomotics Seguridad — alarma Alarmo, zonas, sirena y presencia en los planos.
 *
 * Pantalla: tarjeta «Panel de Alarma» centrada sobre el plano, botón «Zonas»
 * a su derecha (superpone el detalle de zonas) y el selector de planta en el
 * mismo dock flotante que Dispositivos. El plano ocupa el resto, recortado a
 * su dibujo (sin bordes blancos). El coche y el cable de carga solo se dibujan
 * en Dispositivos.
 *
 * Mismo patrón que Energía: dentro de Home Assistant lee el objeto hass del
 * usuario y actúa con hass.callService (permisos de ese usuario); fuera, lee
 * /api/security/state y usa POST /api/security/alarm (solo administrador).
 * Zonas (interruptores de input_boolean.notificacion_alarma_*) y «Sirena»
 * (input_boolean.alarma_sirena, tono, nivel y «Probar sirena», que pide
 * confirmación) siguen el mismo patrón; fuera de HA van a
 * POST /api/security/control (solo administrador, lista blanca exacta).
 * El cambio se ve al momento y se deshace si la orden falla.
 * Los planos son los mismos de Dispositivos (/api/floors + /api/images).
 * El código de Alarmo solo vive en el campo del diálogo: no se guarda ni se
 * registra y se borra al cerrar.
 */
"use strict";

(function () {
  const $ = (id) => document.getElementById(id);
  let MAP = null;
  let floors = [];
  let floorDetails = {};
  let currentFloorId = null;
  let states = {};
  let started = false;
  let startPromise = null;
  let pollTimer = null;
  let scale = 1;
  // Cambios de zona/sirena ya pedidos: se muestran al momento y se deshacen
  // si Home Assistant (o el add-on) rechaza la orden.
  const pending = {};
  const PENDING_MS = 8000;
  const SIREN_TEST_TEXT = "Sonará la sirena real. ¿Probar la sirena?";

  const MODE_INFO = {
    disarmed: { service: "alarm_disarm", label: "Desarmar", icon: "lock_open", bit: 0 },
    armed_home: { service: "alarm_arm_home", label: "En casa", icon: "home", bit: 1 },
    armed_away: { service: "alarm_arm_away", label: "Ausente", icon: "directions_walk", bit: 2 },
    armed_night: { service: "alarm_arm_night", label: "Noche", icon: "bedtime", bit: 4 },
    armed_vacation: { service: "alarm_arm_vacation", label: "Vacaciones", icon: "flight", bit: 32 },
    armed_custom_bypass: { service: "alarm_arm_custom_bypass", label: "Personalizado", icon: "tune", bit: 16 },
  };
  const STATE_TEXT = {
    disarmed: "Desarmada",
    armed_home: "Armada (en casa)",
    armed_away: "Armada (ausente)",
    armed_night: "Armada (noche)",
    armed_vacation: "Armada (vacaciones)",
    armed_custom_bypass: "Armada (personalizado)",
    arming: "Armando…",
    pending: "Pendiente (entrada)",
    triggered: "¡DISPARADA!",
    disarming: "Desarmando…",
    unavailable: "No disponible",
    unknown: "Desconocido",
  };

  function root() {
    return (window.HADomotics && window.HADomotics.panelRoot) ? window.HADomotics.panelRoot() : "";
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function embeddedHass() {
    try {
      if (!window.parent || window.parent === window) return null;
      const r = window.parent.document.querySelector("home-assistant");
      return r && r.hass ? r.hass : null;
    } catch (e) {
      return null;
    }
  }
  function toast(t) {
    const el = $("secToast");
    if (!el) return;
    el.textContent = t;
    el.classList.remove("hidden");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.add("hidden"), 3500);
  }

  /** Hora local de Madrid de un ISO (último cambio). */
  function madridTime(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    const now = new Date();
    const fmtDay = new Intl.DateTimeFormat("es-ES", { timeZone: "Europe/Madrid", day: "2-digit", month: "2-digit" });
    const fmtTime = new Intl.DateTimeFormat("es-ES", { timeZone: "Europe/Madrid", hour: "2-digit", minute: "2-digit", hour12: false });
    const sameDay = fmtDay.format(d) === fmtDay.format(now);
    return (sameDay ? "" : fmtDay.format(d) + " ") + fmtTime.format(d);
  }

  /** Modos que se ofrecen: los del dashboard que Alarmo admite (supported_features). */
  function availableModes(alarmState, wanted) {
    const feats = parseInt((alarmState && alarmState.attributes && alarmState.attributes.supported_features) || 0, 10) || 0;
    const list = Array.isArray(wanted) && wanted.length ? wanted : Object.keys(MODE_INFO);
    return list.filter((m) => MODE_INFO[m] && (MODE_INFO[m].bit === 0 || (feats & MODE_INFO[m].bit)));
  }

  /** ¿Pide código esta acción? (code_format; al armar, code_arm_required) */
  function needsCode(service, alarmState) {
    const a = (alarmState && alarmState.attributes) || {};
    if (!a.code_format) return false;
    if (service === "alarm_disarm") return true;
    return a.code_arm_required !== false;
  }

  function wantedEntities() {
    if (!MAP) return [];
    const out = new Set();
    if (MAP.alarm && MAP.alarm.entity) out.add(MAP.alarm.entity);
    (MAP.zones || []).forEach((z) => out.add(z.entity));
    (MAP.presence || []).forEach((p) => out.add(p.entity));
    if (MAP.siren) {
      out.add(MAP.siren.entity);
      (MAP.siren.extra || []).forEach((x) => out.add(x.entity));
    }
    return [...out].filter(Boolean);
  }

  /** Estado que se muestra: el pedido (optimista) o el real de HA. */
  function shownState(eid) {
    const p = pending[eid];
    if (p && Date.now() - p.t < PENDING_MS) return p.state;
    const s = states[eid];
    return s ? s.state : undefined;
  }

  function prunePending() {
    Object.keys(pending).forEach((eid) => {
      const p = pending[eid];
      const real = states[eid] && states[eid].state;
      if (real === p.state || Date.now() - p.t >= PENDING_MS) delete pending[eid];
    });
  }

  /** ¿Administrador? Dentro de HA, el usuario de HA; fuera, lo que dice el add-on. */
  function isAdmin() {
    const hass = embeddedHass();
    if (hass && hass.user) return hass.user.is_admin === true;
    return !!(MAP && MAP.user && MAP.user.admin);
  }

  /** Llama al servicio como el usuario (dentro de HA) o al endpoint del add-on. */
  async function callControl(entity, service, extra) {
    const domain = entity.split(".", 1)[0];
    const hass = embeddedHass();
    if (hass && typeof hass.callService === "function") {
      const data = { entity_id: entity };
      if (extra && extra.option !== undefined) data.option = extra.option;
      await hass.callService(domain, service, data);
      return;
    }
    const body = { entity_id: entity, service };
    if (extra && extra.option !== undefined) body.option = extra.option;
    if (extra && extra.confirm === true) body.confirm = true;
    const r = await fetch(root() + "/api/security/control", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401 || r.status === 403) throw new Error("solo un administrador puede hacerlo");
    if (!r.ok) throw new Error(j.error || "HTTP " + r.status);
  }

  /** Aplica al momento el nuevo estado y lo deshace si la orden falla. */
  async function applyControl(entity, service, newState, label, extra) {
    const prev = pending[entity];
    pending[entity] = { state: newState, t: Date.now() };
    renderAll();
    try {
      await callControl(entity, service, extra);
    } catch (e) {
      if (prev) pending[entity] = prev;
      else delete pending[entity];
      renderAll();
      toast(`No se pudo cambiar «${label}»: ${e && e.message ? e.message : e}`);
      return false;
    }
    setTimeout(pullStates, 800);
    return true;
  }

  async function pullStates() {
    const hass = embeddedHass();
    const conn = $("secConn");
    if (hass && hass.states) {
      const next = {};
      wantedEntities().forEach((id) => { if (hass.states[id]) next[id] = hass.states[id]; });
      states = next;
      prunePending();
      if (conn) conn.classList.toggle("on", hass.connected !== false);
      if ($("secConnText")) $("secConnText").textContent = hass.connected === false ? "Desconectado" : "Conectado";
    } else {
      try {
        const r = await fetch(root() + "/api/security/state", { cache: "no-store" });
        if (!r.ok) throw new Error("HTTP " + r.status);
        const j = await r.json();
        const next = {};
        (j.states || []).forEach((s) => { if (s && s.entity_id) next[s.entity_id] = s; });
        states = next;
        prunePending();
        if (conn) conn.classList.toggle("on", !!j.ha_ws);
        if ($("secConnText")) $("secConnText").textContent = j.ha_ws ? "Conectado" : "Sin WebSocket";
      } catch (e) {
        if (conn) conn.classList.remove("on");
        if ($("secConnText")) $("secConnText").textContent = "Desconectado";
      }
    }
    renderAll();
  }

  // ---------------------------------------------------------------- Plan
  function floorCfgKey(floor) {
    const c = window.HADomoticsPlan ? window.HADomoticsPlan.configFor(floor, floors) : null;
    return c ? c.key : null;
  }

  function renderFloorSwitcher() {
    const box = $("secFloorSwitcher");
    if (!box) return;
    box.innerHTML = "";
    floors.forEach((f) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = f.name;
      b.className = "floor-btn" + (f.id === currentFloorId ? " active" : "");
      b.onclick = () => selectFloor(f.id);
      box.appendChild(b);
    });
  }

  async function selectFloor(id) {
    currentFloorId = id;
    renderFloorSwitcher();
    let floor = floorDetails[id];
    if (!floor) {
      const r = await fetch(root() + "/api/floors/" + encodeURIComponent(id), { cache: "no-store" });
      floor = r.ok ? await r.json() : null;
      if (floor) floorDetails[id] = floor;
    }
    const img = $("secFloorImage");
    const canvas = $("secCanvas");
    if (!floor || !floor.image) {
      canvas.hidden = true;
      $("secEmpty").hidden = false;
      $("secEmpty").textContent = "Esta planta no tiene imagen.";
      return;
    }
    delete img.dataset.baseWidth;
    delete img.dataset.baseHeight;
    delete img.dataset.hdApplied;
    const originalSrc = `${root()}/api/images/${floor.image}?t=${Date.now()}`;
    img.onerror = () => {
      if (img.dataset.hdApplied === "1") {
        delete img.dataset.baseWidth;
        delete img.dataset.baseHeight;
        img.dataset.hdApplied = "failed";
        img.src = originalSrc;
      }
    };
    img.onload = () => {
      if (currentFloorId !== id) return;
      if (window.HADomoticsPlan && window.HADomoticsPlan.maybeUseHd(img, floor, floors)) return;
      $("secEmpty").hidden = true;
      canvas.hidden = false;
      const w = parseFloat(img.dataset.baseWidth) || img.naturalWidth;
      const h = parseFloat(img.dataset.baseHeight) || img.naturalHeight;
      img.style.width = w + "px";
      img.style.height = h + "px";
      // El coche y el cable de carga solo van en Dispositivos.
      const old = canvas.querySelector(":scope > svg.plan-overlay");
      if (old) old.remove();
      renderPresence();
      fit();
    };
    img.src = originalSrc;
  }

  /** Recorte de bordes blancos de la planta actual (mismo que Dispositivos). */
  function currentCrop() {
    const img = $("secFloorImage");
    const floor = floorDetails[currentFloorId];
    if (!img || !floor || !window.HADomoticsPlan) return null;
    const w = parseFloat(img.dataset.baseWidth) || img.naturalWidth;
    const h = parseFloat(img.dataset.baseHeight) || img.naturalHeight;
    return w && h ? window.HADomoticsPlan.cropFor(floor, floors, w, h) : null;
  }

  // Margen libre alrededor del dibujo en edición (fracción) para soltar
  // marcadores en el fondo, fuera del plano.
  const EDIT_OUTSIDE_MARGIN = 0.12;
  let editing = false;
  let visibleRect = null;
  let drawingRect = null;
  let drag = null;

  /** Caja (px de la imagen) del icono de un marcador y la altura de su
   *  nombre; el nombre se orienta luego hacia donde haya sitio. */
  function markerBox(d, sc) {
    const x = parseFloat(d.dataset.bx) || 0, y = parseFloat(d.dataset.by) || 0;
    return { x: x - 16 / sc, y: y - 16 / sc, w: 32 / sc, h: (16 + 34) / sc };
  }

  function labelWidthPx(d) {
    const tag = d.querySelector(".tag");
    return Math.max(28, ((tag && tag.textContent.length) || 0) * 6 + 14);
  }

  /** Mismo ajuste "contain" centrado que Dispositivos (PR #19), sobre el
   *  recorte, contando también los marcadores colocados fuera del dibujo. */
  function fit() {
    const wrap = $("secCanvasWrapper");
    const canvas = $("secCanvas");
    const img = $("secFloorImage");
    if (!wrap || !canvas || !img || !img.naturalWidth || canvas.hidden) return;
    const w = parseFloat(img.dataset.baseWidth) || img.naturalWidth;
    const h = parseFloat(img.dataset.baseHeight) || img.naturalHeight;
    // Margen lateral: las cámaras exteriores quedan en el borde del dibujo.
    const margin = 18;
    const aw = wrap.clientWidth - 2 * margin, ah = wrap.clientHeight;
    if (aw <= 0 || ah <= 0) return;
    const crop = currentCrop();
    const view = crop || { x: 0, y: 0, w, h };
    img.style.clipPath = crop ? window.HADomoticsPlan.clipInset(crop) : "";
    const HP = window.HADomoticsPlan;
    const sD = Math.min(aw / view.w, ah / view.h);
    const extras = [...canvas.querySelectorAll(".presence.outside-plan")].map((d) => markerBox(d, sD));
    if (editing) {
      const m = EDIT_OUTSIDE_MARGIN;
      extras.push({ x: view.x - view.w * m, y: view.y - view.h * m, w: view.w * (1 + 2 * m), h: view.h * (1 + 2 * m) });
    }
    const f = HP && HP.computeFit
      ? HP.computeFit({ aw, ah, drawing: view, extras, minRatio: editing ? 0 : 0.85 })
      : { scale: sD, ox: (aw - view.w * sD) / 2 - view.x * sD, oy: (ah - view.h * sD) / 2 - view.y * sD };
    scale = f.scale;
    const ox = margin + f.ox;
    const oy = f.oy;
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    canvas.style.transform = `translate(${ox}px, ${oy}px) scale(${scale})`;
    canvas.style.setProperty("--sec-inv", String(Math.min(3.5, Math.max(1, 1 / scale))));
    // Plano pequeño (móvil): etiquetas más compactas.
    canvas.classList.toggle("compact", view.w * scale < 640);
    const inset = 6;
    visibleRect = {
      x: (inset - ox) / scale,
      y: (inset - oy) / scale,
      w: (wrap.clientWidth - 2 * inset) / scale,
      h: (wrap.clientHeight - 2 * inset) / scale,
    };
    drawingRect = view;
    placeMarkers();
  }

  /** Coloca los marcadores. Los de fuera del dibujo, en su zona pero siempre
   *  dentro de la parte visible (modo vista). */
  function placeMarkers() {
    const canvas = $("secCanvas");
    const HP = window.HADomoticsPlan;
    if (!canvas) return;
    canvas.querySelectorAll(".presence").forEach((d) => {
      let x = parseFloat(d.dataset.bx) || 0, y = parseFloat(d.dataset.by) || 0;
      if (d.classList.contains("outside-plan") && visibleRect) {
        if (!editing && HP && HP.clampBox) {
          const box = markerBox(d, scale);
          const c = HP.clampBox(box, visibleRect);
          x += c.x - box.x;
          y += c.y - box.y;
        }
        // El nombre crece hacia donde hay sitio en pantalla.
        const sx = (x - visibleRect.x) * scale, lw = labelWidthPx(d);
        d.classList.toggle("tag-start", sx - lw / 2 < 0);
        d.classList.toggle("tag-end", sx - lw / 2 >= 0 && sx + lw / 2 > visibleRect.w * scale);
      }
      d.style.left = x.toFixed(1) + "px";
      d.style.top = y.toFixed(1) + "px";
    });
  }

  function renderPresence() {
    const canvas = $("secCanvas");
    const img = $("secFloorImage");
    if (!canvas || !img || !MAP) return;
    canvas.querySelectorAll(".presence").forEach((e) => e.remove());
    const floor = floorDetails[currentFloorId];
    const key = floorCfgKey(floor);
    if (!key) return;
    const w = parseFloat(img.dataset.baseWidth) || img.naturalWidth;
    const h = parseFloat(img.dataset.baseHeight) || img.naturalHeight;
    const crop = currentCrop();
    const view = crop || { x: 0, y: 0, w, h };
    (MAP.presence || []).forEach((p) => {
      if (p.floor !== key || !Array.isArray(p.position)) return;
      const d = document.createElement("div");
      let px = p.position[0] * w, py = p.position[1] * h;
      // Posición por defecto: las cámaras exteriores (pegadas al borde de la
      // imagen) se dejan en el borde del dibujo recortado. Una posición
      // guardada en modo edición se respeta tal cual, también fuera del dibujo.
      if (!p.custom && window.HADomoticsPlan) {
        [px, py] = window.HADomoticsPlan.clampPoint(px, py, crop, 0);
      }
      const fx = (px - view.x) / view.w;
      const edge = fx < 0.15 ? " tag-start" : fx > 0.85 ? " tag-end" : "";
      d.className = "presence" + (p.exterior ? " exterior" : "") + (p.outside ? " outside-plan" : "") + edge;
      d.dataset.entity = p.entity;
      d.dataset.bx = px.toFixed(2);
      d.dataset.by = py.toFixed(2);
      d.style.left = px.toFixed(1) + "px";
      d.style.top = py.toFixed(1) + "px";
      d.setAttribute("role", "img");
      d.innerHTML = `<span class="dot" aria-hidden="true"><span class="material-icons">${p.exterior ? "videocam" : "directions_run"}</span></span><span class="tag" aria-hidden="true">${esc(p.name)}</span>`;
      d.addEventListener("pointerdown", (e) => startDrag(e, d));
      canvas.appendChild(d);
    });
    renderEditOutline(view);
    updatePresence();
  }

  // ---------------------------------------------------------------- Edición
  /** Contorno discontinuo del dibujo en edición: fuera de él queda el fondo. */
  function renderEditOutline(view) {
    const canvas = $("secCanvas");
    if (!canvas) return;
    canvas.querySelectorAll(":scope > .plan-drawing-outline").forEach((e) => e.remove());
    if (!editing || !view) return;
    const o = document.createElement("div");
    o.className = "plan-drawing-outline";
    o.style.left = view.x + "px";
    o.style.top = view.y + "px";
    o.style.width = view.w + "px";
    o.style.height = view.h + "px";
    canvas.appendChild(o);
  }

  function setEditing(on) {
    editing = !!on;
    const app = $("appSeguridad");
    if (app) app.classList.toggle("sec-editing", editing);
    const btn = $("secEditBtn");
    if (btn) {
      btn.classList.toggle("active", editing);
      btn.setAttribute("aria-pressed", editing ? "true" : "false");
      btn.title = editing ? "Terminar de mover elementos" : "Mover elementos";
      btn.setAttribute("aria-label", btn.title);
      const icon = btn.querySelector(".material-icons");
      if (icon) icon.textContent = editing ? "check" : "edit";
    }
    if (editing) {
      Object.keys(POPS).forEach((n) => setPopOpen(n, false));
      toast("Modo edición: arrastra sensores y cámaras. Se guardan al soltar; fuera de la línea quedan en el fondo.");
    }
    renderPresence();
    fit();
  }

  function startDrag(e, d) {
    if (!editing || (e.button !== undefined && e.button !== 0)) return;
    e.preventDefault();
    e.stopPropagation();
    drag = {
      d,
      startX: e.clientX,
      startY: e.clientY,
      ox: parseFloat(d.dataset.bx) || 0,
      oy: parseFloat(d.dataset.by) || 0,
      moved: false,
    };
    d.classList.add("dragging");
    try { d.setPointerCapture(e.pointerId); } catch (err) { /* sin captura */ }
    d.onpointermove = (ev) => {
      if (!drag) return;
      const dx = (ev.clientX - drag.startX) / scale, dy = (ev.clientY - drag.startY) / scale;
      if (Math.abs(ev.clientX - drag.startX) > 2 || Math.abs(ev.clientY - drag.startY) > 2) drag.moved = true;
      d.dataset.bx = (drag.ox + dx).toFixed(2);
      d.dataset.by = (drag.oy + dy).toFixed(2);
      d.style.left = d.dataset.bx + "px";
      d.style.top = d.dataset.by + "px";
    };
    d.onpointerup = d.onpointercancel = () => endDrag(d);
  }

  /** Fracción de la imagen y si queda fuera del dibujo, para guardar. */
  function dropRecord(px, py, w, h, drawing) {
    const outside = !!drawing && (px < drawing.x || py < drawing.y || px > drawing.x + drawing.w || py > drawing.y + drawing.h);
    return { x: Math.round((px / w) * 1e5) / 1e5, y: Math.round((py / h) * 1e5) / 1e5, outside };
  }

  async function endDrag(d) {
    const st = drag;
    drag = null;
    d.onpointermove = d.onpointerup = d.onpointercancel = null;
    d.classList.remove("dragging");
    if (!st || !st.moved) return;
    const img = $("secFloorImage");
    const w = parseFloat(img.dataset.baseWidth) || img.naturalWidth;
    const h = parseFloat(img.dataset.baseHeight) || img.naturalHeight;
    let px = parseFloat(d.dataset.bx) || 0, py = parseFloat(d.dataset.by) || 0;
    // Nunca fuera de la pantalla.
    if (visibleRect) {
      px = Math.min(Math.max(px, visibleRect.x + 14 / scale), visibleRect.x + visibleRect.w - 14 / scale);
      py = Math.min(Math.max(py, visibleRect.y + 14 / scale), visibleRect.y + visibleRect.h - 30 / scale);
    }
    const rec = dropRecord(px, py, w, h, drawingRect);
    const p = (MAP.presence || []).find((x) => x.entity === d.dataset.entity);
    const key = floorCfgKey(floorDetails[currentFloorId]);
    if (!p || !key) return;
    const before = { floor: p.floor, position: p.position, outside: p.outside, custom: p.custom };
    Object.assign(p, { floor: key, position: [rec.x, rec.y], outside: rec.outside, custom: true });
    renderPresence();
    fit();
    try {
      const r = await fetch(root() + "/api/security/positions", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entity_id: p.entity, floor: key, x: rec.x, y: rec.y, outside: rec.outside }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(r.status === 403 ? "Solo un administrador puede mover elementos" : (j.error || "HTTP " + r.status));
      }
      toast(rec.outside ? `${p.name}: guardado fuera del plano` : `${p.name}: posición guardada`);
    } catch (err) {
      Object.assign(p, before);
      renderPresence();
      fit();
      toast("No se pudo guardar: " + (err && err.message ? err.message : err));
    }
  }

  /** Estado de un sensor/cámara de presencia: "on" (detección), "off" (sin
   *  detección) o "na" (no disponible / sin datos). */
  function presenceState(s) {
    if (!s || s.state === "unavailable" || s.state === "unknown") return "na";
    return s.state === "on" ? "on" : "off";
  }
  const PRESENCE_LABEL = { on: "Detección", off: "Sin detección", na: "No disponible" };

  /** Texto completo (aria-label / title / desplegable): nombre, estado y hora. */
  function presenceText(p, s) {
    const st = presenceState(s);
    const t = st === "na" ? "" : madridTime(s && s.last_changed);
    return `${p.name}: ${PRESENCE_LABEL[st]}${t ? " · " + t : ""}`;
  }

  /** En el plano solo el nombre; el estado es el color del icono. */
  function updatePresence() {
    const canvas = $("secCanvas");
    if (!canvas || !MAP) return;
    canvas.querySelectorAll(".presence").forEach((d) => {
      const p = (MAP.presence || []).find((x) => x.entity === d.dataset.entity);
      const st = presenceState(states[d.dataset.entity]);
      d.classList.toggle("on", st === "on");
      d.classList.toggle("off", st === "off");
      d.classList.toggle("unavailable", st === "na");
      const full = p ? presenceText(p, states[d.dataset.entity]) : "";
      d.title = full;
      d.setAttribute("aria-label", full);
    });
  }

  function detectionCounts() {
    const list = (MAP && MAP.presence) || [];
    const on = list.filter((p) => presenceState(states[p.entity]) === "on").length;
    return { on, total: list.length };
  }

  const FLOOR_LABEL = { planta_baja: "Planta baja", planta_1: "Planta 1" };

  function renderDetections() {
    const c = detectionCounts();
    const badge = $("secDetBadge");
    if (badge) badge.textContent = c.on ? String(c.on) : "";
    const btn = $("secDetBtn");
    if (btn) btn.classList.toggle("alert", c.on > 0);
    const sub = $("secDetSub");
    if (sub) sub.textContent = c.on === 1 ? "1 detección activa" : `${c.on} detecciones activas`;
    const box = $("secDetList");
    if (!box || !MAP || $("secDetPop").classList.contains("hidden")) return;
    const groups = {};
    (MAP.presence || []).forEach((p) => { (groups[p.floor] = groups[p.floor] || []).push(p); });
    // Primero la planta que se está viendo.
    const curKey = floorCfgKey(floorDetails[currentFloorId]);
    const order = Object.keys(groups).sort((a, b) => (b === curKey) - (a === curKey));
    const html = order.map((fl) => `
      <div class="det-floor">${esc(FLOOR_LABEL[fl] || fl)}</div>
      <ul class="det-list">${groups[fl].map((p) => {
        const s = states[p.entity];
        const st = presenceState(s);
        const t = st === "na" ? "—" : madridTime(s && s.last_changed);
        return `<li class="det-item ${st}" title="${esc(p.entity)}">
          <span class="det-dot" aria-hidden="true"><span class="material-icons">${p.exterior ? "videocam" : "directions_run"}</span></span>
          <span class="det-name">${esc(p.name)}</span>
          <span class="det-state">${esc(PRESENCE_LABEL[st])}</span>
          <span class="det-time">${esc(t)}</span>
        </li>`;
      }).join("")}</ul>`).join("");
    if (box.innerHTML !== html && box.dataset.sig !== html) { box.innerHTML = html; box.dataset.sig = html; }
  }

  // ---------------------------------------------------------------- Panels
  function renderAlarm() {
    if (!MAP || !MAP.alarm) return;
    const s = states[MAP.alarm.entity];
    const st = s ? s.state : "unavailable";
    const box = $("secAlarmState");
    box.textContent = STATE_TEXT[st] || st;
    box.className = "sec-alarm-state " + (st === "disarmed" ? "disarmed" : st === "triggered" ? "triggered" : /^armed/.test(st) ? "armed" : "pending");
    const a = (s && s.attributes) || {};
    const meta = [];
    if (a.changed_by) meta.push("por " + a.changed_by);
    if (s && s.last_changed) meta.push(madridTime(s.last_changed));
    if (a.code_format) meta.push("pide código");
    const open = a.open_sensors && typeof a.open_sensors === "object" ? Object.keys(a.open_sensors).length : 0;
    if (open) meta.push(open === 1 ? "1 sensor abierto" : `${open} sensores abiertos`);
    $("secAlarmMeta").textContent = meta.join(" · ");
    const modes = availableModes(s, MAP.alarm.modes);
    const wrap = $("secModes");
    const sig = modes.join(",") + "|" + st;
    if (wrap.dataset.sig !== sig) {
      wrap.dataset.sig = sig;
      wrap.innerHTML = "";
      modes.forEach((m) => {
        const info = MODE_INFO[m];
        const b = document.createElement("button");
        b.type = "button";
        b.dataset.mode = m;
        b.className = st === m ? "active" : "";
        b.innerHTML = `<span class="material-icons">${info.icon}</span>${esc(info.label)}`;
        b.onclick = () => requestMode(m);
        wrap.appendChild(b);
      });
    }
  }

  function zoneCounts() {
    const zones = (MAP && MAP.zones) || [];
    const on = zones.filter((z) => shownState(z.entity) === "on").length;
    return { on, total: zones.length };
  }

  /** Zonas: cada fila es un interruptor de su input_boolean (como el glance). */
  function renderZones() {
    const box = $("secZones");
    if (!box || !MAP) return;
    const zones = MAP.zones || [];
    if (box.childElementCount !== zones.length) {
      box.innerHTML = zones.map((z) =>
        `<button type="button" class="zone" role="switch" aria-checked="false" data-entity="${esc(z.entity)}" title="${esc(z.entity)}">` +
        `<span class="material-icons">notifications_off</span><span class="zone-name">${esc(z.name)}</span>` +
        `<span class="sec-switch" aria-hidden="true"><span></span></span></button>`
      ).join("");
      if (!box.dataset.bound) {
        box.dataset.bound = "1";
        box.addEventListener("click", (e) => {
          const b = e.target.closest && e.target.closest("button.zone");
          if (b && !b.disabled) toggleZone(b.dataset.entity);
        });
      }
    }
    zones.forEach((z, i) => {
      const b = box.children[i];
      if (!b) return;
      const st = shownState(z.entity);
      const on = st === "on";
      const na = st === undefined || st === "unavailable" || st === "unknown";
      b.classList.toggle("on", on);
      b.classList.toggle("na", na);
      b.classList.toggle("pending", !!pending[z.entity]);
      b.disabled = na;
      b.setAttribute("aria-checked", on ? "true" : "false");
      b.setAttribute("aria-label", `${z.name}: ${na ? "no disponible" : on ? "activa" : "desactivada"}`);
      b.querySelector(".material-icons").textContent = on ? "notifications_active" : "notifications_off";
    });
    const c = zoneCounts();
    const badge = $("secZonesBadge");
    if (badge) badge.textContent = c.total ? `${c.on}/${c.total}` : "";
    const sub = $("secZonesSub");
    if (sub) sub.textContent = c.total ? `${c.on} de ${c.total} activas` : "";
  }

  function toggleZone(entity) {
    const z = ((MAP && MAP.zones) || []).find((x) => x.entity === entity);
    if (!z) return;
    const on = shownState(entity) === "on";
    return applyControl(entity, on ? "turn_off" : "turn_on", on ? "off" : "on", z.name);
  }

  // ---------------------------------------------------------------- Sirena
  // Lo mismo que la pestaña «Sirena» de Lovelace, que allí solo ven dos
  // usuarios: aquí solo se muestra a administradores (y el add-on solo deja
  // escribir a administradores).
  function sirenEntities() {
    const s = (MAP && MAP.siren) || {};
    const extra = s.extra || [];
    const by = (re) => (extra.find((x) => re.test(x.entity || "")) || {});
    return {
      siren: s.entity,
      enable: by(/^input_boolean\./),
      tone: by(/^select\..*tono/),
      level: by(/^select\..*nivel/),
    };
  }

  function renderSirenButton() {
    const btn = $("secSirenBtn");
    if (!btn) return;
    const show = !!(MAP && MAP.siren && MAP.siren.entity) && isAdmin();
    btn.hidden = !show;
    if (!show && isOpen("sirena")) setPopOpen("sirena", false);
    const badge = $("secSirenBadge");
    if (badge) badge.textContent = show && shownState(MAP.siren.entity) === "on" ? "ON" : "";
    btn.classList.toggle("alert", show && shownState(MAP.siren.entity) === "on");
  }

  function renderSiren() {
    renderSirenButton();
    const box = $("secSiren");
    if (!box || !MAP || !MAP.siren || $("secSirenPop").classList.contains("hidden")) return;
    const e = sirenEntities();
    if (!box.dataset.built) {
      box.dataset.built = "1";
      box.innerHTML =
        `<button type="button" class="siren-row siren-enable" role="switch" aria-checked="false" id="secSirenEnable">` +
        `<span class="material-icons">notifications_active</span><span class="siren-label">${esc(e.enable.name || "Sirena con la alarma")}` +
        `<small>Si está activada, la sirena suena cuando se dispara la alarma.</small></span>` +
        `<span class="sec-switch" aria-hidden="true"><span></span></span></button>` +
        `<label class="siren-row"><span class="material-icons">music_note</span><span class="siren-label">${esc(e.tone.name || "Tono")}</span>` +
        `<select id="secSirenTone" data-entity="${esc(e.tone.entity || "")}"></select></label>` +
        `<label class="siren-row"><span class="material-icons">volume_up</span><span class="siren-label">${esc(e.level.name || "Nivel")}</span>` +
        `<select id="secSirenLevel" data-entity="${esc(e.level.entity || "")}"></select></label>` +
        `<div class="siren-test"><div class="siren-state" id="secSirenState"></div>` +
        `<button type="button" class="siren-test-btn" id="secSirenTest"><span class="material-icons">campaign</span><span>Probar sirena</span></button></div>` +
        `<p class="siren-note">«Probar sirena» hace sonar la sirena real (pide confirmación). Solo administradores.</p>`;
      $("secSirenEnable").addEventListener("click", () => {
        const on = shownState(e.enable.entity) === "on";
        applyControl(e.enable.entity, on ? "turn_off" : "turn_on", on ? "off" : "on", e.enable.name || "Sirena con la alarma");
      });
      [["secSirenTone", e.tone], ["secSirenLevel", e.level]].forEach(([id, ent]) => {
        $(id).addEventListener("change", (ev) => {
          const v = ev.target.value;
          applyControl(ent.entity, "select_option", v, ent.name || id, { option: v });
        });
      });
      $("secSirenTest").addEventListener("click", () => testSiren());
    }
    // Interruptor «Sirena con la alarma»
    const en = $("secSirenEnable");
    const enSt = shownState(e.enable.entity);
    const enOn = enSt === "on";
    en.classList.toggle("on", enOn);
    en.classList.toggle("pending", !!pending[e.enable.entity]);
    en.disabled = enSt === undefined || enSt === "unavailable";
    en.setAttribute("aria-checked", enOn ? "true" : "false");
    // Tono y nivel: opciones de la propia entidad select
    [["secSirenTone", e.tone], ["secSirenLevel", e.level]].forEach(([id, ent]) => {
      const sel = $(id);
      const st = states[ent.entity];
      const opts = (st && st.attributes && Array.isArray(st.attributes.options)) ? st.attributes.options : [];
      const key = opts.join("|");
      if (sel.dataset.opts !== key) {
        sel.dataset.opts = key;
        sel.innerHTML = opts.map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join("");
      }
      const cur = shownState(ent.entity);
      if (document.activeElement !== sel && cur !== undefined) sel.value = cur;
      sel.disabled = !opts.length;
    });
    // Probar / parar
    const sirenOn = shownState(e.siren) === "on";
    const sirenSt = shownState(e.siren);
    $("secSirenState").textContent = sirenSt === undefined ? "Sirena: sin datos"
      : sirenOn ? "Sirena: SONANDO" : sirenSt === "unavailable" ? "Sirena: no disponible" : "Sirena: apagada";
    $("secSirenState").classList.toggle("on", sirenOn);
    const test = $("secSirenTest");
    test.classList.toggle("stop", sirenOn);
    test.querySelector("span:last-child").textContent = sirenOn ? "Parar sirena" : "Probar sirena";
    test.querySelector(".material-icons").textContent = sirenOn ? "volume_off" : "campaign";
    test.disabled = sirenSt === undefined || sirenSt === "unavailable";
    const sub = $("secSirenSub");
    if (sub) sub.textContent = enOn ? "Suena con la alarma" : "No suena con la alarma";
  }

  /** «Probar sirena»: lo mismo que el interruptor de Lovelace (siren.turn_on
   *  solo con entity_id), siempre tras confirmar. «Parar sirena»: siren.turn_off. */
  async function testSiren() {
    const e = sirenEntities();
    if (!e.siren) return false;
    if (shownState(e.siren) === "on") return applyControl(e.siren, "turn_off", "off", "Sirena");
    const res = await confirmDlg(SIREN_TEST_TEXT, false);
    if (!res.ok) return false;
    return applyControl(e.siren, "turn_on", "on", "Sirena", { confirm: true });
  }

  // ------------------------------------- Zonas / Detecciones (desplegables)
  // Solo uno abierto a la vez. Se cierran con la X, Esc, un clic fuera o
  // volviendo a pulsar su botón.
  const POPS = {
    zonas: { pop: "secZonesPop", btn: "secZonesBtn", close: "secZonesClose", render: () => renderZones() },
    detecciones: { pop: "secDetPop", btn: "secDetBtn", close: "secDetClose", render: () => renderDetections() },
    sirena: { pop: "secSirenPop", btn: "secSirenBtn", close: "secSirenClose", render: () => renderSiren() },
  };

  function isOpen(name) {
    const pop = $(POPS[name].pop);
    return !!pop && !pop.classList.contains("hidden");
  }

  function setPopOpen(name, open) {
    const cfg = POPS[name];
    const pop = cfg && $(cfg.pop);
    const btn = cfg && $(cfg.btn);
    if (!pop || !btn) return;
    if (open) Object.keys(POPS).forEach((other) => { if (other !== name) setPopOpen(other, false); });
    if (open) {
      // Justo debajo del panel de alarma y sus botones, mida lo que mida.
      const bar = document.querySelector("#appSeguridad .sec-alarm-bar");
      const bottom = bar ? bar.getBoundingClientRect().bottom : 0;
      if (bottom > 0) pop.style.paddingTop = Math.round(bottom + 8) + "px";
    }
    pop.classList.toggle("hidden", !open);
    btn.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) {
      cfg.render();
      const close = $(cfg.close);
      if (close) setTimeout(() => close.focus(), 0);
    } else if (document.activeElement && pop.contains(document.activeElement)) {
      btn.focus();
    }
  }

  function setZonesOpen(open) { setPopOpen("zonas", open); }
  function setDetectionsOpen(open) { setPopOpen("detecciones", open); }

  function bindPops() {
    if (bindPops.done) return;
    let any = false;
    Object.keys(POPS).forEach((name) => {
      const cfg = POPS[name];
      const btn = $(cfg.btn), pop = $(cfg.pop), close = $(cfg.close);
      if (!btn || !pop) return;
      any = true;
      btn.addEventListener("click", (e) => { e.stopPropagation(); setPopOpen(name, !isOpen(name)); });
      if (close) close.addEventListener("click", () => setPopOpen(name, false));
    });
    if (!any) return;
    bindPops.done = true;
    // Clic fuera de la tarjeta abierta (y de los botones) la cierra.
    document.addEventListener("click", (e) => {
      Object.keys(POPS).forEach((name) => {
        if (!isOpen(name)) return;
        const card = $(POPS[name].pop).querySelector(".sec-pop-card");
        if (card && card.contains(e.target)) return;
        const sheet = $("secConfirm");
        if (sheet && sheet.contains(e.target)) return; // diálogo de confirmación encima
        setPopOpen(name, false);
      });
    });
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if ($("secConfirm") && !$("secConfirm").classList.contains("hidden")) return;
      Object.keys(POPS).forEach((name) => { if (isOpen(name)) setPopOpen(name, false); });
    });
  }

  function renderAll() {
    renderAlarm();
    renderZones();
    updatePresence();
    renderDetections();
    renderSiren();
  }

  // ---------------------------------------------------------------- Actions
  function confirmDlg(text, askCode) {
    return new Promise((resolve) => {
      const sheet = $("secConfirm");
      const code = $("secCode");
      $("secConfirmText").textContent = text;
      $("secCodeRow").classList.toggle("hidden", !askCode);
      code.value = "";
      sheet.classList.remove("hidden");
      if (askCode) setTimeout(() => code.focus(), 30);
      const done = (ok) => {
        const value = code.value;
        code.value = ""; // el código no se conserva
        sheet.classList.add("hidden");
        resolve(ok ? { ok: true, code: value } : { ok: false });
      };
      $("secConfirmYes").onclick = () => {
        if (askCode && !code.value) { code.focus(); return; }
        done(true);
      };
      $("secConfirmNo").onclick = () => done(false);
    });
  }

  async function requestMode(mode) {
    const info = MODE_INFO[mode];
    if (!info || !MAP || !MAP.alarm) return;
    const entity = MAP.alarm.entity;
    const s = states[entity];
    const askCode = needsCode(info.service, s);
    const text = mode === "disarmed" ? "¿Desarmar la alarma?" : `¿Armar la alarma en modo «${info.label}»?`;
    const res = await confirmDlg(text, askCode);
    if (!res.ok) return;
    const data = { entity_id: entity };
    if (res.code) data.code = res.code;
    try {
      const hass = embeddedHass();
      if (hass && typeof hass.callService === "function") {
        await hass.callService("alarm_control_panel", info.service, data);
      } else {
        const r = await fetch(root() + "/api/security/alarm", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ entity_id: entity, service: info.service, code: res.code || undefined }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || "HTTP " + r.status);
      }
      toast(mode === "disarmed" ? "Desarmando la alarma…" : `Armando: ${info.label}`);
      setTimeout(pullStates, 800);
    } catch (e) {
      toast("Error: " + (e && e.message ? e.message : e));
    }
  }

  // ---------------------------------------------------------------- Start
  async function start() {
    if (startPromise) return startPromise;
    startPromise = (async () => {
      bindPops();
      const eb = $("secEditBtn");
      if (eb && !eb.dataset.bound) {
        eb.dataset.bound = "1";
        eb.addEventListener("click", (e) => { e.stopPropagation(); setEditing(!editing); });
      }
      if (window.HADomoticsPlan) await window.HADomoticsPlan.load();
      const r = await fetch(root() + "/api/security/map", { cache: "no-store" });
      if (!r.ok) { $("secEmpty").textContent = "No se pudo cargar la configuración de Seguridad."; return; }
      MAP = await r.json();
      const fr = await fetch(root() + "/api/floors", { cache: "no-store" });
      floors = fr.ok ? await fr.json() : [];
      floors.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      renderFloorSwitcher();
      await pullStates();
      if (floors.length) await selectFloor(floors[0].id);
      else $("secEmpty").textContent = "No hay plantas en Dispositivos.";
      pollTimer = setInterval(pullStates, embeddedHass() ? 1000 : 3000);
      const wrap = $("secCanvasWrapper");
      if (window.ResizeObserver && wrap) new ResizeObserver(() => requestAnimationFrame(fit)).observe(wrap);
      window.addEventListener("resize", () => requestAnimationFrame(fit));
      window.addEventListener("orientationchange", () => setTimeout(fit, 250));
      started = true;
    })();
    return startPromise;
  }

  window.HADomoticsSecurity = {
    ensureStarted() { start().then(() => fit()); },
    availableModes,
    needsCode,
    madridTime,
    presenceText,
    presenceState,
    setZonesOpen,
    setDetectionsOpen,
    setSirenOpen(open) { setPopOpen("sirena", open); },
    setEditing,
    shownState,
    toggleZone,
    testSiren,
    applyControl,
    isAdmin,
    SIREN_TEST_TEXT,
    _setMap(m) { MAP = m; },
    _setStates(s) { states = s; },
    get pending() { return pending; },
    dropRecord,
    get editing() { return editing; },
    get started() { return started; },
    get states() { return states; },
  };
})();
