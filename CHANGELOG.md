# Changelog

## 3.8.0

### Changed
- **Los electrodomésticos ya no vienen de serie en el add-on.** Nevera, lavavajillas y robot aspirador/friegasuelos pasan a ser tipos de elemento que se añaden como cualquier otro:
  1. modo edición → **+** → clic en el plano;
  2. en el panel, **Type** = Nevera, Lavavajillas o Robot aspirador / friegasuelos;
  3. en **Entity ID**, la entidad principal (por ejemplo `vacuum.qrevo_edge_2_pro`);
  4. **Detectar entidades** rellena el resto de entidades del mismo dispositivo de Home Assistant (y de su base, en el robot); cada una se puede cambiar a mano;
  5. **Guardar**.
  - Se pueden mover, redimensionar, duplicar y borrar como los demás elementos.
  - Se conservan el icono redondo, la etiqueta en vivo, el aro de «en marcha» / alarma y los paneles de control de 3.7.0.
  - En el código ya no hay ningún `entity_id` fijo: `hadomotics/appliance_types.json` (antes `appliances_map.json`) describe solo los roles de cada tipo (dominio, `translation_key`, `device_class` o sufijo) para la detección.
- **Proxy de servicios:** `number.set_value` y `select.select_option` se permiten solo para las entidades asignadas a un electrodoméstico colocado en el plano, y solo en los roles que son controles. Al borrar el elemento se vuelven a bloquear. Las entidades de Energía y Seguridad nunca entran, aunque se asignen a mano: el límite del cargador (`number.evse_charging_power_limit`) y el tono de la sirena siguen dando 403.
- **Nuevo estilo de iconos en el plano**, propios (SVG en línea, sin dependencias externas), con un único estilo: rejilla de 24, trazo 1,8 redondeado y estados apagado / encendido / no disponible.
  - Más claros según el uso: persiana (las lamas siguen la posición), puerta de garaje interior, puerta exterior / cancela, puerta, ventana, luz (con rayos al encenderse), modo día, modo noche, escena, aerotermia / clima, temperatura, humedad, energía, depuradora de piscina, interruptor, enchufe, sensor, movimiento, cámara, alarma, sirena, cargador del coche, ventilador, cerradura, altavoz, indicador y genérico. Los electrodomésticos usan el mismo trazo.
  - Se eligen solos según el tipo, el dominio, la clase de dispositivo y el nombre. El nuevo campo **Icono en el plano** del panel permite fijar otro. El campo MDI de siempre se mantiene para la tarjeta Lovelace.
  - Sobre colores claros (como el amarillo de «encendido») el icono pasa a oscuro para que se lea. En elementos girados, el icono se mantiene derecho.

### Migración desde 3.7.0
- No se crea nada automáticamente. La clave `appliance_positions` de 3.7.0 se ignora, se borra al siguiente guardado de la configuración y ya no va en las copias de seguridad. Tras actualizar, los tres aparatos dejan de verse hasta que los añadas con el flujo de arriba (unos segundos cada uno con **Detectar entidades**).
- `GET /api/appliances/map` y `PUT /api/appliances/positions` desaparecen. Hay dos endpoints nuevos:
  - `GET /api/appliances/types`: lectura, también desde ingress.
  - `GET /api/ha/device_entities?entity_id=…`: solo administradores; lee el registro de entidades y dispositivos de Home Assistant para la detección fuera de Home Assistant. Dentro de Home Assistant se usa `hass.entities`/`hass.devices`.

### Fixed
- El panel de un electrodoméstico podía mostrar «No disponible» si los estados llegaban antes que la planta.

## 3.7.0

### Added
- **Electrodomésticos en el plano de Dispositivos:** nevera, lavavajillas y la aspiradora-fregadora Roborock, cada uno con su icono en su sitio de la planta baja y una etiqueta con lo más importante:
  - nevera: temperatura del frigorífico y del congelador;
  - lavavajillas: estado y tiempo restante;
  - Roborock: batería y estado.
  - El icono se rellena mientras el aparato funciona. Se marca en rojo si hay una alarma: puerta de la nevera o del congelador abierta, lavavajillas que requiere acción o error, o error de la aspiradora o de la base.
