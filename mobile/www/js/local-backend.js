/* On-device API: floors/images in IndexedDB, devices via TuyaCloud. Do not touch app.js. */
"use strict";

(function () {
  const nativeFetch = window.fetch.bind(window);
  const NativeES = window.EventSource;
  const DB_NAME = "hadomotics-mobile";
  let dbPromise = null;
  let cache = {
    floors: [{ id: "floor1", name: "Floor 1", order: 0, elements: [], image: null }],
    images: {},
    tuya: {},
  };
  const sseClients = [];
  const blobUrls = {};

  function objectUrlFor(name) {
    if (!name) return "";
    if (blobUrls[name]) return blobUrls[name];
    const dataUrl = cache.images[name];
    if (!dataUrl || typeof dataUrl !== "string") return "";
    const parts = dataUrl.split(",");
    const b64 = parts[1];
    if (!b64) return dataUrl;
    try {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const mimeMatch = (parts[0] || "").match(/data:([^;]+)/);
      const mime = (mimeMatch && mimeMatch[1]) || "image/png";
      blobUrls[name] = URL.createObjectURL(new Blob([bytes], { type: mime }));
      return blobUrls[name];
    } catch (_) {
      return dataUrl;
    }
  }

  window.HADomoticsImageUrl = function (name) {
    return objectUrlFor(name);
  };

  (function patchImageSrc() {
    const desc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src");
    if (!desc || !desc.set) return;
    Object.defineProperty(HTMLImageElement.prototype, "src", {
      configurable: true,
      enumerable: true,
      get() { return desc.get.call(this); },
      set(val) {
        const s = String(val || "");
        if (s.indexOf("/api/images/") >= 0) {
          const raw = s.split("/api/images/")[1] || "";
          const name = decodeURIComponent(raw.split("?")[0]);
          const local = objectUrlFor(name);
          if (local) {
            desc.set.call(this, local);
            return;
          }
        }
        desc.set.call(this, val);
      },
    });
  })();

  function uuid() {
    return crypto.randomUUID ? crypto.randomUUID() : "id-" + Date.now() + "-" + Math.random().toString(16).slice(2);
  }

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function kvGet(key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("kv", "readonly");
      const q = tx.objectStore("kv").get(key);
      q.onsuccess = () => resolve(q.result);
      q.onerror = () => reject(q.error);
    });
  }

  async function kvSet(key, val) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("kv", "readwrite");
      const q = tx.objectStore("kv").put(val, key);
      q.onsuccess = () => resolve();
      q.onerror = () => reject(q.error);
    });
  }

  async function loadStore() {
    const stored = await kvGet("store");
    if (stored && stored.floors) {
      cache = stored;
    } else {
      cache = {
        floors: [{ id: "floor1", name: "Floor 1", order: 0, elements: [], image: null }],
        images: {},
        tuya: {},
      };
      await saveStore();
    }
    if (cache.tuya && cache.tuya.access_id) {
      await TuyaCloud.configure({
        access_id: cache.tuya.access_id,
        access_secret: cache.tuya.access_secret,
        region: cache.tuya.region || "eu",
      });
    }
  }

  async function saveStore() {
    await kvSet("store", cache);
  }

  function jsonRes(obj, status) {
    return new Response(JSON.stringify(obj), {
      status: status || 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  function statesWithAliases() {
    const states = TuyaCloud.haStyleStates();
    const index = {};
    states.forEach((s) => { if (s.entity_id) index[s.entity_id] = s; });
    const extra = [];
    cache.floors.forEach((floor) => {
      (floor.elements || []).forEach((el) => {
        const eid = (el.entity_id || "").trim();
        if (!eid || index[eid]) return;
        try {
          const r = TuyaCloud.resolveEntity(eid, el.type || "");
          const src = (r.code && index[`tuya.${r.id}.${r.code}`]) || index[`tuya.${r.id}`];
          if (src) {
            const aliased = Object.assign({}, src, { entity_id: eid });
            extra.push(aliased);
            index[eid] = aliased;
          }
        } catch (_) { /* ignore */ }
      });
    });
    return states.concat(extra);
  }

  function findFloor(id) {
    return cache.floors.find((f) => f.id === id);
  }

  async function handleApi(url, opts) {
    opts = opts || {};
    const method = (opts.method || "GET").toUpperCase();
    const u = new URL(url, location.origin);
    let path = u.pathname;
    const idx = path.indexOf("/api/");
    if (idx >= 0) path = path.slice(idx);
    let body = {};
    if (opts.body && typeof opts.body === "string") {
      try { body = JSON.parse(opts.body); } catch (_) { body = {}; }
    } else if (opts.body && !(opts.body instanceof FormData)) {
      body = opts.body;
    }

    try {
      if (path === "/api/floors" && method === "GET") {
        return jsonRes(cache.floors.map((f) => ({
          id: f.id, name: f.name, order: f.order || 0, image: f.image || null,
          elements: f.elements || [],
        })));
      }
      if (path === "/api/floors" && method === "POST") {
        const floor = {
          id: uuid(),
          name: body.name || "Floor",
          order: cache.floors.length,
          elements: [],
          image: null,
        };
        cache.floors.push(floor);
        await saveStore();
        return jsonRes(floor);
      }

      const floorMatch = path.match(/^\/api\/floors\/([^/]+)(?:\/(.*))?$/);
      if (floorMatch) {
        const floorId = decodeURIComponent(floorMatch[1]);
        const rest = floorMatch[2] || "";
        const floor = findFloor(floorId);
        if (!floor) return jsonRes({ error: "Floor not found" }, 404);

        if (!rest && method === "GET") return jsonRes(floor);
        if (!rest && method === "DELETE") {
          cache.floors = cache.floors.filter((f) => f.id !== floorId);
          await saveStore();
          return jsonRes({ ok: true });
        }
        if (rest === "image" && method === "POST") {
          const fd = opts.body;
          const file = fd && fd.get && fd.get("image");
          if (!file) return jsonRes({ error: "No image" }, 400);
          const mime = file.type || "";
          if (mime && !/^image\/(jpeg|jpg|png|webp|gif|bmp)/i.test(mime)) {
            return jsonRes({ error: "Usa JPG, PNG o WebP (el formato de la foto no es compatible)" }, 400);
          }
          if (floor.image && blobUrls[floor.image]) {
            try { URL.revokeObjectURL(blobUrls[floor.image]); } catch (_) {}
            delete blobUrls[floor.image];
          }
          const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(file);
          });
          const name = (file.name || "plan.png").replace(/[^\w.-]/g, "_");
          floor.image = `${floor.id}_${name}`;
          cache.images[floor.image] = dataUrl;
          await saveStore();
          return jsonRes({ ok: true, image: floor.image });
        }
        if (rest === "image" && method === "DELETE") {
          if (floor.image) delete cache.images[floor.image];
          floor.image = null;
          await saveStore();
          return jsonRes({ ok: true });
        }
        if (rest === "elements" && method === "POST") {
          const el = Object.assign({ id: uuid(), x: 20, y: 20, width: 64, height: 64 }, body);
          floor.elements = floor.elements || [];
          floor.elements.push(el);
          await saveStore();
          return jsonRes(el);
        }
        const elMatch = rest.match(/^elements\/([^/]+)$/);
        if (elMatch && method === "PUT") {
          const elId = decodeURIComponent(elMatch[1]);
          const el = (floor.elements || []).find((e) => e.id === elId);
          if (!el) return jsonRes({ error: "Element not found" }, 404);
          Object.assign(el, body);
          await saveStore();
          return jsonRes(el);
        }
        if (elMatch && method === "DELETE") {
          const elId = decodeURIComponent(elMatch[1]);
          floor.elements = (floor.elements || []).filter((e) => e.id !== elId);
          await saveStore();
          return jsonRes({ ok: true });
        }
      }

      const imgMatch = path.match(/^\/api\/images\/(.+)$/);
      if (imgMatch && method === "GET") {
        const name = decodeURIComponent(imgMatch[1]);
        const dataUrl = cache.images[name];
        if (!dataUrl) return jsonRes({ error: "Not found" }, 404);
        const bin = atob(dataUrl.split(",")[1] || "");
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const mime = (dataUrl.split(";")[0] || "data:image/png").replace("data:", "") || "image/png";
        return new Response(bytes, { status: 200, headers: { "Content-Type": mime } });
      }

      if (path === "/api/tuya/config" && method === "GET") {
        return jsonRes(Object.assign({}, TuyaCloud.publicConfig(), TuyaCloud.publicStatus()));
      }
      if (path === "/api/tuya/config" && method === "POST") {
        if (body.access_id != null) cache.tuya.access_id = body.access_id;
        if (body.access_secret) cache.tuya.access_secret = body.access_secret;
        if (body.region) cache.tuya.region = body.region;
        await saveStore();
        const status = await TuyaCloud.configure({
          access_id: cache.tuya.access_id,
          access_secret: cache.tuya.access_secret,
          region: cache.tuya.region || "eu",
        });
        broadcast();
        return jsonRes(status);
      }
      if (path === "/api/tuya/devices" && method === "GET") {
        return jsonRes(TuyaCloud.listDevices());
      }
      if (path === "/api/tuya/sync" && method === "POST") {
        const devices = await TuyaCloud.syncDevices();
        broadcast();
        return jsonRes({ ok: true, devices, status: TuyaCloud.publicStatus() });
      }
      if ((path === "/api/ha/states" || path === "/api/tuya/states") && method === "GET") {
        return jsonRes(statesWithAliases());
      }

      const svc = path.match(/^\/api\/(?:ha|tuya)\/services\/([^/]+)\/([^/]+)$/);
      if (svc && method === "POST") {
        const domain = svc[1];
        const service = svc[2];
        const entityId = body.entity_id || (body.service_data && body.service_data.entity_id) || "";
        const resolved = TuyaCloud.resolveEntity(entityId, domain);
        let result;
        const nested = body.service_data || {};
        if (service === "set_cover_position" || service === "set_position" || (domain === "cover" && (body.position != null || nested.position != null))) {
          const pos = body.position != null ? body.position : nested.position;
          result = await TuyaCloud.setCover(resolved.id, pos, resolved.code);
        } else if (service === "turn_on") {
          result = await TuyaCloud.command(resolved.id, [{ code: resolved.code || "switch_1", value: true }]);
        } else if (service === "turn_off") {
          result = await TuyaCloud.command(resolved.id, [{ code: resolved.code || "switch_1", value: false }]);
        } else {
          result = await TuyaCloud.toggle(resolved.id, resolved.code);
        }
        broadcast();
        return jsonRes(result);
      }

      if (path === "/api/backup" && method === "GET") {
        return jsonRes({
          version: "mobile-0.1.0",
          floors: cache.floors,
          images: cache.images,
          tuya: { access_id: cache.tuya.access_id, region: cache.tuya.region },
        });
      }
      if (path === "/api/restore" && method === "POST") {
        if (body.floors) cache.floors = body.floors;
        if (body.images) cache.images = body.images;
        await saveStore();
        return jsonRes({ ok: true });
      }

      return jsonRes({ error: "Not found: " + path }, 404);
    } catch (err) {
      return jsonRes({ error: String(err.message || err) }, 400);
    }
  }

  function broadcast() {
    const payload = JSON.stringify({ type: "states", states: statesWithAliases() });
    const conn = JSON.stringify({
      type: "connected",
      ha_ws: TuyaCloud.publicStatus().connected,
      tuya: TuyaCloud.publicStatus(),
    });
    sseClients.forEach((c) => {
      try {
        if (c.onmessage) {
          c.onmessage({ data: conn });
          c.onmessage({ data: payload });
        }
      } catch (_) { /* ignore */ }
    });
  }

  function LocalEventSource() {
    this.onmessage = null;
    this.onerror = null;
    this.readyState = 1;
    sseClients.push(this);
    setTimeout(() => {
      if (this.onmessage) {
        this.onmessage({
          data: JSON.stringify({
            type: "connected",
            ha_ws: TuyaCloud.publicStatus().connected,
            tuya: TuyaCloud.publicStatus(),
          }),
        });
        this.onmessage({ data: JSON.stringify({ type: "states", states: statesWithAliases() }) });
      }
    }, 150);
    this._timer = setInterval(async () => {
      try {
        if (!TuyaCloud.state.demo) await TuyaCloud.refreshStatuses();
        if (this.onmessage) {
          this.onmessage({ data: JSON.stringify({ type: "states", states: statesWithAliases() }) });
          this.onmessage({
            data: JSON.stringify({
              type: "connected",
              ha_ws: TuyaCloud.publicStatus().connected,
              tuya: TuyaCloud.publicStatus(),
            }),
          });
        }
      } catch (_) { /* ignore */ }
    }, 4000);
  }
  LocalEventSource.prototype.close = function () {
    clearInterval(this._timer);
    const i = sseClients.indexOf(this);
    if (i >= 0) sseClients.splice(i, 1);
  };
  LocalEventSource.prototype.addEventListener = function () {};

  window.fetch = function (url, opts) {
    const s = String(url && url.url ? url.url : url);
    if (s.includes("/api/")) return handleApi(s, opts || {});
    return nativeFetch(url, opts);
  };

  window.EventSource = function (url) {
    const s = String(url);
    if (s.includes("/api/ha/stream") || s.includes("/api/tuya/stream")) return new LocalEventSource();
    return new NativeES(url);
  };

  window.HADomoticsReady = loadStore().catch((err) => console.error("HADomotics store", err));
})();
