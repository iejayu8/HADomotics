/**
 * hadomotics-card.js
 *
 * HADomotics – Lovelace Custom Card
 *
 * Displays an interactive home floor plan with elements that reflect
 * real-time Home Assistant entity states. Supports multiple floors.
 *
 * Configuration example (Lovelace YAML):
 *
 *   type: custom:hadomotics-card
 *   title: My Home
 *   addon_url: http://homeassistant.local:8099
 *   default_floor: floor1
 *
 * The `addon_url` should point to the running HADomotics addon.
 * If the addon is accessed via HA ingress, set `addon_url` to the
 * ingress path (e.g. /api/hassio_ingress/<slug>).
 */

/* ============================================================
   Styles (injected into shadow DOM)
   ============================================================ */
const STYLES = `
  :host {
    display: block;
    font-family: var(--primary-font-family, 'Segoe UI', Roboto, Arial, sans-serif);
  }

  ha-card {
    overflow: hidden;
    position: relative;
  }

  .card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px 4px;
    gap: 8px;
  }

  .card-title {
    font-size: 1.1rem;
    font-weight: 600;
    color: var(--primary-text-color);
    flex: 1;
  }

  /* Floor tabs */
  .floor-tabs {
    display: flex;
    gap: 4px;
    padding: 4px 16px 8px;
    overflow-x: auto;
    scrollbar-width: thin;
  }

  .floor-tab {
    padding: 4px 14px;
    border-radius: 16px;
    border: 1px solid var(--divider-color, #ccc);
    background: transparent;
    color: var(--secondary-text-color);
    font-size: 0.82rem;
    cursor: pointer;
    white-space: nowrap;
    transition: all 0.15s;
  }

  .floor-tab:hover {
    background: var(--secondary-background-color);
  }

  .floor-tab.active {
    background: var(--primary-color, #1976d2);
    color: var(--text-primary-color, #fff);
    border-color: var(--primary-color, #1976d2);
    font-weight: 600;
  }

  /* Canvas */
  .canvas-wrapper {
    position: relative;
    overflow: hidden;
    margin: 0 16px 16px;
    border-radius: 8px;
    background: var(--secondary-background-color, #f5f5f5);
    min-height: 120px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .floor-image {
    display: block;
    max-width: 100%;
    border-radius: 8px;
  }

  .no-image {
    padding: 40px;
    text-align: center;
    color: var(--secondary-text-color);
    font-size: 0.9rem;
  }

  /* Element overlays */
  .element-btn {
    position: absolute;
    border-radius: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 3px;
    font-size: 11px;
    font-weight: 600;
    color: #fff;
    cursor: pointer;
    box-shadow: 0 2px 6px rgba(0,0,0,.25);
    user-select: none;
    transition: opacity 0.2s, transform 0.1s, box-shadow 0.15s;
    padding: 3px 6px;
    box-sizing: border-box;
    overflow: hidden;
    border: 2px solid transparent;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .element-btn:hover {
    opacity: 0.88;
    transform: scale(1.04);
    box-shadow: 0 4px 12px rgba(0,0,0,.3);
  }

  .element-btn:active {
    transform: scale(0.97);
  }

  .element-btn.loading {
    opacity: 0.6;
    pointer-events: none;
  }

  .element-btn ha-icon,
  .element-btn .icon-placeholder {
    --mdc-icon-size: 14px;
    font-size: 14px;
    flex-shrink: 0;
  }

  .element-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 10px;
  }

  /* Sensor / indicator – show value */
  .element-btn.sensor .element-value {
    font-size: 11px;
    font-weight: 700;
  }

  /* Loading state */
  .loading-spinner {
    padding: 24px;
    text-align: center;
    color: var(--secondary-text-color);
  }

  .error-msg {
    padding: 16px;
    color: var(--error-color, #d32f2f);
    font-size: 0.88rem;
  }

  /* Config editor (shown when card is in edit mode) */
  .config-editor {
    padding: 8px 16px 16px;
  }

  .config-row {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-bottom: 10px;
  }

  .config-row label {
    font-size: 0.78rem;
    font-weight: 600;
    color: var(--secondary-text-color);
    text-transform: uppercase;
    letter-spacing: .04em;
  }

  .config-row input {
    padding: 6px 10px;
    border: 1px solid var(--divider-color, #ccc);
    border-radius: 6px;
    font-size: 0.9rem;
    background: var(--secondary-background-color);
    color: var(--primary-text-color);
    outline: none;
  }

  /* Edit mode button */
  .edit-btn {
    padding: 4px 12px;
    border-radius: 16px;
    border: 1px solid var(--primary-color, #1976d2);
    background: transparent;
    color: var(--primary-color, #1976d2);
    font-size: 0.8rem;
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
    transition: all 0.15s;
  }

  .edit-btn:hover {
    background: var(--primary-color, #1976d2);
    color: var(--text-primary-color, #fff);
  }

  .exit-edit-btn {
    padding: 4px 12px;
    border-radius: 16px;
    border: 1px solid var(--error-color, #d32f2f);
    background: var(--error-color, #d32f2f);
    color: #fff;
    font-size: 0.8rem;
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
    transition: all 0.15s;
  }

  .exit-edit-btn:hover {
    opacity: 0.85;
  }

  /* Element overlay in edit mode */
  .element-btn.edit-mode {
    border: 2px dashed rgba(255,255,255,0.85);
    cursor: default;
    pointer-events: none;
    opacity: 0.75;
  }

  .canvas-wrapper.edit-mode {
    outline: 2px dashed var(--error-color, #d32f2f);
    outline-offset: -2px;
  }
`;