- **Al pulsar el icono se abren las acciones principales del aparato:**
  - **Roborock:**
    - botones Iniciar, Pausar, Volver a la base y Localizar; cada uno se activa solo cuando tiene sentido;
    - estado, detalle, batería, habitación actual, progreso, error y estado de la base;
    - modo de limpieza (aspirar / aspirar y fregar / fregar) y potencia de aspiración.
  - **Lavavajillas:**
    - estado, programa en curso, progreso, tiempo restante (con la hora de fin), puerta e inicio remoto;
    - encendido, programa y las opciones media carga, extra seco e higiene;
    - **Iniciar** arranca el programa elegido (`select.cocina_lavavajillas_programa_activo`) y necesita el inicio remoto activado en el aparato. **Detener** pulsa `button.cocina_lavavajillas_detener_programa`. Los dos piden confirmación.
    - Home Assistant no expone «pausar» para este lavavajillas, así que no hay botón de pausa.
  - **Nevera:**
    - temperatura del frigorífico y del congelador, con su consigna (− / + dentro del mínimo y máximo de la entidad);
    - Power cool (super frío), Power freeze (super congelación) y cubitos de hielo;
    - puertas y potencia.
- **Cómo se llama a Home Assistant:** las acciones usan servicios reales, igual que los demás controles: dentro de Home Assistant con `hass.callService` como el usuario; fuera, con el proxy de servicios del add-on.
  - El proxy permite ahora `vacuum.locate` y `vacuum.set_fan_speed`.
  - `number.set_value` y `select.select_option` se permiten solo para las entidades de los aparatos de `appliances_map.json`. El resto de `number`/`select`, como el límite de potencia del cargador, sigue bloqueado.
  - Ninguna acción se lanza sola: solo al pulsar.
- **Posición de los aparatos:**
  - Nevera y lavavajillas están en la cocina (área «Cocina» de Home Assistant); el punto exacto dentro de la cocina es aproximado.
  - La Roborock y su base no tienen área en Home Assistant. La base se coloca en el recibidor, junto a la entrada, porque el robot informa «Recibidor» como habitación actual mientras carga.
  - En el modo edición de Dispositivos cada aparato se puede arrastrar. La posición se guarda al soltar, en `appliance_positions` de la configuración del add-on, mediante `PUT /api/appliances/positions`, que es solo para administradores.
  - Las copias de seguridad incluyen `appliance_positions`.
- Entidades y textos en `hadomotics/appliances_map.json`; `GET /api/appliances/map` es de solo lectura (cualquier usuario de ingress).

## 3.5.2

### Fixed
- **Seguridad: al cambiar a Planta 1 a veces no aparecía su plano**, o salía tarde.
  - Si la respuesta o la imagen de la planta anterior llegaba después de la nueva, dejaba en pantalla el plano equivocado: por ejemplo, Planta 1 marcada y con sus sensores, pero con el dibujo de la planta baja. Pasaba sobre todo al entrar en Seguridad, mientras aún cargaba la planta baja, o al cambiar de planta rápido.
  - Ahora cada cambio de planta tiene su número, y lo que llega de un cambio anterior se descarta.
  - Mientras carga el plano nuevo se muestra «Cargando plano…» en vez del plano anterior.
- **Dispositivos:** volver a la planta anterior mientras la otra aún cargaba no hacía nada y acababa apareciendo la otra. Ahora cuenta siempre la última planta pulsada, y una respuesta antigua no la pisa.
- **Imágenes de los planos:** ya no llevan `?t=<hora>`. El nombre del fichero ya es único por imagen subida, así que el navegador puede reutilizarla en vez de descargarla entera en cada cambio de planta, que era parte del retraso.

## 3.5.1

