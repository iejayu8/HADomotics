/* =========================================================
   HADomotics – Configuration Panel Application
   ========================================================= */

"use strict";

// Derive the base path from the current page URL so that API calls work both
// when the addon is accessed directly (port 8099, pathname = "/") and when it
// is served through Home Assistant ingress (pathname = "/api/hassio_ingress/TOKEN/").
// Examples:
//   "/"                          → ""
//   "/api/hassio_ingress/TOKEN/" → "/api/hassio_ingress/TOKEN"
const API = window.location.pathname.replace(/\/+$/, "");

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let floors = [];
let currentFloor = null;
let currentElement = null;
let pendingPlacement = false;   // true while waiting for canvas click to place
let dragState = null;           // {elemId, startX, startY, origX, origY}
let resizeState = null;         // {elemId, startX, startY, origW, origH}
let viewMode = false;           // false = edit mode (default), true = view/interact mode
let entityStates = {};          // cache of HA entity states keyed by entity_id
let statePollingTimer = null;   // setInterval handle for state refresh in view mode

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
// Floor list rendering
// ---------------------------------------------------------------------------

function typeIcon(type) {
  const map = {
    button: "toggle_on",
    light: "lightbulb",
    sensor: "sensors",
    indicator: "fiber_manual_record",
    climate: "thermostat",
    cover: "curtains",
    camera: "videocam",
    custom: "widgets",
  };
  return map[type] || "widgets";
}

function renderFloorList() {
  const ul = $("floorList");
  ul.innerHTML = "";
  const sorted = [...floors].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  sorted.forEach((f) => {
    const li = document.createElement("li");
    li.dataset.id = f.id;
    if (currentFloor && currentFloor.id === f.id) li.classList.add("active");
    li.innerHTML = `
      <span class="material-icons">${f.has_image ? "map" : "crop_landscape"}</span>
      <span class="floor-name">${escapeHtml(f.name)}</span>
      <span class="item-actions">
        <button class="icon-btn btn-delete-floor" data-id="${f.id}" title="Delete floor">
          <span class="material-icons">delete</span>
        </button>
      </span>`;
    li.addEventListener("click", (e) => {
      if (!e.target.closest(".btn-delete-floor")) selectFloor(f.id);
    });
    li.querySelector(".btn-delete-floor").addEventListener("click", (e) => {
      e.stopPropagation();
      confirmDeleteFloor(f.id, f.name);
    });
    ul.appendChild(li);
  });
}

// ---------------------------------------------------------------------------
// Element list rendering
// ---------------------------------------------------------------------------

function renderElementList(elements) {
  const ul = $("elementList");
  ul.innerHTML = "";
  if (!elements || elements.length === 0) {
    ul.innerHTML = '<li style="padding:8px 16px;color:var(--text-secondary);font-style:italic;font-size:.82rem">No elements yet</li>';
    return;
  }
  elements.forEach((el) => {
    const li = document.createElement("li");
    li.dataset.id = el.id;
    if (currentElement && currentElement.id === el.id) li.classList.add("active");
    li.innerHTML = `
      <span class="material-icons">${typeIcon(el.type)}</span>
      <span>${escapeHtml(el.label || el.entity_id || "Unnamed")}</span>
      <span class="item-actions">
        <button class="icon-btn btn-delete-el" data-id="${el.id}" title="Delete">
          <span class="material-icons">delete</span>
        </button>
      </span>`;
    li.addEventListener("click", (e) => {
      if (!e.target.closest(".btn-delete-el")) openElementProps(el);
    });
    li.querySelector(".btn-delete-el").addEventListener("click", (e) => {
      e.stopPropagation();
      deleteElement(el.id);
    });
    ul.appendChild(li);
  });
}

// ---------------------------------------------------------------------------
// Floor canvas rendering
// ---------------------------------------------------------------------------

function renderFloorCanvas(floor) {
  const fc = $("floorCanvas");
  const ep = $("imagePlaceholder");
  const cc = $("canvasContainer");
  const img = $("floorImage");

  show("floorCanvas", "block");
  hide("emptyState");

  if (!floor.image) {
    show(ep, "flex");
    hide(cc);
  } else {
    hide(ep);
    show(cc, "inline-block");
    img.src = `${API}/api/images/${floor.image}?t=${Date.now()}`;
    img.onload = () => renderElements(floor.elements || []);
  }
}

