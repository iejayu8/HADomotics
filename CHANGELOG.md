# Changelog

## 3.2.1-energia.1

Pre-release de la rama `feature/carga-energia`. Sirve para instalar el panel Energía en Home Assistant sin publicar un release desde `main`. Es mayor que 3.2.0 y menor que 3.2.1 y que 3.3.0.

### Added
- **Panel Energía** (`/energia`, botón Energía en el dock del modo vista): pantallas Coche/Carga, Solar/Inversor y Batería.
  Cliente fino de Home Assistant: datos en vivo (ABRP `sensor.batmovil_*`, Helios, `sensor.carga_decision_noche` y motivo, EVSE, inversor y batería Deye/Solarman `sensor.inverter_*`),
  sin guardar ni calcular datos sincronizados.
- API `GET /api/energy/map`, `GET /api/energy/state`, `POST /api/energy/control` (lista blanca de controles deliberados,
  validación de rango/opciones con los atributos de HA, `dry_run`).
- Interruptores de las 3 automatizaciones de carga (`automation.turn_on` / `turn_off` solo para `automation.carga_coche_dinamica_por_excedente`, `automation.carga_coche_programa_nocturno` y `automation.carga_coche_toda_la_noche`).
- `mobile-energia/`: app Capacitor (Android/iOS) con el mismo panel en modo directo (websocket de HA). El APK de depuración sale solo del workflow manual `android-energia-debug`; no forma parte de la instalación del add-on.

### Modo prueba
- En el panel, el modo prueba (dry-run) está **activado por defecto**. Los controles no llaman a Home Assistant hasta que se apaga.
- Para apagarlo: en la página Energía, **⚙ Ajustes** → desmarcar «Modo prueba (dry-run)» → **Guardar y conectar**. El aviso amarillo desaparece y un aviso confirma que los controles se enviarán.
- La preferencia se guarda solo en ese navegador: `localStorage` `hadomotics.energy.dryrun`. El valor `0` la apaga. Si la clave no existe, o tiene cualquier otro valor, el modo prueba sigue activado.
- `POST /api/energy/control` ejecuta la llamada cuando `dry_run` no es verdadero. El panel envía siempre la casilla actual (`dry_run: true` mientras el modo prueba está activado).

### Probar la rama

No hace falta una imagen publicada ni un release en `main`. `hadomotics/config.yaml` no tiene clave `image:`, así que el Supervisor compila el add-on en el propio Home Assistant a partir del `Dockerfile`.

El Supervisor trata `https://github.com/iejayu8/HADomotics#feature/carga-energia` como **otro repositorio** (el identificador incluye la rama). No aparece el botón Actualizar sobre el HADomotics 3.2.0 ya instalado: aparece un segundo add-on, versión **3.2.1-energia.1**, con el botón Instalar. Los datos (planos) no se comparten. La rama lleva una barra (`feature/...`); hace falta Supervisor 2026.07 o posterior (Home Assistant 2026.10 lo incluye).

1. Copia de seguridad parcial del add-on HADomotics ya instalado: **Ajustes → Sistema → Copias de seguridad**. Nómbrala `pre-hadomotics-energia` más la fecha. Si quieres los planos en la copia de prueba, en el add-on 3.2.0 usa **Export** y guarda el JSON.
2. **Ajustes → Aplicaciones → Tienda de aplicaciones → menú ⋮ → Repositorios → Añadir**  
   `https://github.com/iejayu8/HADomotics#feature/carga-energia`  
   (En instalaciones que aún dicen «Complementos», es la misma tienda.)
3. Para el HADomotics 3.2.0 que ya tenías. Los dos publican el puerto de host `8099/tcp` y no pueden arrancar a la vez. Si aparecen dos entradas «HADomotics» en la barra lateral, la de la prueba es la que arranque en el paso siguiente (la ficha del add-on muestra la versión).
4. Instala el add-on de la rama (versión 3.2.1-energia.1) y arráncalo. La primera vez el Supervisor lo construye en local (varios minutos; necesita salida a Internet para la imagen base y `pip`). No pulses nada en GitHub Releases ni en el workflow Release.
5. Abre el panel lateral **HADomotics** de esa instalación. En el modo vista, el botón **Energía** está en el dock inferior. También vale la ruta `/energia` del ingress. El aviso amarillo indica que el modo prueba está activo.
6. Para probar un control de verdad: ⚙ Ajustes → desmarcar modo prueba → Guardar y conectar. Un control inocuo para la primera prueba es `input_select.carga_dia_domingo` (cámbialo y déjalo como estaba).
7. **Volver atrás:** restaura la copia parcial `pre-hadomotics-energia ...` en **Ajustes → Sistema → Copias de seguridad**. Para el add-on de la rama y desinstálalo. Quita el repositorio `https://github.com/iejayu8/HADomotics#feature/carga-energia` y vuelve a añadir el normal, `https://github.com/iejayu8/HADomotics`. Arranca de nuevo el HADomotics 3.2.0.

## 3.2.0

### Added
- **Bulk On/Off colors (Edit Mode)**  
  Sidebar section to pick Color On / Color Off and apply them to every element on the current floor, or to all elements on all floors, without editing one by one.

## 3.1.0

### Changed
- **Immersive kiosk View Mode**  
  Full-bleed floor plan on a dark canvas. Floor tabs and Edit sit in a floating glass dock at the bottom. Entities render as circular glowing orbs using their on/off colors. Labels are hidden in View Mode; live state chips remain. Edit Mode layout is unchanged.

### Fixed
- Floor plan scaling in View Mode leaves space for the bottom dock so the plan is not covered.

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
