# Changelog
## 1.1.5
- error solving
## 1.1.3

- **Critical fix**: Replaced direct `with-contenv` CMD with a proper `run.sh` startup script (standard HA Python addon pattern). This resolves the broken UI (buttons not working, no View/Edit mode toggle, new floor button doing nothing) that appeared in 1.1.2 for some users.
- The supervisor token fix (element control in View mode) remains in place and is more reliable now.
- If you experienced data loss: The floors are stored in the addon's persistent `/data/config.json`. Check if you had the backup option enabled during previous updates, or look for previous versions in the addon's backup location.

## 1.1.2

- Bumped version to force Home Assistant Add-on Store detection.
- Included improved startup (later refined in 1.1.3).

## 1.1.1

- **Bugfix**: Use `/usr/bin/with-contenv` wrapper in Dockerfile so `SUPERVISOR_TOKEN` is properly available inside the addon container. This fixes "Action failed: no supervisor token" errors when clicking element buttons in View/Interact mode.

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