function renderElements(elements) {
  const cc = $("canvasContainer");
  // Remove existing overlays
  cc.querySelectorAll(".element-overlay").forEach((e) => e.remove());

  // Reflect the current mode on the canvas container cursor
  cc.classList.toggle("view-mode", viewMode);

  elements.forEach((el) => {
    const div = document.createElement("div");
    div.className = "element-overlay" + (viewMode ? " view-mode" : "");
    div.dataset.id = el.id;
    div.style.left = `${el.x}px`;
    div.style.top = `${el.y}px`;
    div.style.width = `${el.width}px`;
    div.style.height = `${el.height}px`;
    div.style.background = _getElementBackground(el);

    if (!viewMode && currentElement && currentElement.id === el.id) {
      div.classList.add("selected");
    }

    div.innerHTML = `
      <span class="material-icons el-icon">${typeIcon(el.type)}</span>
      <span class="el-label">${escapeHtml(el.label || "")}</span>
      ${!viewMode ? '<div class="resize-handle"></div>' : ''}`;

    if (!viewMode) {
      // Edit mode: drag to reposition
      div.addEventListener("mousedown", (e) => {
        if (e.target.classList.contains("resize-handle")) return;
        e.preventDefault();
        dragState = {
          elemId: el.id,
          startX: e.clientX,
          startY: e.clientY,
          origX: el.x,
          origY: el.y,
        };
        openElementProps(el);
      });

      // Resize handle
      div.querySelector(".resize-handle").addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        resizeState = {
          elemId: el.id,
          startX: e.clientX,
          startY: e.clientY,
          origW: el.width,
          origH: el.height,
        };
      });
    } else {
      // View mode: click triggers the configured HA action
      div.addEventListener("click", () => handleElementTap(el, div));
    }

    cc.appendChild(div);
  });
}

// ---------------------------------------------------------------------------
// View / Interact mode helpers
// ---------------------------------------------------------------------------

/**
 * Returns the background colour for an element overlay.
 * In view mode the actual HA entity state drives the colour; in edit mode the
 * "off" colour is always used so the configuration intent stays clear.
 */
function _getElementBackground(el) {
  if (el.entity_id && entityStates[el.entity_id]) {
    const state = entityStates[el.entity_id].state;
    const isOn = ["on", "open", "home", "active", "heating", "cooling", "true"].includes(
      state.toLowerCase()
    );
    return isOn ? (el.color_on || "#4CAF50") : (el.color_off || "#9E9E9E");
  }
  return el.color_off || "#9E9E9E";
}

/** Fetch all HA entity states and cache them. */
async function fetchEntityStates() {
  try {
    const states = await apiFetch("/api/ha/states");
    entityStates = {};
    states.forEach((s) => { entityStates[s.entity_id] = s; });
    updateElementStates();
  } catch (err) {
    // HA may not be reachable (no supervisor token in dev, network error, etc.)
    console.debug("HADomotics: could not fetch HA states", err);
  }
}

/** Repaint element overlay colours based on the latest cached entity states. */
function updateElementStates() {
  if (!currentFloor || !$("canvasContainer")) return;
  (currentFloor.elements || []).forEach((el) => {
    const overlay = $("canvasContainer").querySelector(`[data-id="${el.id}"]`);
    if (overlay) overlay.style.background = _getElementBackground(el);
  });
}

/** Begin polling HA entity states every 5 seconds. */
function startStatePolling() {
  fetchEntityStates();
  statePollingTimer = setInterval(fetchEntityStates, 5000);
}

/** Stop polling and clear the state cache. */
function stopStatePolling() {
  if (statePollingTimer) {
    clearInterval(statePollingTimer);
    statePollingTimer = null;
  }
  entityStates = {};
}

/**
 * Handle a tap/click on an element in view mode.
 * Executes the element's configured tap_action via the HA proxy.
 */
async function handleElementTap(el, overlayEl) {
  const action = el.tap_action || "toggle";

  if (action === "none") return;

  if (!el.entity_id) {
    toast("No entity configured for this element", "warn");
    return;
  }

  if (action === "more-info") {
    const stateObj = entityStates[el.entity_id];
    const stateStr = stateObj ? stateObj.state : "unknown";
    const friendly = (stateObj && stateObj.attributes && stateObj.attributes.friendly_name)
      || el.label || el.entity_id;
    toast(`${friendly}: ${stateStr}`, "info", 4000);
    return;
  }

  if (action === "navigate") {
    toast(`Navigate: ${el.navigate_path || "(no path configured)"}`, "info", 3000);
    return;
  }

  // Default: toggle
  overlayEl.style.opacity = "0.5";
  overlayEl.style.pointerEvents = "none";
  try {
    const [domain] = el.entity_id.split(".");
    await apiFetch(`/api/ha/services/${domain}/toggle`, {
      method: "POST",
      body: JSON.stringify({ entity_id: el.entity_id }),
    });
    await fetchEntityStates();
  } catch (err) {
    toast(`Action failed: ${err.message}`, "error");
  } finally {
    overlayEl.style.opacity = "";
    overlayEl.style.pointerEvents = "";
  }
}

