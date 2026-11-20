# HADomotics para Android (sin Home Assistant) · v0.1.2 (vista previa)

App Android que da **la misma experiencia que el add-on HADomotics 3.5.1** —planos con
elementos, Seguridad con alarma y Energía— a quien **no tiene Home Assistant**: habla
directamente con la nube de **Tuya** (dispositivos WiFi y Zigbee a través de una pasarela
Zigbee de Tuya).

> ⚠️ **Estado: vista previa.** Todo está probado con un servidor Tuya simulado y datos de
> prueba (firmas con los vectores oficiales de Tuya, motor de alarma, persistencia, API).
> **No se ha probado contra una cuenta ni dispositivos Tuya reales.** El APK compila, está
> firmado y pasa las pruebas, pero la primera prueba real debe hacerse con calma
> (ver «Primera prueba con dispositivos reales»).

## Qué incluye

| Pantalla | Qué hace sin HA |
|---|---|
| **Dispositivos** | Los mismos planos y editor del add-on: plantas, imagen del plano (la sube el usuario), botones, luces, sensores, persianas, elementos fuera del plano, colores. Coche y cable de carga animado (cargador Tuya `qccdz`). Escenas Tuya como botones. |
| **Seguridad** | Panel de alarma Desarmar/Noche/Ausente con retardo de salida y de entrada, zonas (las «Noche» se activan en modo noche, todas en Ausente), detecciones en vivo sobre el plano, sirena Tuya (`sgbj`) con «Sirena con la alarma», código opcional, aviso por zona como mucho una vez por minuto, vigilancia de sensores sin conexión (5 min). Réplica de la lógica Node-RED/Alarmo auditada (`AUDITORIA_ALARMA_NODERED.md`). |
| **Energía** | Misma vista de flujo y consumo. Se eligen los sensores (red, solar, batería, consumo destacado…). Sin inversor, «Casa» = red + solar + batería. Controles (enchufes) en la propia vista. |
| **Ajustes** (nuevo) | Módulos, estado y cuota, claves Tuya, dispositivos, alarma, energía, cargador VE, segundo plano, copia de seguridad, ayuda. |

La interfaz es **exactamente la del add-on** (`hadomotics/static`, sin cambios): una capa
nueva intercepta las llamadas `/api/...` y las resuelve dentro del móvil (ver
[DECISIONES.md](DECISIONES.md)).

## Instalación

