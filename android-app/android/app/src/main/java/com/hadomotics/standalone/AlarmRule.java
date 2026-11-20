package com.hadomotics.standalone;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Regla mínima de disparo para cuando la app está en segundo plano (la WebView puede
 * estar dormida). Es un espejo de AlarmEngine.onSensor/tick (src/alarm/engine.js):
 * armado (o fin del retardo de salida) + zona activa + sensor pasa a «on" ->
 * retardo de entrada o disparo; sirena si está habilitada; aviso crítico como mucho
 * uno por zona y minuto; fin del disparo -> sirena off y vuelta al modo armado.
 * Sin dependencias de Android: se prueba con JUnit.
 */
public class AlarmRule {
    public static class Zone { public String id, name; public boolean on; public int entryDelay; }
    public static class Sensor { public String entityId, deviceId, code, zone, label, category; }
    public static class Action {
        public final String type; public final String zone, label; public final boolean on;
        Action(String type, String zone, String label, boolean on) { this.type = type; this.zone = zone; this.label = label; this.on = on; }
        public String toString() { return type + (type.equals("siren") ? (on ? ":on" : ":off") : "") + (zone != null ? "@" + zone : ""); }
    }

    public String state = "disarmed";
    public String target;          // modo al que se arma (durante «arming")
    public String armedMode;
    public long until;             // fin de retardo o del disparo (ms)
    public boolean sirenEnabled = true;
    public boolean sirenConfigured;
    public int triggerTime = 180;
    public final Map<String, Zone> zones = new HashMap<>();
    public final Map<String, Sensor> sensors = new HashMap<>(); // "device:code" -> sensor
    private final Map<String, String> last = new HashMap<>();
    private final Map<String, Long> lastNotify = new HashMap<>();
    public Sensor lastTrigger;

    public static boolean isOn(String category, String code, String value) {
        if (value == null) return false;
        String v = value.toLowerCase();
        if ("presence_state".equals(code)) return v.equals("presence") || v.equals("peaceful") || v.equals("small_move") || v.equals("large_move");
        return v.equals("pir") || v.equals("presence") || v.equals("true") || v.equals("on") || v.equals("alarm") || v.equals("open") || v.equals("1");
    }

    private boolean armedNow(long now) {
        if ("arming".equals(state) && until > 0 && now >= until) {
            state = target != null ? target : "armed_away";
            armedMode = state;
            until = 0;
        }
        return state.startsWith("armed_");
    }

    /** Solo memoriza el valor (la app visible es quien decide). */
    public void remember(String deviceId, String code, String value) { last.put(deviceId + ":" + code, value); }

    public List<Action> onStatus(String deviceId, String code, String value, long now) {
        List<Action> out = new ArrayList<>();
        String key = deviceId + ":" + code;
        Sensor s = sensors.get(key);
        String prev = last.put(key, value);
        if (s == null) return out;
        boolean on = isOn(s.category, code, value);
        boolean wasOn = prev != null && isOn(s.category, code, prev);
        if (prev == null || !on || wasOn) return out;
        boolean armed = armedNow(now);
        if (!(armed || "pending".equals(state) || "triggered".equals(state))) return out;
        Zone z = zones.get(s.zone);
        if (z == null || !z.on) return out;
        lastTrigger = s;
        if (armed && z.entryDelay > 0) {
            state = "pending";
            until = now + z.entryDelay * 1000L;
            out.add(new Action("pending", z.id, s.label, false));
            return out;
        }
        if ("pending".equals(state)) return out;
        trigger(z, s.label, now, out);
        return out;
    }

    private void trigger(Zone z, String label, long now, List<Action> out) {
        if (!"triggered".equals(state)) {
            state = "triggered";
            until = now + Math.max(1, triggerTime) * 1000L;
            if (sirenEnabled && sirenConfigured) out.add(new Action("siren", z.id, label, true));
            out.add(new Action("triggered", z.id, label, true));
        }
        Long ln = lastNotify.get(z.id);
        if (ln == null || now - ln >= 60000) {
            lastNotify.put(z.id, now);
            out.add(new Action("notify", z.id, label, true));
        }
    }

    public List<Action> tick(long now) {
        List<Action> out = new ArrayList<>();
        armedNow(now);
        if ("pending".equals(state) && until > 0 && now >= until && lastTrigger != null) {
            Zone z = zones.get(lastTrigger.zone);
            if (z != null) trigger(z, lastTrigger.label, now, out);
        } else if ("triggered".equals(state) && until > 0 && now >= until) {
            if (sirenConfigured) out.add(new Action("siren", null, null, false));
            state = armedMode != null ? armedMode : "armed_away";
            until = 0;
            out.add(new Action("rearmed", null, null, false));
        }
        return out;
    }

    public boolean watching() {
        return state.startsWith("armed_") || "arming".equals(state) || "pending".equals(state) || "triggered".equals(state);
    }
}