### Added
- **Mover elementos en Seguridad.** En el dock flotante de Seguridad hay un botón lápiz junto al selector de planta, en el mismo sitio y con el mismo estilo que en Dispositivos. Al pulsarlo entras en modo edición:
  - Los sensores de movimiento y las cámaras se pueden arrastrar en cada planta, con ratón o con el dedo.
  - Cada posición se guarda al soltar. Para salir, pulsa ✓.
  - Las posiciones se guardan en la configuración del add-on (`security_positions`, en fracciones de la imagen) mediante `PUT /api/security/positions`, que es solo para administradores. A un usuario que no es administrador se le avisa y el marcador vuelve a su sitio.
  - Las posiciones de siempre (`security_map.json`) son el valor por defecto mientras no muevas nada.
- **Elementos fuera del plano, en Dispositivos y en Seguridad.** En modo edición puedes soltar un elemento en el fondo, fuera del dibujo; por ejemplo, los botones de escena Día y Noche.
  - En modo edición, una línea discontinua marca el borde del dibujo y alrededor queda un margen de fondo donde soltar.
  - El elemento se queda fuera, en la zona aproximada donde lo colocaste, con cualquier tamaño de pantalla. Si no cabe, el plano se reduce como mucho al 85 %; en pantallas pequeñas, el elemento se acerca lo justo para no salirse de la pantalla.
  - El recorte de bordes blancos y la recolocación de 3.5.0 ya no devuelven al plano los elementos que has colocado tú. Solo se aplican a los elementos antiguos, que no tienen el campo `outside`.

- **Zonas que se pueden activar y desactivar.** En Seguridad, cada fila del desplegable «Zonas» es un interruptor de su `input_boolean.notificacion_alarma_*`, igual que la tarjeta «Zonas Activas» de Lovelace.
  - El cambio se ve al momento. Si Home Assistant o el add-on lo rechazan, el interruptor vuelve a su estado y aparece un aviso.
  - Dentro de Home Assistant se llama a `input_boolean.turn_on` / `turn_off` como tu usuario (`hass.callService`), como con la alarma.
  - Fuera de Home Assistant se usa `POST /api/security/control`, solo para administradores. Acepta únicamente las 12 zonas del panel.
- **Botón «Sirena»**, discreto, junto a «Zonas» y «Detecciones», con el mismo estilo. Solo se abre uno de los tres a la vez. El desplegable tiene:
  - el interruptor «Sirena con la alarma» (`input_boolean.alarma_sirena`);
  - el tono y el nivel predeterminados de la Heiman: `select.heiman_warningdevice_ef_3_0_tono_de_sirena_predeterminado` y `select.heiman_warningdevice_ef_3_0_nivel_de_sirena_predeterminado`, con las opciones de cada entidad;
  - «Probar sirena», que hace lo mismo que el interruptor de la sirena en Lovelace: `siren.turn_on` sobre `siren.heiman_warningdevice_ef_3_0`, solo con `entity_id`, es decir, con el tono y el nivel predeterminados. Antes pide confirmación («Sonará la sirena real») y nunca suena sola. Mientras suena, el mismo botón pasa a «Parar sirena» (`siren.turn_off`).
  - En Lovelace, la pestaña «Sirena» solo la ven dos usuarios. Aquí el botón solo se muestra a administradores: dentro de HA, `hass.user.is_admin`; fuera, `user.admin` de `GET /api/security/map`. Además, el add-on solo acepta estas órdenes de administradores.
- **Lista blanca exacta en el servidor**, fija en el código:
  - las 12 zonas y `input_boolean.alarma_sirena`, con `input_boolean.turn_on` y `turn_off`;
  - los dos `select`, con `select.select_option`, y solo con una opción que la entidad anuncie;
  - la sirena, con `siren.turn_on` (solo con `"confirm": true`) y `siren.turn_off`.
  Cualquier otra entidad o servicio devuelve 400 y no llega a Home Assistant. Un usuario de ingress que no es administrador recibe 403, y una petición desde la red local, 401.

