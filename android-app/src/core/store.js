/* Persistencia local de la app: IndexedDB en Android (WebView), memoria en tests.
 * Guarda planos (JSON), imágenes de los planos (Blob), ajustes, registro de entidades
 * y estado de la alarma. Los secretos de Tuya NO van aquí: van al almacén seguro
 * nativo (Android Keystore, ver SecureStore). */
(function (root) {
  "use strict";
  if (!root.HDX && typeof require === "function") require("./umd.js");
  const HDX = root.HDX;

  class MemoryStore {
    constructor() { this.m = new Map(); }
    async get(k) { return this.m.has(k) ? clone(this.m.get(k)) : undefined; }
    async set(k, v) { this.m.set(k, clone(v)); }
    async del(k) { this.m.delete(k); }
    async keys(prefix) { return [...this.m.keys()].filter((k) => !prefix || k.startsWith(prefix)); }
  }

  function clone(v) {
    if (v === undefined || v === null) return v;
    if (typeof Blob !== "undefined" && v instanceof Blob) return v;
    if (v instanceof Uint8Array) return new Uint8Array(v);
    return JSON.parse(JSON.stringify(v));
  }

  class IdbStore {
    constructor(name) { this.name = name || "hadomotics"; this.db = null; }
    open() {
      if (this.db) return Promise.resolve(this.db);
      return new Promise((resolve, reject) => {
        const req = indexedDB.open(this.name, 1);
        req.onupgradeneeded = () => req.result.createObjectStore("kv");
        req.onsuccess = () => { this.db = req.result; resolve(this.db); };
        req.onerror = () => reject(req.error);
      });
    }
    async _tx(mode, fn) {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction("kv", mode);
        const r = fn(tx.objectStore("kv"));
        tx.oncomplete = () => resolve(r && "result" in r ? r.result : undefined);
        tx.onerror = () => reject(tx.error);
      });
    }
    get(k) { return this._tx("readonly", (s) => s.get(k)); }
    set(k, v) { return this._tx("readwrite", (s) => s.put(v, k)); }
    del(k) { return this._tx("readwrite", (s) => s.delete(k)); }
    async keys(prefix) {
      const all = await this._tx("readonly", (s) => s.getAllKeys());
      return (all || []).map(String).filter((k) => !prefix || k.startsWith(prefix));
    }
  }

  /** Almacén seguro: plugin nativo HDSecureStorage (EncryptedSharedPreferences +
   *  Android Keystore). Sin plugin (navegador/tests) guarda SOLO en memoria. */
  class SecureStore {
    constructor(plugin) { this.plugin = plugin || null; this.mem = new Map(); }
    get available() { return !!this.plugin; }
    async get(k) {
      if (this.plugin) { const r = await this.plugin.get({ key: k }); return r && r.value != null ? r.value : null; }
      return this.mem.has(k) ? this.mem.get(k) : null;
    }
    async set(k, v) {
      if (this.plugin) return this.plugin.set({ key: k, value: String(v) });
      this.mem.set(k, String(v));
    }
    async remove(k) {
      if (this.plugin) return this.plugin.remove({ key: k });
      this.mem.delete(k);
    }
  }

  const api = { MemoryStore, IdbStore, SecureStore };
  HDX.define("store", () => api);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
