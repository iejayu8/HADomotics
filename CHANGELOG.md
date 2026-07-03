# Changelog

## 1.1.2

- **Important for update detection**: Bumped version to 1.1.2 to force Home Assistant Add-on Store to recognize the new release after the 1.1.1 changes.
- If you still see version 1.1.0 / 1.1.1 after this update, please **remove and re-add** the custom repository in HA:
  1. Settings → Add-ons → Add-on Store → ⋮ menu on the HADomotics repo → Remove
  2. Re-add the repository: `https://github.com/iejayu8/HADomotics`
  3. Then click "Check for updates"
- This release also includes the critical `with-contenv` fix from 1.1.1 (SUPERVISOR_TOKEN now properly available → element clicks in View mode and live state polling now work correctly).

## 1.1.1

- **Bugfix**: Use `/usr/bin/with-contenv` wrapper in Dockerfile so `SUPERVISOR_TOKEN` is properly available inside the addon container. This fixes "Action failed: no supervisor token" errors when clicking element buttons in View/Interact mode of the configuration panel (and ensures live state polling works).
- No regressions to existing features (floor management, image upload, element CRUD, Lovelace card, drag/resize/rotation, ingress support, etc. all preserved).

## 1.1.0

- Add Element rotation in "edit mode"

## 1.0.2

- Add View/Interact mode to the configuration panel floor plan editor
- Elements can now be clicked in View Mode to toggle entities or show state info
- Edit Mode remains the default; a toolbar button switches between modes
- Live HA entity state colours are polled every 5 s in View Mode

## 1.0.1

- Fix API base URL derivation for Home Assistant ingress compatibility
- Ensure changelog and config files are present for update detection

## 1.0.0

- Initial release
- Interactive home floor plan interface for Home Assistant
- Manage buttons, lights, sensors and more with a visual domotics interface
