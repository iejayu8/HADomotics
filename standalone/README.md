# HADomotics Standalone (piloto Tuya)

Control de planos y dispositivos **Tuya / Smart Life** en tablet o móvil **sin Home Assistant**.

Rama de prueba: `pilot/tuya-standalone`. No mergear a `main` hasta validar.

## Cómo se instala en el móvil (piloto)

No hay IPA/APK de tienda: Apple no deja instalar un `.ipa` desde GitHub, y un APK no firmado de Play es frágil. El piloto es una **PWA** (app instalable) servida por un mini servidor en tu red.

1. En el PC (el mismo donde ya pruebas HADomotics):

```bash
cd standalone
python3 -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python server.py
```

Abre `http://127.0.0.1:8099` en el PC. Deberías ver el plano en **modo demo**.

2. Tablet/móvil en la **misma Wi‑Fi**:

`http://<IP-de-tu-PC>:8099`

| Plataforma | Instalación |
|---|---|
| **Android** | Chrome → `http://IP:8099/install/android.html` → Instalar aplicación |
| **iPhone / iPad** | **Safari** → `http://IP:8099/install/ios.html` → Compartir → Añadir a pantalla de inicio |

## Tuya (dispositivos reales)

Por defecto arranca en **demo** (interruptor, luz, persiana, clima).

Para tu casa:

1. [iot.tuya.com](https://iot.tuya.com) → Cloud → proyecto **Smart Home**.
2. Data Center **Central Europe** (o el de tu app Smart Life).
3. Vincula la cuenta de la app Tuya/Smart Life (*Link Tuya App Account*).
4. Access ID + Access Secret del proyecto.
5. En la app: Edit Mode → **Conectar Tuya** → pega claves → región `eu` → Guardar.
6. **Sincronizar dispositivos** y asocia cada elemento del plano a `tuya.<deviceId>.<codigo>`.

Códigos típicos Tuya:

- interruptores/luces: `switch_1`, `switch_led`
- persianas: `percent_control` (0 cerrado … 100 abierto)
- clima: `temp_current`, `temp_set`

### LAN vs Cloud

- **Misma Wi‑Fi** que los dispositivos y con `local_key`: comando local (más rápido).
- Si no hay LAN o falla: **Tuya Cloud**.
- Fuera de casa: Cloud.

## Docker

```bash
cd standalone
docker build -t hadomotics-standalone .
docker run --rm -p 8099:8099 -v hadomotics-data:/app/data hadomotics-standalone
```

## Negocio (siguientes pasos, no en este piloto)

Backend multi-inquilino + Tuya OAuth por vecino, hosting, y más adelante Play Store / App Store. Este piloto valida el producto sin HA.

## Datos

Config y planos: `standalone/data/` (no se sube a Git). Export/Import igual que el addon.
