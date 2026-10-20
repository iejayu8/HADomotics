HADomotics is a project structured into multiple components, including a backend module, a custom Lovelace card, and a test suite. This repository contains the source code, configuration files, and development assets for the project.

Latest addon version: 3.3.0

**Access**

The panel is part of Home Assistant (ingress). Host port **8099 is not published**. Do not point browsers or phone apps at `http://<home-assistant>:8099`; that URL is closed so the add-on cannot call Home Assistant services without a login.

- **Sidebar:** open HADomotics in Home Assistant. Every logged-in user can load the panel. Only an administrator can edit floors or use the add-on's service proxy. Device taps use the signed-in user when the panel is embedded in Home Assistant.
- **Lovelace card:** set `addon_url` to `/api/hassio_ingress/<token>` (copy the path from the sidebar panel). Administrators can leave it empty and the card will look the path up. Actions on the card go through Home Assistant (`hass.callService`), not the add-on proxy.
- **Direct access (off by default):** in the add-on configuration enable **Allow direct access**, then on the Network page set a host port. Call the API with `Authorization: Bearer <long-lived access token>`. The token is checked with Home Assistant, and service calls run as that user. For a browser on another origin, set **CORS origins** to the exact origin (a wildcard is ignored).

Service calls through the add-on are limited to floor-plan controls (toggle, cover position, lights, scenes, scripts, and the other device services listed in `hadomotics/server.py`). `homeassistant.restart`, shell commands, and similar administrative services are rejected.

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
