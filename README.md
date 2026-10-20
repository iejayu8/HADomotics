HADomotics is a project structured into multiple components, including a backend module, a custom Lovelace card, and a test suite. This repository contains the source code, configuration files, and development assets for the project.

Latest addon version: 3.2.1-energia.1

## Probar la rama

Esta rama (`feature/carga-energia`, versión **3.2.1-energia.1**) añade el panel Energía. Se puede instalar en Home Assistant sin publicar un release y sin tocar `main`.

`hadomotics/config.yaml` no define `image:`. El Supervisor no descarga una imagen precompilada: compila el `Dockerfile` en el propio equipo (`build.yaml` elige la imagen base de Python). No hace falta el workflow Release ni un tag.

La versión es un pre-release semver: **3.2.0 < 3.2.1-energia.1 < 3.2.1 < 3.3.0** (AwesomeVersion, la misma comparación que usa el Supervisor).

El Supervisor identifica el repositorio por la URL **incluyendo** `#rama`. Añadir la rama no actualiza el HADomotics 3.2.0 ya instalado: crea un segundo add-on, con botón **Instalar**, no Actualizar. Los planos no se copian solos. La rama se llama `feature/carga-energia` (lleva `/`); hace falta Supervisor **2026.07** o posterior. Home Assistant 2026.10 lo cumple.

1. Copia de seguridad parcial del add-on HADomotics instalado: **Ajustes → Sistema → Copias de seguridad**. Ponle un nombre que empiece por `pre-hadomotics-energia` y la fecha. Si quieres los mismos planos en la copia de prueba, en el add-on 3.2.0 pulsa **Export** y guarda el JSON.
2. **Ajustes → Aplicaciones → Tienda de aplicaciones → menú ⋮ → Repositorios → Añadir** esta URL:

   `https://github.com/iejayu8/HADomotics#feature/carga-energia`

   En una interfaz que todavía diga «Complementos», es la misma tienda de add-ons.
3. Para el HADomotics **3.2.0**. Los dos publican `8099/tcp` en el host y no pueden estar en marcha a la vez.
4. En la tienda, sección HADomotics, instala el add-on versión **3.2.1-energia.1** y arráncalo. La primera construcción local tarda varios minutos y necesita Internet. No lances el workflow Release.
5. Abre el panel lateral **HADomotics** de esa instalación (si quedan dos entradas con el mismo nombre, es la de la versión 3.2.1-energia.1; con la 3.2.0 parada solo queda una). En el **modo vista**, el botón **Energía** está en el dock inferior. La misma pantalla es la ruta `/energia` del ingress.
6. Arriba verás un aviso amarillo: el **modo prueba (dry-run) está activado por defecto** y los controles no se envían a Home Assistant. Para apagarlo: **⚙ Ajustes** → desmarca «Modo prueba (dry-run)» → **Guardar y conectar**. El aviso desaparece y sale un mensaje de que los controles se enviarán. La preferencia queda solo en ese navegador (`localStorage` clave `hadomotics.energy.dryrun`: `0` = apagado; si no existe, o vale cualquier otra cosa, sigue activado). La API `POST /api/energy/control` ejecuta la llamada cuando `dry_run` no es verdadero; el panel manda siempre el estado de esa casilla.
7. Para una primera prueba real, con el modo prueba apagado, cambia `input_select.carga_dia_domingo` y vuelve a dejarlo como estaba.
8. **Volver atrás.** Restaura la copia parcial `pre-hadomotics-energia ...` en **Ajustes → Sistema → Copias de seguridad**. Para el add-on de la rama y desinstálalo. Quita el repositorio `https://github.com/iejayu8/HADomotics#feature/carga-energia` y vuelve a añadir el normal, `https://github.com/iejayu8/HADomotics`. Arranca otra vez el HADomotics 3.2.0.

La app móvil (`mobile-energia/`) no se instala con el add-on. El APK de depuración solo se construye a mano con el workflow `android-energia-debug`.

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

# Pre-release (X.Y.Z-label). 3.2.0 < 3.2.1-energia.1 < 3.2.1
python scripts/bump_version.py --set 3.2.1-energia.1
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
