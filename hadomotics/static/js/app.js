/* =========================================================
   HADomotics – Configuration Panel Application
   ========================================================= */

"use strict";

const API = window.location.pathname.replace(/\/+$/, "");

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let floors = [];
let currentFloor = null;
let currentElement = null;
let pendingPlacement = false;
let dragState = null;
let resizeState = null;
let viewMode = true;
let entityStates = {};
let statePollingTimer = null;

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function $(id) { return document.getElementById(id); }

function show(el, display = "flex") {
  if (typeof el === "string") el = $(el);
  el.style.display = display;
}

function hide(el) {
  if (typeof el === "string") el = $(el);
  el.style.display = "none";
}

function toast(msg, type = "info", duration = 3000) {
  const container = $("toastContainer");
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.innerHTML = `<span class="material-icons">${
    type === "success" ? "check_circle" : type === "error" ? "error" : "info"
  }</span> ${escapeHtml(msg)}`;
  container.appendChild(el);
  setTimeout(() => el.remove(), duration);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function apiFetch(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Dynamic form fields for actions
// ---------------------------------------------------------------------------

function updateActionFields() {
  const action = $("propTapAction").value;
  const posGroup = $("positionGroup");
  const svcGroup = $("serviceGroup");
  const dataGroup = $("serviceDataGroup");

  if (posGroup) posGroup.style.display = (action === "set_position") ? "block" : "none";
  if (svcGroup) svcGroup.style.display = (action === "call-service") ? "block" : "none";
  if (dataGroup) dataGroup.style.display = (action === "call-service") ? "block" : "none";
}

// ---------------------------------------------------------------------------
// Element properties panel
// ---------------------------------------------------------------------------

function openElementProps(el) {
  currentElement = el;
  $("propElementId").value = el.id;
  $("propLabel").value = el.label || "";
  $("propType").value = el.type || "button";
  $("propEntityId").value = el.entity_id || "";
  $("propIcon").value = el.icon || "";
  $("propColorOn").value = el.color_on || "#4CAF50";
  $("propColorOff").value = el.color_off || "#9E9E9E";
  $("propTapAction").value = el.tap_action || "toggle";
  $("propWidth").value = el.width || 60;
  $("propHeight").value = el.height || 30;
  $("propRotation").value = el.rotation || 0;

  // New fields for advanced actions
  if ($("propPosition")) $("propPosition").value = el.position || 50;
  if ($("propService")) $("propService").value = el.service || "";
  if ($("propServiceData")) $("propServiceData").value = el.service_data || "";

  show("propertiesPanel");
  updateActionFields();
  $("propTapAction").onchange = updateActionFields;
}

function saveElementProps(e) {
  e.preventDefault();
  if (!currentElement || !currentFloor) return;

  const data = {
    label: $("propLabel").value.trim(),
    type: $("propType").value,
    entity_id: $("propEntityId").value.trim(),
    icon: $("propIcon").value.trim(),
    color_on: $("propColorOn").value,
    color_off: $("propColorOff").value,
    tap_action: $("propTapAction").value,
    width: parseInt($("propWidth").value) || 60,
    height: parseInt($("propHeight").value) || 30,
    rotation: parseFloat($("propRotation").value) || 0,
    // New fields
    position: parseInt($("propPosition")?.value) || 50,
    service: $("propService")?.value?.trim() || "",
    service_data: $("propServiceData")?.value?.trim() || "",
  };

  apiFetch(`/api/floors/${currentFloor.id}/elements/${currentElement.id}`, {
    method: "PUT",
    body: JSON.stringify(data),
  })
    .then(() => {
      toast("Element saved", "success");
      selectFloor(currentFloor.id);
    })
    .catch((err) => toast(`Error saving: ${err.message}`, "error"));
}

// ---------------------------------------------------------------------------
// Handle tap in View Mode (supports set_position + any service)
// ---------------------------------------------------------------------------
async function handleElementTap(el, overlayEl) {
  const action = el.tap_action || "toggle";

  if (action === "none") return;

  if (!el.entity_id && action !== "call-service") {
    toast("No entity configured for this element", "warn");
    return;
  }

  if (action === "more-info") {
    const stateObj = entityStates[el.entity_id];
    const stateStr = stateObj ? stateObj.state : "unknown";
    const friendly = (stateObj && stateObj.attributes && stateObj.attributes.friendly_name) || el.label || el.entity_id;
    toast(`${friendly}: ${stateStr}`, "info", 4000);
    return;
  }

  if (action === "navigate") {
    toast(`Navigate: ${el.navigate_path || "(no path configured)"}`, "info", 3000);
    return;
  }

  overlayEl.style.opacity = "0.5";
  overlayEl.style.pointerEvents = "none";

  try {
    if (action === "set_position") {
      const position = parseInt(el.position) || 50;
      await apiFetch(`/api/ha/services/cover/set_cover_position`, {
        method: "POST",
        body: JSON.stringify({ entity_id: el.entity_id, position }),
      });
    } 
    else if (action === "call-service") {
      if (!el.service) {
        toast("No service configured", "error");
        return;
      }
      const [domain, serviceName] = el.service.split(".");
      let data = {};
      try {
        data = el.service_data ? JSON.parse(el.service_data) : {};
      } catch (e) {
        toast("Invalid JSON in Service Data", "error");
        return;
      }
      if (!data.entity_id && el.entity_id) {
        data.entity_id = el.entity_id;
      }
      await apiFetch(`/api/ha/services/${domain}/${serviceName}`, {
        method: "POST",
        body: JSON.stringify(data),
      });
    } 
    else {
      // Default: toggle
      const [domain] = el.entity_id.split(".");
      await apiFetch(`/api/ha/services/${domain}/toggle`, {
        method: "POST",
        body: JSON.stringify({ entity_id: el.entity_id }),
      });
    }

    await fetchEntityStates();
    toast("Action executed successfully", "success", 1500);
  } catch (err) {
    console.error("HADomotics action failed:", err);
    toast(`Action failed: ${err.message}`, "error");
  } finally {
    overlayEl.style.opacity = "";
    overlayEl.style.pointerEvents = "";
  }
}

// ---------------------------------------------------------------------------
// (rest of the file remains the same as current version)
// ---------------------------------------------------------------------------