### Changed
- En Dispositivos, el modo edición muestra el plano recortado igual que el modo vista, para que lo que colocas sea lo que ves.
- Cada elemento de Dispositivos guarda un campo nuevo, `outside` (`true` o `false`), al soltarlo tras moverlo. Las coordenadas siguen en píxeles de la imagen y pueden ser negativas o pasar del borde. Pulsar un elemento sin moverlo no cambia nada de lo guardado.
- La copia de seguridad y la restauración incluyen `security_positions`.
- Las configuraciones guardadas siguen funcionando igual.

## 3.5.0

### Added
- **Tercera sub-app: Seguridad.** Abajo, los botones quedan en este orden: **Seguridad**, **Dispositivos**, **Energía**. Seguridad usa los mismos planos que Dispositivos y deja todo el espacio al plano:
  - Arriba, centrada sobre el plano, la tarjeta **Panel de Alarma** (`alarm_control_panel.alarmo`) con su estado y los modos que Alarmo anuncia en `supported_features` y que coinciden con el panel: Desarmar, Noche y Ausente.
    - Cada modo pide confirmación.
    - El código se pide solo si `code_format` lo exige (para armar, además, `code_arm_required`). Nunca se guarda y se borra al cerrar el diálogo.
    - Si Alarmo informa de sensores abiertos, la tarjeta indica cuántos hay.
  - A la derecha de la tarjeta, un botón discreto **Zonas** muestra superpuestas las 12 zonas (`input_boolean.notificacion_alarma_*`). Se cierra con la X, con Esc, pulsando fuera o pulsando otra vez el botón.
  - El selector de planta va en el mismo dock flotante que en Dispositivos.
  - **Detección dinámica en el plano.** Cada sensor de movimiento y cada cámara con detección de personas se dibuja en su habitación, rotulado solo con su nombre (por ejemplo «Cocina / comedor»).
    - El estado se ve por el color del icono: rojo `#ef4444` cuando hay detección (con un pulso suave), verde `#22c55e` cuando no la hay y gris apagado `#64748b` cuando no está disponible.
    - El estado completo y la hora del último cambio están en `aria-label` y en `title`.
  - Junto a «Zonas», un botón discreto **Detecciones** con el número de detecciones activas despliega la lista de sensores y cámaras: nombre, estado con su color y último cambio en hora de Madrid. Primero aparece la planta que estás viendo.
    - Se cierra con la X, con Esc, pulsando fuera o pulsando otra vez el botón.
    - «Zonas» y «Detecciones» nunca se abren a la vez: al abrir uno se cierra el otro.
- Dentro de Home Assistant, las llamadas a la alarma se hacen como tu usuario (`hass.callService`). Fuera, van a `POST /api/security/alarm`, que es solo para administradores y solo admite la entidad de alarma mapeada y los modos que anuncia. La lectura (`/api/security/map`, `/api/security/state`, `/api/plan/overlays`) también está abierta a usuarios de ingress que no son administradores.
- **Tesla Model Y Juniper (2025) gris en el garaje de Dispositivos.** Es una imagen realista vista desde arriba, con fondo transparente, sombra suave y la misma luz que el plano (`static/plans/tesla_model_y.webp`). Forma parte del dibujo: no se puede pulsar.
- **Cable del cargador Deye al puerto de carga** (trasera izquierda del coche), solo en Dispositivos.
  - Con carga real, un flujo verde animado va del cargador al coche. Hay carga real cuando `sensor.evse_charging_power` supera 100 W (si viene en kW, se convierte) o cuando `sensor.evse_charging_operational_state` es `Charging`.
  - En reposo, el cable está gris y quieto.
  - Con «reducir movimiento» no se anima.
  - El límite `number.evse_charging_power_limit` no se usa.

