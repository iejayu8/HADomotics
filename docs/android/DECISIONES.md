# Decisiones tomadas sin consultar (noche del 16 al 17/11/2026)

Encargo: «genera una versión equivalente para Android de la versión final… que una persona que
no tenga Home Assistant pueda instalar sensores Tuya y Zigbee y tener la misma funcionalidad
únicamente con la app Android». Donde había dudas se propuso e implementó lo siguiente.
Todo es reversible; cada punto indica la alternativa descartada.

## Arquitectura

1. **Capacitor 6 + la interfaz del add-on sin tocar.** La app es una WebView (Capacitor) que
   carga `hadomotics/static` copiado tal cual en la compilación (`scripts/build-web.mjs`).
   *Por qué:* misma experiencia y un solo código de interfaz que mantener; cada mejora del
   add-on llega a Android recompilando. *Descartado:* reescribir en Kotlin/Compose (meses) o
   Flutter/React Native.
2. **Capa de abstracción de backend por interceptación** (`src/backend/shim.js`): se
   interceptan `fetch('/api/…')`, `EventSource('/api/ha/stream')` y las imágenes
   `/api/images/…` y se resuelven con una API dentro del móvil (`src/backend/api.js`) que
   imita las rutas del add-on. Hay dos «adaptadores»: el add-on (HA, servidor Python, sin
   cambios) y el **Hub Tuya directo** (`src/backend/hub.js`). *Por qué:* el add-on no necesita
   ningún cambio (cero riesgo para la 3.5.1 en producción). *Descartado:* refactorizar
   `static/*.js` para inyectar un cliente: más limpio a largo plazo, pero tocaba el add-on.
3. **Modelo de entidades estilo Home Assistant** (`light.x`, `binary_sensor.x`,
   `alarm_control_panel.hadomotics`, `input_boolean.hd_zona_*`) generado desde los
   dispositivos Tuya (`src/tuya/mapper.js`), con ids estables guardados en el móvil. *Por qué:*
   la interfaz y las copias del add-on ya hablan ese idioma, y así una copia exportada se
   puede llevar al add-on y viceversa (planos, elementos, posiciones).
4. **Sin cambios en `hadomotics/`** ni en la versión 3.5.1 ni en los workflows. La app vive en
   `android-app/` y la documentación en `docs/android/`.

## Tuya

5. **Tuya Cloud OpenAPI con las claves del propio usuario** (proyecto Cloud gratuito,
   vinculando su cuenta Smart Life por QR). *Por qué:* es la vía oficial, cubre WiFi y Zigbee
   (vía pasarela Tuya), sin servidor intermedio nuestro. *Descartado:* el SDK «Device Sharing»
   que usa la integración oficial de HA (sin proyecto, solo QR): necesita las credenciales de
   aplicación de otro (Home Assistant), no podemos usarlas. *Descartado:* servidor propio que
   guarde las claves de todos (privacidad, coste).
6. **Claves en el Android Keystore** (AES-256-GCM, alias `hadomotics_secrets_v1`): el plugin
   nativo solo admite `tuya_access_id` y `tuya_access_secret`, no registra valores, no se
   devuelven a la interfaz salvo para firmar, no van en copias. En navegador (demo) se
   quedan solo en memoria.
7. **Firma HMAC-SHA256 implementada dos veces** (JS para la app, Java para el servicio) y
   comprobada con los **vectores oficiales** de la documentación de Tuya.
8. **Sondeo adaptado a la cuota** (Trial ≈ 26.000 llamadas/mes): intervalo calculado para gastar
   como máximo el 80 % de la cuota configurada (24.000 por defecto), mínimo 60 s; el sondeo se
   pausa con la app oculta.
9. **Servicio de mensajes (Pulsar por WebSocket) como opción, desactivado por defecto.** El
   navegador no puede poner cabeceras en un WebSocket, así que va en el servicio nativo (OkHttp).
   Protocolo tomado del SDK oficial `tuya/tuya-pulsar-sdk-python` (contraseña
   `md5(id + md5(secret))[8:24]`, AES-ECB o AES-GCM con `secret[8:24]`) y de la API WebSocket
   estándar de Apache Pulsar (puerto 8285). **No probado contra el servicio real**; si no
   conecta, se vuelve al sondeo.
10. **Control local (LAN) para la fase 2.** Requiere sockets TCP nativos, las claves locales de
    cada dispositivo y los protocolos 3.3/3.4/3.5. Mucho trabajo y riesgo para v0.1.
11. **Zigbee que no es Tuya para la fase 2** (Zigbee2MQTT o dongle USB-OTG). Recomendación
    mientras tanto: emparejar los Zigbee genéricos a una pasarela Zigbee de Tuya.
