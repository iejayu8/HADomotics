/* HADomotics Seguridad — alarma Alarmo, zonas y presencia en los planos.
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
    return [...out].filter(Boolean);
  }

  async function pullStates() {
    const hass = embeddedHass();
    const conn = $("secConn");
    if (hass && hass.states) {
      const next = {};
      wantedEntities().forEach((id) => { if (hass.states[id]) next[id] = hass.states[id]; });
      states = next;
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

  /** Mismo ajuste "contain" centrado que Dispositivos (PR #19), sobre el recorte. */
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
    scale = Math.min(aw / view.w, ah / view.h);
    const ox = margin + Math.max(0, (aw - view.w * scale) / 2) - view.x * scale;
    const oy = Math.max(0, (ah - view.h * scale) / 2) - view.y * scale;
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    canvas.style.transform = `translate(${ox}px, ${oy}px) scale(${scale})`;
    canvas.style.setProperty("--sec-inv", String(Math.min(3.5, Math.max(1, 1 / scale))));
    // Plano pequeño (móvil): solo se rotulan los sensores con persona; el resto, en la lista.
    canvas.classList.toggle("compact", view.w * scale < 640);
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
      // Las cámaras exteriores (pegadas al borde de la imagen) se dejan en el
      // borde del dibujo recortado.
      const [px, py] = window.HADomoticsPlan
        ? window.HADomoticsPlan.clampPoint(p.position[0] * w, p.position[1] * h, crop, 0)
        : [p.position[0] * w, p.position[1] * h];
      const fx = (px - view.x) / view.w;
      const edge = fx < 0.15 ? " tag-start" : fx > 0.85 ? " tag-end" : "";
      d.className = "presence" + (p.exterior ? " exterior" : "") + edge;
      d.dataset.entity = p.entity;
      d.style.left = px.toFixed(1) + "px";
      d.style.top = py.toFixed(1) + "px";
      d.innerHTML = `<span class="dot"><span class="material-icons">${p.exterior ? "videocam" : "directions_run"}</span></span><span class="tag"></span>`;
      canvas.appendChild(d);
    });
    updatePresence();
  }

  function presenceText(p, s) {
    if (!s) return `${p.name}: sin datos`;
    if (s.state === "unavailable" || s.state === "unknown") return `${p.name}: no disponible`;
    const on = s.state === "on";
    return `${p.name}: ${on ? "PERSONA" : "libre"} · ${madridTime(s.last_changed)}`;
  }

  function updatePresence() {
    const canvas = $("secCanvas");
    if (!canvas || !MAP) return;
    canvas.querySelectorAll(".presence").forEach((d) => {
      const p = (MAP.presence || []).find((x) => x.entity === d.dataset.entity);
      const s = states[d.dataset.entity];
      d.classList.toggle("on", !!s && s.state === "on");
      d.classList.toggle("unavailable", !s || s.state === "unavailable" || s.state === "unknown");
      const tag = d.querySelector(".tag");
      if (tag && p) tag.textContent = presenceText(p, s).replace(/^[^:]+: /, p.name + " · ");
      d.title = p ? presenceText(p, s) : "";
    });
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
    const on = zones.filter((z) => states[z.entity] && states[z.entity].state === "on").length;
    return { on, total: zones.length };
  }

  function renderZones() {
    const box = $("secZones");
    if (!box || !MAP) return;
    box.innerHTML = (MAP.zones || []).map((z) => {
      const s = states[z.entity];
      const on = s && s.state === "on";
      const na = !s || s.state === "unavailable";
      return `<div class="zone${on ? " on" : ""}" title="${esc(z.entity)}"><span class="material-icons">${on ? "notifications_active" : "notifications_off"}</span>${esc(z.name)}${na ? " (n/d)" : ""}</div>`;
    }).join("");
    const c = zoneCounts();
    const badge = $("secZonesBadge");
    if (badge) badge.textContent = c.total ? `${c.on}/${c.total}` : "";
    const sub = $("secZonesSub");
    if (sub) sub.textContent = c.total ? `${c.on} de ${c.total} activas` : "";
  }

  // ------------------------------------------------------- Zonas (superpuesto)
  function setZonesOpen(open) {
    const pop = $("secZonesPop");
    const btn = $("secZonesBtn");
    if (!pop || !btn) return;
    pop.classList.toggle("hidden", !open);
    btn.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) {
      renderZones();
      const close = $("secZonesClose");
      if (close) setTimeout(() => close.focus(), 0);
    } else if (document.activeElement && pop.contains(document.activeElement)) {
      btn.focus();
    }
  }

  function bindZones() {
    const btn = $("secZonesBtn");
    const pop = $("secZonesPop");
    if (!btn || !pop || btn.dataset.bound) return;
    btn.dataset.bound = "1";
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      setZonesOpen(pop.classList.contains("hidden"));
    });
    $("secZonesClose").addEventListener("click", () => setZonesOpen(false));
    // Clic fuera de la tarjeta (en el fondo) la cierra.
    pop.addEventListener("click", (e) => { if (e.target === pop) setZonesOpen(false); });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !pop.classList.contains("hidden")) setZonesOpen(false);
    });
  }

  function renderAll() {
    renderAlarm();
    renderZones();
    updatePresence();
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
      bindZones();
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
    setZonesOpen,
    get started() { return started; },
    get states() { return states; },
  };
})();
