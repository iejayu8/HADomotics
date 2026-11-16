package com.hadomotics.standalone;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;

import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;

/** Puente JS <-> servicio nativo: configuración, avisos, cola de eventos, permisos y compartir copias. */
@CapacitorPlugin(name = "HDAlarmService", permissions = {
        @Permission(alias = "notifications", strings = { "android.permission.POST_NOTIFICATIONS" })
})
public class HDAlarmServicePlugin extends Plugin {

    @Override
    public void load() {
        AlarmMonitorService.sink = new AlarmMonitorService.Sink() {
            @Override public void status(String deviceId, JSONArray status, Boolean online) {
                JSObject ev = new JSObject();
                ev.put("device_id", deviceId);
                ev.put("status", status.toString());
                if (online != null) ev.put("online", online);
                notifyListeners("tuyaStatus", ev);
            }
            @Override public void alarm(JSONObject e) {
                JSObject ev = new JSObject();
                ev.put("type", e.optString("type"));
                notifyListeners("alarmEvent", ev);
            }
        };
    }

    @PluginMethod
    public void configure(PluginCall call) {
        String json = call.getString("json", "{}");
        try {
            JSONObject cfg = new JSONObject(json);
            AlarmMonitorService.prefs(getContext()).edit().putString("config", cfg.toString()).apply();
            boolean want = AlarmMonitorService.wanted(cfg);
            if (want) {
                if (AlarmMonitorService.instance != null) AlarmMonitorService.instance.reload();
                else AlarmMonitorService.start(getContext());
            } else if (AlarmMonitorService.instance != null) {
                AlarmMonitorService.stop(getContext());
            }
            JSObject r = new JSObject();
            r.put("running", want);
            call.resolve(r);
        } catch (Exception e) {
            call.reject("configuración inválida");
        }
    }

    @PluginMethod
    public void status(PluginCall call) {
        JSObject r = new JSObject();
        r.put("running", AlarmMonitorService.instance != null);
        PowerManager pm = (PowerManager) getContext().getSystemService(android.content.Context.POWER_SERVICE);
        r.put("battery_unrestricted", pm.isIgnoringBatteryOptimizations(getContext().getPackageName()));
        r.put("notifications", Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED);
        call.resolve(r);
    }

    @PluginMethod
    public void notify(PluginCall call) {
        AlarmMonitorService.notifyUser(getContext(), call.getString("title", "HADomotics"), call.getString("body", ""),
                Boolean.TRUE.equals(call.getBoolean("critical", false)), call.getString("tag", ""));
        call.resolve();
    }

    @PluginMethod
    public void drainEvents(PluginCall call) {
        JSObject r = new JSObject();
        r.put("events", AlarmMonitorService.drain(getContext()));
        call.resolve(r);
    }

    @PluginMethod
    public void requestPermissions(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "permCallback");
        } else {
            JSObject r = new JSObject();
            r.put("notifications", "granted");
            call.resolve(r);
        }
    }

    @PermissionCallback
    private void permCallback(PluginCall call) {
        JSObject r = new JSObject();
        r.put("notifications", getPermissionState("notifications").toString());
        call.resolve(r);
    }

    @PluginMethod
    public void requestIgnoreBatteryOptimizations(PluginCall call) {
        try {
            Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
            i.setData(Uri.parse("package:" + getContext().getPackageName()));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
        } catch (Exception e) {
            Intent i = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
        }
        call.resolve();
    }

    /** Comparte un fichero de texto (copia de seguridad) con el selector de Android. */
    @PluginMethod
    public void shareFile(PluginCall call) {
        String name = call.getString("name", "hadomotics-backup.json").replaceAll("[^A-Za-z0-9._-]", "_");
        String data = call.getString("text", call.getString("data", ""));
        try {
            File dir = new File(getContext().getCacheDir(), "share");
            dir.mkdirs();
            File f = new File(dir, name);
            try (FileOutputStream os = new FileOutputStream(f)) { os.write(data.getBytes(StandardCharsets.UTF_8)); }
            Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", f);
            Intent send = new Intent(Intent.ACTION_SEND).setType("application/json").putExtra(Intent.EXTRA_STREAM, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            Intent chooser = Intent.createChooser(send, "Guardar copia de HADomotics").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(chooser);
            call.resolve();
        } catch (Exception e) {
            call.reject("no se pudo compartir");
        }
    }
}