12. **Escenas Tuya** (`/v1.1/homes/{home}/scenes`) como entidades `scene.*` (botones), que en
    la demo se colocan fuera del plano.

## Alarma

13. **Motor de alarma en la app** (`src/alarm/engine.js`) que replica `AUDITORIA_ALARMA_NODERED.md`
    y Alarmo: Noche = apagar todas las zonas y la sirena y encender las «Noche»; Ausente = todas;
    Desarmar = todas off y sirena off; la zona se comprueba en el momento de la detección; aviso
    «Detectada presencia en: <zona> - <sensor>»; sirena solo con «Sirena con la alarma»; avisos
    críticos como mucho 1/min por zona; tras el tiempo de disparo vuelve al modo armado;
    vigilancia de sensores sin conexión 5 min. Retardos: salida Noche 10 s / Ausente 30 s,
    entrada configurable por zona (0 por defecto, como el flujo auditado).
14. **La primera lectura de un sensor nunca dispara** (al arrancar la app, un PIR ya «activo» no
    es una intrusión).
15. **Código opcional guardado solo como hash PBKDF2-SHA256** con sal (100.000 iteraciones).
    El panel lo pide si existe (como el add-on).
16. **Doble motor: JS con la app visible, Java (`AlarmRule`) con la app en segundo plano.** El
    servicio solo memoriza valores mientras la app está visible (no decide), y la app recibe la
    cola de eventos al volver. *Descartado:* motor único en Java (habría que reescribir el
    motor y la interfaz dejaría de compartir la lógica probada).
17. **Servicio en primer plano tipo `specialUse`** (Android 14), con wake lock parcial solo
    durante cada ciclo, solo con la alarma armada y relanzado al reiniciar. *Descartado:*
    WorkManager (mínimo 15 min, inútil para una alarma).
18. **Limitaciones explicadas en la propia app** (Ajustes → Segundo plano) y en el README: un móvil
    no es una centralita 24/7.

## Datos, interfaz y seguridad

19. **Planos subidos por el usuario**, guardados en IndexedDB del móvil; la demo trae dos planos
    genéricos generados (`tools/make_demo_plans.py`), no los de la casa de Xavi.
20. **Copia de seguridad en el formato del add-on** (planos, elementos, posiciones de Seguridad)
    más un bloque `standalone` con ajustes sin claves ni código; se comparte con el selector de
    Android.
21. **Asistente de 5 pasos** la primera vez y **modo demo** con un servidor Tuya simulado que
    verifica las firmas igual que el real (16 dispositivos: luces, enchufes, persiana, garaje,
    3 PIR Zigbee, puerta, sirena, cargador, medidor, cámara). Etiqueta «DEMO» visible.
22. **Pestaña «Ajustes»** añadida a la barra inferior por la capa standalone (no por el add-on).
23. **Iconos Material empaquetados** (sin Google Fonts: funciona sin Internet y sin rastreo).
24. **Sin meta CSP** en el `index.html` empaquetado: podía bloquear el puente de Capacitor; el
    contenido es local y las llamadas a Tuya van por HTTP nativo (CapacitorHttp).
25. **Las llamadas a Tuya van por HTTP nativo** (CapacitorHttp) porque Tuya no permite CORS.
26. **Android 8.0+ (minSdk 26)**, target 34; `allowBackup=false`; FileProvider limitado a la
    carpeta de copias; el panel no permite servicios peligrosos (lista blanca como el add-on;
    probar la sirena pide confirmación).
27. **Firma**: APK de depuración y APK release firmado con una clave autogenerada **fuera del
    repositorio** (`HD_KEYSTORE_PROPS`). La clave no está en el repo, ni en logs, ni en ejemplos.
28. **Publicación**: rama `feat/android-standalone`, PR en borrador (sin fusionar) y pre-release
    `android-v0.1.0` marcada como *prerelease* (no «latest»). Es segura: `release.yml` solo se
    dispara con cambios de `hadomotics/config.yaml` en `main`, y `version-check.yml` sigue en
    3.5.1.

## Pruebas

- JS (`android-app`, `npm test`): 47 pruebas — vectores oficiales de firma, nube simulada
  (paginación, firma incorrecta, lotes de 20, órdenes, escenas, renovación de token, error
  1010), motor de alarma (15+), mapeo, paridad de Energía con `energy.py`, API completa con la demo.
- Java (`./gradlew testDebugUnitTest`): 17 pruebas — vectores oficiales de firma, cifrado del
  servicio de mensajes (fixtures generadas con Python), regla de alarma en segundo plano.
- Add-on sin cambios: 135 pruebas pytest + 32 node, en verde.
- **Nada probado contra dispositivos ni cuentas Tuya reales.**
