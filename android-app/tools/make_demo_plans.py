"""Genera los planos genéricos del modo demo (no son la casa de nadie). Uso: python3 tools/make_demo_plans.py"""
from PIL import Image, ImageDraw, ImageFont
import os
OUT = os.path.join(os.path.dirname(__file__), "..", "assets")
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"

def plan(name, rooms, doors, size=(1400, 800)):
    W, H = size
    img = Image.new("RGB", size, (250, 250, 247))
    d = ImageDraw.Draw(img)
    f = ImageFont.truetype(FONT, 22)
    fs = ImageFont.truetype(FONT, 15)
    # suelo de cada estancia
    for (x0, y0, x1, y1, label, fill) in rooms:
        d.rectangle([x0, y0, x1, y1], fill=fill)
        for gx in range(x0, x1, 40):
            d.line([gx, y0, gx, y1], fill=tuple(max(0, c - 8) for c in fill), width=1)
    for (x0, y0, x1, y1, label, fill) in rooms:
        d.rectangle([x0, y0, x1, y1], outline=(70, 74, 82), width=10)
    for (x0, y0, x1, y1, label, fill) in rooms:
        w = d.textlength(label, font=f)
        d.text(((x0 + x1) / 2 - w / 2, y1 - 40), label, fill=(90, 96, 108), font=f)
        area = f"{(x1 - x0) * (y1 - y0) / 6400:.1f} m²"
        wa = d.textlength(area, font=fs)
        d.text(((x0 + x1) / 2 - wa / 2, y1 - 62), area, fill=(140, 146, 156), font=fs)
    for (x0, y0, x1, y1) in doors:  # huecos de puertas
        d.rectangle([x0, y0, x1, y1], fill=(250, 250, 247))
    img.save(os.path.join(OUT, name), optimize=True)

wood, tile, grey, green = (236, 226, 208), (232, 236, 240), (224, 226, 230), (214, 232, 214)
plan("demo-planta-baja.png", [
    (60, 60, 560, 460, "Salón", wood),
    (560, 60, 860, 460, "Cocina", tile),
    (860, 60, 1340, 460, "Garaje", grey),
    (60, 460, 420, 740, "Porche", green),
    (420, 460, 760, 740, "Recibidor", tile),
    (760, 460, 1040, 740, "Baño", tile),
    (1040, 460, 1340, 740, "Lavadero", tile),
], [(540, 200, 580, 300), (560, 455, 660, 466), (880, 455, 960, 466), (1300, 120, 1346, 400), (400, 560, 440, 650), (540, 735, 640, 746)])
plan("demo-planta-1.png", [
    (60, 60, 560, 460, "Dormitorio principal", wood),
    (560, 60, 900, 460, "Vestidor", wood),
    (900, 60, 1340, 460, "Dormitorio 2", wood),
    (60, 460, 700, 740, "Pasillo", tile),
    (700, 460, 1020, 740, "Baño", tile),
    (1020, 460, 1340, 740, "Despacho", wood),
], [(200, 455, 300, 466), (640, 455, 720, 466), (1000, 455, 1100, 466), (695, 560, 706, 640), (1015, 560, 1026, 640)])
print("ok")