/* ============================================================
   HADomoticsCard – Custom Element
   ============================================================ */

class HADomoticsCard extends HTMLElement {
  constructor() {
    super();
    this._config = {};
    this._hass = null;
    this._floors = [];
    this._currentFloor = null;
    this._statePollingInterval = null;
    this._attached = false;
    this._editMode = false;

    this.attachShadow({ mode: "open" });
    this._render();
  }

  /* ── Lovelace hooks ── */

  set hass(hass) {
    const prev = this._hass;
    this._hass = hass;
    if (!prev || JSON.stringify(this._getRelevantStates(prev)) !== JSON.stringify(this._getRelevantStates(hass))) {
      this._updateElementStates();
    }
  }

  setConfig(config) {
    if (!config.addon_url && !config.addon_path) {
      throw new Error("HADomotics: addon_url is required");
    }
    this._config = config;
    this._addonBase = (config.addon_url || "").replace(/\/$/, "");
    this._render();
    this._loadFloors();
  }

  getCardSize() {
    return 4;
  }

  connectedCallback() {
    this._attached = true;
  }

  disconnectedCallback() {
    this._attached = false;
    if (this._statePollingInterval) {
      clearInterval(this._statePollingInterval);
      this._statePollingInterval = null;
    }
  }

  /* ── Render ── */

  _render() {
    const shadow = this.shadowRoot;
    const editBtn = this._editMode
      ? `<button class="exit-edit-btn" id="editModeBtn">Exit Edit Mode</button>`
      : `<button class="edit-btn" id="editModeBtn">Edit</button>`;
    shadow.innerHTML = `
      <style>${STYLES}</style>
      <ha-card>
        <div class="card-header">
          <div class="card-title">${this._escHtml(this._config.title || "HADomotics")}</div>
          ${editBtn}
        </div>
        <div class="floor-tabs" id="floorTabs"></div>
        <div class="canvas-wrapper" id="canvasWrapper">
          <div class="loading-spinner">Loading floor plan…</div>
        </div>
      </ha-card>`;

    shadow.getElementById("editModeBtn").addEventListener("click", () => this._toggleEditMode());
  }

