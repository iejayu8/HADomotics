/* HADomotics — electrodomésticos como elementos del plano de Dispositivos.
 *
 * Nevera, lavavajillas y robot aspirador/friegasuelos son tipos de elemento
 * (fridge, dishwasher, vacuum) que se añaden como cualquier otro: «+» en modo
 * edición, clic en el plano, y en el panel se elige el tipo y la entidad
 * principal. Las demás entidades del aparato (temperaturas, programa, batería…)
 * se guardan por rol en el elemento (appliance_entities): se descubren en el
 * mismo dispositivo de Home Assistant y se pueden cambiar a mano.
 *
 * Los tipos y sus roles vienen de appliance_types.json (GET /api/appliances/types);
 * aquí no hay ningún entity_id fijo.
 *
 * En modo vista, al pulsar el elemento se abre su ventana con el estado y las
 * acciones principales. Las acciones llaman a servicios reales de Home Assistant
 * con la misma función que los demás controles (callAddonOrHass). Nada se
 * ejecuta sin que el usuario pulse.
 */
"use strict";

(function () {
  let types = { kinds: {}, labels: {} };
  let loadPromise = null;
  let states = {};
  let openEl = null;
  let ctx = { call: null, toast: null, confirm: null, fetchJson: null, hass: null };
  const busy = new Set();
  const errors = {};

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
      loadPromise = fetch(panelRoot() + "/api/appliances/types", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : { kinds: {} }))
        .catch(() => ({ kinds: {} }))
        .then((j) => { setTypes(j); return types; });
    }
    return loadPromise;
  }

  function setTypes(t) { types = t && t.kinds ? t : { kinds: {}, labels: {} }; }
  function kind(type) { return (types.kinds || {})[type] || null; }
  function isAppliance(type) { return !!kind(type); }
  function kindList() { return Object.entries(types.kinds || {}).map(([id, k]) => ({ id, label: k.label, icon: k.icon })); }

  // -------------------------------------------------------------------------
  // Entidades del elemento
  // -------------------------------------------------------------------------

  /** {rol: entity_id} del elemento; el rol de la entidad principal sale de entity_id. */
  function entitiesFor(el) {
    const k = kind(el && el.type);
    if (!k) return {};
    const out = Object.assign({}, (el && el.appliance_entities) || {});
    const main = String((el && el.entity_id) || "");
    const dom = main.split(".")[0];
    // Si un rol no está asignado y la entidad principal es de su dominio y le
    // corresponde (p. ej. vacuum.* → rol «vacuum»), se usa la principal.
    for (const [role, r] of Object.entries(k.roles || {})) {
      if (out[role] || !main || r.domain !== dom) continue;
      if (matchScore(r, { entity_id: main, translation_key: null }, states[main]) > 0 || role === k.main_role || k.main_domain === dom) {
        out[role] = main;
      }
    }
    return out;
  }

  function st(el, role) {
    const eid = entitiesFor(el)[role];
    return (eid && states && states[eid]) || null;
  }
  const isMissing = (v) => v == null || v === "" || v === "unavailable" || v === "unknown";

  // -------------------------------------------------------------------------
  // Descubrimiento por dispositivo
  // -------------------------------------------------------------------------

  /** Puntuación de una entidad candidata para un rol (0 = no vale). */
  function matchScore(r, cand, stateObj) {
    const eid = String(cand.entity_id || "");
    const [dom, obj] = eid.split(".");
    if (!obj || dom !== r.domain) return 0;
    if (!r.keys && !r.device_class && !r.suffix) return 1;
    if (cand.translation_key && (r.keys || []).includes(cand.translation_key)) return 4;
    const dc = stateObj && stateObj.attributes && stateObj.attributes.device_class;
    if (dc && (r.device_class || []).includes(dc)) return 3;
    if ((r.suffix || []).some((sfx) => obj.endsWith(sfx.replace(/^_/, "")) && (sfx[0] !== "_" || obj.endsWith(sfx)))) return 2;
    return 0;
  }

  /** {rol: entity_id} a partir de las entidades del aparato. */
  function matchRoles(type, candidates, stateMap) {
    const k = kind(type);
    if (!k) return {};
    const sm = stateMap || states;
    const out = {};
    for (const [role, r] of Object.entries(k.roles || {})) {
      let best = null, bestScore = 0;
      for (const c of candidates || []) {
        const sc = matchScore(r, c, sm[c.entity_id]);
        if (sc > bestScore) { best = c.entity_id; bestScore = sc; }
      }
      if (best) out[role] = best;
    }
    return out;
  }

  /** Entidades del mismo aparato: dentro de HA con hass.entities/devices; fuera, el add-on. */
  async function deviceCandidates(mainEntity) {
    const hass = ctx.hass ? ctx.hass() : null;
    if (hass && hass.entities && hass.devices) {
      const ents = Object.values(hass.entities);
      const main = hass.entities[mainEntity];
      if (!main || !main.device_id) return [];
      const dev = hass.devices[main.device_id] || {};
      const name = String(dev.name_by_user || dev.name || "").trim().toLowerCase();
      const ids = new Set([main.device_id]);
      for (const d of Object.values(hass.devices)) {
        const dn = String(d.name_by_user || d.name || "").trim().toLowerCase();
        const sameEntry = (d.config_entries || []).some((c) => (dev.config_entries || []).includes(c));
        if (d.via_device_id === main.device_id || (name && dn.startsWith(name) && sameEntry)) ids.add(d.id);
      }
      return ents.filter((e) => ids.has(e.device_id))
        .map((e) => ({ entity_id: e.entity_id, translation_key: e.translation_key || null, device_id: e.device_id }));
    }
    if (!ctx.fetchJson) return [];
    const j = await ctx.fetchJson(`/api/ha/device_entities?entity_id=${encodeURIComponent(mainEntity)}`);
    return (j && j.entities) || [];
  }

  async function discover(type, mainEntity) {
    const cands = await deviceCandidates(mainEntity);
    if (!cands.some((c) => c.entity_id === mainEntity)) cands.push({ entity_id: mainEntity });
    return { roles: matchRoles(type, cands, states), found: cands.length };
  }

  // -------------------------------------------------------------------------
  // Textos
  // -------------------------------------------------------------------------

  function labelsFor(item) {
    const l = item && item.labels;
    if (!l) return null;
    if (typeof l === "string") return (types.labels || {})[l] || null;
    return l;
  }

  function rawValue(el, item) {
    const s = st(el, item.role);
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
    try { at = new Date(t).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" }); } catch (e) { at = ""; }
    return at ? `${left} (fin ${at})` : left;
  }

  function prettyOption(v) {
    return String(v).replace(/^.*_program_/, "").replace(/_/g, " ");
  }

  function formatValue(el, item, now) {
    const v = rawValue(el, item);
    if (v == null || v === "unavailable") return "No disponible";
    if (v === "unknown" || v === "") {
      const l = labelsFor(item);
      return l && l.unknown ? l.unknown : "—";
    }
    const s = st(el, item.role);
    const unit = (s && s.attributes && s.attributes.unit_of_measurement) || "";
    if (item.format === "temp") return `${fmtNumber(v)} ${unit || "°C"}`;
    if (item.format === "value") return unit ? `${fmtNumber(v)} ${unit}` : fmtNumber(v);
    if (item.format === "remaining") return remaining(v, now) || "—";
    const l = labelsFor(item);
    if (l && Object.prototype.hasOwnProperty.call(l, v)) return l[v];
    if (item.labels === "dishwasher_program") return prettyOption(v);
    return String(v);
  }

  function badgeText(el, now) {
    const k = kind(el && el.type);
    if (!k) return "";
    return (k.badge || [])
      .map((b) => {
        const v = rawValue(el, b);
        if (isMissing(v)) return "";
        if (b.format === "remaining") { const r = remaining(v, now); return r ? r.replace(/ \(fin .*\)$/, "") : ""; }
        return formatValue(el, b, now);
      })
      .filter(Boolean)
      .join(" · ");
  }

  function alertMatches(el, rule) {
    const s = st(el, rule.role);
    if (!s) return false;
    if (Array.isArray(rule.when)) return rule.when.includes(s.state);
    if (Array.isArray(rule.not)) return !rule.not.includes(s.state);
    return false;
  }

  function activeAlerts(el) {
    const k = kind(el && el.type);
    return k ? (k.alerts || []).filter((r) => alertMatches(el, r)).map((r) => r.text) : [];
  }

  function isRunning(el) {
    const k = kind(el && el.type);
    const r = k && k.running;
    const s = r && st(el, r.role);
    return !!(s && (r.when || []).includes(s.state));
  }

  function isUnavailable(el) {
    const s = el && el.entity_id ? states[el.entity_id] : null;
    return !s || s.state === "unavailable";
  }

  /** Clases del elemento en el plano: en marcha, alarma, no disponible. */
  function stateClasses(el) {
    return [isRunning(el) ? "running" : "", activeAlerts(el).length ? "alert" : "", isUnavailable(el) ? "unavailable" : ""]
      .filter(Boolean);
  }

  // -------------------------------------------------------------------------
  // Acciones
  // -------------------------------------------------------------------------

  function actionState(el, act) {
    const target = st(el, act.role);
    if (!target || target.state === "unavailable") return { ok: false, reason: "No disponible" };
    for (const c of act.enabled_when || []) {
      const s = st(el, c.role);
      if (!s || !(c.in || []).includes(s.state)) return { ok: false, reason: "" };
    }
    if (act.option_from) {
      const src = st(el, act.option_from);
      const opts = (target.attributes && target.attributes.options) || [];
      if (!src || isMissing(src.state) || !opts.includes(src.state)) return { ok: false, reason: "Elige un programa" };
    }
    return { ok: true, reason: "" };
  }

  function buildActionCall(el, act) {
    const ents = entitiesFor(el);
    const data = { entity_id: ents[act.role] };
    if (act.option_from) {
      const src = st(el, act.option_from);
      data.option = src ? src.state : null;
    }
    return { domain: act.domain, service: act.service, data };
  }

  function buildControlCall(el, ctrl, value) {
    const eid = entitiesFor(el)[ctrl.role];
    if (!eid) return null;
    if (ctrl.type === "switch") return { domain: "switch", service: value ? "turn_on" : "turn_off", data: { entity_id: eid } };
    if (ctrl.type === "number") return { domain: "number", service: "set_value", data: { entity_id: eid, value } };
    if (ctrl.type === "select") return { domain: "select", service: "select_option", data: { entity_id: eid, option: value } };
    if (ctrl.type === "fan_speed") return { domain: "vacuum", service: "set_fan_speed", data: { entity_id: eid, fan_speed: value } };
    return null;
  }

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
  // Ventana del aparato
  // -------------------------------------------------------------------------

  function iconSvg(type) {
    const k = kind(type);
    const I = window.HADomoticsIcons;
    return I ? I.svg((k && k.icon) || "generico", {}) : "";
  }

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

  function open(el) {
    if (!el || !kind(el.type)) return;
    openEl = el;
    const ov = ensureModal();
    ov.style.display = "flex";
    renderSheet(true);
  }

  function close() {
    openEl = null;
    const ov = document.getElementById("applianceModal");
    if (ov) ov.style.display = "none";
  }

  function update(newStates) {
    states = newStates || {};
    if (openEl) renderSheet(false);
  }

  function controlHtml(el, c, i) {
    const s = st(el, c.role);
    if (!entitiesFor(el)[c.role]) return "";
    const off = !s || s.state === "unavailable";
    const dis = off || busy.has(`c:${el.id}:${c.role}`) ? " disabled" : "";
    if (c.type === "switch") {
      const on = s && s.state === "on";
      return `<div class="appl-row appl-control"><span class="appl-label">${esc(c.label)}</span>` +
        `<button type="button" class="appl-switch${on ? " on" : ""}" data-control="${i}" role="switch" aria-checked="${on}"${dis}>` +
        `<span class="appl-switch-knob"></span><span class="appl-switch-text">${off ? "No disponible" : on ? "Sí" : "No"}</span></button></div>`;
    }
    if (c.type === "number") {
      const a = (s && s.attributes) || {};
      const val = off || isMissing(s && s.state) ? "—" : `${fmtNumber(s.state)} ${a.unit_of_measurement || ""}`;
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
      const options = (opts.includes(cur) ? "" : '<option value="" selected>—</option>') +
        opts.map((o) => `<option value="${esc(o)}"${o === cur ? " selected" : ""}>${esc(l[o] || (c.labels === "dishwasher_program" ? prettyOption(o) : o))}</option>`).join("");
      return `<div class="appl-row appl-control"><span class="appl-label">${esc(c.label)}</span>` +
        `<select class="appl-select" data-control="${i}"${dis || (opts.length ? "" : " disabled")}>${options}</select></div>`;
    }
    return "";
  }

  function renderSheet(force) {
    const el = openEl;
    const k = kind(el && el.type);
    const ov = document.getElementById("applianceModal");
    if (!k || !ov) return;
    const box = ov.querySelector(".appliance-modal");
    if (!force && document.activeElement && box.contains(document.activeElement) &&
        document.activeElement.tagName === "SELECT") return;
    const ents = entitiesFor(el);
    const alerts = activeAlerts(el);
    const status = (k.status || []).filter((it) => ents[it.role]).map((it) => {
      const v = rawValue(el, it);
      const bad = (Array.isArray(it.alert) && it.alert.includes(v)) ||
        (Array.isArray(it.alert_not) && v != null && !it.alert_not.includes(v));
      return `<div class="appl-row${bad ? " bad" : ""}"><span class="appl-label">${esc(it.label)}</span>` +
        `<span class="appl-value">${esc(formatValue(el, it))}</span></div>`;
    }).join("");
    const actions = (k.actions || []).filter((a) => ents[a.role]).map((act) => {
      const s = actionState(el, act);
      const i = k.actions.indexOf(act);
      const dis = !s.ok || busy.has(`a:${el.id}:${act.id}`) ? " disabled" : "";
      return `<button type="button" class="btn appl-action appl-action-${esc(act.id)}" data-action="${i}"${dis}` +
        `${s.reason ? ` title="${esc(s.reason)}"` : ""}><span class="material-icons">${esc(act.icon || "play_arrow")}</span>${esc(act.label)}</button>`;
    }).join("");
    const controls = (k.controls || []).map((c, i) => controlHtml(el, c, i)).join("");
    const notes = (k.notes || []).map((n) => `<p class="appl-note">${esc(n)}</p>`).join("");
    const err = errors[el.id] ? `<p class="appl-error">${esc(errors[el.id])}</p>` : "";
    const name = el.label || (states[el.entity_id] && states[el.entity_id].attributes && states[el.entity_id].attributes.friendly_name) || k.label;
    const empty = !status && !actions && !controls
      ? '<p class="appl-note">Este elemento no tiene entidades asignadas. En modo edición, elige su entidad principal y pulsa «Detectar entidades».</p>' : "";

    box.innerHTML =
      `<div class="appl-head"><div class="appl-head-icon appliance-${esc(el.type)}${isRunning(el) ? " running" : ""}">${iconSvg(el.type)}</div>` +
      `<div class="appl-head-text"><h2 id="applianceTitle">${esc(name)}</h2><div class="appl-sub">${esc(k.label)}</div></div>` +
      `<button type="button" class="appl-close" aria-label="Cerrar"><span class="material-icons">close</span></button></div>` +
      (alerts.length ? `<div class="appl-alerts">${alerts.map((t) => `<div class="appl-alert"><span class="material-icons">warning</span>${esc(t)}</div>`).join("")}</div>` : "") +
      (actions ? `<div class="appl-actions">${actions}</div>` : "") + err +
      (status ? `<div class="appl-section">${status}</div>` : "") +
      (controls ? `<div class="appl-section appl-controls">${controls}</div>` : "") + notes + empty;

    box.querySelector(".appl-close").addEventListener("click", close);
    box.querySelectorAll("[data-action]").forEach((b) => {
      b.addEventListener("click", () => runAction(el, k.actions[Number(b.dataset.action)]));
    });
    box.querySelectorAll("button[data-control]").forEach((b) => {
      b.addEventListener("click", () => {
        const c = k.controls[Number(b.dataset.control)];
        if (c.type === "switch") {
          const s = st(el, c.role);
          runControl(el, c, !(s && s.state === "on"));
        } else if (c.type === "number") {
          const v = stepNumber(st(el, c.role), Number(b.dataset.dir));
          if (v != null) runControl(el, c, v);
        }
      });
    });
    box.querySelectorAll("select[data-control]").forEach((sel) => {
      sel.addEventListener("change", () => { if (sel.value) runControl(el, k.controls[Number(sel.dataset.control)], sel.value); });
    });
  }

  async function invoke(el, key, call) {
    if (!ctx.call || !call || !call.data.entity_id) return false;
    busy.add(key);
    delete errors[el.id];
    if (openEl) renderSheet(true);
    try {
      await ctx.call(call.domain, call.service, call.data);
      return true;
    } catch (e) {
      errors[el.id] = "Home Assistant no aceptó la orden. Inténtalo de nuevo.";
      return false;
    } finally {
      busy.delete(key);
      if (openEl && openEl.id === el.id) renderSheet(true);
    }
  }

  async function runAction(el, act) {
    if (!act || !actionState(el, act).ok) return false;
    const call = buildActionCall(el, act);
    if (act.confirm) {
      const l = labelsFor({ labels: act.option_labels }) || {};
      const opt = call.data.option ? (l[call.data.option] || prettyOption(call.data.option)) : "";
      const ask = act.confirm.replace("{option}", opt);
      const ok = ctx.confirm ? ctx.confirm(ask) : window.confirm(ask);
      if (!ok) return false;
    }
    return invoke(el, `a:${el.id}:${act.id}`, call);
  }

  function runControl(el, c, value) {
    return invoke(el, `c:${el.id}:${c.role}`, buildControlCall(el, c, value));
  }

  /** call(domain, service, data), toast, confirm, fetchJson(path), hass() */
  function configure(o) { ctx = Object.assign(ctx, o || {}); }

  if (typeof document !== "undefined" && document.addEventListener) {
    document.addEventListener("keydown", (ev) => { if (ev.key === "Escape" && openEl) close(); });
  }

  window.HADomoticsAppliances = {
    load, configure, isAppliance, kind, kindList, entitiesFor, discover, matchRoles,
    badgeText, stateClasses, update, open, close, iconSvg,
    _internals: {
      setTypes, setStates: (s) => { states = s || {}; }, formatValue, activeAlerts, isRunning, actionState,
      buildActionCall, buildControlCall, stepNumber, runAction, runControl, remaining, matchScore,
      get openEl() { return openEl; },
    },
  };
})();
