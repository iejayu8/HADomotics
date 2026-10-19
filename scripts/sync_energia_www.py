#!/usr/bin/env python3
"""Genera mobile-energia/www a partir del panel Energía del add-on (fuente única).

hadomotics/static/energia/{js,css} + hadomotics/energy_map.json + energia.html (rutas relativas)
-> mobile-energia/www (webDir de Capacitor).
"""
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "hadomotics"
DST = ROOT / "mobile-energia" / "www"

if DST.exists():
    shutil.rmtree(DST)
(DST / "js").mkdir(parents=True)
(DST / "css").mkdir()
for f in (SRC / "static" / "energia" / "js").glob("*.js"):
    shutil.copy2(f, DST / "js" / f.name)
for f in (SRC / "static" / "energia" / "css").glob("*.css"):
    shutil.copy2(f, DST / "css" / f.name)
shutil.copy2(SRC / "energy_map.json", DST / "energy_map.json")
html = (SRC / "static" / "energia.html").read_text(encoding="utf-8").replace("static/energia/", "")
(DST / "index.html").write_text(html, encoding="utf-8")
print("OK ->", DST)
