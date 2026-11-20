"""Capturas headless de la app (WebView emulada en Chrome) servida en http://127.0.0.1:8765.
Uso: <venv>/bin/python tools/capture.py <dir_salida>
Solo se permite tráfico a 127.0.0.1 (modo demo: Tuya simulado dentro de la página)."""
import sys, json, os
from playwright.sync_api import sync_playwright
OUT = sys.argv[1]
BASE = "http://127.0.0.1:8765/"
os.makedirs(OUT, exist_ok=True)
log = []

def guard(route):
    return route.continue_() if route.request.url.startswith("http://127.0.0.1") else route.abort()

with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
    def ctx(mobile=True):
        if mobile:
            c = b.new_context(viewport={"width": 412, "height": 892}, is_mobile=True, has_touch=True, device_scale_factor=2)
        else:
            c = b.new_context(viewport={"width": 1280, "height": 800})
        pg = c.new_page()
        errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.on("console", lambda m: errs.append("console." + m.type + ": " + m.text) if m.type in ("error",) else None)
        pg.route("**/*", guard)
        return c, pg, errs
    def shot(pg, name, errs):
        path = os.path.join(OUT, name)
        pg.screenshot(path=path)
        log.append({"shot": name, "errors": list(errs)})
        errs.clear()

    # 1) Asistente (móvil, primera vez)
    c, pg, errs = ctx(True)
    pg.goto(BASE); pg.wait_for_timeout(1500)
    shot(pg, "01_asistente_bienvenida_movil.png", errs)
    pg.click("[data-w=next]"); pg.wait_for_timeout(300)
    shot(pg, "02_asistente_guia_tuya_movil.png", errs)
    pg.click("[data-w=next]"); pg.wait_for_timeout(300)
    shot(pg, "03_asistente_claves_movil.png", errs)
    pg.click("[data-w=demo]"); pg.wait_for_timeout(2500)
    shot(pg, "04_asistente_dispositivos_movil.png", errs)
    pg.click("[data-w=next]"); pg.wait_for_timeout(300)
    pg.click("[data-w=finish]"); pg.wait_for_timeout(3500)
    shot(pg, "05_dispositivos_movil.png", errs)
    # Seguridad
    pg.click("#navSeguridad"); pg.wait_for_timeout(2500)
    shot(pg, "06_seguridad_movil.png", errs)
    pg.click("#secZonesBtn"); pg.wait_for_timeout(600)
    shot(pg, "07_seguridad_zonas_movil.png", errs)
    pg.click("#secZonesBtn"); pg.wait_for_timeout(300)
    pg.click("#secDetBtn"); pg.wait_for_timeout(600)
    shot(pg, "08_seguridad_detecciones_movil.png", errs)
    pg.click("#secDetBtn"); pg.wait_for_timeout(300)
    # Energía
    pg.click("#navEnergia"); pg.wait_for_timeout(3000)
    shot(pg, "09_energia_movil.png", errs)
    # Ajustes
    pg.click("#navAjustes"); pg.wait_for_timeout(1200)
    shot(pg, "10_ajustes_estado_movil.png", errs)
    pg.click(".hdx-tabs button[data-t=alarma]"); pg.wait_for_timeout(1000)
    shot(pg, "11_ajustes_alarma_movil.png", errs)
    pg.click(".hdx-tabs button[data-t=tuya]"); pg.wait_for_timeout(800)
    shot(pg, "12_ajustes_tuya_movil.png", errs)
    pg.click(".hdx-tabs button[data-t=fondo]"); pg.wait_for_timeout(800)
    shot(pg, "13_ajustes_segundo_plano_movil.png", errs)
    pg.click(".hdx-tabs button[data-t=energia]"); pg.wait_for_timeout(800)
    shot(pg, "14_ajustes_energia_movil.png", errs)
    pg.click(".hdx-tabs button[data-t=copia]"); pg.wait_for_timeout(600)
    shot(pg, "15_ajustes_copia_movil.png", errs)
    c.close()

    # 2) Escritorio / tablet (asistente rápido en modo demo)
    c, pg, errs = ctx(False)
    pg.goto(BASE); pg.wait_for_timeout(1500)
    pg.click("[data-w=next]"); pg.wait_for_timeout(200)
    pg.click("[data-w=next]"); pg.wait_for_timeout(200)
    pg.click("[data-w=demo]"); pg.wait_for_timeout(2500)
    pg.click("[data-w=next]"); pg.wait_for_timeout(200)
    pg.click("[data-w=finish]"); pg.wait_for_timeout(3500)
    errs.clear()
    shot(pg, "20_dispositivos_tablet.png", errs)
    pg.click("#navSeguridad"); pg.wait_for_timeout(2500)
    pg.click("#secZonesBtn"); pg.wait_for_timeout(600)
    shot(pg, "21_seguridad_zonas_tablet.png", errs)
    pg.click("#secZonesBtn"); pg.wait_for_timeout(300)
    pg.click("#navEnergia"); pg.wait_for_timeout(3000)
    shot(pg, "22_energia_tablet.png", errs)
    c.close()
    print(json.dumps(log, ensure_ascii=False, indent=1))
    b.close()