/**
 * Switch between Edit Mode (viewMode=false) and View/Interact Mode (viewMode=true).
 * Updates the toolbar UI, toggles edit-only controls, and re-renders elements.
 */
function setViewMode(enabled) {
  viewMode = enabled;
  const btn = $("btnToggleMode");

  if (enabled) {
    // Cancel any pending placement
    if (pendingPlacement) {
      pendingPlacement = false;
      if ($("canvasContainer")) $("canvasContainer").style.cursor = "";
    }
    // Close properties panel
    hide("propertiesPanel");
    currentElement = null;
    // Update toggle button appearance
    btn.innerHTML = '<span class="material-icons">edit</span> Edit Mode';
    btn.classList.add("active");
    btn.title = "Switch to Edit Mode";
    // Hide edit-only toolbar controls
    document.querySelectorAll(".edit-only").forEach((el) => hide(el));
    // Disable "Add element" while in view mode
    $("btnAddElement").disabled = true;
    // Start polling HA states
    startStatePolling();
  } else {
    // Update toggle button appearance
    btn.innerHTML = '<span class="material-icons">visibility</span> View Mode';
    btn.classList.remove("active");
    btn.title = "Switch to View Mode";
    // Restore edit-only toolbar controls
    document.querySelectorAll(".edit-only").forEach((el) => {
      // Label and Button both need inline-flex; other elements (spans) use inline
      if (el.tagName === "LABEL" || el.tagName === "BUTTON") {
        show(el, "inline-flex");
      } else {
        show(el, "inline");
      }
    });
    // Re-enable "Add element"
    $("btnAddElement").disabled = false;
    // Stop polling
    stopStatePolling();
  }

  // Re-render elements to apply mode-specific behaviour (drag vs click)
  if (currentFloor && currentFloor.image) {
    renderElements(currentFloor.elements || []);
  }
}



async function selectFloor(floorId) {
  try {
    currentFloor = await apiFetch(`/api/floors/${floorId}`);
    currentElement = null;

    // Update sidebar highlight
    document.querySelectorAll("#floorList li").forEach((li) => {
      li.classList.toggle("active", li.dataset.id === floorId);
    });

    show("elementSection");
    show("editorToolbar");

    renderElementList(currentFloor.elements || []);
    renderFloorCanvas(currentFloor);
    hide("propertiesPanel");
  } catch (err) {
    toast(`Error loading floor: ${err.message}`, "error");
  }
}

// ---------------------------------------------------------------------------
// Add / delete floor
// ---------------------------------------------------------------------------

function confirmDeleteFloor(id, name) {
  if (!confirm(`Delete floor "${name}" and all its elements?`)) return;
  deleteFloor(id);
}

async function deleteFloor(id) {
  try {
    await apiFetch(`/api/floors/${id}`, { method: "DELETE" });
    floors = floors.filter((f) => f.id !== id);
    if (currentFloor && currentFloor.id === id) {
      currentFloor = null;
      hide("elementSection");
      hide("editorToolbar");
      hide("floorCanvas");
      show("emptyState", "flex");
      hide("propertiesPanel");
    }
    renderFloorList();
    toast("Floor deleted", "success");
  } catch (err) {
    toast(`Error deleting floor: ${err.message}`, "error");
  }
}

// ---------------------------------------------------------------------------
// Image upload
// ---------------------------------------------------------------------------

