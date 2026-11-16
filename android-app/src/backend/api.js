/* La misma API HTTP que el add-on (hadomotics/server.py, security.py, energy.py),
 * implementada dentro de la app sobre el Hub (Tuya directo) y el almacén local.
 * El shim (shim.js) desvía aquí los fetch('/api/…') del frontend del add-on.
 * Rutas extra /api/standalone/* para ajustes, claves y descubrimiento. */
(function (root) {
  "use strict";
  if (!root.HDX && typeof require === "function") require("../core/umd.js");
  const HDX = root.HDX;
  const alarmMod = HDX.alarmEngine || require("../alarm/engine.js");
  const energy = HDX.energyFlow || require("../energy/flow.js");

  const EXT_MAP = { ".png": ".png", ".jpg": ".jpg", ".jpeg": ".jpg", ".gif": ".gif", ".webp": ".webp", ".svg": ".svg" };
  const HEX = /^#[0-9a-fA-F]{6}$/;
  const SAFE_ID = /^[A-Za-z0-9_-]+$/;
  const POS_MIN = -1, POS_MAX = 2;
  const ARM_BITS = { alarm_arm_home: 1, alarm_arm_away: 2, alarm_arm_night: 4, alarm_arm_vacation: 32, alarm_arm_custom_bypass: 16 };
  const DEFAULT_FLOORS = [{ id: "planta_baja", name: "Planta baja", order: 0, image: null, elements: [] }];
  const UPDATABLE = ["type", "label", "entity_id", "icon", "x", "y", "width", "height", "color_on", "color_off", "tap_action", "rotation", "state_position", "position", "service", "service_data"];

  function uuid() {
    const c = globalThis.crypto;
    if (c && c.randomUUID) return c.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => { const r = Math.random() * 16 | 0; return (ch === "x" ? r : (r & 3 | 8)).toString(16); });
  }
  const J = (status, body) => ({ status, body });

  /** Casa demo completa: dos plantas con plano genérico, elementos colocados (dos escenas
   *  fuera del dibujo), zonas de alarma, sirena, energía y cargador. Solo si no hay planos. */
  async function seedDemoHome(store, hub, loadConfig, saveConfig, demoAssets) {
    const c = await loadConfig();
    if (c.floors.some((f) => f.image) || !demoAssets) return false;
    const assets = await demoAssets();
    if (!assets || !assets.pb) return false;
    const el = (entity_id, label, type, icon, x, y, extra) => Object.assign({ id: uuid(), type, label, entity_id, icon, x, y, width: 64, height: 34, color_on: "#4CAF50", color_off: "#9E9E9E", tap_action: "toggle", state_position: "bottom" }, extra || {});
    const pb = { id: "planta_baja", name: "Planta baja", order: 0, image: "demo_planta_baja.png", elements: [
      el("light.luz_salon", "Salón", "light", "lightbulb", 300, 200),
      el("light.luz_cocina", "Cocina", "light", "lightbulb", 700, 160),
      el("cover.persiana_salon", "Persiana", "cover", "blinds", 140, 110, { tap_action: "quick-position" }),
      el("cover.puerta_garaje", "Garaje", "cover", "garage", 1230, 330),
      el("sensor.temperatura_salon_temperature", "Temp.", "sensor", "thermostat", 440, 110, { tap_action: "none" }),
      el("switch.depuradora", "Depuradora", "button", "pool", 230, 590),
      el("switch.regleta_oficina_1", "Regleta", "button", "power", 900, 600),
      el("scene.escena_dia", "Escena día", "button", "wb_sunny", 360, 850, { outside: true, color_on: "#f59e0b" }),
      el("scene.escena_noche", "Escena noche", "button", "nightlight", 520, 850, { outside: true, color_on: "#6366f1" }),
    ] };
    const p1 = { id: "planta_1", name: "Planta 1", order: 1, image: assets.p1 ? "demo_planta_1.png" : null, elements: [
      el("switch.regleta_oficina_2", "Despacho", "button", "computer", 1180, 600),
    ] };
    await store.set("img:demo_planta_baja.png", assets.pb);
    if (assets.p1) await store.set("img:demo_planta_1.png", assets.p1);
    c.floors = [pb, p1];
    c.security_positions = {
      "binary_sensor.pir_entrada": { floor: "planta_baja", x: 0.42, y: 0.75, outside: false },
      "binary_sensor.pir_salon": { floor: "planta_baja", x: 0.22, y: 0.4, outside: false },
      "binary_sensor.puerta_principal": { floor: "planta_baja", x: 0.43, y: 0.94, outside: false },
      "binary_sensor.pir_pasillo_arriba": { floor: "planta_1", x: 0.3, y: 0.75, outside: false },
      "binary_sensor.camara_jardin_persona": { floor: "planta_baja", x: 0.12, y: 0.9, outside: false },
    };
    await saveConfig(c);
    await hub.saveSettings({
      alarm: {
        exit_delay: { armed_night: 10, armed_away: 30 },
        siren: { entity: "siren.sirena" },
        zones: [
          { id: "entrada", name: "Entrada", night: true, sensors: ["binary_sensor.puerta_principal", "binary_sensor.pir_entrada"] },
          { id: "salon", name: "Salón", night: true, sensors: ["binary_sensor.pir_salon"] },
          { id: "planta_1", name: "Pasillo arriba", night: false, sensors: ["binary_sensor.pir_pasillo_arriba"] },
        ],
      },
      energy: { grid_power: "sensor.contador_general_phase_a_potencia", aux_power: "sensor.cargador_coche_potencia_de_carga", grid_import_daily: null, controls: ["switch.depuradora", "switch.regleta_oficina_1"] },
      evse: { enabled: true, floor_id: "planta_baja", power_entity: "sensor.cargador_coche_potencia_de_carga", state_entity: "sensor.cargador_coche_estado", threshold_w: 100, x: 0.66, y: 0.16, w: 0.27, h: 0.3, from_x: 0.63, from_y: 0.5 },
    });
    return true;
  }

  function createApi({ hub, store, now, secure, demoAssets }) {
    const clock = now || (() => Date.now());

    async function loadConfig() {
      const c = await store.get("config");
      return c && Array.isArray(c.floors) ? c : { floors: JSON.parse(JSON.stringify(DEFAULT_FLOORS)) };
    }
    const saveConfig = (c) => store.set("config", c);
    const getFloor = (c, id) => c.floors.find((f) => f.id === id) || null;

    async function securityMap() {
      const c = await loadConfig();
      const floors = [...c.floors].sort((a, b) => (a.order || 0) - (b.order || 0));
      return hub.securityMap(floors, c.security_positions || {});
    }

    async function overlays() {
      const c = await loadConfig();
      return hub.overlays([...c.floors].sort((a, b) => (a.order || 0) - (b.order || 0)));
    }

    function validRecord(rec, keys) {
      if (!rec || typeof rec !== "object" || !keys.has(rec.floor)) return false;
      return ["x", "y"].every((k) => typeof rec[k] === "number" && Number.isFinite(rec[k]) && rec[k] >= POS_MIN && rec[k] <= POS_MAX);
    }

    const routes = [];
    const on = (method, pattern, fn) => routes.push({ method, re: new RegExp("^" + pattern.replace(/:(\w+)/g, "(?<$1>[^/]+)") + "$"), fn });

    // ------------------------------------------------------------ plantas
    on("GET", "/api/floors", async () => {
      const c = await loadConfig();
      return J(200, [...c.floors].sort((a, b) => (a.order || 0) - (b.order || 0)).map((f) => ({ id: f.id, name: f.name, order: f.order, has_image: !!f.image })));
    });
    on("POST", "/api/floors", async ({ body }) => {
      const name = String((body && body.name) || "").trim();
      if (!name) return J(400, { error: "name is required" });
      const c = await loadConfig();
      const order = c.floors.reduce((m, f) => Math.max(m, f.order || 0), -1) + 1;
      const floor = { id: uuid(), name, order, image: null, elements: [] };
      c.floors.push(floor);
      await saveConfig(c);
      return J(201, floor);
    });
    on("GET", "/api/floors/:id", async ({ p }) => {
      const f = getFloor(await loadConfig(), p.id);
      return f ? J(200, f) : J(404, { error: "Floor not found" });
    });
    on("PUT", "/api/floors/:id", async ({ p, body }) => {
      const c = await loadConfig();
      const f = getFloor(c, p.id);
      if (!f) return J(404, { error: "Floor not found" });
      if ("name" in (body || {})) f.name = String(body.name || "").trim();
      if ("order" in (body || {})) f.order = parseInt(body.order, 10) || 0;
      await saveConfig(c);
      return J(200, f);
    });
    on("DELETE", "/api/floors/:id", async ({ p }) => {
      const c = await loadConfig();
      const f = getFloor(c, p.id);
      if (!f) return J(404, { error: "Floor not found" });
      if (f.image) await store.del("img:" + f.image);
      c.floors = c.floors.filter((x) => x.id !== p.id);
      await saveConfig(c);
      return J(200, { ok: true });
    });
    on("POST", "/api/floors/:id/image", async ({ p, files }) => {
      if (!SAFE_ID.test(p.id)) return J(400, { error: "Invalid floor ID" });
      const c = await loadConfig();
      const f = getFloor(c, p.id);
      if (!f) return J(404, { error: "Floor not found" });
      const file = files && files.image;
      if (!file) return J(400, { error: "No image file provided" });
      const m = /\.[^.]+$/.exec(String(file.name || "").toLowerCase());
      const ext = m && EXT_MAP[m[0]];
      if (!ext) return J(400, { error: "File type not allowed" });
      const name = uuid().replace(/-/g, "") + ext;
      if (f.image) await store.del("img:" + f.image);
      await store.set("img:" + name, file);
      f.image = name;
      await saveConfig(c);
      return J(200, { ok: true, image: name });
    });
    on("DELETE", "/api/floors/:id/image", async ({ p }) => {
      const c = await loadConfig();
      const f = getFloor(c, p.id);
      if (!f) return J(404, { error: "Floor not found" });
      if (f.image) { await store.del("img:" + f.image); f.image = null; await saveConfig(c); }
      return J(200, { ok: true });
    });
    on("GET", "/api/images/:name", async ({ p }) => {
      const c = await loadConfig();
      const name = decodeURIComponent(p.name).split("/").pop();
      if (!c.floors.some((f) => f.image === name)) return J(404, { error: "Image not found" });
      const blob = await store.get("img:" + name);
      return blob ? { status: 200, blob } : J(404, { error: "Image not found" });
    });

    // ------------------------------------------------------------ elementos
    on("GET", "/api/floors/:id/elements", async ({ p }) => {
      const f = getFloor(await loadConfig(), p.id);
      return f ? J(200, f.elements || []) : J(404, { error: "Floor not found" });
    });
    on("POST", "/api/floors/:id/elements", async ({ p, body }) => {
      const c = await loadConfig();
      const f = getFloor(c, p.id);
      if (!f) return J(404, { error: "Floor not found" });
      const d = body || {};
      const el = {
        id: uuid(), type: d.type || "button", label: d.label || "", entity_id: d.entity_id || "", icon: d.icon || "",
        x: Number(d.x ?? 50), y: Number(d.y ?? 50), width: Number(d.width ?? 60), height: Number(d.height ?? 30),
        color_on: d.color_on || "#4CAF50", color_off: d.color_off || "#9E9E9E", tap_action: d.tap_action || "toggle",
        state_position: d.state_position || "bottom",
      };
      (f.elements = f.elements || []).push(el);
      await saveConfig(c);
      return J(201, el);
    });
    on("PUT", "/api/floors/:id/elements/:eid", async ({ p, body }) => {
      const c = await loadConfig();
      const f = getFloor(c, p.id);
      if (!f) return J(404, { error: "Floor not found" });
      const el = (f.elements || []).find((e) => e.id === p.eid);
      if (!el) return J(404, { error: "Element not found" });
      const d = body || {};
      UPDATABLE.forEach((k) => { if (k in d) el[k] = d[k]; });
      if ("outside" in d) el.outside = !!d.outside;
      await saveConfig(c);
      return J(200, el);
    });
    on("DELETE", "/api/floors/:id/elements/:eid", async ({ p }) => {
      const c = await loadConfig();
      const f = getFloor(c, p.id);
      if (!f) return J(404, { error: "Floor not found" });
      const before = (f.elements || []).length;
      f.elements = (f.elements || []).filter((e) => e.id !== p.eid);
      if (f.elements.length === before) return J(404, { error: "Element not found" });
      await saveConfig(c);
      return J(200, { ok: true });
    });
    on("PUT", "/api/elements/colors", async ({ body }) => {
      const d = body || {};
      const scope = d.scope || "floor";
      if (d.color_on == null && d.color_off == null) return J(400, { error: "color_on or color_off required" });
      if (d.color_on != null && !HEX.test(String(d.color_on))) return J(400, { error: "Invalid color_on" });
      if (d.color_off != null && !HEX.test(String(d.color_off))) return J(400, { error: "Invalid color_off" });
      if (!["floor", "all"].includes(scope)) return J(400, { error: "scope must be 'floor' or 'all'" });
      if (scope === "floor" && !d.floor_id) return J(400, { error: "floor_id required when scope is floor" });
      const c = await loadConfig();
      let targets = c.floors;
      if (scope === "floor") { const f = getFloor(c, d.floor_id); if (!f) return J(404, { error: "Floor not found" }); targets = [f]; }
      let updated = 0;
      targets.forEach((f) => (f.elements || []).forEach((el) => { if (d.color_on != null) el.color_on = d.color_on; if (d.color_off != null) el.color_off = d.color_off; updated++; }));
      await saveConfig(c);
      return J(200, { ok: true, updated });
    });

    // ------------------------------------------------------------ «HA» (estados y servicios)
    on("GET", "/api/ha/states", async () => J(200, hub.allStates()));
    on("GET", "/api/ha/states/:eid", async ({ p }) => {
      const s = hub.getState(decodeURIComponent(p.eid));
      return s ? J(200, s) : J(404, { message: "Entity not found." });
    });
    on("POST", "/api/ha/services/:domain/:service", async ({ p, body }) => {
      const domain = p.domain.toLowerCase(), service = p.service.toLowerCase();
      if (domain === "alarm_control_panel") return J(403, { error: "Use /api/security/alarm" });
      try {
        await hub.callService(domain, service, body || {}, "app");
        return J(200, [hub.getState([].concat((body || {}).entity_id)[0])].filter(Boolean));
      } catch (e) {
        return J(400, { error: String(e.message || e) });
      }
    });
    on("GET", "/api/config", async () => { const c = await loadConfig(); const o = Object.assign({}, c); delete o.floors; return J(200, o); });

    // ------------------------------------------------------------ copia de seguridad (formato del add-on)
    async function blobToB64(blob) {
      const buf = new Uint8Array(await blob.arrayBuffer());
      let bin = "";
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
      return typeof btoa === "function" ? btoa(bin) : Buffer.from(bin, "binary").toString("base64");
    }
    function b64ToBlob(b64, ext) {
      const bin = typeof atob === "function" ? atob(b64) : Buffer.from(b64, "base64").toString("binary");
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const type = { ".png": "image/png", ".jpg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml" }[ext] || "application/octet-stream";
      return new Blob([bytes], { type });
    }
    async function backup(withStandalone) {
      const c = await loadConfig();
      const out = { version: "1.7.0", exported_at: new Date(clock()).toISOString(), floors: [] };
      for (const f of c.floors) {
        const fd = { id: f.id, name: f.name, order: f.order || 0, elements: f.elements || [], image_base64: null, image_ext: null };
        if (f.image) {
          const blob = await store.get("img:" + f.image);
          if (blob) { fd.image_base64 = await blobToB64(blob); fd.image_ext = (/\.[^.]+$/.exec(f.image) || [""])[0]; }
        }
        out.floors.push(fd);
      }
      if (c.security_positions && Object.keys(c.security_positions).length) out.security_positions = c.security_positions;
      if (withStandalone) {
        // Ajustes de la app SIN secretos (las claves de Tuya nunca salen del Keystore).
        const s = JSON.parse(JSON.stringify(hub.settings));
        if (s.alarm) delete s.alarm.code_hash;
        out.standalone = { app: "hadomotics-android", settings: s, registry: hub.registry.toJSON() };
      }
      return out;
    }
    on("GET", "/api/backup", async () => J(200, await backup(true)));
    on("POST", "/api/restore", async ({ body }) => {
      const d = body;
      if (!d || !Array.isArray(d.floors)) return J(400, { error: "Invalid backup file" });
      const old = await loadConfig();
      for (const f of old.floors) if (f.image) await store.del("img:" + f.image);
      const cfg = { floors: [] };
      for (const fd of d.floors) {
        const f = { id: fd.id || uuid(), name: fd.name || "Unnamed Floor", order: fd.order || 0, elements: fd.elements || [], image: null };
        if (fd.image_base64 && fd.image_ext && EXT_MAP[String(fd.image_ext).toLowerCase()]) {
          try {
            const name = uuid().replace(/-/g, "") + EXT_MAP[String(fd.image_ext).toLowerCase()];
            await store.set("img:" + name, b64ToBlob(fd.image_base64, EXT_MAP[String(fd.image_ext).toLowerCase()]));
            f.image = name;
          } catch (_) { /* imagen corrupta: se omite */ }
        }
        cfg.floors.push(f);
      }
      if (d.security_positions && typeof d.security_positions === "object") cfg.security_positions = d.security_positions;
      await saveConfig(cfg);
      if (d.standalone && d.standalone.settings && typeof d.standalone.settings === "object") {
        const s = d.standalone.settings;
        delete s.tuya_access_secret; // por si acaso: nunca se importan secretos
        if (s.alarm) delete s.alarm.code_hash;
        if (d.standalone.registry && d.standalone.registry.map) {
          Object.assign(hub.registry.map, d.standalone.registry.map);
          await store.set("registry", hub.registry.toJSON());
        }
        await hub.saveSettings(s);
      }
      return J(200, { ok: true, message: "Configuration restored successfully" });
    });

    // ------------------------------------------------------------ Seguridad
    on("GET", "/api/security/map", async () => J(200, await securityMap()));
    on("GET", "/api/plan/overlays", async () => J(200, await overlays()));
    on("PUT", "/api/security/positions", async ({ body }) => {
      const m = await securityMap();
      const ov = await overlays();
      const d = body || {};
      const entity = String(d.entity_id || "");
      if (!m.presence.some((x) => x.entity === entity)) return J(400, { ok: false, error: "Unknown presence entity" });
      const rec = { floor: d.floor, x: d.x, y: d.y };
      if (!validRecord(rec, new Set(ov.floors.map((f) => f.key)))) return J(400, { ok: false, error: "Invalid floor or position" });
      rec.x = Math.round(rec.x * 1e5) / 1e5;
      rec.y = Math.round(rec.y * 1e5) / 1e5;
      rec.outside = !!d.outside;
      const c = await loadConfig();
      c.security_positions = Object.assign({}, c.security_positions || {}, { [entity]: rec });
      await saveConfig(c);
      return J(200, Object.assign({ ok: true, entity_id: entity }, rec));
    });
    on("GET", "/api/security/state", async () => {
      const m = await securityMap();
      const ov = await overlays();
      const wanted = new Set([m.alarm.entity].concat(m.zones.map((z) => z.entity), m.presence.map((x) => x.entity)));
      if (m.siren) { wanted.add(m.siren.entity); m.siren.extra.forEach((x) => wanted.add(x.entity)); }
      ov.floors.forEach((f) => { if (f.evse_cable) { wanted.add(f.evse_cable.power_entity); if (f.evse_cable.state_entity) wanted.add(f.evse_cable.state_entity); } });
      return J(200, { ha_ws: hub.connected || hub.settings.mode === "unconfigured", states: hub.allStates().filter((s) => wanted.has(s.entity_id)) });
    });
    on("POST", "/api/security/alarm", async ({ body }) => {
      const d = body || {};
      let service = String(d.service || "");
      if (service.startsWith("alarm_control_panel.")) service = service.split(".")[1];
      if (d.entity_id !== alarmMod.ALARM_ENTITY) return J(400, { ok: false, error: "entidad de alarma no permitida" });
      if (!(service in alarmMod.SERVICE_MODE)) return J(400, { ok: false, error: `servicio ${service || "(vacío)"} no permitido` });
      const st = hub.getState(alarmMod.ALARM_ENTITY);
      const attrs = (st && st.attributes) || {};
      const bit = ARM_BITS[service];
      if (bit !== undefined && !((attrs.supported_features || 0) & bit)) return J(400, { ok: false, error: `${service} no está disponible` });
      const needs = attrs.code_format && (service === "alarm_disarm" || attrs.code_arm_required !== false);
      if (needs) {
        if (typeof d.code !== "string" || !d.code) return J(400, { ok: false, error: "esta acción requiere el código de la alarma" });
        if (!(await alarmMod.verifyCode(d.code, hub.settings.alarm.code_hash))) return J(400, { ok: false, error: "código incorrecto" });
      }
      await hub.callService("alarm_control_panel", service, { entity_id: alarmMod.ALARM_ENTITY }, "app");
      return J(200, { ok: true, service: `alarm_control_panel.${service}` });
    });
    on("POST", "/api/security/control", async ({ body }) => {
      const d = body || {};
      const m = await securityMap();
      const entity = String(d.entity_id || "");
      const allowed = {};
      m.zones.forEach((z) => { allowed[z.entity] = ["input_boolean.turn_on", "input_boolean.turn_off"]; });
      if (m.siren) {
        allowed[m.siren.entity] = ["siren.turn_on", "siren.turn_off"];
        m.siren.extra.forEach((x) => { allowed[x.entity] = /^select\./.test(x.entity) ? ["select.select_option"] : ["input_boolean.turn_on", "input_boolean.turn_off"]; });
      }
      if (!allowed[entity]) return J(400, { ok: false, error: "entidad no permitida" });
      const domain = entity.split(".")[0];
      let service = String(d.service || "");
      if (service.includes(".")) { const [sd, sv] = service.split("."); if (sd !== domain) return J(400, { ok: false, error: "servicio no permitido" }); service = sv; }
      if (!allowed[entity].includes(`${domain}.${service}`)) return J(400, { ok: false, error: `servicio ${service || "(vacío)"} no permitido para ${entity}` });
      const payload = { entity_id: entity };
      if (domain === "select") {
        const opts = ((hub.getState(entity) || {}).attributes || {}).options;
        if (!Array.isArray(opts)) return J(400, { ok: false, error: "opciones no disponibles" });
        if (!opts.includes(d.option)) return J(400, { ok: false, error: "opción no permitida" });
        payload.option = d.option;
      }
      if (m.siren && entity === m.siren.entity && service === "turn_on" && d.confirm !== true) return J(400, { ok: false, error: "la prueba de la sirena requiere confirmación" });
      try {
        await hub.callService(domain, service, payload, "app");
      } catch (e) { return J(502, { ok: false, error: String(e.message || e) }); }
      return J(200, { ok: true, service: `${domain}.${service}`, entity_id: entity });
    });

    // ------------------------------------------------------------ Energía
    on("GET", "/api/energy/map", async () => J(200, hub.energyMap()));
    on("GET", "/api/energy/state", async () => {
      const wanted = new Set(energy.mappedEntities(hub.energyMap()));
      return J(200, { ha_ws: hub.connected, states: hub.allStates().filter((s) => wanted.has(s.entity_id)) });
    });
    on("GET", "/api/energy/flow", async () => J(200, energy.buildFlow(hub.states, hub.energyMap())));
    on("POST", "/api/energy/control", async ({ body }) => {
      const d = body || {};
      let r;
      try { r = energy.validateControl(hub.energyMap(), d, hub.getState(String(d.entity_id || ""))); } catch (e) { return J(400, { ok: false, error: e.message }); }
      const would = { service: `${r[0]}.${r[1]}`, data: Object.assign({}, r[2], { entity_id: d.entity_id }) };
      if (d.dry_run) return J(200, { ok: true, dry_run: true, would_call: would });
      try { await hub.callService(r[0], r[1], would.data, "app"); } catch (e) { return J(502, { ok: false, error: e.message }); }
      return J(200, { ok: true, called: would });
    });

    // ------------------------------------------------------------ propias de la app
    on("GET", "/api/standalone/status", async () => J(200, hub.status()));
    on("GET", "/api/standalone/settings", async () => {
      const s = JSON.parse(JSON.stringify(hub.settings));
      if (s.alarm) { s.alarm.has_code = !!s.alarm.code_hash; delete s.alarm.code_hash; }
      return J(200, s);
    });
    on("PUT", "/api/standalone/settings", async ({ body }) => {
      const patch = Object.assign({}, body || {});
      delete patch.mode; // el modo cambia con credenciales/demo
      if (patch.alarm) {
        patch.alarm = Object.assign({}, patch.alarm);
        delete patch.alarm.has_code;
        const code = patch.alarm.code;
        delete patch.alarm.code;
        delete patch.alarm.code_hash;
        if (code === "") patch.alarm.code_hash = null;
        else if (typeof code === "string") {
          if (!/^\d{4,10}$/.test(code)) return J(400, { error: "El código debe tener de 4 a 10 cifras" });
          patch.alarm.code_hash = await alarmMod.hashCode(code);
        }
      }
      await hub.saveSettings(patch);
      return J(200, { ok: true });
    });
    on("POST", "/api/standalone/credentials", async ({ body }) => {
      const d = body || {};
      const id = String(d.access_id || "").trim(), secret = String(d.access_secret || "").trim();
      if (!/^[A-Za-z0-9]{10,64}$/.test(id) || secret.length < 16) return J(400, { error: "Access ID / Access Secret con formato no válido" });
      if (!secure) return J(500, { error: "Sin almacén seguro" });
      await secure.set("tuya_access_id", id);
      await secure.set("tuya_access_secret", secret);
      await hub.saveSettings({ tuya: { region: d.region || "eu", configured: true } });
      hub.settings.mode = "tuya";
      await store.set("settings", hub.settings);
      const ok = await hub.connect();
      return J(ok ? 200 : 502, { ok, error: ok ? undefined : hub.lastError, secure_storage: secure.available });
    });
    on("DELETE", "/api/standalone/credentials", async () => {
      if (secure) { await secure.remove("tuya_access_id"); await secure.remove("tuya_access_secret"); }
      hub.settings.mode = "unconfigured";
      hub.settings.tuya.configured = false;
      await store.set("settings", hub.settings);
      await hub.connect();
      return J(200, { ok: true });
    });
    on("POST", "/api/standalone/demo", async ({ body }) => {
      hub.settings.mode = body && body.enabled === false ? "unconfigured" : "demo";
      await store.set("settings", hub.settings);
      await hub.connect();
      let seeded = false;
      if (hub.settings.mode === "demo") {
        await hub.discover();
        await hub.poll();
        seeded = await seedDemoHome(store, hub, loadConfig, saveConfig, demoAssets);
      }
      return J(200, { ok: true, mode: hub.settings.mode, seeded });
    });
    on("POST", "/api/standalone/discover", async () => {
      try { const list = await hub.discover(); await hub.poll(); return J(200, { ok: true, devices: list.map((d) => ({ id: d.id, name: d.name, category: d.category, online: d.online, sub: d.sub })) }); } catch (e) { return J(502, { ok: false, error: String(e.message || e) }); }
    });
    on("POST", "/api/standalone/poll", async () => J(200, { ok: await hub.poll() }));
    on("GET", "/api/standalone/devices", async () => J(200, Object.values(hub.devices).map((d) => ({ id: d.id, name: d.name, category: d.category, online: d.online, sub: d.sub, gateway_id: d.gateway_id, entities: hub.allStates().filter((s) => s.attributes.tuya && s.attributes.tuya.device_id === d.id).map((s) => s.entity_id) }))));

    async function handle(req) {
      const method = String(req.method || "GET").toUpperCase();
      const path = req.path.replace(/\/+$/, "") || "/";
      for (const r of routes) {
        if (r.method !== method) continue;
        const m = r.re.exec(path);
        if (!m) continue;
        try {
          return await r.fn({ p: m.groups || {}, body: req.body, files: req.files, query: req.query || {} });
        } catch (e) {
          return J(500, { error: String((e && e.message) || e) });
        }
      }
      return J(404, { error: "Not found" });
    }

    return { handle, loadConfig, backup };
  }

  const api = { createApi, DEFAULT_FLOORS };
  HDX.define("api", () => api);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
