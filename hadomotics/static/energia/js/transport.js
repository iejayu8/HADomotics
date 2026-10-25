/* HADomotics Energía — transporte del add-on.
 * Los estados salen de la caché del add-on (GET de lectura) y, si el panel
 * está dentro de Home Assistant, del frontend del usuario. El stream SSE
 * sigue siendo solo para administradores; si no abre, se sigue por sondeo.
 */
"use strict";

window.EnergyTransport = (function () {
  function emitter() {
    const h = {};
    return {
      on(ev, fn) { (h[ev] = h[ev] || []).push(fn); },
      emit(ev, ...a) { (h[ev] || []).forEach((f) => { try { f(...a); } catch (e) { console.error(e); } }); },
    };
  }

  function panelRoot() {
    if (window.HADomotics && typeof window.HADomotics.panelRoot === "function") {
      return window.HADomotics.panelRoot();
    }
    let path = window.location.pathname.replace(/\/+$/, "");
    if (path.endsWith("/energia")) path = path.slice(0, -"/energia".length);
    return path;
  }

  function Addon(opts) {
    const ev = emitter();
    let es = null;
    let poll = null;
    let stopped = false;
    const want = new Set(opts.entityIds || []);
    const base = panelRoot();
    function url(path) { return base + path; }
    function filt(list) {
      return (list || []).filter((s) => s && want.has(s.entity_id)).map((s) => Object.assign({ _full: true }, s));
    }
    async function pull() {
      try {
        const r = await fetch(url("/api/energy/state"), { cache: "no-store" });
        if (!r.ok) { ev.emit("status", "disconnected"); return; }
        const j = await r.json();
        ev.emit("states", filt(j.states || []));
        ev.emit("status", j.ha_ws ? "connected" : "disconnected");
        ev.emit("tick");
      } catch (e) {
        ev.emit("status", "error", String(e));
      }
    }
    return {
      kind: "addon",
      on: ev.on,
      async start() {
        stopped = false;
        ev.emit("status", "connecting");
        await pull();
        poll = setInterval(() => { if (!stopped) pull(); }, 3000);
        try {
          es = new EventSource(url("/api/ha/stream"));
          es.onmessage = (m) => {
            let d; try { d = JSON.parse(m.data); } catch (_) { return; }
            if (d.type === "connected") ev.emit("status", d.ha_ws ? "connected" : "disconnected");
            else if (d.type === "states") ev.emit("states", filt(d.states || []));
            else if (d.type === "state_changed" && d.state) ev.emit("states", filt([d.state]));
            ev.emit("tick");
          };
          es.onerror = () => {
            ev.emit("status", "disconnected");
            if (es) { es.close(); es = null; }
          };
        } catch (_) { /* sondeo */ }
      },
      stop() {
        stopped = true;
        if (poll) clearInterval(poll);
        if (es) es.close();
      },
      refresh() { return pull(); },
      async callService(domain, service, entityId, data, dryRun) {
        const r = await fetch(url("/api/energy/control"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            entity_id: entityId,
            service: domain + "." + service,
            data: data || {},
            dry_run: !!dryRun,
          }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || ("HTTP " + r.status));
        return j;
      },
    };
  }

  function Embedded(opts) {
    const ev = emitter();
    const want = new Set(opts.entityIds || []);
    let timer = null;
    let unsub = null;
    let hassReadLogged = false;
    // El frontend de Home Assistant sustituye el objeto hass en cada cambio.
    // Hay que volver a leerlo en cada sondeo: la referencia del arranque
    // conserva states viejos y pisa el state_changed.
    function currentHass() {
      if (typeof opts.getHass === "function") {
        try {
          return opts.getHass() || null;
        } catch (e) {
          if (!hassReadLogged) {
            hassReadLogged = true;
            console.error("EnergyTransport: embedded hass read failed", e);
          }
          return null;
        }
      }
      return opts.hass || null;
    }
    function snapshot() {
      const hass = currentHass();
      if (!hass || !hass.states) {
        ev.emit("status", "disconnected");
        ev.emit("tick");
        return;
      }
      const states = hass.states;
      const list = [];
      want.forEach((id) => { if (states[id]) list.push(states[id]); });
      ev.emit("states", list);
      ev.emit("status", hass.connected === false ? "disconnected" : "connected");
      ev.emit("tick");
    }
    return {
      kind: "embedded",
      on: ev.on,
      async start() {
        snapshot();
        const hass = currentHass();
        try {
          if (hass && hass.connection && hass.connection.subscribeEvents) {
            unsub = await hass.connection.subscribeEvents((event) => {
              const data = event.data || {};
              if (!want.has(data.entity_id) || !data.new_state) return;
              ev.emit("states", [data.new_state]);
              ev.emit("tick");
            }, "state_changed");
          }
        } catch (e) {
          console.error("EnergyTransport: state_changed subscription failed", e);
        }
        timer = setInterval(snapshot, 4000);
      },
      stop() {
        if (timer) clearInterval(timer);
        if (typeof unsub === "function") {
          try { unsub(); } catch (e) {
            console.error("EnergyTransport: state_changed unsubscribe failed", e);
          }
        }
      },
      refresh() { snapshot(); },
      callService(domain, service, entityId, data, dryRun) {
        return Addon(opts).callService(domain, service, entityId, data, dryRun);
      },
    };
  }

  return { Addon: Addon, Embedded: Embedded };
})();
