package com.hadomotics.standalone;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.PowerManager;
import android.util.Log;

import androidx.core.app.NotificationCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * Servicio en primer plano que vigila la alarma con la app cerrada o en segundo plano.
 *  - Fuente de cambios: Pulsar (si está activado) o sondeo de los sensores de alarma.
 *  - App visible: solo reenvía estados a la WebView (allí manda AlarmEngine).
 *  - App en segundo plano: evalúa AlarmRule, enciende la sirena Tuya y avisa.
 * Los eventos quedan en cola (SharedPreferences) y la app los recoge al volver.
 * Configuración: JSON sin secretos enviado por la app (Hub.syncNative); las claves se
 * leen del SecureStore en el momento.
 */
public class AlarmMonitorService extends Service implements PulsarClient.Listener {
    static final String TAG = "HDAlarm";
    static final String CH_SERVICE = "hd_service";
    static final String CH_ALARM = "hd_alarm";
    static final String PREFS = "hadomotics_service";
    static final int NOTIF_ID = 1;

    static volatile boolean appVisible;
    static volatile AlarmMonitorService instance;
    interface Sink { void status(String deviceId, JSONArray status, Boolean online); void alarm(JSONObject ev); }
    static volatile Sink sink;

    private HandlerThread thread;
    private Handler handler;
    private PowerManager.WakeLock wake;
    private TuyaHttp http;
    private PulsarClient pulsar;
    private final AlarmRule rule = new AlarmRule();
    private JSONObject cfg = new JSONObject();
    private String sirenDevice, sirenCode;
    private int pollSeconds = 180;
    private volatile boolean pulsarConnected;

