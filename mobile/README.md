# HADomotics Mobile (Android / iOS)

App de planos + Tuya **en la tablet**, sin PC y sin Home Assistant.

La UI es la misma del piloto standalone. El backend Flask se sustituye por:

- **Tuya Cloud** desde la propia app (HMAC, sin CORS en nativo)
- **Plano e imágenes** guardados en la tablet (IndexedDB)

Rama: `pilot/tuya-mobile`.

## Qué puede hacer tu amigo

Instala el APK (Android) o la app (iOS), abre **Conectar Tuya** con **sus** claves Cloud, sube su plano. No necesita dejar un ordenador encendido.

## Android (generar APK para enviárselo)

En tu PC, una vez:

1. Instala [Android Studio](https://developer.android.com/studio).
2. En esta carpeta:

```bash
cd mobile
npm install
npx cap add android
npx cap sync android
npx cap open android
```

3. En Android Studio: **Build → Build Bundle(s) / APK(s) → Build APK(s)**.
4. El APK queda en `android/app/build/outputs/apk/debug/app-debug.apk`.
5. Pásaselo por Drive/WhatsApp. En la tablet: permitir “instalar apps desconocidas” y abrir el APK.

La tablet habla con Tuya Cloud por internet (Wi‑Fi o datos). No hace falta estar en la misma red que los módulos.

## iOS (iPhone / iPad)

Apple no deja instalar una IPA desde GitHub. Hace falta un Mac + cuenta Apple:

```bash
cd mobile
npm install
npx cap add ios
npx cap sync ios
npx cap open ios
```

En Xcode: firma con tu equipo y envía por **TestFlight** (gratis) o instala por cable en el iPad.

Hasta tener TestFlight, un amigo con iPhone puede usar **Safari → Añadir a pantalla de inicio** solo si más adelante publicas un servidor web; el piloto nativo de iOS es la app de Xcode.

## Probar el plano en el navegador (PC)

```bash
cd mobile/www
python -m http.server 8099
```

Abre `http://127.0.0.1:8099`. El **modo demo** funciona (planos, botones). Conectar Tuya real **falla en Chrome** (CORS); en la app nativa sí funciona.

## Primera configuración en la tablet

1. Edit Mode → **Conectar Tuya**
2. Access ID + Secret del proyecto Cloud de **esa** casa
3. Región `eu` o `eu-w`
4. Guardar → Sincronizar dispositivos
5. Subir plano y colocar elementos

Cada casa usa su propio proyecto Tuya. No compartas tus claves.
