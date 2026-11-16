HADomotics is a project structured into multiple components, including a backend module, a custom Lovelace card, and a test suite. This repository contains the source code, configuration files, and development assets for the project.

Latest addon version: 3.5.1

**Access**

The panel is part of Home Assistant (ingress). Host port **8099 is not published**. Do not point browsers or phone apps at `http://<home-assistant>:8099`; that URL is closed so the add-on cannot call Home Assistant services without a login.

- **Sidebar:** open HADomotics in Home Assistant. Every logged-in user can load the panel. Only an administrator can edit floors or use the add-on's service proxy. Device taps use the signed-in user when the panel is embedded in Home Assistant.
- **Lovelace card:** set `addon_url` to `/api/hassio_ingress/<token>` (copy the path from the sidebar panel). Administrators can leave it empty and the card will look the path up. Actions on the card go through Home Assistant (`hass.callService`), not the add-on proxy.
- **Direct access (off by default):** in the add-on configuration enable **Allow direct access**, then on the Network page set a host port. Call the API with `Authorization: Bearer <long-lived access token>`. The token is checked with Home Assistant, and service calls run as that user. For a browser on another origin, set **CORS origins** to the exact origin (a wildcard is ignored).

Service calls through the add-on are limited to floor-plan controls (toggle, cover position, lights, scenes, scripts, and the other device services listed in `hadomotics/server.py`) plus the Energía helpers `input_number.set_value` and `input_select.select_option`. The Seguridad sub-app has its own admin-only endpoints. `POST /api/security/alarm` accepts only `alarm_control_panel.alarmo` and the arm/disarm modes Alarmo advertises. `POST /api/security/control` accepts only the alarm zones and siren entities listed below. `homeassistant.restart`, shell commands, and similar administrative services are rejected.

**Dispositivos and Energía**

Version 3.4.0 is one add-on. The bottom buttons **Dispositivos** and **Energía** switch the two sub-apps. Dispositivos is the floor plan (view mode, edit mode, bulk colours, cover position, floor swipe). The floor switcher and the Edit button stay in that sub-app. Energía is the car-charging, solar/inverter and battery panel, plus a live power-flow view (solar strings, inverter, battery, grid, house and car).

Updating from 3.3.0 keeps the same slug, so the installed add-on updates in place and existing floor plans in the add-on data directory are kept. Take a backup before you update. Since 3.4.2 Energía controls start in live mode and are sent to Home Assistant. Test mode (dry-run) is on only when you tick «Modo prueba» in Energía → ⚙ Ajustes and press Guardar (`localStorage` key `hadomotics.energy.testmode` = `1`); the old `hadomotics.energy.dryrun` key is ignored and removed. Inside Home Assistant those controls run as the signed-in user. The draft add-on from `feature/carga-energia` is superseded by this release; uninstall it if it is still present. Host port 8099 stays closed.

**Seguridad**

Since 3.5.0 the bottom buttons are **Seguridad**, **Dispositivos** and **Energía**, in that order. Seguridad shows the Alarmo panel as a single card centred above the floor plan, where you can arm or disarm the alarm. Each mode asks for confirmation, and asks for the code only when Alarmo requires one; the code is never stored. Two small buttons next to the card open overlays, one at a time:
- **Zonas** shows the alarm zones.
- **Detecciones** shows a counter of active detections and lists every motion sensor and camera with its state and last change in Madrid time.

Close either with X, Esc, a click outside, or its button. The floor switcher is the same floating dock as in Dispositivos.

Motion sensors and cameras are drawn on the same floor plans as Dispositivos, labelled with their name only. The icon colour shows the state: red for detection, green for no detection, dim grey for unavailable. The full state is in the marker's `aria-label` and `title`. The entities are listed in `hadomotics/security_map.json`.

Since 3.5.1 the Seguridad dock has a pencil button next to the floor switcher, in the same place as the Edit button in Dispositivos. In edit mode you can drag motion sensors and cameras with a mouse or a finger. Each position is saved when you drop it; press ✓ to leave edit mode. Positions are stored in the add-on configuration under `security_positions` as fractions of the plan image, through the admin-only `PUT /api/security/positions`. Until you move a marker, the positions in `security_map.json` are used.

**Zones and siren**

Since 3.5.1 each row in **Zonas** is a switch for its `input_boolean.notificacion_alarma_*`, like the Lovelace «Zonas Activas» card. The change shows at once and is undone, with a message, if it fails.

