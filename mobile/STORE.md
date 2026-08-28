# Publicar HADomotics (Android / iOS)

## Android — instalador firmado (listo)

El APK firmado `HADomotics-1.0.1.apk` se instala en cualquier tablet Android (permitir apps desconocidas). Eso es el instalador para vecinos.

Para **Play Store** (tú, 15–20 min):

1. Cuenta de desarrollador: https://play.google.com/console (25 USD, un solo pago).
2. Crear app → nombre HADomotics → categoría Casa / Estilo de vida.
3. Subir el **AAB** (`HADomotics-1.0.1.aab`) en Pruebas internas o Producción.
4. Completar ficha, política de privacidad (URL) y clasificación de contenido.
5. **Guarda el keystore** (`hadomotics-release.jks` + archivo de contraseñas). Sin eso Google no aceptará actualizaciones.

Este entorno no puede iniciar sesión en tu Play Console.

## iOS — no se puede publicar desde aquí

Apple exige:

- Mac con Xcode
- Cuenta [Apple Developer](https://developer.apple.com/programs/) (99 USD/año)
- Certificados + App Store Connect / TestFlight

Linux no puede firmar una IPA que un iPhone acepte. El proyecto Xcode ya está en `mobile/ios/`.

En un Mac:

```bash
git checkout pilot/tuya-mobile
cd mobile
npm install
npx cap sync ios
npx cap open ios
```

En Xcode: Team = tu Apple ID → Product → Archive → Distribute App → App Store Connect / TestFlight.

Hasta tener eso, un vecino con iPhone **no puede instalar** esta app nativa (Apple no permite IPA a pelo como Android).