async function uploadImage(file) {
  if (!currentFloor) return;
  const formData = new FormData();
  formData.append("image", file);
  try {
    const res = await fetch(`${API}/api/floors/${currentFloor.id}/image`, {
      method: "POST",
      body: formData,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    // Reload floor
    await selectFloor(currentFloor.id);
    // Update floor list (has_image flag)
    await loadFloors();
    toast("Image uploaded", "success");
  } catch (err) {
    toast(`Upload failed: ${err.message}`, "error");
  }
}

// ---------------------------------------------------------------------------
// Element placement (click on canvas)
// ---------------------------------------------------------------------------

function startPlacement() {
  pendingPlacement = true;
  $("toolbarHint").textContent = "👆 Click on the floor plan to place the element";
  $("canvasContainer").style.cursor = "crosshair";
}

async function placeElementAt(x, y) {
  pendingPlacement = false;
  $("toolbarHint").textContent = "Click on the image to place an element";
  $("canvasContainer").style.cursor = "default";

  try {
    const el = await apiFetch(`/api/floors/${currentFloor.id}/elements`, {
      method: "POST",
      body: JSON.stringify({ x, y, type: "button", label: "New Element" }),
    });
    currentFloor.elements = currentFloor.elements || [];
    currentFloor.elements.push(el);
    renderElements(currentFloor.elements);
    renderElementList(currentFloor.elements);
    openElementProps(el);
    toast("Element added – configure it in the panel", "success");
  } catch (err) {
    toast(`Error adding element: ${err.message}`, "error");
  }
}

// ---------------------------------------------------------------------------
// Element properties panel
// ---------------------------------------------------------------------------

function openElementProps(el) {
  currentElement = el;

  // Highlight in overlay
  document.querySelectorAll(".element-overlay").forEach((d) => {
    d.classList.toggle("selected", d.dataset.id === el.id);
  });
  // Highlight in element list
  document.querySelectorAll("#elementList li").forEach((li) => {
    li.classList.toggle("active", li.dataset.id === el.id);
  });

  $("propPanelTitle").textContent = el.label || "Element";
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

  show("propertiesPanel", "flex");
  $("propertiesPanel").style.flexDirection = "column";
}

async function saveElementProps(e) {
  e.preventDefault();
  if (!currentFloor || !currentElement) return;

  const data = {
    label: $("propLabel").value.trim(),
    type: $("propType").value,
    entity_id: $("propEntityId").value.trim(),
    icon: $("propIcon").value.trim(),
    color_on: $("propColorOn").value,
    color_off: $("propColorOff").value,
    tap_action: $("propTapAction").value,
    width: parseFloat($("propWidth").value) || 60,
    height: parseFloat($("propHeight").value) || 30,
  };

  try {
    const updated = await apiFetch(
      `/api/floors/${currentFloor.id}/elements/${currentElement.id}`,
      { method: "PUT", body: JSON.stringify(data) }
    );
    // Update local state
    const idx = currentFloor.elements.findIndex((x) => x.id === updated.id);
    if (idx !== -1) currentFloor.elements[idx] = updated;
    currentElement = updated;
    renderElements(currentFloor.elements);
    renderElementList(currentFloor.elements);
    $("propPanelTitle").textContent = updated.label || "Element";
    toast("Saved", "success");
  } catch (err) {
    toast(`Error saving: ${err.message}`, "error");
  }
}

async function deleteElement(elemId) {
  if (!currentFloor) return;
  if (!confirm("Delete this element?")) return;
  try {
    await apiFetch(`/api/floors/${currentFloor.id}/elements/${elemId}`, { method: "DELETE" });
    currentFloor.elements = currentFloor.elements.filter((e) => e.id !== elemId);
    if (currentElement && currentElement.id === elemId) {
      currentElement = null;
      hide("propertiesPanel");
    }
    renderElements(currentFloor.elements);
    renderElementList(currentFloor.elements);
    toast("Element deleted", "success");
  } catch (err) {
    toast(`Error deleting element: ${err.message}`, "error");
  }
}

// ---------------------------------------------------------------------------
// Drag / resize handlers
// ---------------------------------------------------------------------------

document.addEventListener("mousemove", async (e) => {
  if (dragState) {
    const dx = e.clientX - dragState.startX;
    const dy = e.clientY - dragState.startY;
    const newX = Math.max(0, dragState.origX + dx);
    const newY = Math.max(0, dragState.origY + dy);
    const el = currentFloor.elements.find((x) => x.id === dragState.elemId);
    if (el) {
      el.x = newX;
      el.y = newY;
      const overlay = $("canvasContainer").querySelector(`[data-id="${el.id}"]`);
      if (overlay) {
        overlay.style.left = `${newX}px`;
        overlay.style.top = `${newY}px`;
      }
      if (currentElement && currentElement.id === el.id) {
        currentElement.x = newX;
        currentElement.y = newY;
      }
    }
  }

  if (resizeState) {
    const dx = e.clientX - resizeState.startX;
    const dy = e.clientY - resizeState.startY;
    const el = currentFloor.elements.find((x) => x.id === resizeState.elemId);
    if (el) {
      el.width = Math.max(20, resizeState.origW + dx);
      el.height = Math.max(20, resizeState.origH + dy);
      const overlay = $("canvasContainer").querySelector(`[data-id="${el.id}"]`);
      if (overlay) {
        overlay.style.width = `${el.width}px`;
        overlay.style.height = `${el.height}px`;
      }
      if (currentElement && currentElement.id === el.id) {
        $("propWidth").value = Math.round(el.width);
        $("propHeight").value = Math.round(el.height);
      }
    }
  }
});

document.addEventListener("mouseup", async () => {
  if (dragState) {
    const el = currentFloor.elements.find((x) => x.id === dragState.elemId);
    if (el) {
      await apiFetch(`/api/floors/${currentFloor.id}/elements/${el.id}`, {
        method: "PUT",
        body: JSON.stringify({ x: el.x, y: el.y }),
      }).catch(() => {});
    }
    dragState = null;
  }
  if (resizeState) {
    const el = currentFloor.elements.find((x) => x.id === resizeState.elemId);
    if (el) {
      await apiFetch(`/api/floors/${currentFloor.id}/elements/${el.id}`, {
        method: "PUT",
        body: JSON.stringify({ width: el.width, height: el.height }),
      }).catch(() => {});
    }
    resizeState = null;
  }
});

// ---------------------------------------------------------------------------
// Load floors
// ---------------------------------------------------------------------------

async function loadFloors() {
  try {
    floors = await apiFetch("/api/floors");
    renderFloorList();
  } catch (err) {
    toast(`Could not load floors: ${err.message}`, "error");
  }
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------

document.addEventListener("DOMContentLoaded", async () => {
  await loadFloors();

  // Add floor button
  $("btnAddFloor").addEventListener("click", () => {
    $("newFloorName").value = "";
    show("addFloorModal");
    $("newFloorName").focus();
  });

  $("btnConfirmAddFloor").addEventListener("click", async () => {
    const name = $("newFloorName").value.trim();
    if (!name) { toast("Please enter a floor name", "warn"); return; }
    try {
      const floor = await apiFetch("/api/floors", {
        method: "POST",
        body: JSON.stringify({ name }),
      });
      floors.push({ id: floor.id, name: floor.name, order: floor.order, has_image: false });
      renderFloorList();
      hide("addFloorModal");
      selectFloor(floor.id);
      toast(`Floor "${name}" created`, "success");
    } catch (err) {
      toast(`Error: ${err.message}`, "error");
    }
  });

  $("btnCancelAddFloor").addEventListener("click", () => hide("addFloorModal"));

  $("newFloorName").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("btnConfirmAddFloor").click();
    if (e.key === "Escape") $("btnCancelAddFloor").click();
  });

  // Image upload
  $("imageUpload").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) uploadImage(file);
    e.target.value = "";
  });

  // Clicking the toolbar label triggers the hidden file input
  document.querySelector(".toolbar-label").addEventListener("click", () => {
    $("imageUpload").click();
  });

  $("btnUploadFromPlaceholder").addEventListener("click", () => $("imageUpload").click());

  $("btnDeleteImage").addEventListener("click", async () => {
    if (!currentFloor || !currentFloor.image) return;
    if (!confirm("Remove the floor plan image?")) return;
    try {
      await apiFetch(`/api/floors/${currentFloor.id}/image`, { method: "DELETE" });
      await selectFloor(currentFloor.id);
      await loadFloors();
      toast("Image removed", "success");
    } catch (err) {
      toast(`Error: ${err.message}`, "error");
    }
  });

  // Add element button → start placement mode
  $("btnAddElement").addEventListener("click", () => {
    if (!currentFloor) { toast("Select a floor first", "warn"); return; }
    if (!currentFloor.image) {
      toast("Upload a floor plan image first", "warn");
      return;
    }
    startPlacement();
  });

  // Canvas click → place element (edit mode only)
  $("canvasContainer").addEventListener("click", (e) => {
    if (viewMode) return;
    if (!pendingPlacement) return;
    const rect = $("canvasContainer").getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    placeElementAt(x, y);
  });

  // Mode toggle button
  $("btnToggleMode").addEventListener("click", () => setViewMode(!viewMode));

  // Properties form
  $("elementForm").addEventListener("submit", saveElementProps);

  $("btnCloseProps").addEventListener("click", () => {
    currentElement = null;
    hide("propertiesPanel");
    document.querySelectorAll(".element-overlay").forEach((d) => d.classList.remove("selected"));
    document.querySelectorAll("#elementList li").forEach((li) => li.classList.remove("active"));
  });

  $("btnDeleteElement").addEventListener("click", () => {
    if (currentElement) deleteElement(currentElement.id);
  });

  // Close modal on overlay click
  $("addFloorModal").addEventListener("click", (e) => {
    if (e.target === $("addFloorModal")) hide("addFloorModal");
  });
});