    public static void start(Context ctx) {
        Intent i = new Intent(ctx, AlarmMonitorService.class);
        if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i); else ctx.startService(i);
    }

    public static void stop(Context ctx) { ctx.stopService(new Intent(ctx, AlarmMonitorService.class)); }

    static SharedPreferences prefs(Context ctx) { return ctx.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE); }

    static boolean wanted(JSONObject cfg) {
        JSONObject bg = cfg.optJSONObject("background");
        return "tuya".equals(cfg.optString("mode")) && bg != null && bg.optBoolean("enabled");
    }

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override public void onCreate() {
        super.onCreate();
        instance = this;
        channels(this);
        thread = new HandlerThread("hd-alarm");
        thread.start();
        handler = new Handler(thread.getLooper());
        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        wake = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "hadomotics:alarm");
        wake.setReferenceCounted(false);
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        Notification n = new NotificationCompat.Builder(this, CH_SERVICE)
                .setSmallIcon(android.R.drawable.ic_lock_idle_lock)
                .setContentTitle("HADomotics vigilando")
                .setContentText("Alarma y sensores Tuya en segundo plano")
                .setOngoing(true)
                .setContentIntent(openApp(this))
                .build();
        if (Build.VERSION.SDK_INT >= 34) startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        else startForeground(NOTIF_ID, n);
        handler.post(this::reload);
        return START_STICKY;
    }

    @Override public void onDestroy() {
        instance = null;
        if (pulsar != null) pulsar.stop();
        if (handler != null) handler.removeCallbacksAndMessages(null);
        if (thread != null) thread.quitSafely();
        if (wake != null && wake.isHeld()) wake.release();
        super.onDestroy();
    }

    /** Relee la configuración guardada (la app la cambia con configure()). */
    void reload() {
        try {
            cfg = new JSONObject(prefs(this).getString("config", "{}"));
        } catch (Exception e) { cfg = new JSONObject(); }
        if (!wanted(cfg)) { stopSelf(); return; }
        String id = SecureStore.get(this, "tuya_access_id");
        String secret = SecureStore.get(this, "tuya_access_secret");
        if (id == null || secret == null) { Log.w(TAG, "sin claves"); stopSelf(); return; }
        String region = cfg.optString("region", "eu");
        http = new TuyaHttp(id, secret, region);
        loadRule(rule, cfg);
        JSONObject siren = cfg.optJSONObject("siren");
        sirenDevice = siren != null ? siren.optString("device_id", null) : null;
        sirenCode = siren != null ? siren.optString("code", "alarm_switch") : null;
        rule.sirenConfigured = sirenDevice != null;
        JSONObject bg = cfg.optJSONObject("background");
        pollSeconds = Math.max(60, bg != null ? bg.optInt("poll_s", 180) : 180);
        boolean usePulsar = bg != null && bg.optBoolean("pulsar");
        if (pulsar != null) { pulsar.stop(); pulsar = null; }
        if (usePulsar) { pulsar = new PulsarClient(id, secret, region, this); pulsar.start(); }
        handler.removeCallbacksAndMessages(null);
        handler.post(this::loop);
    }

    static void loadRule(AlarmRule rule, JSONObject cfg) {
        JSONObject a = cfg.optJSONObject("alarm");
        if (a == null) a = new JSONObject();
        rule.state = a.optString("state", "disarmed");
        rule.target = a.isNull("target") ? null : a.optString("target", null);
        rule.armedMode = a.isNull("armed_mode") ? null : a.optString("armed_mode", null);
        rule.until = a.optLong("until", 0);
        rule.sirenEnabled = a.optBoolean("siren_enabled", true);
        rule.triggerTime = a.optInt("trigger_time", 180);
        rule.zones.clear();
        JSONArray zs = a.optJSONArray("zones");
        for (int i = 0; zs != null && i < zs.length(); i++) {
            JSONObject z = zs.optJSONObject(i);
            AlarmRule.Zone zz = new AlarmRule.Zone();
            zz.id = z.optString("id"); zz.name = z.optString("name", zz.id); zz.on = z.optBoolean("on"); zz.entryDelay = z.optInt("entry_delay", 0);
            rule.zones.put(zz.id, zz);
        }
        rule.sensors.clear();
        JSONArray ss = cfg.optJSONArray("sensors");
        for (int i = 0; ss != null && i < ss.length(); i++) {
            JSONObject s = ss.optJSONObject(i);
            AlarmRule.Sensor x = new AlarmRule.Sensor();
            x.entityId = s.optString("entity_id"); x.deviceId = s.optString("device_id"); x.code = s.optString("code");
            x.zone = s.optString("zone"); x.label = s.optString("label", x.entityId); x.category = s.optString("category");
            rule.sensors.put(x.deviceId + ":" + x.code, x);
        }
    }

    private void loop() {
        try {
            wake.acquire(60_000);
            handleActions(rule.tick(System.currentTimeMillis()));
            // Sin Pulsar (o caído): sondeo. Con la app visible sondea la propia app.
            boolean doPoll = (pulsar == null || !pulsarConnected) && !appVisible && rule.watching();
            if (doPoll) poll();
        } catch (Exception e) {
            Log.w(TAG, "ciclo: " + e.getClass().getSimpleName());
        } finally {
            if (wake.isHeld()) wake.release();
        }
        // Retardos/disparo en curso: revisar cada segundo; si no, al ritmo del sondeo.
        boolean busy = "arming".equals(rule.state) || "pending".equals(rule.state) || "triggered".equals(rule.state);
        handler.postDelayed(this::loop, busy ? 1000 : (pulsar != null && pulsarConnected ? 15000 : pollSeconds * 1000L));
    }

    private void poll() throws Exception {
        List<String> ids = new ArrayList<>();
        for (AlarmRule.Sensor s : rule.sensors.values()) if (!ids.contains(s.deviceId)) ids.add(s.deviceId);
        if (ids.isEmpty()) return;
        for (java.util.Map.Entry<String, JSONArray> e : http.statuses(ids).entrySet()) onStatus(e.getKey(), e.getValue());
    }

    @Override public void onStatus(String deviceId, JSONArray status) {
        handler.post(() -> {
            Sink s = sink;
            if (appVisible && s != null) { s.status(deviceId, status, null); }
            else queue(new JSONObjectSafe().put("type", "status").put("device_id", deviceId).put("status", status).o);
            if (appVisible) { // la app manda; solo memorizamos el último valor
                for (int i = 0; i < status.length(); i++) { JSONObject st = status.optJSONObject(i); if (st != null) rule.remember(deviceId, st.optString("code"), st.optString("value")); }
                return;
            }
            long now = System.currentTimeMillis();
            for (int i = 0; i < status.length(); i++) {
                JSONObject st = status.optJSONObject(i);
                if (st != null) handleActions(rule.onStatus(deviceId, st.optString("code"), st.optString("value"), now));
            }
        });
    }

    @Override public void onOnline(String deviceId, boolean online) {
        Sink s = sink;
        if (appVisible && s != null) s.status(deviceId, new JSONArray(), online);
        else queue(new JSONObjectSafe().put("type", "status").put("device_id", deviceId).put("status", new JSONArray()).put("online", online).o);
    }

    @Override public void onState(boolean connected, String info) { pulsarConnected = connected; Log.i(TAG, "pulsar " + (connected ? "conectado" : "desconectado") + " " + info); }

    private void handleActions(List<AlarmRule.Action> actions) {
        for (AlarmRule.Action a : actions) {
            switch (a.type) {
                case "siren":
                    if (sirenDevice != null) {
                        try { http.command(sirenDevice, sirenCode, a.on); } catch (Exception e) { Log.w(TAG, "sirena: " + e.getMessage()); }
                    }
                    break;
                case "notify": {
                    AlarmRule.Zone z = rule.zones.get(a.zone);
                    notifyUser(this, "¡Alarma!", "Detectada presencia en: " + (z != null ? z.name : a.zone) + " - " + a.label, true, "zone-" + a.zone);
                    break;
                }
                case "triggered": {
                    JSONObject ev = new JSONObjectSafe().put("type", "triggered").put("zone", a.zone).put("label", a.label)
                            .put("until", rule.until).put("siren", rule.sirenEnabled && rule.sirenConfigured)
                            .put("last_trigger", new JSONObjectSafe().put("zone", a.zone).put("sensor", a.label).put("at", System.currentTimeMillis()).o).o;
                    queue(ev);
                    Sink s = sink;
                    if (s != null) s.alarm(ev);
                    break;
                }
                default:
                    queue(new JSONObjectSafe().put("type", a.type).put("zone", a.zone).put("state", rule.state).o);
            }
        }
    }

    // ------------------------------------------------------------------ utilidades estáticas
    static synchronized void queue(Context ctx, JSONObject ev) {
        SharedPreferences p = prefs(ctx);
        try {
            JSONArray arr = new JSONArray(p.getString("events", "[]"));
            arr.put(ev);
            while (arr.length() > 200) arr.remove(0);
            p.edit().putString("events", arr.toString()).apply();
        } catch (Exception ignored) { }
    }

    private void queue(JSONObject ev) { queue(this, ev); }

    static synchronized JSONArray drain(Context ctx) {
        SharedPreferences p = prefs(ctx);
        JSONArray arr;
        try { arr = new JSONArray(p.getString("events", "[]")); } catch (Exception e) { arr = new JSONArray(); }
        p.edit().putString("events", "[]").apply();
        return arr;
    }

    static void channels(Context ctx) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        nm.createNotificationChannel(new NotificationChannel(CH_SERVICE, "Servicio en segundo plano", NotificationManager.IMPORTANCE_LOW));
        NotificationChannel alarm = new NotificationChannel(CH_ALARM, "Alarma y avisos", NotificationManager.IMPORTANCE_HIGH);
        alarm.enableVibration(true);
        alarm.setBypassDnd(true);
        nm.createNotificationChannel(alarm);
    }

    static PendingIntent openApp(Context ctx) {
        Intent i = new Intent(ctx, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(ctx, 0, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    static void notifyUser(Context ctx, String title, String body, boolean critical, String tag) {
        channels(ctx);
        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, CH_ALARM)
                .setSmallIcon(android.R.drawable.ic_dialog_alert)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                .setAutoCancel(true)
                .setContentIntent(openApp(ctx))
                .setPriority(critical ? NotificationCompat.PRIORITY_MAX : NotificationCompat.PRIORITY_DEFAULT)
                .setCategory(critical ? NotificationCompat.CATEGORY_ALARM : NotificationCompat.CATEGORY_STATUS);
        NotificationManager nm = (NotificationManager) ctx.getSystemService(NOTIFICATION_SERVICE);
        try { nm.notify(tag == null || tag.isEmpty() ? "hd" : tag, critical ? 2 : 3, b.build()); } catch (SecurityException ignored) { /* sin permiso */ }
    }

    /** JSONObject con put encadenable sin excepciones comprobadas. */
    static final class JSONObjectSafe {
        final JSONObject o = new JSONObject();
        JSONObjectSafe put(String k, Object v) { try { o.put(k, v == null ? JSONObject.NULL : v); } catch (Exception ignored) { } return this; }
    }
}