  _toggleEditMode() {
    this._editMode = !this._editMode;
    // Re-render header button
    const editBtn = this.shadowRoot.getElementById("editModeBtn");
    if (editBtn) {
      if (this._editMode) {
        editBtn.className = "exit-edit-btn";
        editBtn.textContent = "Exit Edit Mode";
      } else {
        editBtn.className = "edit-btn";
        editBtn.textContent = "Edit";
      }
    }
    // Update canvas wrapper outline
    const wrapper = this.shadowRoot.getElementById("canvasWrapper");
    if (wrapper) {
      if (this._editMode) {
        wrapper.classList.add("edit-mode");
      } else {
        wrapper.classList.remove("edit-mode");
      }
    }
    // Re-render elements to apply/remove edit mode styling
    this._renderElements();
  }

  _renderFloors() {
    const tabsEl = this.shadowRoot.getElementById("floorTabs");
    if (!tabsEl) return;
    tabsEl.innerHTML = "";
    const sorted = [...this._floors].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    sorted.forEach((f) => {
      const btn = document.createElement("button");
      btn.className = "floor-tab" + (this._currentFloor && this._currentFloor.id === f.id ? " active" : "");
      btn.textContent = f.name;
      btn.dataset.id = f.id;
      btn.addEventListener("click", () => this._selectFloor(f.id));
      tabsEl.appendChild(btn);
    });
  }

  async _renderCurrentFloor() {
    const wrapper = this.shadowRoot.getElementById("canvasWrapper");
    if (!wrapper || !this._currentFloor) return;

    if (!this._currentFloor.image) {
      wrapper.innerHTML = `<div class="no-image">No floor plan image uploaded yet.<br>Open the HADomotics configuration panel to add one.</div>`;
      return;
    }

    const imgSrc = `${this._addonBase}/api/images/${this._currentFloor.image}`;

    wrapper.innerHTML = `
      <img class="floor-image" id="floorImg" src="${imgSrc}" alt="${this._escHtml(this._currentFloor.name)}" />`;

    const img = wrapper.querySelector("#floorImg");
    img.addEventListener("load", () => {
      this._renderElements();
      if (this._editMode) wrapper.classList.add("edit-mode");
    });
    img.addEventListener("error", () => {
      wrapper.innerHTML = `<div class="error-msg">Could not load floor plan image.</div>`;
    });
  }

  _renderElements() {
    const wrapper = this.shadowRoot.getElementById("canvasWrapper");
    if (!wrapper || !this._currentFloor) return;

    // Remove old overlays
    wrapper.querySelectorAll(".element-btn").forEach((e) => e.remove());

    const elements = this._currentFloor.elements || [];
    elements.forEach((el) => {
      const btn = document.createElement("div");
      btn.className = `element-btn ${el.type || ""}`;
      btn.dataset.id = el.id;
      btn.dataset.entityId = el.entity_id || "";
      btn.dataset.tapAction = el.tap_action || "toggle";
      btn.style.left = `${el.x}px`;
      btn.style.top = `${el.y}px`;
      btn.style.width = `${el.width || 60}px`;
      btn.style.height = `${el.height || 30}px`;
      btn.style.background = el.color_off || "#9E9E9E";

      const iconName = el.icon || this._defaultIcon(el.type);
      const stateInfo = this._getEntityStateInfo(el);

      if (stateInfo.isOn) {
        btn.style.background = el.color_on || "#4CAF50";
      }

      btn.innerHTML = `
        <span class="icon-placeholder">${this._mdiSvg(iconName)}</span>
        ${el.label ? `<span class="element-label">${this._escHtml(el.label)}</span>` : ""}
        ${(el.type === "sensor" || el.type === "indicator") && stateInfo.value
          ? `<span class="element-value">${this._escHtml(stateInfo.value)}</span>`
          : ""}`;

      btn.setAttribute("title", this._elementTooltip(el, stateInfo));

      if (!this._editMode) {
        btn.addEventListener("click", () => this._handleTap(el, btn));
      } else {
        btn.classList.add("edit-mode");
      }

      wrapper.appendChild(btn);
    });
  }