1. Descarga `HADomotics-android-0.1.2.apk` de la pre-release
   [`android-v0.1.2`](https://github.com/iejayu8/HADomotics/releases/tag/android-v0.1.2)
   (o compílalo, ver abajo).
2. En el móvil: abre el APK y permite «Instalar apps desconocidas» para el navegador o el gestor de archivos.
3. Android 8.0 o superior (minSdk 26). Probado en compilación con targetSdk 34.
4. Al abrir por primera vez aparece un asistente de 5 pasos. Puedes elegir **Probar modo demo**
   (casa simulada con 16 dispositivos, sin cuenta) o conectar tu cuenta Tuya.

El APK de la pre-release está firmado con una clave propia autogenerada (no es de Google
Play). Si más adelante se publica con otra clave, habrá que desinstalar antes de actualizar
(exporta antes una copia desde Ajustes → Copia).

## Configurar Tuya (una vez, ~10 minutos)

La app usa **tu propio proyecto** en la plataforma de desarrolladores de Tuya (gratuito).
Nadie más ve tus claves y la app no depende de ningún servidor nuestro.

1. Instala **Smart Life** (o Tuya Smart) y empareja ahí tus dispositivos: enchufes, luces,
   sensores PIR/puerta, sirena, cargador… Los Zigbee se emparejan a una **pasarela Zigbee de Tuya**.
2. Entra en <https://platform.tuya.com> y crea una cuenta.
3. **Cloud → Development → Create Cloud Project**:
   - Industry: *Smart Home*; Development Method: *Smart Home*.
   - **Data Center: el mismo de tu cuenta Smart Life** (en España, *Central Europe*).
   - Servicios API: deja los que vienen (*IoT Core*, *Authorization*, *Smart Home Scene Linkage*).
4. En el proyecto: **Devices → Link App Account → Add App Account** → aparece un QR.
   En Smart Life: *Yo → icono de escanear* y escanéalo. Tus dispositivos aparecen en el proyecto.
5. En **Overview** copia el **Access ID** y el **Access Secret** y pégalos en la app
   (asistente, o Ajustes → Tuya). Elige la región (Europa central = `eu`).
6. Pulsa **Buscar dispositivos**. La app crea las entidades. En Ajustes → Alarma, «Proponer zonas»
   crea una zona por cada sensor de movimiento/puerta (luego puedes agruparlas).
7. (Opcional) Para cambios **al instante** en segundo plano: en el proyecto, **Message Service →
   activar**, y en la app Ajustes → Segundo plano → «Recibir cambios al instante».

Las claves se guardan **cifradas con el Android Keystore** (AES-256-GCM, la clave no sale del
móvil). No se muestran nunca, no van en las copias de seguridad y Android no hace copia
automática de la app (`allowBackup=false`).

### Cuota gratuita
La edición *Trial* de IoT Core da unas **26.000 llamadas/mes** y ~68.000 mensajes/mes; al
pasarse, Tuya suspende el servicio hasta el mes siguiente. Tuya pide **renovar el Trial**
periódicamente desde la web (avisa por correo). La app:
- reparte el sondeo para usar como mucho el 80 % de la cuota configurada (Ajustes → Energía →
  Cuota) y deja el 20 % para órdenes; con 15 dispositivos sale un sondeo cada ~2 min;
- deja de sondear con la app en segundo plano (manda el servicio nativo, solo con la alarma
  armada y solo los sensores de la alarma: cada 180 s ≈ 14.400 llamadas/mes armada 24/7);
- muestra las llamadas del mes en Ajustes → Estado.

## Segundo plano y alarma con la app cerrada

Si activas Ajustes → Segundo plano, mientras la alarma está **armada** corre un *servicio en
primer plano* (notificación fija «HADomotics vigilando») que:
- recibe cambios por el servicio de mensajes de Tuya (si está activado) o sondea los sensores de la alarma;
- con la app en segundo plano decide él: retardo de entrada, sirena Tuya y aviso de Android
  «Detectada presencia en: zona – sensor»;
- deja los eventos en cola y la app los recoge al volver; arranca de nuevo tras reiniciar el móvil.

Pulsa también **Permitir notificaciones** y **Quitar optimización de batería**.

## Limitaciones (honestas)

- **Un móvil no es una centralita 24/7.** Android puede retrasar o matar el servicio (Doze,
  gestores de batería de OnePlus, Xiaomi, Samsung…). Para una alarma fiable: móvil o tablet
  dedicado, enchufado, sin optimización de batería. La nube de Tuya y la app Smart Life
  pueden seguir actuando como respaldo (automatizaciones de Tuya propias).
- **Sondeo ≠ eventos.** Sin el servicio de mensajes, un PIR que se activa y vuelve a reposo entre
  dos sondeos puede no verse. Los sensores de puerta (que se quedan «abierto») sí se ven.
- **La detección de personas de cámaras (`sp`)** solo llega como evento; por sondeo casi nunca se verá.
- **Servicio de mensajes (Pulsar) experimental**: implementado según el SDK oficial de Tuya
  (contraseña, cifrado AES-ECB/AES-GCM, confirmación), pero **sin probar contra el servicio
  real**. Si no conecta, la app vuelve sola al sondeo.
- **Energía**: la vista de flujo está pensada para un inversor (PV1–PV3, batería). Sin inversor
  esas cajas muestran «no disponible»; red, casa, consumo destacado y controles sí funcionan.
- **Sin control local (LAN)** en v0.1: todo pasa por la nube de Tuya (necesita Internet).
- **Zigbee que no es Tuya**: solo si se empareja a una pasarela Zigbee de Tuya (muchos
  genéricos lo admiten). Zigbee2MQTT o un dongle USB al móvil quedan para la fase 2.
- **Tipos de dispositivo**: interruptores/enchufes/regletas, luces (brillo), persianas, puertas
  de garaje, sensores binarios (PIR, presencia, puerta, humo, gas, agua, CO, SOS), sirena,
  cargador VE, medidor monofásico (`zndb`), termostato (solo lectura), cámara (evento de
  persona), sensores genéricos (potencia, energía, temperatura, humedad, batería). Otros
  aparecen en «Dispositivos» pero sin entidades.
- **Varios usuarios**: no hay cuentas en la app; cualquiera con el móvil desbloqueado puede
  desarmar si no se configura un código.
- **iOS**: no incluido.

## Primera prueba con dispositivos reales (recomendada)

1. Conecta Tuya y pulsa *Buscar dispositivos*. Comprueba en Ajustes → Dispositivos que salen todos.
2. Enciende/apaga un enchufe desde el plano y mira que Smart Life refleje el cambio.
3. Arma en **Noche** con una sola zona y la sirena **desactivada** («Sirena con la alarma» off);
   provoca una detección y comprueba el aviso. Luego prueba la sirena con el botón «Probar».
4. Bloquea el móvil 15 min con la alarma armada y vuelve a probar (segundo plano).
5. Si algo no cuadra, Ajustes → Estado muestra el último error (sin claves).

## Compilar

Requisitos: Node 20+, JDK 17, Android SDK 34.

```bash
cd android-app
npm ci
npm test                # 47 pruebas JS (firma, nube simulada, alarma, mapeo, energía, API)
npm run build:web       # copia hadomotics/static + capa standalone a www/
npx cap sync android
cd android
./gradlew testDebugUnitTest assembleDebug   # 17 pruebas JUnit + APK de depuración
```

APK firmado (release): crea un `keystore.properties` **fuera del repositorio** con
`storeFile`, `storePassword`, `keyAlias`, `keyPassword` y ejecuta
`HD_KEYSTORE_PROPS=/ruta/keystore.properties ./gradlew assembleRelease`. Nunca subas la clave.

Ver el código sin móvil: `npm run build:web` y sirve `www/` (p. ej. `python3 -m http.server`);
en el navegador solo funciona el modo demo (Tuya no admite CORS).

## Cambios

- **0.1.2** (20/11/2026): **módulos configurables**. El asistente de primer arranque
  pregunta qué usar (Dispositivos, Energía, Seguridad; nada marcado y al menos uno para
  seguir) y se cambia en Ajustes → Módulos. Un módulo desactivado no aparece (ni pestaña,
  ni botón, ni sus ajustes) ni trabaja en segundo plano: sin Seguridad no corre el motor de
  alarma ni el servicio de vigilancia; sin Energía no se calcula ni se sondea su flujo. Con
  un solo módulo, la barra inferior solo deja «Ajustes». Para desactivar Seguridad hay que
  desarmar antes. Quien venga de 0.1.1 sigue con los tres activos. El modo demo respeta la
  elección. Incluye el frontend del add-on 3.6.0 (PR #24).
- **0.1.1** (17/11/2026): en Dispositivos, modo edición, los elementos ya se arrastran y
  redimensionan con el dedo (tablets/móviles). Antes solo respondían al ratón. También se corrige
  que un segundo arrastre seguido del mismo elemento saltara a su posición anterior. Es una
  actualización directa sobre la 0.1.0 (misma firma).
- **0.1.0** (17/11/2026): primera vista previa.

## Hoja de ruta

- **0.2**: probar con cuentas reales y corregir mapeos; validar el servicio de mensajes;
  widget/atajo rápido para armar; avisos con sonido de alarma a pantalla completa.
- **0.3 (fase 2)**: control local LAN de Tuya (protocolos 3.3/3.4/3.5, claves locales desde la nube)
  para funcionar sin Internet y sin gastar cuota.
- **Fase 2 Zigbee**: Zigbee2MQTT (MQTT por WebSocket) o dongle USB-OTG.
- Climatización con control, más categorías, gráficos históricos de Energía guardados en el móvil,
  copia automática a un fichero, varios móviles sincronizados (uno como «centralita»).
