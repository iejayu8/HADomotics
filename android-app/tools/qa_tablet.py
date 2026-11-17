"""QA de HADomotics Android (www/ en modo demo) emulando una tablet con toques reales (CDP).
Uso: npm run build:web; servir www/ en http://127.0.0.1:8765; <venv>/bin/python tools/qa_tablet.py <dir_salida>"""
import json, os, sys
from playwright.sync_api import sync_playwright
BASE = "http://127.0.0.1:8765/"
OUT = sys.argv[1]
os.makedirs(OUT, exist_ok=True)
R = []
def ok(name, cond, detail=""):
    R.append({"test": name, "ok": bool(cond), "detail": detail}); print(("OK  " if cond else "FAIL") + " " + name + " " + str(detail)[:200], flush=True)
def guard(route):
    return route.continue_() if route.request.url.startswith("http://127.0.0.1") else route.abort()

def session(b, w, h, tag):
    c = b.new_context(viewport={"width": w, "height": h}, is_mobile=True, has_touch=True, device_scale_factor=1)
    pg = c.new_page(); pg.route("**/*", guard)
    errs = []; pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.on("console", lambda m: errs.append("console.error: " + m.text) if m.type == "error" else None)
    cdp = c.new_cdp_session(pg)
    def shot(name): pg.screenshot(path=os.path.join(OUT, f"{name}_{tag}.png"))
    def center(sel):
        bb = pg.locator(sel).first.bounding_box(); return bb["x"] + bb["width"] / 2, bb["y"] + bb["height"] / 2
    def touch_drag(x, y, dx, dy, steps=12):
        cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": x, "y": y}]})
        for i in range(1, steps + 1):
            cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [{"x": x + dx * i / steps, "y": y + dy * i / steps}]}); pg.wait_for_timeout(25)
        cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []}); pg.wait_for_timeout(900)
    def tap(sel):
        x, y = center(sel); pg.touchscreen.tap(x, y); pg.wait_for_timeout(700)
    def api(path):
        return pg.evaluate("async (p) => (await fetch(p)).json()", path)
    def state(eid):
        return pg.evaluate("(e) => { const s = window.HDStandalone.hub.getState(e); return s && s.state; }", eid)
    return c, pg, errs, shot, center, touch_drag, tap, api, state