  _updateElementStates() {
    const wrapper = this.shadowRoot.getElementById("canvasWrapper");
    if (!wrapper || !this._currentFloor) return;
    const elements = this._currentFloor.elements || [];
    elements.forEach((el) => {
      const btn = wrapper.querySelector(`[data-id="${el.id}"]`);
      if (!btn) return;
      const stateInfo = this._getEntityStateInfo(el);
      btn.style.background = stateInfo.isOn ? (el.color_on || "#4CAF50") : (el.color_off || "#9E9E9E");
      btn.setAttribute("title", this._elementTooltip(el, stateInfo));
      // Update value for sensors
      const valEl = btn.querySelector(".element-value");
      if (valEl && stateInfo.value) valEl.textContent = stateInfo.value;
    });
  }

  /* ── State helpers ── */

  _getRelevantStates(hass) {
    if (!hass || !this._currentFloor) return {};
    const result = {};
    (this._currentFloor.elements || []).forEach((el) => {
      if (el.entity_id && hass.states[el.entity_id]) {
        result[el.entity_id] = hass.states[el.entity_id].state;
      }
    });
    return result;
  }

  _getEntityStateInfo(el) {
    if (!el.entity_id || !this._hass) return { isOn: false, value: null, state: "unknown" };
    const stateObj = this._hass.states[el.entity_id];
    if (!stateObj) return { isOn: false, value: null, state: "unavailable" };
    const state = stateObj.state;
    const isOn = ["on", "open", "home", "active", "heating", "cooling", "true"].includes(
      state.toLowerCase()
    );
    const value = stateObj.attributes?.unit_of_measurement
      ? `${state} ${stateObj.attributes.unit_of_measurement}`
      : state;
    return { isOn, value, state };
  }

  _elementTooltip(el, stateInfo) {
    const parts = [];
    if (el.label) parts.push(el.label);
    if (el.entity_id) parts.push(el.entity_id);
    if (stateInfo.state && stateInfo.state !== "unknown") parts.push(`State: ${stateInfo.state}`);
    return parts.join("\n");
  }

  /* ── User interaction ── */

  async _handleTap(el, btnEl) {
    if (!el.entity_id || !this._hass) return;
    const action = el.tap_action || "toggle";

    if (action === "more-info") {
      const event = new Event("hass-more-info", { bubbles: true, composed: true });
      event.detail = { entityId: el.entity_id };
      this.dispatchEvent(event);
      return;
    }

    if (action === "none") return;

    if (action === "navigate" && el.navigate_path) {
      window.history.pushState(null, "", el.navigate_path);
      const evt = new Event("location-changed", { bubbles: true, composed: true });
      this.dispatchEvent(evt);
      return;
    }

    // Default: toggle
    btnEl.classList.add("loading");
    try {
      const [domain] = el.entity_id.split(".");
      await this._hass.callService(domain, "toggle", { entity_id: el.entity_id });
    } catch (err) {
      console.error("HADomotics: service call failed", err);
    } finally {
      btnEl.classList.remove("loading");
    }
  }

  /* ── Data loading ── */

