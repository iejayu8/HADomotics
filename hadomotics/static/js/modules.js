/* HADomotics — módulos configurables (Dispositivos / Energía / Seguridad).
 *
 * Lee qué módulos están activos (GET /api/modules: opciones del add-on, o los
 * ajustes de la app Android) y quita de la vista los desactivados: panel, botón
 * de navegación y ajustes. Los demás scripts esperan a `HDModules.ready` antes de
 * arrancar su sondeo, así que un módulo desactivado no trabaja en segundo plano.
 * Debe cargarse antes que app.js, energy.js y security.js. */
(function (root) {
  "use strict";
  const KEYS = ["dispositivos", "energia", "seguridad"];
  // Orden de preferencia para la vista inicial.
  const PREFERRED = ["dispositivos", "seguridad", "energia"];
  const UI = {
    dispositivos: { pane: "appDispositivos", nav: "navDispositivos" },
    energia: { pane: "appEnergia", nav: "navEnergia" },
    seguridad: { pane: "appSeguridad", nav: "navSeguridad" },
  };
  const FALSE_WORDS = ["0", "false", "no", "off"];

  function flag(v) {
    if (v === undefined || v === null) return true;
    if (typeof v === "string") return !FALSE_WORDS.includes(v.trim().toLowerCase());
    return !!v;
  }

  /** Falta un módulo = activo. Todos apagados = los tres activos (nunca una app vacía). */
  function normalize(raw) {
    const src = raw && typeof raw === "object" ? raw : {};
    const out = {};
    KEYS.forEach((k) => { out[k] = flag(src[k]); });
    if (!KEYS.some((k) => out[k])) KEYS.forEach((k) => { out[k] = true; });
    return out;
  }

  function enabledList(mods) { return KEYS.filter((k) => mods[k]); }

  function firstEnabled(mods, wanted) {
    if (wanted && mods[wanted]) return wanted;
    return PREFERRED.find((k) => mods[k]) || "dispositivos";
  }

  function panelRoot() {
    const loc = root.location || { pathname: "" };
    let path = String(loc.pathname || "").replace(/\/+$/, "");
    if (path.endsWith("/index.html")) path = path.slice(0, -"/index.html".length);
    if (path.endsWith("/energia")) path = path.slice(0, -"/energia".length);
    if (path.endsWith("/seguridad")) path = path.slice(0, -"/seguridad".length);
    return path;
  }

  let current = normalize(null);

  /** Oculta (y desactiva) lo que pertenece a módulos apagados. */
  function apply(mods, doc) {
    doc = doc || root.document;
    current = normalize(mods);
    if (!doc || !doc.getElementById) return current;
    const body = doc.body;
    KEYS.forEach((k) => {
      const on = current[k];
      const nav = doc.getElementById(UI[k].nav);
      if (nav) { nav.hidden = !on; nav.disabled = !on; }
      const pane = doc.getElementById(UI[k].pane);
      if (pane && !on) pane.hidden = true;
      if (body && body.classList) body.classList.toggle("hd-mod-off-" + k, !on);
    });
    if (body && body.classList) {
      body.classList.toggle("hd-single-module", enabledList(current).length === 1);
      body.classList.add("hd-modules-ready");
    }
    return current;
  }

  async function load() {
    try {
      const r = await root.fetch(panelRoot() + "/api/modules", { cache: "no-store" });
      if (!r || !r.ok) return normalize(null); // backend antiguo: todo activo
      const j = await r.json();
      return normalize(j && j.modules);
    } catch (_) {
      return normalize(null);
    }
  }

  const api = {
    KEYS,
    normalize,
    enabledList,
    firstEnabled,
    apply,
    load,
    isEnabled(k) { return !!current[k]; },
    get current() { return Object.assign({}, current); },
    ready: null,
  };
  if (root.document && typeof root.fetch === "function") {
    api.ready = load().then((m) => apply(m));
  } else {
    api.ready = Promise.resolve(current);
  }
  root.HDModules = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
