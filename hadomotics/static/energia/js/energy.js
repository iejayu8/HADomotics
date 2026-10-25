/* HADomotics Energía — Coche/Carga, Solar/Inversor, Batería y flujo.
 * El modo prueba (localStorage hadomotics.energy.dryrun) está activado
 * salvo que el valor sea "0". Con el modo prueba no hay llamada real.
 * Con el modo prueba apagado, el control sale por el usuario de Home
 * Assistant (hass.callService) o, si no hay frontend, por el proxy de
 * administrador.
 */
"use strict";

(function () {
  const LS = { dry: "hadomotics.energy.dryrun" };
  const $ = (id) => document.getElementById(id);
  const states = {};
  const callLog = [];
  window.__callLog = callLog;
  let MAP = null;
  let transport = null;
  let activeTab = "flujo";
  let dryRun = localStorage.getItem(LS.dry) !== "0";
  let started = false;
  let flowTimer = null;

  const SERVICE_FOR = {
    toggle: (eid, on) => [eid.split(".")[0], on ? "turn_on" : "turn_off", {}],
    number: (eid, v) => [eid.split(".")[0], "set_value", { value: v }],
    select: (eid, o) => [eid.split(".")[0], "select_option", { option: o }],
  };

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }
  function toast(t) {
    const el = $("toast");
    if (!el) return;
    el.textContent = t;
    el.classList.remove("hidden");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.add("hidden"), 3500);
  }
  function isNA(s) {
    return !s || s.state == null || s.state === "unavailable" || s.state === "unknown" || s.state === "";
  }

  const madridClockFmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Madrid",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const madridDateFmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Madrid",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  function madridPick(parts, type) {
    const part = parts.find((p) => p.type === type);
    return part ? part.value : "";
  }

  function madridClock(date) {
    const parts = madridClockFmt.formatToParts(date);
    let hour = madridPick(parts, "hour") || "00";
    if (hour === "24") hour = "00";
    return `${hour}:${madridPick(parts, "minute") || "00"}:${madridPick(parts, "second") || "00"}`;
  }

  // Lunes = 0 … domingo = 6, como energy_map.json. El día civil es el de Madrid.
  function madridWeekdayIndex(date) {
    const parts = madridDateFmt.formatToParts(date);
    const year = Number(madridPick(parts, "year"));
    const month = Number(madridPick(parts, "month"));
    const day = Number(madridPick(parts, "day"));
    const sunday0 = new Date(Date.UTC(year, month - 1, day, 12)).getUTCDay();
    return (sunday0 + 6) % 7;
  }

  function stateMillis(s) {
    if (!s || !s.last_updated) return null;
    const t = Date.parse(s.last_updated);
    return Number.isNaN(t) ? null : t;
  }

  function isStaleUpdate(prev, s) {
    if (!prev) return false;
    const incoming = stateMillis(s);
    const current = stateMillis(prev);
    if (incoming == null || current == null) return false;
    if (incoming < current) return true;
    // Un control local reutiliza last_updated anterior. Un sondeo de esa
    // misma generación no debe devolver el valor viejo.
    if (prev._optimistic && incoming === current && s.state !== prev.state) return true;
    return false;
  }

  function optimisticEntity(prev, entityId, control, value) {
    const state = control === "toggle" ? (value ? "on" : "off") : String(value);
    const next = {
      entity_id: entityId,
      state: state,
      attributes: (prev && prev.attributes) || {},
      _optimistic: true,
    };
    if (prev && prev.last_updated) next.last_updated = prev.last_updated;
    return next;
  }

  function applyStates(store, list) {
    (list || []).forEach((s) => {
      if (!s || !s.entity_id) return;
      if (s._removed) { delete store[s.entity_id]; return; }
      const prev = store[s.entity_id];
      if (isStaleUpdate(prev, s)) return;
      if (s._delta && prev) {
        if (s.state !== undefined) prev.state = s.state;
        if (s.attributes) prev.attributes = Object.assign({}, prev.attributes, s.attributes);
        (s.attrs_removed || []).forEach((k) => delete prev.attributes[k]);
        if (s.last_updated) prev.last_updated = s.last_updated;
        delete prev._optimistic;
      } else {
        store[s.entity_id] = {
          entity_id: s.entity_id,
          state: s.state,
          attributes: s.attributes || {},
          last_updated: s.last_updated,
        };
      }
    });
    return store;
  }

  function callLogLine(c) {
    const clock = madridClock(new Date(c.ts));
    return `${clock} ${c.dry_run ? "DRY " : ""}${c.domain}.${c.service} ${c.entity_id} ${JSON.stringify(c.data)} → ${c.result}`;
  }

  function fmt(it, s) {
    if (!s) return { txt: "sin dato", na: true };
    if (isNA(s)) return { txt: s.state === "unknown" ? "desconocido" : "no disponible", na: true };
    const dom = it.entity.split(".")[0];
    let v = s.state;
    if (it.format === "datetime" || (s.attributes && s.attributes.device_class === "timestamp")) {
      const d = new Date(v);
      if (!isNaN(d)) {
        return { txt: d.toLocaleString("es-ES", { timeZone: "Europe/Madrid", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) };
      }
    }
    if (dom === "binary_sensor" || dom === "switch" || dom === "input_boolean" || dom === "automation") {
      const on = v === "on";
      return { txt: dom === "automation" ? (on ? "activa" : "desactivada") : (on ? "sí" : "no") };
    }
    if (dom === "device_tracker") return { txt: v === "home" ? "en casa" : v === "not_home" ? "fuera" : v };
    const unit = (s.attributes && s.attributes.unit_of_measurement) || "";
    if (v !== "" && !isNaN(Number(v))) {
      const n = Number(v);
      v = Math.abs(n) >= 100 || Number.isInteger(n) ? String(Math.round(n * 10) / 10) : n.toFixed(1);
      v = v.replace(".", ",");
    }
    return { txt: unit ? v + " " + unit : v };
  }

  function allItems() {
    const o = [];
    (MAP.screens || []).forEach((sc) => sc.sections.forEach((se) => se.items.forEach((it) => o.push(it))));
    return o;
  }

  function buildUI() {
    const main = $("screens");
    const tabs = $("tabs");
    if (!main || !tabs) return;
    main.innerHTML = "";
    tabs.innerHTML = "";
    const icons = { flujo: "⚡", coche: "🚗", solar: "☀️", bateria: "🔋" };
    const screens = [{ id: "flujo", title: "Flujo", sections: [] }].concat(MAP.screens || []);
    screens.forEach((sc) => {
      const b = document.createElement("button");
      b.type = "button";
      b.dataset.tab = sc.id;
      b.innerHTML = `<span class="ic">${icons[sc.id] || "•"}</span>${esc(sc.title)}`;
      b.onclick = () => showTab(sc.id);
      tabs.appendChild(b);
      const div = document.createElement("section");
      div.className = "screen" + (sc.id === "flujo" ? " flow-screen" : "");
      div.id = "screen-" + sc.id;
      if (sc.id === "flujo" && window.FlowView) window.FlowView.mount(div);
      (sc.sections || []).forEach((se) => {
        const card = document.createElement("div");
        card.className = "card";
        card.dataset.kind = se.kind || "";
        card.innerHTML = `<h3>${esc(se.title)}</h3>`;
        if (se.kind === "decision") {
          card.innerHTML += `<div class="decision" id="decTitle">…</div><div class="motivo" id="decMotivo"></div>`;
        } else {
          (se.items || []).forEach((it) => {
            const row = document.createElement("div");
            row.className = "item" + (it.big ? " big" : "");
            row.dataset.entity = it.entity;
            if (it.weekday != null) row.dataset.weekday = it.weekday;
            row.innerHTML = `<span class="lbl">${esc(it.label)}</span><span class="val"></span>`;
            if (it.control) row.dataset.control = it.control;
            card.appendChild(row);
          });
        }
        div.appendChild(card);
      });
      main.appendChild(div);
    });
    showTab(activeTab);
  }

  function showTab(id) {
    activeTab = id;
    document.querySelectorAll("#appEnergia .screen").forEach((s) => s.classList.toggle("active", s.id === "screen-" + id));
    document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === id));
    if (id === "flujo") refreshFlow();
  }

  function renderDecision() {
    const t = $("decTitle");
    const m = $("decMotivo");
    if (!t) return;
    const toda = states["input_boolean.carga_coche_toda_la_noche"];
    const inst = states["input_boolean.carga_instantanea_tesla"];
    const dec = states["sensor.carga_decision_noche"];
    const mot = states["sensor.carga_decision_motivo"];
    let cls = "na";
    let txt;
    if (inst && inst.state === "on") { txt = "⚡ CARGA INSTANTÁNEA ACTIVA"; cls = "noche"; }
    else if (toda && toda.state === "on") { txt = "🔌 TODA LA NOCHE (5 kW hasta el amanecer)"; cls = "noche"; }
    else if (isNA(dec)) txt = "⚠️ DECISIÓN NO DISPONIBLE (falta dato en HA: no se programa carga)";
    else if (dec.state === "cargar_noche") { txt = "🌙 CARGAR ESTA NOCHE (03:30–05:00, 5 kW)"; cls = "noche"; }
    else if (dec.state === "esperar_sol") { txt = "☀️ ESPERAR AL SOL (excedente de día)"; cls = "sol"; }
    else txt = dec.state;
    t.textContent = txt;
    t.className = "decision " + cls;
    m.textContent = isNA(mot) ? "" : mot.state;
  }

  function renderRow(row, today) {
    const eid = row.dataset.entity;
    const s = states[eid];
    const it = itemByEntity[eid];
    const val = row.querySelector(".val");
    const ctl = row.dataset.control;
    if (row.dataset.weekday != null) {
      const wd = Number(row.dataset.weekday);
      row.classList.toggle("today", wd === today);
      row.classList.toggle("tomorrow", wd === (today + 1) % 7);
    }
    if (!it) return;
    if (!ctl || isNA(s)) {
      const f = fmt(it, s);
      val.className = "val" + (f.na ? " unavail" : "");
      val.textContent = f.txt;
      return;
    }
    val.className = "val";
    const a = s.attributes || {};
    if (ctl === "toggle") {
      let cb = val.querySelector("input");
      if (!cb) {
        val.innerHTML = `<label class="switch"><input type="checkbox"><span></span></label>`;
        cb = val.querySelector("input");
        cb.onchange = () => { const want = cb.checked; cb.checked = !want; request(it, want); };
      }
      cb.checked = s.state === "on";
    } else if (ctl === "number") {
      let inp = val.querySelector("input");
      if (!inp) {
        val.innerHTML = `<span class="numctl"><input type="number" inputmode="decimal"><button type="button">Aplicar</button></span>`;
        inp = val.querySelector("input");
        val.querySelector("button").onclick = () => {
          const n = Number(String(inp.value).replace(",", "."));
          const lo = Number(a.min);
          const hi = Number(a.max);
          if (isNaN(n) || (!isNaN(lo) && n < lo) || (!isNaN(hi) && n > hi)) {
            toast(`Valor fuera de rango (${a.min}–${a.max} ${a.unit_of_measurement || ""})`);
            return;
          }
          request(it, n);
        };
      }
      inp.min = a.min;
      inp.max = a.max;
      inp.step = a.step || "any";
      if (document.activeElement !== inp) inp.value = s.state;
      inp.title = `${a.min}–${a.max} ${a.unit_of_measurement || ""}`;
    } else if (ctl === "select") {
      const opts = a.options || [];
      let seg = val.querySelector(".seg");
      if (!seg || seg.dataset.opts !== opts.join("|")) {
        val.innerHTML = `<span class="seg" data-opts="${esc(opts.join("|"))}">${opts.map((o) => `<button type="button" data-o="${esc(o)}">${esc(o)}</button>`).join("")}</span>`;
        seg = val.querySelector(".seg");
        seg.querySelectorAll("button").forEach((b) => (b.onclick = () => {
          if (states[eid] && states[eid].state !== b.dataset.o) request(it, b.dataset.o);
        }));
      }
      seg.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.o === s.state));
    }
  }

  let itemByEntity = {};
  function renderAll() {
    const today = madridWeekdayIndex(new Date());
    document.querySelectorAll("#appEnergia .item[data-entity]").forEach((row) => renderRow(row, today));
    renderDecision();
  }

  function confirmDlg(text) {
    return new Promise((res) => {
      $("confirmText").textContent = text;
      $("confirm").classList.remove("hidden");
      const done = (v) => { $("confirm").classList.add("hidden"); res(v); };
      $("confirmYes").onclick = () => done(true);
      $("confirmNo").onclick = () => done(false);
    });
  }

  function embeddedHass() {
    if (typeof window.embeddedHass === "function") return window.embeddedHass();
    return null;
  }

  async function request(it, value) {
    const [domain, service, data] = SERVICE_FOR[it.control](it.entity, value);
    if (it.confirm) {
      const ok = await confirmDlg(`${it.label}: ${value === true ? "activar" : value === false ? "desactivar" : value}?`);
      if (!ok) return;
    }
    const entry = { ts: new Date().toISOString(), dry_run: dryRun, domain, service, entity_id: it.entity, data };
    let sent = false;
    try {
      if (dryRun) {
        try {
          const r = await transport.callService(domain, service, it.entity, data, true);
          entry.result = r && r.would_call ? "validado por el add-on, no enviado" : "no enviado (dry-run)";
          if (r && r.would_call) entry.would_call = r.would_call;
        } catch (e) {
          if (/403|401|Administrator|Authentication|autentic/i.test(String(e.message))) {
            entry.result = "no enviado (dry-run)";
          } else {
            throw e;
          }
        }
      } else {
        const hass = embeddedHass();
        if (hass && typeof hass.callService === "function") {
          await hass.callService(domain, service, Object.assign({ entity_id: it.entity }, data));
          entry.result = "enviado como usuario";
        } else {
          const r = await transport.callService(domain, service, it.entity, data, false);
          entry.result = "enviado";
          if (r && r.called) entry.called = r.called;
        }
        sent = true;
      }
      toast((dryRun ? "[PRUEBA] " : "") + `${domain}.${service} → ${it.entity}`);
    } catch (e) {
      entry.result = "error: " + e.message;
      toast("Error: " + e.message);
    }
    callLog.push(entry);
    const logEl = $("callLog");
    if (logEl) logEl.textContent = callLog.slice(-30).map(callLogLine).join("\n");
    if (sent) {
      states[it.entity] = optimisticEntity(states[it.entity], it.entity, it.control, value);
      renderAll();
      refreshStatesSoon();
    }
  }

  function refreshStatesSoon() {
    if (!transport || typeof transport.refresh !== "function") return;
    const run = () => {
      try {
        const pending = transport.refresh();
        if (pending && typeof pending.then === "function") {
          pending.catch((e) => console.error("EnergyTransport: state refresh failed", e));
        }
      } catch (e) {
        console.error("EnergyTransport: state refresh failed", e);
      }
    };
    run();
    setTimeout(run, 500);
  }

  function setConn(st) {
    const c = $("conn");
    if (!c) return;
    c.classList.toggle("on", st === "connected");
    c.classList.toggle("stale", st === "connecting");
    $("connText").textContent = {
      connected: "En vivo",
      connecting: "Conectando…",
      disconnected: "Sin conexión",
      auth_invalid: "Token no válido",
      error: "Error",
    }[st] || st;
  }

  function onStates(list) {
    applyStates(states, list);
    renderAll();
  }

  async function refreshFlow() {
    if (!window.FlowView) return;
    try {
      const root = (window.HADomotics && window.HADomotics.panelRoot) ? window.HADomotics.panelRoot() : "";
      const r = await fetch(root + "/api/energy/flow", { cache: "no-store" });
      if (!r.ok) return;
      window.FlowView.render(await r.json());
    } catch (_) { /* el diagrama se queda en el último valor */ }
  }

  function start() {
    if (transport) transport.stop();
    const ids = Object.keys(itemByEntity);
    const hass = embeddedHass();
    if (hass && hass.states) transport = EnergyTransport.Embedded({ entityIds: ids, getHass: embeddedHass });
    else transport = EnergyTransport.Addon({ entityIds: ids });
    transport.on("status", setConn);
    transport.on("states", onStates);
    transport.on("tick", () => { if (activeTab === "flujo") refreshFlow(); });
    transport.start();
    refreshFlow();
    if (flowTimer) clearInterval(flowTimer);
    flowTimer = setInterval(refreshFlow, 2000);
  }

  function openSettings() {
    $("dryRun").checked = dryRun;
    $("modeInfo").textContent = "Los controles se ejecutan como tu usuario de Home Assistant. El modo prueba está activado por defecto y no envía servicios hasta que lo desmarques y pulses Guardar. Se recuerda en este navegador (hadomotics.energy.dryrun = 0 lo apaga).";
    $("settings").classList.remove("hidden");
  }

  function applyDry() {
    const b = $("dryBanner");
    if (b) b.classList.toggle("hidden", !dryRun);
  }

  async function init() {
    const root = (window.HADomotics && window.HADomotics.panelRoot) ? window.HADomotics.panelRoot() : "";
    const r = await fetch(root + "/api/energy/map", { cache: "no-store" });
    if (!r.ok) {
      setConn("disconnected");
      return;
    }
    MAP = await r.json();
    itemByEntity = {};
    allItems().forEach((it) => { itemByEntity[it.entity] = it; });
    buildUI();
    applyDry();
    $("btnSettings").onclick = openSettings;
    $("btnClose").onclick = () => $("settings").classList.add("hidden");
    $("btnSave").onclick = () => {
      dryRun = $("dryRun").checked;
      localStorage.setItem(LS.dry, dryRun ? "1" : "0");
      applyDry();
      if (!dryRun) toast("Modo prueba desactivado: los controles se enviarán a Home Assistant");
      $("settings").classList.add("hidden");
    };
    started = true;
    start();
    setInterval(renderDecision, 60000);
  }

  window.HADomoticsEnergy = {
    states: states,
    callLog: callLog,
    showTab: showTab,
    refreshFlow: refreshFlow,
    ensureStarted: function () { if (started) refreshFlow(); },
    applyStates: applyStates,
    optimisticEntity: optimisticEntity,
    madridClock: madridClock,
    madridWeekdayIndex: madridWeekdayIndex,
    callLogLine: callLogLine,
    get dryRun() { return dryRun; },
    get mode() { return transport ? transport.kind : "addon"; },
  };
  document.addEventListener("DOMContentLoaded", init);
})();