  async _loadFloors() {
    const wrapper = this.shadowRoot.getElementById("canvasWrapper");
    try {
      const res = await fetch(`${this._addonBase}/api/floors`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this._floors = await res.json();
      this._renderFloors();

      if (this._floors.length === 0) {
        if (wrapper) wrapper.innerHTML = `<div class="no-image">No floors configured yet. Open the HADomotics panel to set up your home.</div>`;
        return;
      }

      // Select default floor (from config, or first)
      const defaultId = this._config.default_floor;
      const target = defaultId
        ? this._floors.find((f) => f.id === defaultId)
        : this._floors[0];
      await this._selectFloor(target ? target.id : this._floors[0].id);
    } catch (err) {
      console.error("HADomotics: could not load floors", err);
      if (wrapper) wrapper.innerHTML = `<div class="error-msg">Could not connect to HADomotics addon.<br>Check that addon_url is correct: <code>${this._escHtml(this._addonBase)}</code></div>`;
    }
  }

  async _selectFloor(floorId) {
    try {
      const res = await fetch(`${this._addonBase}/api/floors/${floorId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this._currentFloor = await res.json();
      this._renderFloors();  // update active tab
      await this._renderCurrentFloor();
    } catch (err) {
      console.error("HADomotics: could not load floor", err);
    }
  }

  /* ── Utilities ── */

  _defaultIcon(type) {
    const map = {
      button: "toggle-switch",
      light: "lightbulb",
      sensor: "eye",
      indicator: "circle",
      climate: "thermostat",
      cover: "window-open",
      camera: "cctv",
      custom: "widgets",
    };
    return map[type] || "widgets";
  }

  /** Returns a minimal SVG icon representation (text fallback for MDI). */
  _mdiSvg(name) {
    // We emit a ha-icon if available, otherwise a text glyph
    return `<ha-icon icon="mdi:${this._escHtml(name)}"></ha-icon>`;
  }

  _escHtml(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
}

/* ============================================================
   HADomoticsCardEditor – Config UI in Lovelace editor
   ============================================================ */

class HADomoticsCardEditor extends HTMLElement {
  constructor() {
    super();
    this._config = {};
    this.attachShadow({ mode: "open" });
  }

  set hass(_) {}

  setConfig(config) {
    this._config = config;
    this._render();
  }

  _render() {
    const s = this.shadowRoot;
    s.innerHTML = `
      <style>
        .config-form { padding: 8px 0; display: flex; flex-direction: column; gap: 12px; }
        .config-row { display: flex; flex-direction: column; gap: 4px; }
        label { font-size: 0.8rem; font-weight: 600; color: var(--secondary-text-color); text-transform: uppercase; }
        input { padding: 8px 10px; border: 1px solid var(--divider-color,#ccc); border-radius: 6px; font-size: 0.9rem; }
      </style>
      <div class="config-form">
        <div class="config-row">
          <label>Title</label>
          <input id="title" value="${this._escHtml(this._config.title || "")}" placeholder="My Home" />
        </div>
        <div class="config-row">
          <label>Addon URL</label>
          <input id="addon_url" value="${this._escHtml(this._config.addon_url || "")}" placeholder="http://homeassistant.local:8099" />
        </div>
        <div class="config-row">
          <label>Default Floor ID</label>
          <input id="default_floor" value="${this._escHtml(this._config.default_floor || "")}" placeholder="floor1" />
        </div>
      </div>`;

    s.querySelectorAll("input").forEach((inp) => {
      inp.addEventListener("change", () => this._valueChanged());
    });
  }

  _valueChanged() {
    const event = new CustomEvent("config-changed", {
      detail: {
        config: {
          ...this._config,
          title: this.shadowRoot.getElementById("title").value,
          addon_url: this.shadowRoot.getElementById("addon_url").value,
          default_floor: this.shadowRoot.getElementById("default_floor").value,
        },
      },
      bubbles: true,
      composed: true,
    });
    this.dispatchEvent(event);
  }

  _escHtml(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
}

/* ============================================================
   Registration
   ============================================================ */

customElements.define("hadomotics-card", HADomoticsCard);
customElements.define("hadomotics-card-editor", HADomoticsCardEditor);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "hadomotics-card",
  name: "HADomotics – Interactive Floor Plan",
  description:
    "Displays an interactive home floor plan with buttons, lights, sensors and indicators that reflect real-time Home Assistant entity states.",
  preview: false,
  documentationURL: "https://github.com/iejayu8/HADomotics",
});

console.info(
  "%c HADomotics Card %c v1.0.2 ",
  "background:#1976D2;color:#fff;font-weight:bold;padding:2px 4px;border-radius:3px 0 0 3px",
  "background:#42A5F5;color:#fff;padding:2px 4px;border-radius:0 3px 3px 0"
);
