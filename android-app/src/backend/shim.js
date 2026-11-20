/* Capa de abstracción del backend en la app Android.
 *
 * El frontend del add-on (hadomotics/static) habla con su backend por HTTP:
 * fetch('/api/…'), EventSource('/api/ha/stream') e <img src="/api/images/…">.
 * Aquí se desvían esas tres vías al backend local (api.js + hub.js), así que
 * el MISMO código de Dispositivos, Seguridad y Energía funciona en las dos variantes:
 *   - adaptador «HA»: el add-on (Flask + Home Assistant), sin este fichero;
 *   - adaptador «Tuya directo»: esta app, con este fichero cargado antes que app.js.
 * Debe cargarse después de los módulos src/* y antes de static/js/app.js. */
(function () {
  "use strict";
  const HDX = window.HDX;
  const Cap = window.Capacitor || null;
  const isNative = !!(Cap && Cap.isNativePlatform && Cap.isNativePlatform());
  const plugins = (Cap && Cap.Plugins) || {};
  const realFetch = window.fetch.bind(window);
  const RealEventSource = window.EventSource;

  // ------------------------------------------------------------ transporte HTTP hacia Tuya
  async function http(req) {
    const Http = plugins.CapacitorHttp;
    if (isNative && Http) {
      const r = await Http.request({ url: req.url, method: req.method, headers: req.headers, data: req.body ? JSON.parse(req.body) : undefined, connectTimeout: 15000, readTimeout: 15000, responseType: "json" });
      return { status: r.status, data: r.data };
    }
    // Navegador: Tuya no permite CORS. Solo sirve el modo demo.
    const r = await realFetch(req.url, { method: req.method, headers: req.headers, body: req.body || undefined });
    return { status: r.status, data: await r.json().catch(() => ({})) };
  }

  // ------------------------------------------------------------ avisos locales
  async function notify(n) {
    const svc = plugins.HDAlarmService;
    if (svc && svc.notify) return svc.notify({ title: n.title, body: n.body || "", critical: !!n.critical, tag: n.tag || "" });
    if (window.HDStandaloneUI && window.HDStandaloneUI.toast) window.HDStandaloneUI.toast(`${n.title} ${n.body || ""}`, n.critical ? "error" : "info");
    console.info("[aviso]", n.title, n.body || "");
  }

  const store = new HDX.store.IdbStore("hadomotics");
  const secure = new HDX.store.SecureStore(plugins.HDSecureStorage || null);
  const hub = new HDX.hub.Hub({
    store, secure, http, notify, native: plugins.HDAlarmService || null, simulate: true,
    log: (m) => console.debug("[hub]", m),
  });
  async function demoAssets() {
    const get = async (n) => { const r = await realFetch("standalone/assets/" + n); return r.ok ? r.blob() : null; };
    return { pb: await get("demo-planta-baja.png"), p1: await get("demo-planta-1.png") };
  }
  const api = HDX.api.createApi({ hub, store, secure, demoAssets });
  const ready = hub.init().catch((e) => { console.error("HADomotics: arranque", e); });
  window.HDStandalone = { hub, api, ready, isNative, store, secure };

  // ------------------------------------------------------------ fetch
  function apiPath(input) {
    const raw = typeof input === "string" ? input : input && input.url;
    if (!raw) return null;
    let u;
    try { u = new URL(raw, window.location.href); } catch (_) { return null; }
    if (u.origin !== window.location.origin && window.location.protocol !== "file:") return null;
    const i = u.pathname.indexOf("/api/");
    if (i < 0) return null;
    const query = {};
    u.searchParams.forEach((v, k) => { query[k] = v; });
    return { path: u.pathname.slice(i), query };
  }

  window.fetch = async function (input, init) {
    const target = apiPath(input);
    if (!target) return realFetch(input, init);
    await ready;
    const opts = init || {};
    const method = (opts.method || (input && input.method) || "GET").toUpperCase();
    let body = null, files = null;
    if (opts.body instanceof FormData) {
      files = {};
      opts.body.forEach((v, k) => { if (v instanceof Blob) files[k] = v; });
    } else if (typeof opts.body === "string" && opts.body) {
      try { body = JSON.parse(opts.body); } catch (_) { body = null; }
    }
    const r = await api.handle({ method, path: target.path, query: target.query, body, files });
    if (r.blob) return new Response(r.blob, { status: 200, headers: { "Content-Type": r.blob.type || "application/octet-stream" } });
    return new Response(JSON.stringify(r.body === undefined ? null : r.body), { status: r.status, headers: { "Content-Type": "application/json" } });
  };

  // ------------------------------------------------------------ EventSource /api/ha/stream
  class LocalEventSource {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.onmessage = null;
      this.onerror = null;
      this.onopen = null;
      this._unsub = null;
      ready.then(() => {
        if (this.readyState === 2) return;
        this.readyState = 1;
        this._send({ type: "connected", ha_ws: hub.connected || hub.settings.mode === "unconfigured" });
        this._send({ type: "states", states: hub.allStates() });
        this._unsub = hub.subscribe((msg) => this._send(msg));
        if (this.onopen) this.onopen({});
      });
    }
    _send(msg) { if (this.readyState === 1 && this.onmessage) this.onmessage({ data: JSON.stringify(msg) }); }
    addEventListener(type, fn) { if (type === "message") this.onmessage = fn; if (type === "error") this.onerror = fn; if (type === "open") this.onopen = fn; }
    removeEventListener() {}
    close() { this.readyState = 2; if (this._unsub) this._unsub(); }
  }
  window.EventSource = function (url, cfg) {
    const t = apiPath(url);
    if (t && t.path === "/api/ha/stream") return new LocalEventSource(url);
    return new RealEventSource(url, cfg);
  };

  // ------------------------------------------------------------ <img src="/api/images/…">
  const desc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src");
  const blobUrls = new Map();
  Object.defineProperty(HTMLImageElement.prototype, "src", {
    configurable: true,
    enumerable: desc.enumerable,
    get() { return desc.get.call(this); },
    set(value) {
      const t = apiPath(String(value));
      if (!t || !t.path.startsWith("/api/images/")) return desc.set.call(this, value);
      const img = this;
      const name = t.path.slice("/api/images/".length);
      img.dataset.apiSrc = name;
      (async () => {
        await ready;
        let url = blobUrls.get(name);
        if (!url) {
          const r = await api.handle({ method: "GET", path: t.path });
          if (!r.blob) { desc.set.call(img, "data:,"); return; }
          url = URL.createObjectURL(r.blob);
          blobUrls.set(name, url);
        }
        if (img.dataset.apiSrc === name) desc.set.call(img, url);
      })();
    },
  });

  // ------------------------------------------------------------ bucle: sondeo, temporizadores, nativo
  let pollTimer = null;
  async function pollLoop() {
    clearTimeout(pollTimer);
    if (document.hidden) return; // en segundo plano manda el servicio nativo
    await hub.poll();
    const s = hub.nextPollSeconds();
    if (Number.isFinite(s)) pollTimer = setTimeout(pollLoop, s * 1000);
  }
  async function resume() {
    const svc = plugins.HDAlarmService;
    if (svc && svc.drainEvents) {
      try { const r = await svc.drainEvents(); await hub.applyNativeEvents(r && r.events); } catch (e) { console.debug(e); }
    }
    pollLoop();
  }
  ready.then(() => {
    setInterval(() => hub.tick(), 1000);
    const svc = plugins.HDAlarmService;
    if (svc && svc.addListener) {
      svc.addListener("tuyaStatus", (ev) => { try { hub.applyPush(ev.device_id, JSON.parse(ev.status || "[]"), ev.online); } catch (_) { /* mensaje raro */ } });
      svc.addListener("alarmEvent", () => resume());
    }
    document.addEventListener("visibilitychange", () => { if (!document.hidden) resume(); });
    resume();
  });
})();