A **Sirena** button next to Zonas and Detecciones opens one overlay with:
- the «Sirena con la alarma» switch (`input_boolean.alarma_sirena`);
- the Heiman default tone and level selects (`select.heiman_warningdevice_ef_3_0_tono_de_sirena_predeterminado`, `select.heiman_warningdevice_ef_3_0_nivel_de_sirena_predeterminado`);
- **Probar sirena**, which does what the Lovelace siren toggle does: `siren.turn_on` on `siren.heiman_warningdevice_ef_3_0` with only the `entity_id`. It always asks for confirmation first («Sonará la sirena real»). While the siren sounds, the button becomes «Parar sirena» (`siren.turn_off`).

The Lovelace Sirena view is visible to two users only, so the Sirena button is shown to administrators only.

How the calls are made:
- Inside Home Assistant, zones and siren use `hass.callService` as the signed-in user.
- Outside, they go to `POST /api/security/control`. It is admin-only and has a fixed whitelist: the 12 zones and `input_boolean.alarma_sirena` with `turn_on`/`turn_off`, the two selects with `select_option` (only an option the entity lists), and the siren with `turn_on` (only with `"confirm": true`) and `turn_off`. Anything else is rejected before it reaches Home Assistant.

**Elements outside the floor plan**

In edit mode, in both Dispositivos and Seguridad, a dashed line marks the edge of the drawing and leaves a margin of background around it. Drop an element in that margin to keep it outside the drawing, for example the Día and Noche scene buttons. It stays outside, roughly where you put it, at any screen size. The plan shrinks to at most 85% to make room. On small screens the element moves only as much as it needs to stay on screen.

How it is stored:
- Dispositivos elements keep their pixel coordinates, which may now be negative or beyond the image edge, plus `outside: true` or `false`. The field is set when you drop an element after moving it.
- Elements without the `outside` field are the older ones. Only they get the 3.5.0 crop clamp and relocation, so saved configurations keep working.
- Backups include `security_positions`.

Drawing overlays live in `hadomotics/plan_overlays.json`:
- the white-border crop of each plan, applied only to the reference images (since 3.5.1 also in edit mode, so what you place is what you see);
- the HD versions of both plans;
- the garage Tesla and the charger cable, shown only in Dispositivos; the cable animates when `sensor.evse_charging_power` is above 100 W.

**Repository Structure**

hadomotics/        # Core project module
lovelace-card/     # Custom Lovelace card implementation
tests/             # Test suite
scripts/           # Versioning helpers (bump / check / changelog extract)
.github/workflows/ # CI: version check + release automation
.gitignore         # Git ignore rules
CHANGELOG.md       # Version history
repository.yaml    # Repository metadata
server.log         # Server log file
README.md          # Project documentation (this file)

**Components**
hadomotics/
Contains the main logic or backend portion of the project.

lovelace-card/
Includes the custom Lovelace card implementation.
This likely provides UI elements or integrations for Home Assistant dashboards.

tests/
Holds automated tests for validating project functionality.

**Versioning (CI/CD)**

Source of truth: `hadomotics/config.yaml` → `version`.

| File | Role |
|------|------|
| `hadomotics/config.yaml` | Addon version (Home Assistant Supervisor) |
| `hadomotics/build.yaml` | `io.hass.version` label |
| `README.md` | `Latest addon version` line |
| `CHANGELOG.md` | Section `## X.Y.Z` |

Local commands:

```bash
# Check all version files match
python scripts/check_version.py

# Bump and sync (patch / minor / major)
python scripts/bump_version.py patch
python scripts/bump_version.py minor --note "- New feature description"

# Propagate current config.yaml version to the other files
python scripts/bump_version.py --sync
```

GitHub Actions:
- **Version check** — runs on every PR/push to `main`; fails if files disagree.
- **Release** — when `config.yaml` version changes on `main`, creates tag `vX.Y.Z` + GitHub Release from CHANGELOG.
- **Bump version** — manual workflow (Actions → Bump version) to bump patch/minor/major on `main`.

**Development**

1. Clone the project
2. Explore the module directories (hadomotics/, lovelace-card/)
3. Review the test suite in tests/
4. Check CHANGELOG.md for version history
5. Use the latest addon version when installing or updating the add-on
6. Use server.log for debugging or runtime insights
