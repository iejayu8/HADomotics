/* Ajustes y asistente de primera configuración de la app Android (sin Home Assistant).
 * Todo pasa por la misma API local (/api/standalone/*): las claves de Tuya se
 * envían una vez al almacén seguro nativo y nunca se vuelven a mostrar. */
(function () {
  "use strict";
  const $ = (s, el) => (el || document).querySelector(s);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const api = async (method, path, body) => {
    const r = await fetch(path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  };
  const plugins = (window.Capacitor && window.Capacitor.Plugins) || {};
  const REGIONS = [["eu", "Europa central (eu)"], ["eu-w", "Europa occidental (eu-w)"], ["us", "EE. UU. oeste (us)"], ["us-e", "EE. UU. este (us-e)"], ["in", "India (in)"], ["cn", "China (cn)"], ["sg", "Singapur (sg)"]];
  const SEC_CLASSES = ["motion", "occupancy", "door", "window", "opening"];

  function toast(msg, type) {
    const t = document.createElement("div");
    t.className = "hdx-toast " + (type || "");
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3500);
  }

  let states = [];
  let settings = null;
  let status = null;
  async function refreshData() {
    [states, settings, status] = await Promise.all([api("GET", "/api/ha/states"), api("GET", "/api/standalone/settings"), api("GET", "/api/standalone/status")]);
  }
  const byDomain = (d) => states.filter((s) => s.entity_id.startsWith(d + "."));
  const fname = (s) => (s.attributes && s.attributes.friendly_name) || s.entity_id;
  const securitySensors = () => byDomain("binary_sensor").filter((s) => SEC_CLASSES.includes((s.attributes || {}).device_class));
  const options = (list, sel, empty) => (empty ? `<option value="">${esc(empty)}</option>` : "") + list.map((s) => `<option value="${esc(s.entity_id)}" ${s.entity_id === sel ? "selected" : ""}>${esc(fname(s))} · ${esc(s.entity_id)}</option>`).join("");

  // ------------------------------------------------------------ hoja de ajustes
  const sheet = document.createElement("div");
  sheet.className = "hdx-sheet";
  sheet.hidden = true;
  sheet.innerHTML = `<div class="hdx-panel" role="dialog" aria-label="Ajustes de la app">
    <div class="hdx-head"><span class="material-icons">settings</span><h2>Ajustes de la app</h2><button class="hdx-x" aria-label="Cerrar">×</button></div>
    <nav class="hdx-tabs"></nav><div class="hdx-body"></div></div>`;
  const TABS = [["estado", "Estado"], ["modulos", "Módulos"], ["tuya", "Tuya"], ["dispositivos", "Dispositivos"], ["alarma", "Alarma"], ["energia", "Energía"], ["cargador", "Cargador VE"], ["fondo", "Segundo plano"], ["copia", "Copia"], ["ayuda", "Ayuda"]];
  // Pestañas de ajustes que pertenecen a un módulo: si está desactivado, no aparecen.
  const TAB_MODULE = { dispositivos: "dispositivos", cargador: "dispositivos", alarma: "seguridad", fondo: "seguridad", energia: "energia" };
  const MODULES = [
    ["dispositivos", "devices", "Dispositivos", "Planos con luces, enchufes, persianas, escenas… y el coche/cargador en el plano."],
    ["energia", "bolt", "Energía", "Red, solar, batería y consumo, con el diagrama de flujo."],
    ["seguridad", "shield", "Seguridad", "Alarma propia (Noche / Ausente), zonas, sirena, avisos y sensores en los planos."],
  ];
  const mods = () => (status && status.modules) || (window.HDModules && window.HDModules.current) || { dispositivos: true, energia: true, seguridad: true };
  const tabVisible = (k) => !TAB_MODULE[k] || mods()[TAB_MODULE[k]];
  const moduleChecks = (sel, prefix) => `<div class="hdx-mods">${MODULES.map(([k, icon, label, desc]) => `<label class="hdx-mod ${sel[k] ? "on" : ""}"><input type="checkbox" data-mod="${k}" id="${prefix}${k}" ${sel[k] ? "checked" : ""}><span class="material-icons">${icon}</span><span><b>${label}</b><small>${desc}</small></span></label>`).join("")}</div>`;
  const readModules = (root) => { const m = {}; MODULES.forEach(([k]) => { const c = root.querySelector(`input[data-mod="${k}"]`); m[k] = !!(c && c.checked); }); return m; };
  const anyModule = (m) => MODULES.some(([k]) => m[k]);
  let tab = "estado";
  sheet.addEventListener("click", (e) => { if (e.target === sheet || e.target.closest(".hdx-x")) close(); });

  async function open(which) {
    if (which) tab = which;
    sheet.hidden = false;
    await render();
  }
  function close() { sheet.hidden = true; }

  async function render() {
    try { await refreshData(); } catch (e) { toast(e.message, "error"); }
    if (!tabVisible(tab)) tab = "estado";
    $(".hdx-tabs", sheet).innerHTML = TABS.filter(([k]) => tabVisible(k)).map(([k, l]) => `<button data-t="${k}" class="${k === tab ? "on" : ""}">${l}</button>`).join("");
    $(".hdx-tabs", sheet).onclick = (e) => { const b = e.target.closest("button[data-t]"); if (b) { tab = b.dataset.t; render(); } };
    const body = $(".hdx-body", sheet);
    body.innerHTML = VIEWS[tab]();
    if (BIND[tab]) BIND[tab](body);
  }

  const save = async (patch, reload) => {
    await api("PUT", "/api/standalone/settings", patch);
    toast("Guardado");
    if (reload) setTimeout(() => location.reload(), 600);
  };

  const VIEWS = {
    estado() {
      const s = status || {};
      const modeTxt = { demo: "Demostración (casa simulada)", tuya: "Tuya Cloud (tu cuenta)", unconfigured: "Sin configurar" }[s.mode] || s.mode;
      const used = s.budget ? s.budget.calls : 0;
      return `<div class="hdx-grid">
        <div class="hdx-stat"><b>${esc(modeTxt)}</b><span>Modo</span></div>
        <div class="hdx-stat"><b>${s.connected ? "Conectado" : "Sin conexión"}</b><span>Tuya Cloud</span></div>
        <div class="hdx-stat"><b>${s.devices || 0}</b><span>dispositivos · ${s.entities || 0} entidades</span></div>
        <div class="hdx-stat"><b>${used} / ${esc(s.budget_month)}</b><span>llamadas a la API este mes</span></div>
        <div class="hdx-stat"><b>${Number.isFinite(s.next_poll_s) ? s.next_poll_s + " s" : "pausado"}</b><span>sondeo (según cuota)</span></div>
        ${mods().seguridad ? `<div class="hdx-stat"><b>${esc(s.alarm)}</b><span>alarma</span></div>` : ""}
      </div>
      ${s.last_error ? `<div class="hdx-note">Último error: ${esc(s.last_error)}</div>` : ""}
      ${s.secure_storage ? `<div class="hdx-note hdx-ok">Claves guardadas en el almacén seguro del sistema (Android Keystore).</div>` : `<div class="hdx-note">Sin almacén seguro nativo (navegador): las claves solo se guardarían en memoria. Usa la app Android.</div>`}
      <div class="hdx-actions"><button class="hdx-btn primary" data-a="poll"><span class="material-icons">sync</span>Actualizar ahora</button>
      <button class="hdx-btn" data-a="discover"><span class="material-icons">travel_explore</span>Buscar dispositivos</button>
      <button class="hdx-btn" data-a="wizard"><span class="material-icons">school</span>Asistente</button></div>
      ${mods().seguridad ? `<h3>Registro de la alarma</h3><p>${(s.alarm_log || []).slice().reverse().map((l) => `${esc(new Date(l.t).toLocaleString("es-ES", { timeZone: "Europe/Madrid" }))} — ${esc(l.text)}`).join("<br>") || "Sin eventos."}</p>` : ""}`;
    },
    modulos() {
      return `<p>Elige qué partes de la app usas. Lo que desactives desaparece del todo (pestaña, botón y ajustes) y no trabaja en segundo plano: sin <b>Seguridad</b> no corre el motor de alarma ni la vigilancia con la app cerrada; sin <b>Energía</b> no se calcula ni se sondea su flujo.</p>
      ${moduleChecks(mods(), "hdxMod_")}
      <div class="hdx-note">Deja al menos uno activo. Con uno solo, la app abre directamente esa vista.${mods().seguridad ? " Para desactivar Seguridad, la alarma tiene que estar desarmada." : ""}</div>
      <div class="hdx-actions"><button class="hdx-btn primary" data-a="savemodules">Guardar módulos</button></div>`;
    },
    tuya() {
      const t = (settings && settings.tuya) || {};
      return `${GUIDE}
      <h3>Tus claves</h3>
      <label class="hdx-field">Centro de datos (el de tu cuenta Smart Life)<select id="hdxRegion">${REGIONS.map(([v, l]) => `<option value="${v}" ${t.region === v ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      <label class="hdx-field">Access ID / Client ID<input id="hdxId" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="${t.configured ? "(guardado: escribe de nuevo para cambiarlo)" : "p. ej. 7xk2…"}"></label>
      <label class="hdx-field">Access Secret / Client Secret<input id="hdxSecret" type="password" autocomplete="off" placeholder="${t.configured ? "(guardado, no se muestra)" : ""}"></label>
      <div class="hdx-actions"><button class="hdx-btn primary" data-a="savekeys">Guardar y conectar</button>
      ${t.configured ? `<button class="hdx-btn danger" data-a="delkeys">Borrar claves</button>` : ""}
      <button class="hdx-btn" data-a="demo">${status && status.mode === "demo" ? "Salir del modo demo" : "Probar en modo demo"}</button></div>
      <div class="hdx-note">Las claves se guardan cifradas en el móvil (Android Keystore). No salen del teléfono salvo hacia Tuya, no se incluyen en las copias de seguridad y no se muestran nunca.</div>`;
    },
    dispositivos() {
      return `<p>Dispositivos de tu cuenta Smart Life / Tuya (WiFi y Zigbee detrás de una pasarela Tuya). Para ponerlos en el plano: pestaña <b>Dispositivos</b> → lápiz → «+».</p>
      <div class="hdx-actions"><button class="hdx-btn primary" data-a="discover"><span class="material-icons">travel_explore</span>Buscar dispositivos</button></div>
      <ul class="hdx-devlist" id="hdxDevs"><li>Cargando…</li></ul>`;
    },
    alarma() {
      const a = (settings && settings.alarm) || {};
      const sensors = securitySensors();
      const zones = a.zones || [];
      return `<p>Motor de alarma propio (sustituye a Alarmo + Node-RED). <b>Noche</b> activa solo las zonas marcadas «Noche»; <b>Ausente</b> las activa todas; <b>Desarmar</b> las apaga y para la sirena. Las zonas se pueden cambiar a mano desde Seguridad → Zonas.</p>
      <div id="hdxZones">${zones.map((z, i) => zoneHtml(z, i, sensors)).join("") || `<div class="hdx-note">Aún no hay zonas. Pulsa «Proponer zonas».</div>`}</div>
      <div class="hdx-actions"><button class="hdx-btn" data-a="addzone"><span class="material-icons">add</span>Zona</button><button class="hdx-btn" data-a="autozones"><span class="material-icons">auto_fix_high</span>Proponer zonas</button></div>
      <h3>Tiempos</h3>
      <div class="hdx-row">Salida Noche <input type="number" id="hdxExitN" min="0" max="300" value="${esc((a.exit_delay || {}).armed_night)}"> s · Salida Ausente <input type="number" id="hdxExitA" min="0" max="300" value="${esc((a.exit_delay || {}).armed_away)}"> s</div>
      <div class="hdx-row">Entrada (por defecto) <input type="number" id="hdxEntry" min="0" max="300" value="${esc(a.entry_delay)}"> s · Disparo/sirena <input type="number" id="hdxTrig" min="10" max="3600" value="${esc(a.trigger_time)}"> s</div>
      <h3>Sirena</h3>
      <label class="hdx-field">Sirena Tuya (categoría sgbj)<select id="hdxSiren">${options(byDomain("siren"), (a.siren || {}).entity, "Sin sirena")}</select></label>
      <h3>Código</h3>
      <div class="hdx-row"><input type="text" inputmode="numeric" id="hdxCode" placeholder="${a.has_code ? "Código guardado (escribe uno nuevo para cambiarlo)" : "Sin código (4–10 cifras)"}" autocomplete="off">
      <label><input type="checkbox" id="hdxCodeArm" ${a.code_arm_required ? "checked" : ""}> pedir también al armar</label>
      ${a.has_code ? `<button class="hdx-btn danger" data-a="delcode">Quitar código</button>` : ""}</div>
      <p>Solo se guarda un hash con sal del código (PBKDF2), nunca el código.</p>
      <div class="hdx-actions"><button class="hdx-btn primary" data-a="savealarm">Guardar alarma</button></div>`;
    },
    energia() {
      const e = (settings && settings.energy) || {};
      const power = byDomain("sensor").filter((s) => (s.attributes || {}).device_class === "power");
      const en = byDomain("sensor").filter((s) => (s.attributes || {}).device_class === "energy");
      const pct = byDomain("sensor").filter((s) => (s.attributes || {}).device_class === "battery");
      const f = (k, label, list) => `<label class="hdx-field">${label}<select data-k="${k}">${options(list, e[k], "—")}</select></label>`;
      const sw = byDomain("switch");
      return `<p>Elige qué sensor es cada cosa. Sin inversor, «Casa» se calcula como red + solar + batería.</p>
      ${f("grid_power", "Red (W, + importación / − exportación)", power)}${f("pv_power", "Solar (W)", power)}${f("battery_power", "Batería (W, + descarga)", power)}${f("battery_soc", "Batería (%)", pct)}
      ${f("aux_power", "Consumo destacado (W, p. ej. cargador VE)", power)}
      ${f("grid_import_daily", "Importación diaria (kWh)", en)}${f("load_daily", "Consumo diario (kWh)", en)}
      <h3>Controles en Energía</h3><div class="hdx-sensors">${sw.map((s) => `<label class="hdx-chip ${(e.controls || []).includes(s.entity_id) ? "on" : ""}"><input type="checkbox" data-ctl="${esc(s.entity_id)}" ${(e.controls || []).includes(s.entity_id) ? "checked" : ""}>${esc(fname(s))}</label>`).join(" ")}</div>
      <h3>Cuota de Tuya</h3><div class="hdx-row">Llamadas al mes <input type="number" id="hdxBudget" min="1000" value="${esc(settings.poll.budget_month)}"> · sondeo mínimo <input type="number" id="hdxPollMin" min="15" value="${esc(settings.poll.foreground_s)}"> s</div>
      <p>La edición gratuita (Trial) de Tuya IoT Core da unas 26.000 llamadas al mes; la app reparte el sondeo para no pasarse (deja un 20 % para órdenes).</p>
      <div class="hdx-actions"><button class="hdx-btn primary" data-a="saveenergy">Guardar</button></div>`;
    },
    cargador() {
      const v = (settings && settings.evse) || {};
      const power = byDomain("sensor").filter((s) => (s.attributes || {}).device_class === "power");
      return `<p>Coche y cable animado en el plano de Dispositivos: el cable muestra flujo verde cuando la potencia de carga supera el umbral (o el estado es «Charging»).</p>
      <label class="hdx-row"><input type="checkbox" id="hdxEvOn" ${v.enabled ? "checked" : ""}> Mostrar coche y cable</label>
      <label class="hdx-field">Planta<select id="hdxEvFloor"></select></label>
      <label class="hdx-field">Potencia de carga<select id="hdxEvPower">${options(power, v.power_entity, "—")}</select></label>
      <label class="hdx-field">Estado del cargador (opcional)<select id="hdxEvState">${options(byDomain("sensor"), v.state_entity, "—")}</select></label>
      <div class="hdx-row">Umbral <input type="number" id="hdxEvTh" value="${esc(v.threshold_w || 100)}"> W</div>
      <div class="hdx-row">Coche x <input type="number" step="0.01" id="hdxEvX" value="${esc(v.x ?? 0.6)}"> y <input type="number" step="0.01" id="hdxEvY" value="${esc(v.y ?? 0.2)}"> ancho <input type="number" step="0.01" id="hdxEvW" value="${esc(v.w ?? 0.27)}"> alto <input type="number" step="0.01" id="hdxEvH" value="${esc(v.h ?? 0.24)}"></div>
      <div class="hdx-row">Cargador x <input type="number" step="0.01" id="hdxEvFx" value="${esc(v.from_x ?? 0.58)}"> y <input type="number" step="0.01" id="hdxEvFy" value="${esc(v.from_y ?? 0.45)}"></div>
      <p>Coordenadas en fracción (0–1) del ancho y alto de la imagen del plano.</p>
      <div class="hdx-actions"><button class="hdx-btn primary" data-a="saveevse">Guardar</button></div>`;
    },
    fondo() {
      const b = (settings && settings.background) || {};
      const native = status && status.native;
      return `<p>Con la app cerrada, un <b>servicio en primer plano</b> de Android (notificación fija «HADomotics vigilando») sigue recibiendo los cambios de Tuya y hace sonar la sirena y avisa si salta la alarma.</p>
      ${native ? "" : `<div class="hdx-note">Solo disponible en la app Android instalada.</div>`}
      <label class="hdx-row"><input type="checkbox" id="hdxBgOn" ${b.enabled ? "checked" : ""} ${native ? "" : "disabled"}> Vigilar en segundo plano mientras la alarma esté armada</label>
      <label class="hdx-row"><input type="checkbox" id="hdxPulsar" ${b.pulsar ? "checked" : ""} ${native ? "" : "disabled"}> Recibir cambios al instante (servicio de mensajes de Tuya, «Message Service», experimental). Si no conecta, se vuelve al sondeo.</label>
      <div class="hdx-row">Sondeo en segundo plano cada <input type="number" min="60" step="10" id="hdxBgPoll" value="${esc(b.poll_s || 180)}"> s (solo sensores de alarma; 180 s ≈ 14.400 llamadas/mes si está armada todo el mes)</div>
      <div class="hdx-actions"><button class="hdx-btn primary" data-a="savebg" ${native ? "" : "disabled"}>Guardar</button>
      <button class="hdx-btn" data-a="perm" ${native ? "" : "disabled"}>Permitir notificaciones</button>
      <button class="hdx-btn" data-a="battery" ${native ? "" : "disabled"}>Quitar optimización de batería</button></div>
      <div class="hdx-note"><b>Límites reales:</b> un móvil no es una centralita 24/7. Android puede retrasar o matar el servicio (modo Doze, ahorro de batería del fabricante: OnePlus, Xiaomi, Samsung…). Sin el servicio de mensajes, la detección depende del sondeo (cada ~2 min con la cuota gratuita) y un PIR que vuelve a reposo antes puede no verse. Para una alarma fiable usa una tablet o móvil dedicado, enchufado, con la optimización de batería quitada, o deja también la sirena/escenas en la propia app Smart Life.</div>`;
    },
    copia() {
      return `<p>Exporta planos, elementos, posiciones de Seguridad y ajustes (sin claves ni código). El formato es compatible con «Export/Import» del add-on.</p>
      <div class="hdx-actions"><button class="hdx-btn primary" data-a="export"><span class="material-icons">download</span>Exportar</button>
      <label class="hdx-btn"><span class="material-icons">upload</span>Importar<input type="file" id="hdxImport" accept="application/json,.json" hidden></label></div>`;
    },
    ayuda() { return GUIDE + `<h3>Zigbee que no es Tuya</h3><p>Los sensores Zigbee de otras marcas funcionan si los emparejas con una <b>pasarela Zigbee de Tuya</b> (muchos genéricos lo admiten). Una pasarela Zigbee2MQTT o un dongle USB directo al móvil quedan para la fase 2 (ver docs/android/README.md).</p>`; },
  };

  const GUIDE = `<h3>Cómo conectar tu cuenta Tuya (una vez, ~10 min)</h3><ol>
    <li>Instala <b>Smart Life</b> (o Tuya Smart) y añade ahí tus enchufes, luces, sensores y la <b>pasarela Zigbee</b> con sus sensores.</li>
    <li>En un ordenador entra en <code>platform.tuya.com</code> (iot.tuya.com), crea una cuenta y luego <b>Cloud → Development → Create Cloud Project</b>: tipo «Smart Home», el centro de datos de tu cuenta (en España: «Central Europe»).</li>
    <li>En el proyecto, pestaña <b>Service API</b>: deja «IoT Core», «Authorization» y, para la alarma al instante, «Message Service».</li>
    <li>Pestaña <b>Devices → Link App Account → Add App Account</b>: aparece un QR. En Smart Life: <i>Yo → icono de escanear</i> y escanéalo. Tus dispositivos aparecen en el proyecto.</li>
    <li>En <b>Overview</b> copia el <b>Access ID</b> y el <b>Access Secret</b> y pégalos aquí.</li></ol>
    <p>La cuenta gratuita (Trial) de IoT Core se renueva cada mes desde la web de Tuya y da ~26.000 llamadas/mes.</p>`;

  function zoneHtml(z, i, sensors) {
    return `<div class="hdx-zone" data-i="${i}" data-id="${esc(z.id || "")}">
      <div class="hdx-row"><input type="text" class="zname" value="${esc(z.name)}" placeholder="Nombre de la zona">
      <label><input type="checkbox" class="znight" ${z.night ? "checked" : ""}> Noche</label>
      Entrada <input type="number" class="zentry" min="0" max="300" style="width:70px" value="${z.entry_delay ?? ""}" placeholder="—"> s
      <button class="hdx-btn danger zdel" title="Quitar zona">×</button></div>
      <div class="hdx-sensors">${sensors.map((s) => { const on = (z.sensors || []).includes(s.entity_id); return `<label class="hdx-chip ${on ? "on" : ""}"><input type="checkbox" class="zs" value="${esc(s.entity_id)}" ${on ? "checked" : ""}>${esc(fname(s))}</label>`; }).join("") || "<small>No hay sensores de movimiento/puerta.</small>"}</div></div>`;
  }

  function readZones(body) {
    const used = new Set();
    return [...body.querySelectorAll(".hdx-zone")].map((el, i) => {
      const name = el.querySelector(".zname").value.trim() || `Zona ${i + 1}`;
      // Se conserva el id existente (renombrar no pierde el estado de la zona); ids únicos.
      const base = el.dataset.id || window.HDX.tuyaMapper.slug(name) || "zona";
      let id = base;
      for (let n = 2; used.has(id); n++) id = `${base}_${n}`;
      used.add(id);
      const entry = el.querySelector(".zentry").value;
      return { id, name, night: el.querySelector(".znight").checked, entry_delay: entry === "" ? null : Number(entry), sensors: [...el.querySelectorAll(".zs:checked")].map((c) => c.value) };
    });
  }

  const BIND = {
    estado(body) { body.onclick = actions; },
    modulos(body) {
      body.onclick = actions;
      body.onchange = (e) => {
        const c = e.target.closest(".hdx-mod");
        if (c) c.classList.toggle("on", e.target.checked);
        const btn = $("[data-a=savemodules]", body);
        if (btn) btn.disabled = !anyModule(readModules(body));
      };
    },
    tuya(body) { body.onclick = actions; },
    async dispositivos(body) {
      body.onclick = actions;
      const devs = await api("GET", "/api/standalone/devices");
      $("#hdxDevs", body).innerHTML = devs.map((d) => `<li><span>${esc(d.name)}<br><small>${esc(d.category)}${d.sub ? " · Zigbee (pasarela)" : ""} · ${esc(d.entities.join(", ") || "sin entidades")}</small></span><span class="hdx-badge ${d.online ? "online" : "offline"}">${d.online ? "en línea" : "sin conexión"}</span></li>`).join("") || "<li>Sin dispositivos. Conecta Tuya y pulsa «Buscar dispositivos».</li>";
    },
    alarma(body) {
      body.onclick = actions;
      body.onchange = (e) => { const c = e.target.closest(".hdx-chip"); if (c) c.classList.toggle("on", e.target.checked); };
    },
    energia(body) { body.onclick = actions; },
    async cargador(body) {
      body.onclick = actions;
      const floors = await api("GET", "/api/floors");
      $("#hdxEvFloor", body).innerHTML = floors.map((f) => `<option value="${esc(f.id)}" ${settings.evse.floor_id === f.id ? "selected" : ""}>${esc(f.name)}</option>`).join("");
    },
    fondo(body) { body.onclick = actions; },
    copia(body) {
      body.onclick = actions;
      $("#hdxImport", body).onchange = async (e) => {
        const f = e.target.files[0];
        if (!f) return;
        try { await api("POST", "/api/restore", JSON.parse(await f.text())); toast("Importado"); setTimeout(() => location.reload(), 600); } catch (err) { toast("No se pudo importar: " + err.message, "error"); }
      };
    },
    ayuda() {},
  };

  async function actions(e) {
    const b = e.target.closest("[data-a]");
    if (!b) return;
    const body = $(".hdx-body", sheet);
    b.disabled = true;
    try {
      switch (b.dataset.a) {
        case "poll": await api("POST", "/api/standalone/poll"); toast("Actualizado"); break;
        case "savemodules": {
          const m = readModules(body);
          if (!anyModule(m)) { toast("Elige al menos un módulo", "error"); return; }
          await save({ modules: m }, true);
          return;
        }
        case "discover": { const r = await api("POST", "/api/standalone/discover"); toast(`${r.devices.length} dispositivos`); break; }
        case "wizard": close(); wizard.open(0); return;
        case "savekeys": {
          const id = $("#hdxId", body).value.trim(), secret = $("#hdxSecret", body).value.trim();
          if (!id || !secret) { toast("Escribe el Access ID y el Access Secret", "error"); break; }
          $("#hdxSecret", body).value = "";
          const r = await api("POST", "/api/standalone/credentials", { access_id: id, access_secret: secret, region: $("#hdxRegion", body).value });
          toast(r.ok ? "Conectado con Tuya" : "Guardado, pero no conecta: " + r.error, r.ok ? "" : "error");
          if (r.ok) await api("POST", "/api/standalone/discover");
          break;
        }
        case "delkeys": await api("DELETE", "/api/standalone/credentials"); toast("Claves borradas"); break;
        case "demo": await api("POST", "/api/standalone/demo", { enabled: !(status && status.mode === "demo") }); toast("Listo"); setTimeout(() => location.reload(), 500); return;
        case "addzone": { const zs = readZones(body); let nid = zs.length + 1; while (zs.some((z) => z.id === "zona_" + nid)) nid++; zs.push({ id: "zona_" + nid, name: "Zona " + (zs.length + 1), night: false, sensors: [] }); settings.alarm.zones = zs; await save({ alarm: { zones: zs } }); break; }
        case "autozones": {
          const seen = new Set();
          const uniq = (b) => { let id = b || "zona"; for (let n = 2; seen.has(id); n++) id = `${b}_${n}`; seen.add(id); return id; };
          const zs = securitySensors().map((s) => ({ id: uniq(window.HDX.tuyaMapper.slug(fname(s))), name: fname(s), night: /door|window|opening/.test(s.attributes.device_class), sensors: [s.entity_id] }));
          await save({ alarm: { zones: zs } });
          break;
        }
        case "savealarm": {
          const zones = readZones(body);
          b.closest(".hdx-body").querySelectorAll(".zdel").forEach(() => {});
          const patch = { alarm: {
            zones,
            exit_delay: { armed_night: Number($("#hdxExitN", body).value) || 0, armed_away: Number($("#hdxExitA", body).value) || 0 },
            entry_delay: Number($("#hdxEntry", body).value) || 0,
            trigger_time: Number($("#hdxTrig", body).value) || 180,
            siren: { entity: $("#hdxSiren", body).value || null },
            code_arm_required: $("#hdxCodeArm", body).checked,
          } };
          const code = $("#hdxCode", body).value.trim();
          if (code) patch.alarm.code = code;
          await save(patch, true);
          return;
        }
        case "delcode": await save({ alarm: { code: "" } }); break;
        case "saveenergy": {
          const energy = {};
          body.querySelectorAll("select[data-k]").forEach((s) => { energy[s.dataset.k] = s.value || null; });
          energy.controls = [...body.querySelectorAll("input[data-ctl]:checked")].map((c) => c.dataset.ctl);
          await save({ energy, poll: { budget_month: Number($("#hdxBudget", body).value) || 24000, foreground_s: Math.max(15, Number($("#hdxPollMin", body).value) || 60) } }, true);
          return;
        }
        case "saveevse": {
          const n = (id) => Number($(id, body).value);
          await save({ evse: { enabled: $("#hdxEvOn", body).checked, floor_id: $("#hdxEvFloor", body).value, power_entity: $("#hdxEvPower", body).value || null, state_entity: $("#hdxEvState", body).value || null, threshold_w: n("#hdxEvTh"), x: n("#hdxEvX"), y: n("#hdxEvY"), w: n("#hdxEvW"), h: n("#hdxEvH"), from_x: n("#hdxEvFx"), from_y: n("#hdxEvFy") } }, true);
          return;
        }
        case "savebg": await save({ background: { enabled: $("#hdxBgOn", body).checked, pulsar: $("#hdxPulsar", body).checked, poll_s: Math.max(60, Number($("#hdxBgPoll", body).value) || 180) } }); break;
        case "perm": if (plugins.HDAlarmService) await plugins.HDAlarmService.requestPermissions(); break;
        case "battery": if (plugins.HDAlarmService) await plugins.HDAlarmService.requestIgnoreBatteryOptimizations(); break;
        case "export": {
          const data = await api("GET", "/api/backup");
          const text = JSON.stringify(data, null, 1);
          const name = `hadomotics-android-${new Date().toISOString().slice(0, 10)}.json`;
          if (plugins.HDAlarmService && plugins.HDAlarmService.shareFile) await plugins.HDAlarmService.shareFile({ name, text });
          else { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], { type: "application/json" })); a.download = name; a.click(); }
          break;
        }
        default: break;
      }
      await render();
    } catch (err) {
      toast(err.message, "error");
    } finally { b.disabled = false; }
  }

  // ------------------------------------------------------------ asistente de primera vez
  const wizard = (() => {
    const el = document.createElement("div");
    el.className = "hdx-sheet hdx-wizard";
    el.hidden = true;
    let step = 0;
    // Módulos elegidos en el asistente. La primera vez no hay nada marcado: elige el usuario.
    let pick = { dispositivos: false, energia: false, seguridad: false };
    const finalStep = () => {
      const li = [];
      if (pick.dispositivos) li.push(`<li>Pestaña <b>Dispositivos</b> → lápiz → <b>sube la imagen del plano</b> de cada planta y pulsa «+» para colocar luces, enchufes, persianas, escenas… También fuera del dibujo.</li>`);
      if (pick.seguridad) {
        li.push(`<li><b>Seguridad</b>: los sensores de movimiento y puertas aparecen solos; colócalos con el lápiz.${pick.dispositivos ? "" : " Usa los planos que ya tengas (se suben en Dispositivos)."}</li>`);
        li.push(`<li><b>Ajustes → Alarma</b>: «Proponer zonas», marca cuáles se activan de <b>Noche</b>, elige la sirena y, si quieres, un código.</li>`);
        li.push(`<li><b>Ajustes → Segundo plano</b>: activa la vigilancia con la app cerrada.</li>`);
      }
      if (pick.energia) li.push(`<li><b>Ajustes → Energía</b>: elige qué sensor es la red, la solar y la batería.</li>`);
      li.push(`<li>Puedes cambiar los módulos cuando quieras en <b>Ajustes → Módulos</b>.</li>`);
      return `<h3>Últimos pasos</h3><ol>${li.join("")}</ol>`;
    };
    const STEPS = [
      { id: "intro", html: () => `<div class="hdx-hero material-icons">home</div><h2>HADomotics sin Home Assistant</h2>
        <p>Controla tus dispositivos <b>Tuya</b> (WiFi y Zigbee con pasarela Tuya) sobre el plano de tu casa, con alarma propia (Noche / Ausente, zonas, sirena y avisos) y vista de energía. Todo desde este móvil: no necesitas servidor.</p>
        <div class="hdx-note">Probado con dispositivos simulados. Aún no se ha probado con dispositivos Tuya reales.</div>` },
      { id: "modules", html: () => `<h3>¿Qué quieres usar?</h3>
        <p>Marca los módulos que vas a usar (al menos uno). Lo que no marques no aparecerá en la app ni trabajará en segundo plano. Lo puedes cambiar después en Ajustes → Módulos.</p>
        ${moduleChecks(pick, "wMod_")}` },
      { id: "guide", html: () => GUIDE },
      { id: "keys", html: () => `<h3>Tus claves de Tuya</h3>
        <label class="hdx-field">Centro de datos<select id="wRegion">${REGIONS.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select></label>
        <label class="hdx-field">Access ID<input id="wId" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
        <label class="hdx-field">Access Secret<input id="wSecret" type="password" autocomplete="off"></label>
        <p>Se guardan cifradas en el móvil (Android Keystore) y no se muestran nunca más.</p>
        <div class="hdx-actions"><button class="hdx-btn primary" data-w="keys">Conectar</button><button class="hdx-btn" data-w="demo">Usar casa de demostración</button></div>` },
      { id: "devices", html: () => `<h3>Tus dispositivos</h3><p>Buscando en tu cuenta…</p><ul class="hdx-devlist" id="wDevs"></ul>` },
      { id: "final", html: finalStep },
    ];
    const cur = () => STEPS[step].id;
    function render() {
      const last = step === STEPS.length - 1;
      const blocked = cur() === "modules" && !anyModule(pick);
      el.innerHTML = `<div class="hdx-panel"><div class="hdx-head"><h2>Primeros pasos</h2><button class="hdx-x" aria-label="Cerrar">×</button></div>
        <div class="hdx-steps">${STEPS.map((_, i) => `<i class="${i <= step ? "on" : ""}"></i>`).join("")}</div>
        <div class="hdx-body">${STEPS[step].html()}</div>
        <div class="hdx-body" style="padding-top:0"><div class="hdx-actions">${step > 0 ? `<button class="hdx-btn" data-w="back">Atrás</button>` : ""}
        ${cur() === "keys" ? "" : `<button class="hdx-btn primary" data-w="${last ? "finish" : "next"}" ${blocked ? "disabled" : ""}>${last ? "Empezar" : "Siguiente"}</button>`}</div>
        ${cur() === "modules" ? `<p class="hdx-hint" id="wModHint" ${blocked ? "" : "hidden"}>Elige al menos un módulo para continuar.</p>` : ""}</div></div>`;
      if (cur() === "devices") loadDevs();
    }
    async function loadDevs() {
      try {
        const r = await api("POST", "/api/standalone/discover");
        const ul = $("#wDevs", el);
        if (ul) ul.innerHTML = r.devices.map((d) => `<li><span>${esc(d.name)}<br><small>${esc(d.category)}${d.sub ? " · Zigbee" : ""}</small></span><span class="hdx-badge ${d.online ? "online" : "offline"}">${d.online ? "en línea" : "sin conexión"}</span></li>`).join("") || "<li>No hay dispositivos en la cuenta vinculada.</li>";
      } catch (err) { const ul = $("#wDevs", el); if (ul) ul.innerHTML = `<li>${esc(err.message)}</li>`; }
    }
    el.addEventListener("click", async (e) => {
      if (e.target.closest(".hdx-x")) { el.hidden = true; return; }
      const b = e.target.closest("[data-w]");
      if (!b) return;
      const w = b.dataset.w;
      try {
        if (w === "next" && cur() === "modules") {
          pick = readModules(el);
          if (!anyModule(pick)) { toast("Elige al menos un módulo", "error"); render(); return; }
          await api("PUT", "/api/standalone/settings", { modules: pick });
        }
        if (w === "next") step++;
        if (w === "back") step--;
        if (w === "keys") {
          const r = await api("POST", "/api/standalone/credentials", { access_id: $("#wId", el).value.trim(), access_secret: $("#wSecret", el).value.trim(), region: $("#wRegion", el).value });
          if (!r.ok) throw new Error(r.error || "no conecta");
          step++;
        }
        if (w === "demo") { await api("POST", "/api/standalone/demo", { enabled: true }); step++; }
        if (w === "finish") { await api("PUT", "/api/standalone/settings", { onboarded: true }); el.hidden = true; location.reload(); return; }
        render();
      } catch (err) { toast(err.message, "error"); }
    });
    el.addEventListener("change", (e) => {
      if (!e.target.matches || !e.target.matches("input[data-mod]")) return;
      pick = readModules(el);
      const c = e.target.closest(".hdx-mod");
      if (c) c.classList.toggle("on", e.target.checked);
      const btn = $("[data-w=next]", el);
      if (btn) btn.disabled = !anyModule(pick);
      const hint = $("#wModHint", el);
      if (hint) hint.hidden = anyModule(pick);
    });
    return {
      el,
      async open(s) {
        step = s || 0;
        // Primera vez: nada marcado. Si ya se eligieron (asistente abierto desde Ajustes), se muestran.
        const st = await api("GET", "/api/standalone/status").catch(() => null);
        pick = st && st.modules_chosen ? Object.assign({}, st.modules) : { dispositivos: false, energia: false, seguridad: false };
        el.hidden = false;
        render();
      },
    };
  })();

  // ------------------------------------------------------------ montaje
  function mount() {
    document.body.appendChild(sheet);
    document.body.appendChild(wizard.el);
    const nav = document.getElementById("appNav");
    if (nav && !document.getElementById("navAjustes")) {
      const b = document.createElement("button");
      b.type = "button";
      b.id = "navAjustes";
      b.innerHTML = `<span class="material-icons">settings</span>Ajustes`;
      b.addEventListener("click", () => open());
      nav.appendChild(b);
    }
    const ready = (window.HDStandalone && window.HDStandalone.ready) || Promise.resolve();
    ready.then(async () => {
      const st = await api("GET", "/api/standalone/status").catch(() => null);
      if (st && st.mode === "demo") {
        const ban = document.createElement("div");
        ban.className = "hdx-demo-banner";
        ban.textContent = "DEMO";
        ban.title = "Modo demo: dispositivos simulados";
        document.body.appendChild(ban);
      }
      if (st && !st.onboarded && !/[?&]nowizard/.test(location.search)) wizard.open(0);
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount); else mount();
  window.HDStandaloneUI = { open, close, toast, wizard: () => wizard.open(0) };
})();
