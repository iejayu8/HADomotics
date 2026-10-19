/* HADomotics Energía — UI. Cliente fino:
 *  - Todo dato mostrado viene en vivo de HA (ABRP, Helios, decisión/motivo, EVSE, inversor, batería).
 *  - No se persiste ni se calcula ningún dato sincronizado: el estado solo vive en memoria como espejo.
 *  - Solo son editables los controles deliberados del mapa (input_boolean / input_number / input_select).
 *  - Sin actualización optimista: el control refleja el valor cuando HA lo confirma. */
"use strict";

(function () {
  const LS = { url: "hadomotics.energy.url", token: "hadomotics.energy.token", dry: "hadomotics.energy.dryrun" };
  const $ = (id) => document.getElementById(id);
  const states = {};           // espejo en memoria de HA (no se guarda)
  const callLog = [];
  window.__callLog = callLog;  // para tests
  let MAP = null, transport = null, mode = "direct", activeTab = "coche";
  let dryRun = localStorage.getItem(LS.dry) !== "0";  // por defecto: modo prueba

  const SERVICE_FOR = {
    toggle: (eid, on) => [eid.split(".")[0], on ? "turn_on" : "turn_off", {}],
    number: (eid, v) => [eid.split(".")[0], "set_value", { value: v }],
    select: (eid, o) => [eid.split(".")[0], "select_option", { option: o }],
  };

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
  function toast(t) { const el = $("toast"); el.textContent = t; el.classList.remove("hidden"); clearTimeout(toast._t); toast._t = setTimeout(() => el.classList.add("hidden"), 3500); }
  function isNA(s) { return !s || s.state == null || s.state === "unavailable" || s.state === "unknown" || s.state === ""; }

  function fmt(it, s) {
    if (!s) return { txt: "sin dato", na: true };
    if (isNA(s)) return { txt: s.state === "unknown" ? "desconocido" : "no disponible", na: true };
    const dom = it.entity.split(".")[0];
    let v = s.state;
    if (it.format === "datetime" || (s.attributes && s.attributes.device_class === "timestamp")) {
      const d = new Date(v);
      if (!isNaN(d)) return { txt: d.toLocaleString("es-ES", { timeZone: "Europe/Madrid", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) };
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

  /* ---------- render ---------- */
  function allItems() { const o = []; MAP.screens.forEach((sc) => sc.sections.forEach((se) => se.items.forEach((it) => o.push(it)))); return o; }

  function buildUI() {
    const main = $("screens"), tabs = $("tabs");
    main.innerHTML = ""; tabs.innerHTML = "";
    const icons = { coche: "🚗", solar: "☀️", bateria: "🔋", planos: "🏠" };
    MAP.screens.concat([{ id: "planos", title: "Planos", sections: [] }]).forEach((sc) => {
      const b = document.createElement("button");
      b.dataset.tab = sc.id; b.innerHTML = `<span class="ic">${icons[sc.id] || "•"}</span>${esc(sc.title)}`;
      b.onclick = () => showTab(sc.id);
      tabs.appendChild(b);
      const div = document.createElement("section");
      div.className = "screen"; div.id = "screen-" + sc.id;
      if (sc.id === "planos") {
        div.innerHTML = `<div class="card planos"><h3>Planos HADomotics</h3>${mode === "addon"
          ? '<p>Los planos interactivos siguen en el panel del add-on.</p><p><a href="./">Abrir planos</a></p>'
          : '<p class="muted">Los planos interactivos viven en el add-on HADomotics (panel ingress). En la app móvil se integrarán en la fase 3 vía API del add-on.</p>'}</div>`;
      }
      sc.sections.forEach((se) => {
        const card = document.createElement("div");
        card.className = "card"; card.dataset.kind = se.kind || "";
        card.innerHTML = `<h3>${esc(se.title)}</h3>`;
        if (se.kind === "decision") {
          card.innerHTML += `<div class="decision" id="decTitle">…</div><div class="motivo" id="decMotivo"></div>`;
        } else {
          se.items.forEach((it) => {
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
    document.querySelectorAll(".screen").forEach((s) => s.classList.toggle("active", s.id === "screen-" + id));
    document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === id));
  }

  function renderDecision() {
    const t = $("decTitle"), m = $("decMotivo");
    if (!t) return;
    const toda = states["input_boolean.carga_coche_toda_la_noche"], inst = states["input_boolean.carga_instantanea_tesla"];
    const dec = states["sensor.carga_decision_noche"], mot = states["sensor.carga_decision_motivo"];
    let cls = "na", txt;
    if (inst && inst.state === "on") { txt = "⚡ CARGA INSTANTÁNEA ACTIVA"; cls = "noche"; }
    else if (toda && toda.state === "on") { txt = "🔌 TODA LA NOCHE (5 kW hasta el amanecer)"; cls = "noche"; }
    else if (isNA(dec)) txt = "⚠️ DECISIÓN NO DISPONIBLE (falta dato en HA: no se programa carga)";
    else if (dec.state === "cargar_noche") { txt = "🌙 CARGAR ESTA NOCHE (03:30–05:00, 5 kW)"; cls = "noche"; }
    else if (dec.state === "esperar_sol") { txt = "☀️ ESPERAR AL SOL (excedente de día)"; cls = "sol"; }
    else txt = dec.state;
    t.textContent = txt; t.className = "decision " + cls;
    m.textContent = isNA(mot) ? "" : mot.state;
  }

  function renderRow(row) {
    const eid = row.dataset.entity, s = states[eid], it = itemByEntity[eid];
    const val = row.querySelector(".val");
    const ctl = row.dataset.control;
    const today = (new Date().getDay() + 6) % 7;
    if (row.dataset.weekday != null) {
      const wd = Number(row.dataset.weekday);
      row.classList.toggle("today", wd === today);
      row.classList.toggle("tomorrow", wd === (today + 1) % 7);
    }
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
        val.innerHTML = `<span class="numctl"><input type="number" inputmode="decimal"><button>Aplicar</button></span>`;
        inp = val.querySelector("input");
        val.querySelector("button").onclick = () => {
          const n = Number(String(inp.value).replace(",", "."));
          const lo = Number(a.min), hi = Number(a.max);
          if (isNaN(n) || (!isNaN(lo) && n < lo) || (!isNaN(hi) && n > hi)) { toast(`Valor fuera de rango (${a.min}–${a.max} ${a.unit_of_measurement || ""})`); return; }
          request(it, n);
        };
      }
      inp.min = a.min; inp.max = a.max; inp.step = a.step || "any";
      if (document.activeElement !== inp) inp.value = s.state;
      inp.title = `${a.min}–${a.max} ${a.unit_of_measurement || ""}`;
    } else if (ctl === "select") {
      const opts = a.options || [];
      let seg = val.querySelector(".seg");
      if (!seg || seg.dataset.opts !== opts.join("|")) {
        val.innerHTML = `<span class="seg" data-opts="${esc(opts.join("|"))}">${opts.map((o) => `<button data-o="${esc(o)}">${esc(o)}</button>`).join("")}</span>`;
        seg = val.querySelector(".seg");
        seg.querySelectorAll("button").forEach((b) => (b.onclick = () => { if (states[eid].state !== b.dataset.o) request(it, b.dataset.o); }));
      }
      seg.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.o === s.state));
    }
  }

  let itemByEntity = {};
  function renderAll() {
    document.querySelectorAll(".item[data-entity]").forEach(renderRow);
    renderDecision();
  }

  /* ---------- controles ---------- */
  function confirmDlg(text) {
    return new Promise((res) => {
      $("confirmText").textContent = text; $("confirm").classList.remove("hidden");
      const done = (v) => { $("confirm").classList.add("hidden"); res(v); };
      $("confirmYes").onclick = () => done(true); $("confirmNo").onclick = () => done(false);
    });
  }

  async function request(it, value) {
    const [domain, service, data] = SERVICE_FOR[it.control](it.entity, value);
    if (it.confirm) {
      const ok = await confirmDlg(`${it.label}: ${value === true ? "activar" : value === false ? "desactivar" : value}?`);
      if (!ok) return;
    }
    const entry = { ts: new Date().toISOString(), dry_run: dryRun, domain, service, entity_id: it.entity, data };
    try {
      if (dryRun && transport.kind === "direct") {
        entry.result = "no enviado (dry-run)";
      } else {
        const r = await transport.callService(domain, service, it.entity, data, dryRun);
        entry.result = dryRun ? (r && r.would_call ? "validado por el add-on, no enviado" : "dry-run") : "enviado";
        if (r && r.would_call) entry.would_call = r.would_call;
      }
      toast((dryRun ? "[PRUEBA] " : "") + `${domain}.${service} → ${it.entity}`);
    } catch (e) {
      entry.result = "error: " + e.message; toast("Error: " + e.message);
    }
    callLog.push(entry);
    console.log((dryRun ? "[DRY-RUN] " : "[CALL] ") + JSON.stringify(entry));
    $("callLog").textContent = callLog.slice(-30).map((c) => `${c.ts.slice(11, 19)} ${c.dry_run ? "DRY " : ""}${c.domain}.${c.service} ${c.entity_id} ${JSON.stringify(c.data)} → ${c.result}`).join("\n");
  }

  /* ---------- conexión ---------- */
  function setConn(st, info) {
    const c = $("conn");
    c.classList.toggle("on", st === "connected");
    c.classList.toggle("stale", st === "connecting");
    $("connText").textContent = { connected: "En vivo", connecting: "Conectando…", disconnected: "Sin conexión", auth_invalid: "Token no válido", error: "Error" }[st] || st;
    if (st === "auth_invalid") toast("Token de HA no válido: revisa Ajustes");
  }

  function onStates(list) {
    list.forEach((s) => {
      if (s._removed) { delete states[s.entity_id]; return; }
      if (s._delta && states[s.entity_id]) {
        const cur = states[s.entity_id];
        if (s.state !== undefined) cur.state = s.state;
        if (s.attributes) cur.attributes = Object.assign({}, cur.attributes, s.attributes);
        (s.attrs_removed || []).forEach((k) => delete cur.attributes[k]);
        if (s.last_updated) cur.last_updated = s.last_updated;
      } else states[s.entity_id] = { entity_id: s.entity_id, state: s.state, attributes: s.attributes || {}, last_updated: s.last_updated };
    });
    renderAll();
  }

  async function detectMode() {
    if (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) return "direct";
    if (window.HADOMOTICS_FORCE_MODE) return window.HADOMOTICS_FORCE_MODE;
    try {
      const r = await fetch("api/energy/map", { cache: "no-store" });
      if (r.ok) { const j = await r.json(); if (j && j.screens) { MAP = j; return "addon"; } }
    } catch (_) {}
    return "direct";
  }

  function start() {
    if (transport) transport.stop();
    const ids = Object.keys(itemByEntity);
    if (mode === "addon") transport = EnergyTransport.Addon({ entityIds: ids, base: "" });
    else {
      const url = localStorage.getItem(LS.url), token = localStorage.getItem(LS.token);
      if (!url || !token) { setConn("disconnected"); openSettings(); return; }
      transport = EnergyTransport.DirectHA({ url, token, entityIds: ids });
    }
    transport.on("status", setConn);
    transport.on("states", onStates);
    transport.start();
  }

  function openSettings() {
    $("haUrl").value = localStorage.getItem(LS.url) || "";
    $("haToken").value = "";
    $("haToken").placeholder = localStorage.getItem(LS.token) ? "•••••• (guardado; vacío = mantener)" : "(se guarda solo en este dispositivo)";
    $("dryRun").checked = dryRun;
    $("directFields").style.display = mode === "direct" ? "" : "none";
    $("modeInfo").textContent = mode === "direct"
      ? "Modo directo: la app habla con la API websocket de Home Assistant con tu token."
      : "Modo add-on: datos y controles pasan por el add-on HADomotics (sesión de HA, sin token propio).";
    $("settings").classList.remove("hidden");
  }

  function applyDry() { $("dryBanner").classList.toggle("hidden", !dryRun); }

  async function init() {
    mode = await detectMode();
    if (!MAP) MAP = await (await fetch("energy_map.json")).json();
    itemByEntity = {}; allItems().forEach((it) => (itemByEntity[it.entity] = it));
    buildUI(); applyDry();
    $("btnSettings").onclick = openSettings;
    $("btnClose").onclick = () => $("settings").classList.add("hidden");
    $("btnSave").onclick = () => {
      const u = $("haUrl").value.trim(), t = $("haToken").value.trim();
      if (u) localStorage.setItem(LS.url, u);
      if (t) localStorage.setItem(LS.token, t);
      dryRun = $("dryRun").checked; localStorage.setItem(LS.dry, dryRun ? "1" : "0"); applyDry();
      $("settings").classList.add("hidden");
      start();
    };
    start();
    setInterval(renderDecision, 60000);
  }
  window.HADomoticsEnergy = { states, callLog, showTab, get mode() { return mode; }, get dryRun() { return dryRun; } };
  document.addEventListener("DOMContentLoaded", init);
})();
