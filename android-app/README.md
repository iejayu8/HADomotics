# android-app — HADomotics para Android sin Home Assistant

Código de la app Android (Capacitor 6). Documentación completa en
[`docs/android/README.md`](../docs/android/README.md) y decisiones en
[`docs/android/DECISIONES.md`](../docs/android/DECISIONES.md).

```
src/core      registro de módulos y almacenes (memoria, IndexedDB, seguro)
src/tuya      firma, cliente Tuya Cloud, mapeo a entidades, casa demo y servidor simulado
src/alarm     motor de alarma (réplica de la lógica Node-RED/Alarmo)
src/energy    flujo de energía (port de hadomotics/energy.py)
src/backend   Hub (adaptador Tuya directo), API /api/* en el móvil y shim fetch/EventSource
src/ui        pestaña Ajustes y asistente
android/      proyecto Android: plugins nativos (Keystore, servicio de alarma, Pulsar)
```

```bash
npm ci && npm test && npm run build:web && npx cap sync android
cd android && ./gradlew testDebugUnitTest assembleDebug
```
