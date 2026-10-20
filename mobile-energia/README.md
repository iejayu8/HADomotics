# HADomotics Energía — app móvil (Android / iOS, Capacitor)

Cliente fino de Home Assistant con las pantallas **Coche/Carga**, **Solar/Inversor** y **Batería**.
Es el mismo panel que el add-on sirve en `/energia` (ingress), empaquetado como app.

- Datos: en vivo desde HA (`subscribe_entities` por websocket): ABRP (`sensor.batmovil_*`), Helios
  (`sensor.helios_forecast_*`), decisión/motivo (`sensor.carga_decision_*`), cargador Deye
  (`sensor.evse_*`, `number.evse_charging_power_limit`), inversor/batería Deye-Solarman (`sensor.inverter_*`).
- Nada sincronizado se guarda ni se calcula en la app. Solo se guardan en el dispositivo la URL de HA,
  el token (credencial) y la preferencia de modo prueba.
- Editables solo los controles deliberados de `hadomotics/energy_map.json` (helpers `input_boolean` /
  `input_number` / `input_select` de la carga, y `automation.turn_on` / `turn_off` solo de
  `automation.carga_coche_dinamica_por_excedente`, `automation.carga_coche_programa_nocturno`
  y `automation.carga_coche_toda_la_noche`). Cargador e inversor: solo lectura.
- **Modo prueba (dry-run) activado por defecto.** La casilla está en ⚙ Ajustes. Se apaga
  desmarcándola y pulsando Guardar y conectar. La preferencia queda en el dispositivo
  (`localStorage` `hadomotics.energy.dryrun` = `0`; cualquier otro valor, o si no existe, lo deja activado).

## Construir (debug)

```bash
cd mobile-energia
npm install
npm run www            # copia hadomotics/static/energia -> www
npx cap add android    # solo la primera vez
npx cap sync android
cd android && ./gradlew assembleDebug   # app/build/outputs/apk/debug/app-debug.apk
```

La firma de release (Play Store) usa el keystore del usuario y NO está en el repositorio.
