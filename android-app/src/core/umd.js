/* HADomotics Android — registro de módulos compartido entre la WebView y Node (tests).
 * Cada módulo se registra con HDX.define(nombre, fábrica). En Node, require() devuelve
 * el módulo; en la WebView quedan en window.HDX.<nombre>. Sin dependencias externas. */
(function (root) {
  "use strict";
  const HDX = root.HDX || (root.HDX = {});
  HDX.define = HDX.define || function (name, factory) {
    const mod = factory(HDX);
    HDX[name] = mod;
    return mod;
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
