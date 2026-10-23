# Changelog

## 3.4.0

### Added
- **Una sola instalación, dos sub-apps.** El panel se cambia con los botones inferiores **Dispositivos** y **Energía**. El slug del add-on no cambia: una actualización sustituye a la 3.3.0 y los planos de `/data` se conservan.
- **HADomotics Dispositivos** es el plano de planta de siempre (modo vista, modo edición, colores en bloque, posición de persianas, cambio de planta, copia de seguridad) con la paleta oscura del panel Energía. El selector de planta y el botón Editar siguen dentro de Dispositivos.
- **HADomotics Energía** trae Coche/Carga, Solar/Inversor y Batería (cliente fino de Home Assistant: ABRP, Helios, decisión de carga, EVSE, inversor y batería). Los controles editables siguen siendo solo los helpers de carga y los tres interruptores de automatización.
- **Flujo en vivo** en Energía → Flujo, equivalente a la tarjeta Casa → ENERGÍA: Solar (3 MPPT) → Inversor ↔ Batería (7,6 kWh) ↔ Red, e Inversor → Casa y → Coche. Potencia en W (la red, publicada en kW, se convierte), dirección animada, kWh del día, autarquía diaria y los colores de esa vista. Un dato `unavailable` se muestra como «no disponible» y no mueve la línea.
- El modo prueba de los controles está **activado por defecto** (`localStorage` `hadomotics.energy.dryrun`; solo el valor `0` lo apaga). Hasta que se desmarca en ⚙ Ajustes, no se llama a ningún servicio.

### Security
- Las lecturas de Energía (`/energia`, `/api/energy/map`, `/api/energy/state`, `/api/energy/flow`) entran en la lista de lectura del ingress: cualquier usuario que haya iniciado sesión puede verlas.
- Los controles no usan un `HA_TOKEN` fijado al arrancar. Dentro del panel salen por el usuario de Home Assistant (`hass.callService`). El proxy del add-on solo lo usa un administrador (o el token propio si el acceso directo está activado) y pasa por `get_ha_token()`.
- Lista blanca ampliada solo con lo que Energía llama de más: `input_number.set_value` e `input_select.select_option`. `input_boolean` y `automation` turn on/off ya estaban. El cargador, el inversor y servicios como `homeassistant.restart` siguen rechazados.
- `GET /api/ha/stream` sigue siendo solo para administradores. Quien no lo es ve el flujo y los estados por el frontend de Home Assistant o por el sondeo de las lecturas.

### Migration
- Actualiza el add-on **HADomotics** que ya tienes (mismo repositorio, mismo slug). No hace falta el repositorio de la rama `feature/carga-energia`: esta versión lo sustituye. Si ese add-on de prueba sigue instalado, páralo y desinstálalo; no comparte los planos y no debe quedar escuchando a la vez.
- Haz una copia de seguridad del add-on antes de actualizar. Los planos no se migran de formato: el JSON de `/data` es el de 3.3.0.
- El puerto de host 8099 sigue cerrado. Entra por la barra lateral. En Energía, el aviso amarillo significa que los controles están en modo prueba.
- El gesto vertical entre plantas en modo vista vuelve a estar activo (se había quedado sin oyentes en 3.0.1): desde el centro de Dispositivos, arriba pasa a la planta siguiente y abajo a la anterior.

## 3.3.0

### Security
- **Host port 8099 is no longer published.** The panel is served through Home Assistant ingress. A client on the LAN can no longer call Home Assistant with the add-on's Supervisor token.
- **Direct access is off unless you turn it on.** The `allow_direct_access` option accepts `Authorization: Bearer <Home Assistant long-lived access token>`. The token is checked with Home Assistant, and service calls are made as that user. Assign a host port on the add-on Network page as well; the port stays unmapped until you do.
- **CORS is not a wildcard.** Cross-origin browser calls are refused unless direct access is on and `cors_origins` lists that exact origin. `*` is ignored.
- **The service proxy is an allowlist.** Floor-plan actions are forwarded (`<entity domain>.toggle`, cover open/close/position, and the other device services the editor offers, including `light.turn_on`, `scene.turn_on`, and `script.turn_on`). Administrative calls such as `homeassistant.restart`, `shell_command`, and `hassio.*` are rejected.
- Ingress is trusted only from the Supervisor address `172.30.32.2`, and only with the user id the Supervisor adds. Spoofed `X-Forwarded-For` or `X-Remote-User-*` headers from anywhere else are ignored. Any signed-in user can read floor plans (so the Lovelace card works). Editing and the service proxy require a Home Assistant administrator (the `system-admin` group, or the older `is_admin` flag).
- Inside the ingress panel, live state and device actions use the signed-in Home Assistant user when the frontend is available, so those actions follow that user's permissions.

### Migration
- Bookmarks, wall tablets, and phone apps that opened `http://<home-assistant>:8099` directly will not connect. Open **HADomotics** in the Home Assistant sidebar instead.
- Lovelace: set `addon_url` to the ingress path `/api/hassio_ingress/<token>`. Open the sidebar panel and copy the path after the hostname. Administrators may leave `addon_url` empty or keep an old `:8099` URL; the card asks the Supervisor for the ingress path. Other users need the ingress path saved on the card.
- The sidebar entry is visible to every logged-in user. Only administrators can edit the plan or use the add-on service proxy. Device taps on the Lovelace card still go through Home Assistant as the signed-in user.
- Private direct clients (off by default): enable **Allow direct access**, set a host port under **Network**, create a long-lived access token, and send `Authorization: Bearer <token>`. For a browser on another origin, set **CORS origins** to that origin, for example `http://homeassistant.local:8123`.

### Fixed
- Server tests follow the single default floor (`floor1`) instead of removed `floor2` / `garden` entries.
- Home Assistant proxy tests change the live token the server reads, and the state cache is cleared between tests so results do not depend on order.

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
