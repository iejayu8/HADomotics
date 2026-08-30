HADomotics is a project structured into multiple components, including a backend module, a custom Lovelace card, and a test suite. This repository contains the source code, configuration files, and development assets for the project.

Latest addon version: 3.1.0

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
