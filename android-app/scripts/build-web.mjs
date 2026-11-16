// Construye www/ para Capacitor: el frontend del add-on (hadomotics/static) SIN CAMBIOS
// + la capa standalone (src/) que sustituye al backend Flask/HA. Uso: node scripts/build-web.mjs
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const app = resolve(here, "..");
const addonStatic = resolve(app, "../hadomotics/static");
const www = join(app, "www");

// Orden de carga: registro de módulos, núcleo, Tuya, alarma, energía, backend, shim (antes que app.js).
export const MODULES = [
  "core/umd.js", "core/store.js",
  "tuya/sign.js", "tuya/cloud.js", "tuya/mapper.js", "tuya/demo-home.js", "tuya/mock-server.js",
  "alarm/engine.js", "energy/flow.js",
  "backend/hub.js", "backend/api.js", "backend/shim.js",
];

rmSync(www, { recursive: true, force: true });
mkdirSync(www, { recursive: true });
cpSync(addonStatic, join(www, "static"), { recursive: true });
cpSync(join(app, "src"), join(www, "standalone"), { recursive: true });
cpSync(join(app, "assets"), join(www, "standalone/assets"), { recursive: true });

let html = readFileSync(join(addonStatic, "index.html"), "utf8");
const googleIcons = '<link rel="stylesheet" href="https://fonts.googleapis.com/icon?family=Material+Icons" />';
if (!html.includes(googleIcons)) throw new Error("index.html del add-on cambió: revisa el enlace de Material Icons");
html = html.replace(googleIcons, '<link rel="stylesheet" href="standalone/assets/material-icons.css" />\n  <link rel="stylesheet" href="standalone/ui/standalone.css" />');
html = html.replace('<html lang="en">', '<html lang="es">');
html = html.replace('<meta name="viewport" content="width=device-width, initial-scale=1.0" />', '<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />');
const firstAddonScript = '<script src="static/js/plan_overlays.js"></script>';
if (!html.includes(firstAddonScript)) throw new Error("index.html del add-on cambió: no encuentro plan_overlays.js");
const inject = MODULES.map((m) => `  <script src="standalone/${m}"></script>`).join("\n") + "\n  ";
html = html.replace(firstAddonScript, inject + firstAddonScript);
html = html.replace("</body>", '  <script src="standalone/ui/standalone.js"></script>\n</body>');
writeFileSync(join(www, "index.html"), html);
const pkg = JSON.parse(readFileSync(join(app, "package.json"), "utf8"));
writeFileSync(join(www, "standalone/version.json"), JSON.stringify({ app: pkg.version, addon: (readFileSync(resolve(app, "../hadomotics/config.yaml"), "utf8").match(/^version:\s*"?([^"\s]+)/m) || [])[1] }));
console.log("www/ listo:", existsSync(join(www, "index.html")));