### Changed
- **Planos sin bordes blancos.** En modo vista, Dispositivos y Seguridad recortan los márgenes blancos de la planta baja y de la planta 1, y el dibujo ocupa más pantalla.
  - El recorte se hace en pantalla (`clip-path` y ajuste de escala). Las imágenes no se tocan y los elementos conservan sus coordenadas guardadas, así que cada icono sigue en su sitio del dibujo.
  - El recorte se define en fracciones de la imagen (`plan_overlays.json` → `crop`). Solo se aplica si la imagen es la de referencia (1425×736 y 1315×652, también cuando se muestra la versión HD). Si subes otra imagen, se ve entera.
  - Los elementos que quedaban en el margen blanco se muestran en el punto más cercano dentro del dibujo; no se guarda nada. Depuradora, Día y Noche tienen una posición fija junto a su esquina. En modo edición se ve la imagen completa con las posiciones reales.
- **Los botones y elementos personalizados muestran su nombre en modo vista**, con su estado ON/OFF si la entidad lo tiene (por ejemplo «Depuradora · OFF», «Día», «Noche»). Hasta ahora, en modo vista solo se veía el icono. Las etiquetas siguen siendo legibles aunque el plano se reduzca.
- **Planta baja y planta 1 más nítidas.** Si el plano es la imagen original, se muestra una versión reescalada ×2 y limpiada (`static/plans/planta_baja_hd.webp`, `static/plans/planta1_hd.webp`) con la misma proporción exacta. Los elementos conservan sus coordenadas. Si subes otra imagen, se usa la tuya.

## 3.4.2

### Fixed
- **Los planos (planta baja y planta 1) caben en la ventana.** El ajuste solo se calculaba 50 ms después de pedir la imagen; como la imagen se descarga siempre de nuevo, con una red lenta (navegador del coche, móvil) aún no había cargado y el plano se quedaba a tamaño original, recortado. Ahora se ajusta al cargar la imagen y cada vez que cambia el área visible (giro de pantalla, `visualViewport`, cabecera que se oculta en modo vista).
- El plano entero se ve con su proporción («contain»), centrado en el área libre que deja el selector de plantas, y también se amplía en pantallas grandes. Los elementos siguen en sus coordenadas de la imagen original y se escalan con ella, así que quedan alineados.
- El alto de la página usa `100dvh` para no quedar tapado por la barra del navegador en móvil o coche.
- En modo edición, arrastrar, redimensionar y colocar elementos convierte el movimiento a píxeles de la imagen original, así que con el plano reducido las posiciones guardadas siguen siendo correctas.

### Changed
- **Energía arranca en modo real.** Los controles se envían a Home Assistant como tu usuario salvo que actives «Modo prueba (dry-run)» en ⚙ Ajustes y pulses Guardar. La elección se guarda en una clave nueva, `localStorage` `hadomotics.energy.testmode` (`1` = prueba).
- La clave antigua `hadomotics.energy.dryrun` ya no se respeta y se borra al abrir el panel: valía `1` también si solo se había pulsado Guardar con el valor por defecto, así que no indica una elección. Si tenías el modo prueba, verás un aviso una vez; vuelve a marcarlo en ⚙ Ajustes si lo quieres.
- El aviso amarillo de modo prueba empieza oculto y solo aparece con el modo prueba activado.

## 3.4.1

### Fixed
- **Energía ya no revierte un control.** Dentro de Home Assistant el panel leía el objeto `hass` una sola vez. El sondeo cada 4 s reenviaba esos estados viejos y tapaba el `state_changed`, así que el calendario seguía marcando «fuera» aunque Home Assistant ya hubiera pasado a «casa». Cada sondeo vuelve a leer el `hass` actual, un estado más antiguo no pisa uno más nuevo y, tras un control enviado, el panel aplica el valor y refresca enseguida.
- **Registro de llamadas en hora de Madrid.** La hora visible del registro usa `Europe/Madrid` (en el ejemplo, 15:17 y no 14:17 UTC).
- **Hoy y mañana del calendario semanal** se calculan en `Europe/Madrid`, igual que el resto de Energía, y no con la zona horaria del dispositivo.
- Si la suscripción `state_changed` falla, el error queda en la consola. El sondeo del frontend sigue.

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
