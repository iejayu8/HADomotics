# Changelog

## 3.0.1

### Fixed
- **Quick-position modal order**  
  Cover position buttons are now ordered from **100% (top)** to **0% (bottom)** so the open position is first.
- **Floor swipe on touch displays**  
  Vertical swipe between floors now uses document-level touch/pointer listeners, a wider center zone, and `touch-action: none` on the canvas so gestures work reliably on wall panels (e.g. Shelly Display). Swipes no longer conflict with element taps.

## 3.0.0

### Added
- **Large quick-position buttons**  
  Cover / blind position selector (0%, 25%, 50%, 75%, 100%) uses large touch-friendly buttons for wall displays. Floor-plan element sizes are unchanged.
- **HA connection indicator**  
  Blinking round status light: green while the Home Assistant WebSocket/SSE link is active, red when disconnected. Visible in the header (Edit Mode) and fixed top-right corner in View Mode.
- **Swipe between floors**  
  In View Mode, vertical swipe (up = next floor, down = previous floor) from the **center** of the screen (not from the edges) switches floors.

## 2.0.1

### Added
- **Real-time entity states via Home Assistant WebSocket**  
  The backend maintains a persistent WebSocket connection to Home Assistant (`/api/websocket`), subscribes to `state_changed` events, and keeps an in-memory state cache.
- **Server-Sent Events stream** (`GET /api/ha/stream`)  
  The frontend receives live state updates over SSE instead of polling every 5 seconds. Entity colors and sensor values on the floor plan update immediately when HA state changes.
- Fallback to REST polling if the SSE stream is unavailable.

### Changed
- `/api/ha/states` prefers the WebSocket-backed cache when available.
- Local development continues to support `HA_URL` + `HA_TOKEN` for both REST and WebSocket.
- Dependency: `websocket-client`.

## 1.9.0

### Added
- **Auto-hide toolbar (View Mode)**  
  The main HADomotics header is automatically hidden in View Mode to free screen space (ideal for wall displays / kiosk). It reappears when switching back to Edit Mode.

- **Tap feedback**  
  Interactive elements show a short visual feedback animation when tapped in View Mode.

- **Live sensor / state values on the floor plan**  
  Elements of type sensor, climate, indicator and cover display their live value (e.g. temperature, cover position %).  
  - State text is rendered **outside** the element box.  
  - Position is configurable in Edit Mode: top / bottom / left / right / hidden.  
  - Values update with the existing state polling.

### Changed
- Element state styling improved for readability (badge outside the control).
- Backend persists `state_position` (and related element fields) on update.
- Local development: optional `HA_URL` + `HA_TOKEN` for Home Assistant API access outside the Supervisor.

## 1.8.0

- Added canvas layout adjustments and automatic scaling for floor plans.
- Removed the sidebar toggle button and related event handling.
- Added floor switcher buttons and view-mode rendering logic.
- Cleaned up unused floor definitions and improved initialization behavior.
- Implemented automatic sidebar toggling based on view mode.

## 1.7.1

- Sidebar hiden; import/export hiden in view mode; realtime elements status;

## 1.7.0

- Added Export / Import configuration feature (floors, elements and floor plan images).
- Major version bump for better update detection.

## 1.6.0
- Quick Position Selector modal and Duplicate button.
- escapeHtml permanently fixed.
