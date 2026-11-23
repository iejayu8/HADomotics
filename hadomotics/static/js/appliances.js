/* HADomotics — electrodomésticos en el plano de Dispositivos.
 *
 * - Los aparatos y sus entidades vienen de appliances_map.json
 *   (GET /api/appliances/map, con las posiciones movidas ya aplicadas).
 * - Cada aparato es un icono en su sitio del plano (fracciones de la imagen
 *   de la planta, como la presencia de Seguridad). En modo vista, al pulsarlo
 *   se abre su ventana con el estado y las acciones principales; en modo
 *   edición se arrastra y se guarda la posición (PUT /api/appliances/positions).
 * - Las acciones llaman a servicios reales de Home Assistant con la misma
 *   función que los demás controles (callAddonOrHass: hass.callService como el
 *   usuario dentro de HA). Nada se ejecuta sin que el usuario pulse.
 */
"use strict";

(function () {
  let mapData = { appliances: [], labels: {} };
  let loadPromise = null;
  let states = {};
  let openId = null;
  let ctx = { call: null, save: null, toast: null, confirm: null };
  const busy = new Set();
  const errors = {};

  const ICONS = {
    fridge:
      '<rect x="6" y="2.5" width="12" height="19" rx="2"/><line x1="6" y1="9.5" x2="18" y2="9.5"/>' +
      '<line x1="9" y1="5" x2="9" y2="7.5"/><line x1="9" y1="12" x2="9" y2="16"/>',
    dishwasher:
      '<rect x="4" y="3" width="16" height="18" rx="2"/><line x1="4" y1="7.5" x2="20" y2="7.5"/>' +
      '<circle cx="7.5" cy="5.25" r=".7"/><circle cx="10.5" cy="5.25" r=".7"/>' +
      '<path d="M8 12.5c1.2-1 2.8-1 4 0s2.8 1 4 0"/><path d="M8 16.5c1.2-1 2.8-1 4 0s2.8 1 4 0"/>',
    vacuum:
      '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.2"/>' +
      '<path d="M5.6 7.6a8 8 0 0 1 12.8 0"/><circle cx="12" cy="5.4" r=".8"/>',
  };

  function iconSvg(kind) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICONS[kind] || ICONS.fridge) + "</svg>";
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function panelRoot() {
    if (window.HADomotics && typeof window.HADomotics.panelRoot === "function") return window.HADomotics.panelRoot();
    return window.location.pathname.replace(/\/+$/, "");
  }

  function load(force) {
    if (!loadPromise || force) {
      loadPromise = fetch(panelRoot() + "/api/appliances/map", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : { appliances: [] }))
        .catch(() => ({ appliances: [] }))
        .then((j) => {
          mapData = j && Array.isArray(j.appliances) ? j : { appliances: [], labels: {} };
          return mapData;
        });
    }
    return loadPromise;
  }

  function setMap(m) { mapData = m && Array.isArray(m.appliances) ? m : { appliances: [], labels: {} }; }
  function byId(id) { return mapData.appliances.find((a) => a.id === id) || null; }
  function st(eid) { return (eid && states && states[eid]) || null; }
  function isMissing(v) { return v == null || v === "" || v === "unavailable" || v === "unknown"; }

  function labelsFor(item) {
    const l = item && item.labels;
    if (!l) return null;
    if (typeof l === "string") return (mapData.labels || {})[l] || null;
    return l;
  }

  function rawValue(item) {
    const s = st(item.entity);
    if (!s) return null;
    if (item.attribute) return s.attributes ? s.attributes[item.attribute] : null;
    return s.state;
  }

  function fmtNumber(v) {
    const n = Number(v);
    if (!isFinite(n)) return String(v);
    return Math.abs(n - Math.round(n)) < 0.05 ? String(Math.round(n)) : n.toFixed(1).replace(".", ",");
  }

  function remaining(iso, now) {
    const t = Date.parse(iso);
    if (!isFinite(t)) return null;
    const min = Math.round((t - (now || Date.now())) / 60000);
    if (min <= 0) return null;
    const h = Math.floor(min / 60), m = min % 60;
    const left = h ? `${h} h ${String(m).padStart(2, "0")} min` : `${m} min`;
    let at = "";
    try {
      at = new Date(t).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
    } catch (e) { at = ""; }
    return at ? `${left} (fin ${at})` : left;
  }

  /** Texto legible de un valor (estado o atributo) según el formato del mapa. */
  function formatValue(item, now) {
    const v = rawValue(item);
    if (v == null || v === "unavailable") return "No disponible";
    if (v === "unknown" || v === "") {
      const l = labelsFor(item);
      return l && l.unknown ? l.unknown : "—";
    }
    const s = st(item.entity);
    const unit = (s && s.attributes && s.attributes.unit_of_measurement) || "";
    if (item.format === "temp") return `${fmtNumber(v)} ${unit || "°C"}`;
    if (item.format === "value") return unit ? `${fmtNumber(v)} ${unit}` : fmtNumber(v);
    if (item.format === "remaining") return remaining(v, now) || "—";
    const l = labelsFor(item);
    if (l && Object.prototype.hasOwnProperty.call(l, v)) return l[v];
    return String(v);
  }

  function badgeText(a, now) {
    return (a.badge || [])
      .map((b) => {
        const v = rawValue(b);
        if (isMissing(v)) return "";
        if (b.format === "remaining") return remaining(v, now) ? remaining(v, now).replace(/ \(fin .*\)$/, "") : "";
        return formatValue(b, now);
      })
      .filter(Boolean)
      .join(" · ");
  }

  function alertMatches(rule) {
    const s = st(rule.entity);
    if (!s) return false;
    if (Array.isArray(rule.when)) return rule.when.includes(s.state);
    if (Array.isArray(rule.not)) return !rule.not.includes(s.state);
    return false;
  }

  function activeAlerts(a) { return (a.alerts || []).filter(alertMatches).map((r) => r.text); }

  function isRunning(a) {
    const r = a.running;
    const s = r && st(r.entity);
    return !!(s && (r.when || []).includes(s.state));
  }

  function isUnavailable(a) {
    const s = st(a.main);
    return !s || s.state === "unavailable";
  }

  /** ¿Se puede pulsar la acción ahora? Devuelve { ok, reason }. */
  function actionState(act) {
    const target = st(act.entity);
    if (!target || target.state === "unavailable") return { ok: false, reason: "No disponible" };
    for (const c of act.enabled_when || []) {
      const s = st(c.entity);
      if (!s || !(c.in || []).includes(s.state)) return { ok: false, reason: "" };
    }
    if (act.option_from) {
      const src = st(act.option_from);
      const opts = (target.attributes && target.attributes.options) || [];
      if (!src || isMissing(src.state) || !opts.includes(src.state)) return { ok: false, reason: "Elige un programa" };
    }
    return { ok: true, reason: "" };
  }

  /** (dominio, servicio, datos) que manda una acción del mapa. */
  function buildActionCall(act) {
    const data = { entity_id: act.entity };
    if (act.option_from) {
      const src = st(act.option_from);
      data.option = src ? src.state : null;
    }
    return { domain: act.domain, service: act.service, data };
  }

  function buildControlCall(ctrl, value) {
    if (ctrl.type === "switch") {
      return { domain: "switch", service: value ? "turn_on" : "turn_off", data: { entity_id: ctrl.entity } };
    }
    if (ctrl.type === "number") {
      return { domain: "number", service: "set_value", data: { entity_id: ctrl.entity, value } };
    }
    if (ctrl.type === "select") {
      return { domain: "select", service: "select_option", data: { entity_id: ctrl.entity, option: value } };
    }
    if (ctrl.type === "fan_speed") {
      return { domain: "vacuum", service: "set_fan_speed", data: { entity_id: ctrl.entity, fan_speed: value } };
    }
    return null;
  }

  /** Valor siguiente de un number dentro de sus límites (min/max/step de HA). */
  function stepNumber(s, dir) {
    const a = (s && s.attributes) || {};
    const step = Number(a.step) || 1;
    const min = isFinite(Number(a.min)) ? Number(a.min) : -Infinity;
    const max = isFinite(Number(a.max)) ? Number(a.max) : Infinity;
    const cur = Number(s && s.state);
    if (!isFinite(cur)) return null;
    const next = Math.round((cur + dir * step) / step) * step;
    if (next < min || next > max) return null;
    return Number(next.toFixed(4));
  }

  // -------------------------------------------------------------------------
  // Marcadores en el plano
  // -------------------------------------------------------------------------

  function floorKey(floor, floors) {
    const HP = window.HADomoticsPlan;
    const cfg = HP && HP.configFor ? HP.configFor(floor, floors) : null;
    return cfg ? cfg.key : null;
  }

  function markerClass(a) {
    return "appliance-marker appliance-" + a.kind +
      (isRunning(a) ? " running" : "") +
      (activeAlerts(a).length ? " alert" : "") +
      (isUnavailable(a) ? " unavailable" : "");
  }

  /**
   * Dibuja los aparatos de esta planta. opts: { viewMode, crop, onMoved }.
   */
  function render(container, floor, floors, width, height, opts) {
    if (!container) return [];
    container.querySelectorAll(":scope > .appliance-marker").forEach((e) => e.remove());
    const key = floorKey(floor, floors);
    if (!key || !width || !height) return [];
    const o = opts || {};
    const out = [];
    mapData.appliances.filter((a) => a.floor === key && Array.isArray(a.position)).forEach((a) => {
      let px = Number(a.position[0]) * width, py = Number(a.position[1]) * height;
      const HP = window.HADomoticsPlan;
      if (o.viewMode && o.crop && HP && HP.clampPoint) [px, py] = HP.clampPoint(px, py, o.crop, 20);
      const m = document.createElement("div");
      m.className = markerClass(a) + (o.viewMode ? "" : " editing");
      m.dataset.appliance = a.id;
      m.style.left = `${px}px`;
      m.style.top = `${py}px`;
      m.title = a.name + (o.viewMode ? "" : " — arrastra para moverlo");
      m.setAttribute("role", "button");
      m.setAttribute("tabindex", "0");
      m.setAttribute("aria-label", a.name);
      m.innerHTML = `<div class="appl-inner"><div class="appl-icon">${iconSvg(a.kind)}</div>` +
        `<div class="appl-badge">${esc(badgeText(a))}</div></div>`;
      if (o.viewMode) {
        m.addEventListener("click", (ev) => { ev.stopPropagation(); open(a.id); });
        m.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); open(a.id); } });
      } else {
        m.addEventListener("click", (ev) => ev.stopPropagation());
        enableDrag(m, a, key, width, height, o.onMoved);
      }
      container.appendChild(m);
      out.push(m);
    });
    return out;
  }

  function enableDrag(m, a, key, width, height, onMoved) {
    m.addEventListener("pointerdown", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const container = m.parentElement;
      const rect = container.getBoundingClientRect();
      const scale = rect.width / (container.offsetWidth || width) || 1;
      const startX = ev.clientX, startY = ev.clientY;
      const x0 = parseFloat(m.style.left), y0 = parseFloat(m.style.top);
      let moved = false;
      if (m.setPointerCapture) { try { m.setPointerCapture(ev.pointerId); } catch (e) { /* sin captura */ } }
      const move = (e) => {
        const dx = (e.clientX - startX) / scale, dy = (e.clientY - startY) / scale;
        if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
        m.style.left = `${x0 + dx}px`;
        m.style.top = `${y0 + dy}px`;
      };
      const up = () => {
        m.removeEventListener("pointermove", move);
        m.removeEventListener("pointerup", up);
        m.removeEventListener("pointercancel", up);
        if (!moved) return;
        const fx = parseFloat(m.style.left) / width, fy = parseFloat(m.style.top) / height;
        savePosition(a, key, fx, fy).then(() => { if (onMoved) onMoved(a); });
      };
      m.addEventListener("pointermove", move);
      m.addEventListener("pointerup", up);
      m.addEventListener("pointercancel", up);
    });
  }

  async function savePosition(a, key, fx, fy) {
    const x = Math.min(2, Math.max(-1, Number(fx.toFixed(5))));
    const y = Math.min(2, Math.max(-1, Number(fy.toFixed(5))));
    try {
      if (!ctx.save) throw new Error("no save");
      await ctx.save({ id: a.id, floor: key, x, y });
      a.floor = key;
      a.position = [x, y];
      a.custom = true;
      notify(`${a.name}: posición guardada`, "success");
    } catch (e) {
      notify(`No se pudo guardar la posición de ${a.name}`, "error");
    }
  }

  function notify(msg, type) { if (ctx.toast) ctx.toast(msg, type); }

  /** Estados nuevos: actualiza los marcadores y la ventana abierta. */
  function update(container, newStates) {
    states = newStates || {};
    if (container) {
      container.querySelectorAll(":scope > .appliance-marker").forEach((m) => {
        const a = byId(m.dataset.appliance);
        if (!a) return;
        const editing = m.classList.contains("editing");
        m.className = markerClass(a) + (editing ? " editing" : "");
        const b = m.querySelector(".appl-badge");
        const txt = badgeText(a);
        if (b && b.textContent !== txt) b.textContent = txt;
      });
    }
    if (openId) renderSheet(false);
  }

  // -------------------------------------------------------------------------
  // Ventana del aparato
  // -------------------------------------------------------------------------

  function ensureModal() {
    let ov = document.getElementById("applianceModal");
    if (ov) return ov;
    ov = document.createElement("div");
    ov.className = "modal-overlay appliance-overlay";
    ov.id = "applianceModal";
    ov.style.display = "none";
    ov.innerHTML = '<div class="modal appliance-modal" role="dialog" aria-modal="true" aria-labelledby="applianceTitle"></div>';
    ov.addEventListener("click", (ev) => { if (ev.target === ov) close(); });
    document.body.appendChild(ov);
    return ov;
  }

  function open(id) {
    if (!byId(id)) return;
    openId = id;
    const ov = ensureModal();
    ov.style.display = "flex";
    renderSheet(true);
  }

  function close() {
    openId = null;
    const ov = document.getElementById("applianceModal");
    if (ov) ov.style.display = "none";
  }

  function controlHtml(c, i) {
    const s = st(c.entity);
    const off = !s || s.state === "unavailable";
    const key = `c:${c.entity}`;
    const dis = off || busy.has(key) ? " disabled" : "";
    if (c.type === "switch") {
      const on = s && s.state === "on";
      return `<div class="appl-row appl-control"><span class="appl-label">${esc(c.label)}</span>` +
        `<button type="button" class="appl-switch${on ? " on" : ""}" data-control="${i}" role="switch" aria-checked="${on}"${dis}>` +
        `<span class="appl-switch-knob"></span><span class="appl-switch-text">${off ? "No disponible" : on ? "Sí" : "No"}</span></button></div>`;
    }
    if (c.type === "number") {
      const a = (s && s.attributes) || {};
      const unit = a.unit_of_measurement || "";
      const val = off || isMissing(s && s.state) ? "—" : `${fmtNumber(s.state)} ${unit}`;
      const minus = stepNumber(s, -1) == null ? " disabled" : dis;
      const plus = stepNumber(s, 1) == null ? " disabled" : dis;
      return `<div class="appl-row appl-control"><span class="appl-label">${esc(c.label)}</span>` +
        `<span class="appl-stepper"><button type="button" class="appl-step" data-control="${i}" data-dir="-1" aria-label="Bajar"${minus}>−</button>` +
        `<span class="appl-step-val">${esc(val)}</span>` +
        `<button type="button" class="appl-step" data-control="${i}" data-dir="1" aria-label="Subir"${plus}>+</button></span></div>`;
    }
    if (c.type === "select" || c.type === "fan_speed") {
      const opts = c.type === "select"
        ? ((s && s.attributes && s.attributes.options) || [])
        : ((s && s.attributes && s.attributes.fan_speed_list) || []);
      const cur = c.type === "select" ? (s && s.state) : (s && s.attributes && s.attributes.fan_speed);
      const l = labelsFor(c) || {};
      const has = opts.includes(cur);
      const options = (has ? "" : '<option value="" selected>—</option>') +
        opts.map((o) => `<option value="${esc(o)}"${o === cur ? " selected" : ""}>${esc(l[o] || o)}</option>`).join("");
      return `<div class="appl-row appl-control"><span class="appl-label">${esc(c.label)}</span>` +
        `<select class="appl-select" data-control="${i}"${dis || (opts.length ? "" : " disabled")}>${options}</select></div>`;
    }
    return "";
  }

  function renderSheet(force) {
    const a = byId(openId);
    const ov = document.getElementById("applianceModal");
    if (!a || !ov) return;
    const box = ov.querySelector(".appliance-modal");
    // No rehacer mientras se elige en un desplegable.
    if (!force && document.activeElement && box.contains(document.activeElement) &&
        document.activeElement.tagName === "SELECT") return;

    const alerts = activeAlerts(a);
    const status = (a.status || []).map((it) => {
      const v = rawValue(it);
      const bad = (Array.isArray(it.alert) && it.alert.includes(v)) ||
        (Array.isArray(it.alert_not) && v != null && !it.alert_not.includes(v));
      return `<div class="appl-row${bad ? " bad" : ""}"><span class="appl-label">${esc(it.label)}</span>` +
        `<span class="appl-value">${esc(formatValue(it))}</span></div>`;
    }).join("");
    const actions = (a.actions || []).map((act, i) => {
      const s = actionState(act);
      const dis = !s.ok || busy.has(`a:${a.id}:${act.id}`) ? " disabled" : "";
      return `<button type="button" class="btn appl-action appl-action-${esc(act.id)}" data-action="${i}"${dis}` +
        `${s.reason ? ` title="${esc(s.reason)}"` : ""}><span class="material-icons">${esc(act.icon || "play_arrow")}</span>${esc(act.label)}</button>`;
    }).join("");
    const controls = (a.controls || []).map(controlHtml).join("");
    const notes = (a.notes || []).map((n) => `<p class="appl-note">${esc(n)}</p>`).join("");
    const err = errors[a.id] ? `<p class="appl-error">${esc(errors[a.id])}</p>` : "";

    box.innerHTML =
      `<div class="appl-head"><div class="appl-head-icon appliance-${esc(a.kind)}${isRunning(a) ? " running" : ""}">${iconSvg(a.kind)}</div>` +
      `<div class="appl-head-text"><h2 id="applianceTitle">${esc(a.name)}</h2><div class="appl-sub">${esc(a.model || "")}</div></div>` +
      `<button type="button" class="appl-close" aria-label="Cerrar"><span class="material-icons">close</span></button></div>` +
      (alerts.length ? `<div class="appl-alerts">${alerts.map((t) => `<div class="appl-alert"><span class="material-icons">warning</span>${esc(t)}</div>`).join("")}</div>` : "") +
      (actions ? `<div class="appl-actions">${actions}</div>` : "") +
      err +
      `<div class="appl-section">${status}</div>` +
      (controls ? `<div class="appl-section appl-controls">${controls}</div>` : "") +
      notes +
      `<div class="appl-where"><span class="material-icons">place</span>${esc((a.location && a.location.note) || "")}</div>`;

    box.querySelector(".appl-close").addEventListener("click", close);
    box.querySelectorAll("[data-action]").forEach((b) => {
      b.addEventListener("click", () => runAction(a, a.actions[Number(b.dataset.action)]));
    });
    box.querySelectorAll("button[data-control]").forEach((b) => {
      b.addEventListener("click", () => {
        const c = a.controls[Number(b.dataset.control)];
        if (c.type === "switch") {
          const s = st(c.entity);
          runControl(a, c, !(s && s.state === "on"));
        } else if (c.type === "number") {
          const v = stepNumber(st(c.entity), Number(b.dataset.dir));
          if (v != null) runControl(a, c, v);
        }
      });
    });
    box.querySelectorAll("select[data-control]").forEach((sel) => {
      sel.addEventListener("change", () => {
        if (sel.value) runControl(a, a.controls[Number(sel.dataset.control)], sel.value);
      });
    });
  }

  async function invoke(a, key, call) {
    if (!ctx.call || !call) return false;
    busy.add(key);
    delete errors[a.id];
    renderSheet(true);
    try {
      await ctx.call(call.domain, call.service, call.data);
      return true;
    } catch (e) {
      errors[a.id] = "Home Assistant no aceptó la orden. Inténtalo de nuevo.";
      return false;
    } finally {
      busy.delete(key);
      if (openId === a.id) renderSheet(true);
    }
  }

  async function runAction(a, act) {
    if (!act || !actionState(act).ok) return false;
    const call = buildActionCall(act);
    if (act.confirm) {
      const l = labelsFor({ labels: act.option_labels }) || {};
      const opt = call.data.option ? (l[call.data.option] || call.data.option) : "";
      const ask = act.confirm.replace("{option}", opt);
      const ok = ctx.confirm ? ctx.confirm(ask) : window.confirm(ask);
      if (!ok) return false;
    }
    return invoke(a, `a:${a.id}:${act.id}`, call);
  }

  function runControl(a, c, value) {
    return invoke(a, `c:${c.entity}`, buildControlCall(c, value));
  }

  /** call(domain, service, data), save({id, floor, x, y}), toast(msg, type). */
  function configure(o) { ctx = Object.assign(ctx, o || {}); }

  if (typeof document !== "undefined" && document.addEventListener) {
    document.addEventListener("keydown", (ev) => { if (ev.key === "Escape" && openId) close(); });
  }

  window.HADomoticsAppliances = {
    load,
    configure,
    render,
    update,
    open,
    close,
    _internals: {
      setMap, setStates: (s) => { states = s || {}; }, formatValue, badgeText, activeAlerts, isRunning,
      actionState, buildActionCall, buildControlCall, stepNumber, runAction, runControl, remaining,
      get openId() { return openId; },
    },
  };
})();
