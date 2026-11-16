/* Firma HMAC-SHA256 de Tuya Cloud OpenAPI, según la especificación oficial
 * «Sign Requests for Cloud Authorization»:
 *   stringToSign = METHOD \n SHA256(body) \n Optional_Signature_key \n URL
 *   token:    str = client_id + t + nonce + stringToSign
 *   negocio:  str = client_id + access_token + t + nonce + stringToSign
 *   sign = HMAC-SHA256(str, secret).toUpperCase()
 * URL = path + ("?" + parámetros ordenados alfabéticamente, si hay).
 * Usa WebCrypto (WebView y Node >= 18). Nunca registra el secreto. */
(function (root) {
  "use strict";
  if (!root.HDX && typeof require === "function") require("../core/umd.js");
  const HDX = root.HDX;

  function subtle() {
    const c = (typeof globalThis !== "undefined" && globalThis.crypto) || null;
    if (!c || !c.subtle) throw new Error("WebCrypto no disponible");
    return c.subtle;
  }

  function toHex(buf) {
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  async function sha256Hex(str) {
    const data = new TextEncoder().encode(str || "");
    return toHex(await subtle().digest("SHA-256", data));
  }

  async function hmacSha256Hex(secret, msg) {
    const enc = new TextEncoder();
    const key = await subtle().importKey("raw", enc.encode(secret || ""), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return toHex(await subtle().sign("HMAC", key, enc.encode(msg)));
  }

  /** path + query ordenada (claves en orden alfabético, sin codificar, como el ejemplo oficial). */
  function canonicalUrl(path, query) {
    const q = query || {};
    const keys = Object.keys(q).filter((k) => q[k] !== undefined && q[k] !== null && q[k] !== "").sort();
    if (!keys.length) return path;
    return path + "?" + keys.map((k) => `${k}=${q[k]}`).join("&");
  }

  /** Optional_Signature_key: cada cabecera firmada como "k:v\n". */
  function signatureHeadersBlock(signHeaders) {
    const h = signHeaders || {};
    return Object.keys(h).map((k) => `${k}:${h[k]}`).join("\n") + (Object.keys(h).length ? "\n" : "");
  }

  async function stringToSign({ method, body, path, query, signHeaders }) {
    const contentSha = await sha256Hex(body || "");
    return [String(method || "GET").toUpperCase(), contentSha, signatureHeadersBlock(signHeaders), canonicalUrl(path, query)].join("\n");
  }

  /**
   * Firma una petición. Devuelve { sign, headers, url, stringToSign }.
   * opts: clientId, secret, accessToken (vacío = petición de token), t, nonce,
   *       method, path, query, body (string), signHeaders ({k: v}).
   */
  async function signRequest(opts) {
    const t = String(opts.t || Date.now());
    const nonce = opts.nonce || "";
    const sts = await stringToSign(opts);
    const str = opts.clientId + (opts.accessToken || "") + t + nonce + sts;
    const sign = (await hmacSha256Hex(opts.secret, str)).toUpperCase();
    const headers = { client_id: opts.clientId, sign, t, sign_method: "HMAC-SHA256" };
    if (nonce) headers.nonce = nonce;
    if (opts.accessToken) headers.access_token = opts.accessToken;
    const sh = opts.signHeaders || {};
    if (Object.keys(sh).length) {
      headers["Signature-Headers"] = Object.keys(sh).join(":");
      Object.assign(headers, sh);
    }
    return { sign, headers, url: canonicalUrl(opts.path, opts.query), stringToSign: sts };
  }

  const api = { sha256Hex, hmacSha256Hex, canonicalUrl, stringToSign, signRequest, toHex };
  HDX.define("tuyaSign", () => api);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
