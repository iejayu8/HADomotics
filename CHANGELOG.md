# Changelog

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
