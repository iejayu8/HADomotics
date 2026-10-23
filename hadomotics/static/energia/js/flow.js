/* Live power-flow view. Numbers come from GET /api/energy/flow (energy.py). */
"use strict";

window.FlowView = (function () {
  const NS = "http://www.w3.org/2000/svg";
  let root = null;

  function el(name, attrs) {
    const n = document.createElementNS(NS, name);
    Object.keys(attrs || {}).forEach((k) => n.setAttribute(k, attrs[k]));
    return n;
  }

  function box(parent, x, y, w, h, id) {
    const g = el("g", { id: id });
    g.appendChild(el("rect", {
      x: x, y: y, width: w, height: h, rx: 12,
      fill: "#131c2e", stroke: "#22304a", "stroke-width": 1,
    }));
    parent.appendChild(g);
    return g;
  }

  function text(parent, x, y, cls, id, value) {
    const t = el("text", { x: x, y: y, class: cls });
    if (id) t.setAttribute("id", id);
    t.textContent = value;
    parent.appendChild(t);
    return t;
  }

  function mount(container) {
    container.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.className = "flow";
    wrap.id = "powerFlow";
    const svg = el("svg", { viewBox: "0 0 1000 620", role: "img", "aria-label": "Flujo de energía" });
    const lines = el("g", { id: "flowLines" });
    svg.appendChild(lines);
    function line(id, d) {
      const p = el("path", { id: id, d: d, class: "flow-line", "stroke-width": 2, stroke: "#334155" });
      lines.appendChild(p);
    }
    line("line-solar", "M500 108 V190");
    line("line-bat", "M250 290 H340");
    line("line-grid", "M660 290 H750");
    line("line-house", "M460 390 C460 430 305 430 305 450");
    line("line-aux", "M540 390 C540 430 685 430 685 450");

    box(svg, 40, 16, 140, 92, "node-pv1");
    box(svg, 200, 16, 140, 92, "node-pv2");
    box(svg, 360, 16, 140, 92, "node-pv3");
    box(svg, 540, 16, 420, 92, "node-solar");
    text(svg, 52, 36, "node-title", null, "PV1");
    text(svg, 212, 36, "node-title", null, "PV2");
    text(svg, 372, 36, "node-title", null, "PV3");
    text(svg, 52, 58, "node-val", "flow-pv1", "…");
    text(svg, 212, 58, "node-val", "flow-pv2", "…");
    text(svg, 372, 58, "node-val", "flow-pv3", "…");
    text(svg, 52, 80, "node-sub", "flow-pv1-vi", "");
    text(svg, 212, 80, "node-sub", "flow-pv2-vi", "");
    text(svg, 372, 80, "node-sub", "flow-pv3-vi", "");
    text(svg, 556, 38, "node-title", null, "Solar");
    text(svg, 556, 64, "node-val", "flow-solar-w", "…");
    text(svg, 556, 88, "node-sub", "flow-solar-daily", "");

    box(svg, 30, 210, 220, 160, "node-bat");
    box(svg, 340, 190, 320, 200, "node-inv");
    box(svg, 750, 210, 220, 160, "node-grid");
    text(svg, 46, 234, "node-title", null, "Batería");
    text(svg, 46, 260, "node-val", "flow-bat-w", "…");
    text(svg, 46, 284, "node-sub", "flow-bat-soc", "");
    text(svg, 46, 306, "node-sub", "flow-bat-state", "");
    text(svg, 46, 328, "node-sub", "flow-bat-daily", "");
    text(svg, 46, 350, "node-sub", "flow-bat-left", "");

    text(svg, 356, 214, "node-title", null, "Inversor");
    text(svg, 356, 242, "node-val", "flow-inv-w", "…");
    text(svg, 356, 266, "node-sub", "flow-inv-state", "");
    text(svg, 356, 288, "node-sub", "flow-inv-elec", "");
    text(svg, 356, 310, "node-sub", "flow-inv-temp", "");
    text(svg, 356, 332, "node-sub", "flow-inv-mode", "");
    text(svg, 356, 360, "node-sub", "flow-autarky", "");

    text(svg, 766, 234, "node-title", null, "Red");
    text(svg, 766, 260, "node-val", "flow-grid-w", "…");
    text(svg, 766, 284, "node-sub", "flow-grid-dir", "");
    text(svg, 766, 306, "node-sub", "flow-grid-link", "");
    text(svg, 766, 328, "node-sub", "flow-grid-daily", "");

    box(svg, 180, 450, 250, 140, "node-house");
    box(svg, 560, 450, 250, 140, "node-aux");
    text(svg, 196, 476, "node-title", null, "Casa");
    text(svg, 196, 504, "node-val", "flow-house-w", "…");
    text(svg, 196, 528, "node-sub", "flow-house-daily", "");
    text(svg, 576, 476, "node-title", null, "Coche");
    text(svg, 576, 504, "node-val", "flow-aux-w", "…");
    text(svg, 576, 528, "node-sub", "flow-aux-link", "");
    text(svg, 576, 552, "node-sub", "flow-aux-daily", "");

    wrap.appendChild(svg);
    const legend = document.createElement("div");
    legend.className = "flow-legend";
    legend.innerHTML = '<span><i style="background:#e0af29"></i>Solar</span><span><i style="background:#2d8721"></i>Carga batería</span><span><i style="background:#9b2c2c"></i>Descarga</span><span><i style="background:#5c5757"></i>Importación</span><span><i style="background:#11af0e"></i>Exportación</span><span><i style="background:#b7b3b3"></i>Casa</span><span><i style="background:#00b54b"></i>Coche</span>';
    wrap.appendChild(legend);
    container.appendChild(wrap);
    root = wrap;
  }

  function fmtW(w) {
    if (w == null || Number.isNaN(Number(w))) return null;
    const n = Number(w);
    const abs = Math.abs(n);
    if (abs >= 1000) return (n / 1000).toFixed(2) + " kW";
    if (abs >= 100 || Number.isInteger(n)) return Math.round(n).toString() + " W";
    return n.toFixed(2) + " W";
  }

  function fmtKwh(v) {
    if (v == null || Number.isNaN(Number(v))) return null;
    return Number(v).toFixed(1) + " kWh";
  }

  function setText(id, value, unavailable) {
    const node = document.getElementById(id);
    if (!node) return;
    node.textContent = value;
    node.classList.toggle("unavail", !!unavailable);
    node.classList.toggle("node-val", !unavailable && node.classList.contains("node-val") || id.endsWith("-w") || id === "flow-pv1" || id === "flow-pv2" || id === "flow-pv3");
  }

  function paintLine(id, on, colour, reverse, watts) {
    const node = document.getElementById(id);
    if (!node) return;
    node.classList.toggle("on", !!on);
    node.classList.toggle("reverse", !!reverse);
    const width = on ? Math.max(1, Math.min(4, 1 + 3 * Math.min(1, Math.abs(watts || 0) / 4000))) : 1.5;
    node.setAttribute("stroke-width", String(width));
    node.setAttribute("stroke", on ? colour : "#334155");
  }

  function render(flow) {
    if (!flow) return;
    const c = flow.colours || {};
    const solar = c.solar || "#e0af29";
    const charge = c.battery_charge || "#2d8721";
    const discharge = c.battery_discharge || "#9b2c2c";
    const gridC = c.grid || "#5c5757";
    const exp = c.grid_export || "#11af0e";
    const houseC = c.house || "#b7b3b3";
    const houseOff = c.house_off || "#808080";
    const auxC = c.aux || "#00b54b";
    const dir = flow.directions || {};

    (flow.pv || []).forEach((pv, i) => {
      const n = i + 1;
      const w = fmtW(pv.power_w);
      setText("flow-pv" + n, w || "no disponible", !w);
      const bits = [];
      if (pv.voltage_v != null) bits.push(Number(pv.voltage_v).toFixed(0) + " V");
      if (pv.current_a != null) bits.push(Number(pv.current_a).toFixed(1) + " A");
      setText("flow-pv" + n + "-vi", bits.join(" · "), false);
    });
    const sw = fmtW(flow.solar_w);
    setText("flow-solar-w", sw || "no disponible", !sw);
    const sd = fmtKwh(flow.solar_daily_kwh);
    setText("flow-solar-daily", sd ? "Hoy " + sd : "Hoy no disponible", !sd);

    const bw = fmtW(flow.battery_w);
    setText("flow-bat-w", bw ? ((flow.battery_w > 1 ? "↓ " : flow.battery_w < -1 ? "↑ " : "") + bw) : "no disponible", !bw);
    const soc = flow.battery_soc == null ? null : Number(flow.battery_soc).toFixed(0) + " %";
    setText("flow-bat-soc", soc ? "SoC " + soc : "SoC no disponible", !soc);
    setText("flow-bat-state", flow.battery_state || "estado no disponible", !flow.battery_state);
    const ch = fmtKwh(flow.battery_daily_charge_kwh);
    const dis = fmtKwh(flow.battery_daily_discharge_kwh);
    setText("flow-bat-daily", (ch && dis) ? ("Hoy +" + ch + " / −" + dis) : "Hoy no disponible", !(ch && dis));
    const left = flow.battery_remaining_wh == null ? null : (flow.battery_remaining_wh / 1000).toFixed(1) + " kWh";
    setText("flow-bat-left", left ? "Restante " + left : "", !left);

    const iw = fmtW(flow.inverter_w);
    setText("flow-inv-w", iw || "no disponible", !iw);
    setText("flow-inv-state", flow.inverter_state || "no disponible", !flow.inverter_state);
    const elec = [];
    if (flow.inverter_v != null) elec.push(Number(flow.inverter_v).toFixed(1) + " V");
    if (flow.inverter_hz != null) elec.push(Number(flow.inverter_hz).toFixed(1) + " Hz");
    setText("flow-inv-elec", elec.join(" · ") || "V/Hz no disponible", elec.length === 0);
    const temps = [];
    if (flow.inverter_temp_c != null) temps.push(Number(flow.inverter_temp_c).toFixed(0) + " °C");
    if (flow.inverter_dc_temp_c != null) temps.push("DC " + Number(flow.inverter_dc_temp_c).toFixed(0) + " °C");
    setText("flow-inv-temp", temps.join(" · "), temps.length === 0);
    const modes = [flow.inverter_program, flow.inverter_pattern].filter(Boolean).join(" · ");
    setText("flow-inv-mode", modes, !modes);
    const aut = flow.autarky_pct == null ? null : "Autarquía " + Number(flow.autarky_pct).toFixed(1) + " %";
    setText("flow-autarky", aut || "Autarquía no disponible", !aut);

    const gw = fmtW(flow.grid_w);
    setText("flow-grid-w", gw || "no disponible", !gw);
    const gdir = dir.grid === "import" ? "Importación" : dir.grid === "export" ? "Exportación" : flow.grid_connected === false ? "Sin red" : "En reposo";
    setText("flow-grid-dir", gdir, flow.grid_w == null && flow.grid_connected == null);
    setText("flow-grid-link", flow.grid_connected == null ? "enlace no disponible" : (flow.grid_connected ? "Red presente" : "Sin red"), flow.grid_connected == null);
    const gi = fmtKwh(flow.grid_daily_import_kwh);
    const ge = fmtKwh(flow.grid_daily_export_kwh);
    setText("flow-grid-daily", (gi && ge) ? ("Hoy imp " + gi + " · exp " + ge) : "Hoy no disponible", !(gi && ge));

    const hw = fmtW(flow.house_w);
    setText("flow-house-w", hw || "no disponible", !hw);
    const ld = fmtKwh(flow.load_daily_kwh);
    setText("flow-house-daily", ld ? "CONSUMO DIARIO " + ld : "CONSUMO DIARIO no disponible", !ld);

    const aw = fmtW(flow.aux_w);
    setText("flow-aux-w", aw || "no disponible", !aw);
    setText("flow-aux-link", flow.aux_connected == null ? "conexión no disponible" : (flow.aux_connected ? "Conectado" : "Desconectado"), flow.aux_connected == null);
    const ad = fmtKwh(flow.aux_daily_kwh);
    setText("flow-aux-daily", ad ? "Carga coche diaria " + ad : "Carga coche diaria no disponible", !ad);

    paintLine("line-solar", dir.solar_to_inverter, solar, false, flow.solar_w);
    const batOn = dir.battery === "charge" || dir.battery === "discharge";
    paintLine("line-bat", batOn, dir.battery === "charge" ? charge : discharge, dir.battery === "charge", flow.battery_w);
    const gridOn = dir.grid === "import" || dir.grid === "export";
    paintLine("line-grid", gridOn, dir.grid === "export" ? exp : gridC, dir.grid === "import", flow.grid_w);
    paintLine("line-house", dir.inverter_to_house, dir.inverter_to_house ? houseC : houseOff, false, flow.house_w);
    paintLine("line-aux", dir.inverter_to_aux, auxC, false, flow.aux_w);
    const raws = {
      "flow-solar-w": flow.solar_w,
      "flow-bat-w": flow.battery_w,
      "flow-grid-w": flow.grid_w,
      "flow-inv-w": flow.inverter_w,
      "flow-house-w": flow.house_w,
      "flow-aux-w": flow.aux_w,
      "flow-autarky": flow.autarky_pct,
    };
    Object.keys(raws).forEach((id) => {
      const node = document.getElementById(id);
      if (node) node.setAttribute("data-raw", raws[id] == null ? "" : String(raws[id]));
    });

    ["node-pv1", "node-pv2", "node-pv3", "node-solar"].forEach((id) => {
      const rect = document.querySelector("#" + id + " rect");
      if (rect) rect.setAttribute("stroke", dir.solar_to_inverter ? solar : "#22304a");
    });
    const batRect = document.querySelector("#node-bat rect");
    if (batRect) batRect.setAttribute("stroke", dir.battery === "charge" ? charge : dir.battery === "discharge" ? discharge : "#22304a");
    const gridRect = document.querySelector("#node-grid rect");
    if (gridRect) {
      const stroke = flow.grid_connected === false ? (c.grid_off || "#000000") : dir.grid === "export" ? exp : dir.grid === "import" ? gridC : "#22304a";
      gridRect.setAttribute("stroke", stroke);
    }
    const auxRect = document.querySelector("#node-aux rect");
    if (auxRect) auxRect.setAttribute("stroke", dir.inverter_to_aux ? auxC : "#22304a");
  }

  return { mount: mount, render: render };
})();