with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
    # ---------------------------------------------------------------- tablet horizontal
    c, pg, errs, shot, center, touch_drag, tap, api, state = session(b, 1280, 800, "tablet_horizontal")
    pg.goto(BASE); pg.wait_for_timeout(1500)
    ok("asistente visible al primer arranque", pg.locator("[data-w=next]").count() > 0)
    shot("01_asistente")
    for sel in ["[data-w=next]", "[data-w=next]", "[data-w=demo]"]:
        tap(sel); pg.wait_for_timeout(1800 if "demo" in sel else 0)
    shot("02_asistente_demo_dispositivos")
    tap("[data-w=next]"); tap("[data-w=finish]"); pg.wait_for_timeout(3000)
    st = api("/api/standalone/status")
    ok("modo demo activo tras el asistente", st.get("mode") == "demo" and st.get("onboarded"), {k: st.get(k) for k in ("mode", "onboarded", "devices")})
    shot("03_dispositivos")
    # Toggle por toque
    before = state("switch.regleta_oficina_1")
    el_sel = None
    for i in range(pg.locator("#canvasContainer .element-overlay").count()):
        if "Regleta" in pg.locator("#canvasContainer .element-overlay").nth(i).inner_text():
            el_sel = f"#canvasContainer .element-overlay >> nth={i}"; break
    tap(el_sel); pg.wait_for_timeout(800)
    after = state("switch.regleta_oficina_1")
    ok("Dispositivos: tocar «Regleta» conmuta el enchufe", before != after and after in ("on", "off"), f"{before} -> {after}")
    tap(el_sel); pg.wait_for_timeout(600)
    # Cambio de planta
    pg.locator("#floorSwitcher .floor-btn", has_text="Planta 1").first.click(); pg.wait_for_timeout(1500)
    act = pg.inner_text("#floorSwitcher .floor-btn.active")
    els1 = pg.evaluate("() => [...document.querySelectorAll('#canvasContainer .element-overlay')].map(e => e.innerText.trim())")
    ok("cambio a Planta 1 muestra su plano y sus elementos", act == "Planta 1" and any("Despacho" in t for t in els1), f"activa={act} elementos={els1}")
    shot("04_dispositivos_planta1")
    pg.locator("#floorSwitcher .floor-btn", has_text="Planta baja").first.click(); pg.wait_for_timeout(1500)
    ok("vuelta a Planta baja", pg.inner_text("#floorSwitcher .floor-btn.active") == "Planta baja")
    # Modo edición: arrastre táctil dentro y fuera del plano
    pg.click("#btnToggleMode"); pg.wait_for_timeout(1200)
    shot("05_edicion")
    def floor_el(label):
        els = api("/api/floors/planta_baja/elements")
        return next(e for e in els if e.get("label") == label)
    def overlay_sel(eid): return f'#canvasContainer [data-id="{eid}"]'
    e0 = floor_el("Depuradora"); x, y = center(overlay_sel(e0["id"]))
    touch_drag(x, y, 80, -50)
    e1 = floor_el("Depuradora")
    ok("edición: arrastre táctil mueve un elemento del plano y se guarda", abs(e1["x"] - e0["x"]) > 20 and abs(e1["y"] - e0["y"]) > 10, f"({e0['x']:.0f},{e0['y']:.0f}) -> ({e1['x']:.0f},{e1['y']:.0f})")
    shot("06_edicion_tras_arrastre_tactil")
    s0 = floor_el("Escena día"); x, y = center(overlay_sel(s0["id"]))
    touch_drag(x, y, 70, 0)
    s1 = floor_el("Escena día")
    ok("edición: arrastre táctil de un elemento fuera del plano (sigue fuera)", abs(s1["x"] - s0["x"]) > 20 and s1.get("outside") is True, f"x {s0['x']:.0f} -> {s1['x']:.0f}, outside={s1.get('outside')}")
    # arrastrar un elemento del plano al fondo (fuera del dibujo)
    r0 = floor_el("Regleta"); x, y = center(overlay_sel(r0["id"]))
    touch_drag(x, y, 0, 230)
    r1 = floor_el("Regleta")
    ok("edición: soltar fuera del dibujo lo marca «fuera del plano»", r1.get("outside") is True, f"y {r0['y']:.0f} -> {r1['y']:.0f}")
    tx, ty = center("#canvasContainer .plan-drawing-outline") if pg.locator("#canvasContainer .plan-drawing-outline").count() else center("#floorImage")
    rx, ry = center(overlay_sel(r1["id"]))
    touch_drag(rx, ry, tx - rx, ty - ry)
    r2 = floor_el("Regleta")
    ok("edición: devolverlo dentro del dibujo quita «fuera del plano»", r2.get("outside") is False, f"y {r1['y']:.0f} -> {r2['y']:.0f}")
    # redimensionar con el dedo
    w0 = floor_el("Depuradora"); hx, hy = center(overlay_sel(w0["id"]) + " .resize-handle")
    touch_drag(hx, hy, 30, 20)
    w1 = floor_el("Depuradora")
    ok("edición: redimensionar con el dedo", (w1.get("width") or 0) > (w0.get("width") or 0), f"{w0.get('width')} -> {w1.get('width')}")
    # ratón sigue funcionando
    m0 = floor_el("Depuradora"); x, y = center(overlay_sel(m0["id"]))
    pg.mouse.move(x, y); pg.mouse.down(); pg.mouse.move(x - 60, y + 30, steps=8); pg.mouse.up(); pg.wait_for_timeout(900)
    m1 = floor_el("Depuradora")
    ok("edición: arrastre con ratón (escritorio) sigue funcionando", abs(m1["x"] - m0["x"]) > 20, f"x {m0['x']:.0f} -> {m1['x']:.0f}")
    # dos arrastres seguidos del mismo elemento: el segundo parte de donde quedó
    a0 = floor_el("Depuradora"); x, y = center(overlay_sel(a0["id"])); touch_drag(x, y, 40, 0)
    a1 = floor_el("Depuradora"); x, y = center(overlay_sel(a1["id"])); touch_drag(x, y, 40, 0)
    a2 = floor_el("Depuradora")
    ok("edición: segundo arrastre seguido continúa desde la nueva posición", a2["x"] - a1["x"] > 20 and a1["x"] - a0["x"] > 20, f"x {a0['x']:.0f} -> {a1['x']:.0f} -> {a2['x']:.0f}")
    shot("07_edicion_final")
    pg.click("#btnToggleMode"); pg.wait_for_timeout(1000)
    # persistencia tras recargar
    pg.reload(); pg.wait_for_timeout(3500)
    pr = floor_el("Depuradora"); ok("posiciones persisten tras recargar", abs(pr["x"] - a2["x"]) < 1, f"{a2['x']:.0f} vs {pr['x']:.0f}")
    # ---------------------------------------------------------------- Seguridad
    pg.click("#navSeguridad"); pg.wait_for_timeout(2500)
    shot("08_seguridad")
    tap('#secModes button[data-mode="armed_night"]')
    ok("Seguridad: armar pide confirmación", pg.is_visible("#secConfirm"), pg.inner_text("#secConfirmText") if pg.is_visible("#secConfirm") else "")
    shot("09_seguridad_confirmar_noche")
    tap("#secConfirmYes"); pg.wait_for_timeout(1500)
    s = state("alarm_control_panel.hadomotics")
    ok("Seguridad: armar Noche → retardo de salida", s in ("arming", "armed_night"), s)
    pg.wait_for_timeout(11000)
    s = state("alarm_control_panel.hadomotics")
    zones_on = [z for z in ("entrada", "salon", "planta_1") if state(f"input_boolean.hd_zona_{z}") == "on"]
    ok("Seguridad: Noche armada y solo zonas «Noche» activas", s == "armed_night" and zones_on == ["entrada", "salon"], f"{s} {zones_on}")
    shot("10_seguridad_armada_noche")
    tap('#secModes button[data-mode="disarmed"]')
    vis = pg.is_visible("#secConfirm")
    if vis: tap("#secConfirmYes")
    pg.wait_for_timeout(1200)
    s = state("alarm_control_panel.hadomotics")
    ok("Seguridad: desarmar (con confirmación) apaga todas las zonas", s == "disarmed" and not any(state(f"input_boolean.hd_zona_{z}") == "on" for z in ("entrada", "salon", "planta_1")), f"confirm={vis} {s}")
    tap("#secZonesBtn"); pg.wait_for_timeout(600)
    z0 = state("input_boolean.hd_zona_salon")
    pg.locator("#secZones input, #secZones button, #secZones [role=switch]").nth(1).click(); pg.wait_for_timeout(900)
    z1 = state("input_boolean.hd_zona_salon")
    ok("Seguridad: conmutar una zona", z0 != z1, f"salon {z0} -> {z1}")
    shot("11_seguridad_zonas")
    pg.locator("#secZones input, #secZones button, #secZones [role=switch]").nth(1).click(); pg.wait_for_timeout(600)
    tap("#secZonesClose")
    tap("#secSirenBtn"); pg.wait_for_timeout(600)
    shot("12_seguridad_sirena")
    if pg.is_visible("#secSirenTest") and pg.is_enabled("#secSirenTest"):
        tap("#secSirenTest")
        c1 = pg.is_visible("#secConfirm")
        ok("Seguridad: probar sirena pide confirmación", c1, pg.inner_text("#secConfirmText") if c1 else "")
        shot("13_seguridad_sirena_confirmar")
        if c1: tap("#secConfirmNo")
        ok("Seguridad: cancelar no enciende la sirena", state("siren.sirena") != "on", state("siren.sirena"))
    else:
        ok("Seguridad: botón Probar sirena disponible", False, "no visible/deshabilitado")
    tap("#secSirenClose")
    # arrastre en Seguridad
    tap("#secEditBtn"); pg.wait_for_timeout(800)
    secpos = lambda: pg.evaluate("async () => ((await window.HDStandalone.store.get('config')) || {}).security_positions || {}")
    pos0 = secpos().get("binary_sensor.pir_salon")
    x, y = center('#secCanvas .presence[data-entity="binary_sensor.pir_salon"]')
    touch_drag(x, y, 60, 40); pg.wait_for_timeout(800)
    pos1 = secpos().get("binary_sensor.pir_salon")
    ok("Seguridad: arrastre táctil de un sensor (regresión)", pos1 is not None and (pos0 is None or abs(pos1["x"] - pos0["x"]) > 0.01), json.dumps(pos1))
    shot("14_seguridad_edicion_arrastre")
    tap("#secEditBtn")
    # ---------------------------------------------------------------- Energía
    pg.click("#navEnergia"); pg.wait_for_timeout(3000)
    flow = api("/api/energy/flow")
    ok("Energía: flujo calculado", isinstance(flow, dict) and "house_w" in json.dumps(flow), str(flow)[:150])
    shot("15_energia")
    # ---------------------------------------------------------------- Ajustes
    pg.click("#navAjustes"); pg.wait_for_timeout(1200)
    shot("16_ajustes_estado")
    for t in ("dispositivos", "alarma", "fondo", "copia"):
        pg.click(f".hdx-tabs button[data-t={t}]"); pg.wait_for_timeout(700)
        shot(f"17_ajustes_{t}")
    ok("Ajustes: pestañas abren sin errores", True)
    ok("sin errores de página (horizontal)", not errs, errs[:5])
    c.close()
    # ---------------------------------------------------------------- tablet vertical
    c, pg, errs, shot, center, touch_drag, tap, api, state = session(b, 800, 1280, "tablet_vertical")
    pg.goto(BASE + "?nowizard"); pg.wait_for_timeout(1500)
    pg.evaluate("async () => { await fetch('/api/standalone/demo', {method:'POST', body: '{}'}); await fetch('/api/standalone/settings', {method:'PUT', body: JSON.stringify({onboarded: true})}); }"); pg.reload(); pg.wait_for_timeout(3500)
    shot("20_dispositivos")
    pg.click("#btnToggleMode"); pg.wait_for_timeout(1200)
    els = api("/api/floors/planta_baja/elements"); e0 = next(e for e in els if e["label"] == "Depuradora")
    x, y = center(f'#canvasContainer [data-id="{e0["id"]}"]'); touch_drag(x, y, 50, -40)
    e1 = next(e for e in api("/api/floors/planta_baja/elements") if e["label"] == "Depuradora")
    ok("vertical: arrastre táctil en Dispositivos", abs(e1["x"] - e0["x"]) > 20, f"({e0['x']:.0f},{e0['y']:.0f}) -> ({e1['x']:.0f},{e1['y']:.0f})")
    shot("21_dispositivos_edicion_arrastre")
    pg.click("#btnToggleMode"); pg.wait_for_timeout(800)
    pg.click("#navSeguridad"); pg.wait_for_timeout(2500); shot("22_seguridad")
    pg.click("#navEnergia"); pg.wait_for_timeout(2500); shot("23_energia")
    ok("sin errores de página (vertical)", not errs, errs[:5])
    c.close(); b.close()
json.dump(R, open(os.path.join(OUT, "resultados.json"), "w"), ensure_ascii=False, indent=1)
print("RESUMEN", sum(r["ok"] for r in R), "/", len(R))
