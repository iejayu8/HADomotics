"use strict";
// Vectores de la documentación oficial de Tuya («Sign Requests for Cloud Authorization»).
// Son los valores de ejemplo públicos del documento, NO credenciales reales.
const test = require("node:test");
const assert = require("node:assert");
const sign = require("../src/tuya/sign.js");

const DOC = {
  clientId: "1KAD46OrT9HafiKdsXeg",
  secret: "4OHBOnWOqaEC1mWXOpVL3yV50s0qGSRC",
  t: "1588925778000",
  nonce: "5138cc3a9033d69856923fd07b491173",
  signHeaders: { area_id: "29a33e8796834b1efa6", call_id: "8afdb70ab2ed11eb85290242ac130003" },
};

test("SHA256 del cuerpo vacío", async () => {
  assert.strictEqual(await sign.sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});

test("URL canónica: parámetros en orden alfabético", () => {
  assert.strictEqual(
    sign.canonicalUrl("/v1.0/iot-03/devices/87707085bcddc23a5fa3/logs", { start_time: 1657160836000, event_types: 1, end_time: 1657263936000 }),
    "/v1.0/iot-03/devices/87707085bcddc23a5fa3/logs?end_time=1657263936000&event_types=1&start_time=1657160836000"
  );
  assert.strictEqual(sign.canonicalUrl("/v1.0/token", {}), "/v1.0/token");
});

test("firma de petición de token (ejemplo oficial)", async () => {
  const r = await sign.signRequest({ ...DOC, method: "GET", path: "/v1.0/token", query: { grant_type: 1 }, body: "" });
  assert.strictEqual(r.sign, "9E48A3E93B302EEECC803C7241985D0A34EB944F40FB573C7B5C2A82158AF13E");
  assert.strictEqual(r.headers["Signature-Headers"], "area_id:call_id");
  assert.ok(!("access_token" in r.headers));
});

test("firma de petición de negocio (ejemplo oficial)", async () => {
  const r = await sign.signRequest({
    ...DOC, accessToken: "3f4eda2bdec17232f67c0b188af3eec1", method: "GET",
    path: "/v2.0/apps/schema/users", query: { page_size: 50, page_no: 1 }, body: "",
  });
  assert.strictEqual(r.sign, "AE4481C692AA80B25F3A7E12C3A5FD9BBF6251539DD78E565A1A72A508A88784");
  assert.strictEqual(r.headers.access_token, "3f4eda2bdec17232f67c0b188af3eec1");
  assert.strictEqual(r.url, "/v2.0/apps/schema/users?page_no=1&page_size=50");
});

test("las cabeceras nunca llevan el secreto", async () => {
  const r = await sign.signRequest({ clientId: "id", secret: "SECRETO-NO", t: "1", method: "POST", path: "/x", body: "{}" });
  assert.ok(!JSON.stringify(r.headers).includes("SECRETO-NO"));
});
