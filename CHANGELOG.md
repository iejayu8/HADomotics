# Changelog

## 1.2.3

- **New Feature**: Full support for calling **any Home Assistant service** from elements in the configuration panel.
  - New `tap_action` option: `call-service` (allows `light.turn_on`, `scene.turn_on`, `cover.set_cover_position`, `media_player.volume_set`, etc.).
  - New configurable fields: **Service** + **Service Data (JSON)**.
  - `set_position` action for covers is now fully functional.
- Backend already supported any service via generic proxy; frontend now fully utilizes it.
- Dynamic form fields in element properties.
- Better error handling and success toasts.

## 1.2.1
- Improved startup with proper `run.sh` + `with-contenv` (fixed broken UI from previous versions).

## 1.1.x
- Initial partial `set_position` support + supervisor token fixes.

## 1.0.x
- Core floor plan, elements, and toggle functionality.