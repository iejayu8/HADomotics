/* HADomotics Energía — transportes. Cliente fino: el estado vive en HA; aquí solo se refleja.
 * - DirectHA: websocket de Home Assistant (app móvil, Nabu Casa o LAN). Credencial: token del usuario.
 * - Addon: API del add-on HADomotics (panel ingress). El add-on usa SUPERVISOR_TOKEN y valida los controles.
 * Ningún transporte guarda ni calcula datos sincronizados: solo reenvía estados y llamadas de servicio. */
"use strict";

window.EnergyTransport = (function () {
  function emitter() {
    const h = {};
    return {
      on(ev, fn) { (h[ev] = h[ev] || []).push(fn); },
      emit(ev, ...a) { (h[ev] || []).forEach((f) => { try { f(...a); } catch (e) { console.error(e); } }); },
    };
  }

  /* ---------------- Direct Home Assistant websocket ---------------- */
  function DirectHA(opts) {
    const ev = emitter();
    let ws = null, msgId = 0, closed = false, backoff = 1000, subId = null;
    const pending = {};
    const entityIds = opts.entityIds;

    function wsUrl(base) {
      const b = String(base || "").trim().replace(/\/+$/, "");
      return b.replace(/^http/i, "ws") + "/api/websocket";
    }
    function send(obj) {
      obj.id = ++msgId;
      ws.send(JSON.stringify(obj));
      return new Promise((resolve, reject) => { pending[obj.id] = { resolve, reject }; });
    }
    function applyCompressed(msg) {
      // subscribe_entities: {a: added, c: changed (+/-), r: removed}
      const out = [];
      if (msg.a) for (const [eid, s] of Object.entries(msg.a)) {
        out.push({ entity_id: eid, state: s.s, attributes: s.a || {}, last_changed: toIso(s.lc), last_updated: toIso(s.lu || s.lc), _full: true });
      }
      if (msg.c) for (const [eid, d] of Object.entries(msg.c)) {
        const plus = d["+"] || {};
        out.push({ entity_id: eid, state: plus.s, attributes: plus.a, attrs_removed: (d["-"] && d["-"].a) || [],
          last_changed: plus.lc ? toIso(plus.lc) : undefined, last_updated: toIso(plus.lu || plus.lc), _delta: true });
      }
      if (msg.r) for (const eid of msg.r) out.push({ entity_id: eid, _removed: true });
      if (out.length) ev.emit("states", out);
    }
    function toIso(t) { return typeof t === "number" ? new Date(t * 1000).toISOString() : t; }

    function connect() {
      if (closed) return;
      ev.emit("status", "connecting");
      try { ws = new WebSocket(wsUrl(opts.url)); } catch (e) { ev.emit("status", "error", String(e)); return retry(); }
      ws.onmessage = (m) => {
        let d; try { d = JSON.parse(m.data); } catch (_) { return; }
        if (d.type === "auth_required") { ws.send(JSON.stringify({ type: "auth", access_token: opts.token })); return; }
        if (d.type === "auth_invalid") { ev.emit("status", "auth_invalid", d.message); closed = true; ws.close(); return; }
        if (d.type === "auth_ok") {
          backoff = 1000;
          ev.emit("status", "connected", d.ha_version);
          send({ type: "subscribe_entities", entity_ids: entityIds }).then(() => {}).catch((e) => ev.emit("status", "error", e.message));
          subId = msgId;
          return;
        }
        if (d.type === "event" && d.id === subId) { applyCompressed(d.event || {}); ev.emit("tick"); return; }
        if (d.type === "result" && pending[d.id]) {
          const p = pending[d.id]; delete pending[d.id];
          if (d.success) p.resolve(d.result); else p.reject(new Error((d.error && d.error.message) || "error"));
        }
      };
      ws.onclose = () => { if (closed) return; ev.emit("status", "disconnected"); Object.values(pending).forEach((p) => p.reject(new Error("desconectado"))); retry(); };
      ws.onerror = () => {};
    }
    function retry() {
      if (closed) return;
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 30000);
    }
    return {
      kind: "direct",
      on: ev.on,
      start() { closed = false; connect(); },
      stop() { closed = true; if (ws) ws.close(); },
      callService(domain, service, entityId, data) {
        if (!ws || ws.readyState !== 1) return Promise.reject(new Error("Sin conexión con Home Assistant"));
        return send({ type: "call_service", domain, service, target: { entity_id: entityId }, service_data: data || {} });
      },
    };
  }

  /* ---------------- HADomotics add-on (ingress) ---------------- */
  function Addon(opts) {
    const ev = emitter();
    let es = null;
    const want = new Set(opts.entityIds);
    const base = opts.base || "";
    function filt(list) { return list.filter((s) => want.has(s.entity_id)).map((s) => Object.assign({ _full: true }, s)); }
    return {
      kind: "addon",
      on: ev.on,
      async start() {
        ev.emit("status", "connecting");
        try {
          const r = await fetch(base + "api/energy/state");
          if (r.ok) { const j = await r.json(); ev.emit("states", filt(j.states || [])); ev.emit("status", j.ha_ws ? "connected" : "disconnected"); }
        } catch (e) { ev.emit("status", "error", String(e)); }
        es = new EventSource(base + "api/ha/stream");
        es.onmessage = (m) => {
          let d; try { d = JSON.parse(m.data); } catch (_) { return; }
          if (d.type === "connected") ev.emit("status", d.ha_ws ? "connected" : "disconnected");
          else if (d.type === "states") ev.emit("states", filt(d.states || []));
          else if (d.type === "state_changed" && d.state) ev.emit("states", filt([d.state]));
          ev.emit("tick");
        };
        es.onerror = () => ev.emit("status", "disconnected");
      },
      stop() { if (es) es.close(); },
      async callService(domain, service, entityId, data, dryRun) {
        const r = await fetch(base + "api/energy/control", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ entity_id: entityId, service: domain + "." + service, data: data || {}, dry_run: !!dryRun }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || ("HTTP " + r.status));
        return j;
      },
    };
  }

  return { DirectHA, Addon };
})();
