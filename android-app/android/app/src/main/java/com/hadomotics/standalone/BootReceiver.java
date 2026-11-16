package com.hadomotics.standalone;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

import org.json.JSONObject;

/** Tras reiniciar el móvil, vuelve a arrancar la vigilancia si estaba activada. */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context ctx, Intent intent) {
        String a = intent.getAction();
        if (!Intent.ACTION_BOOT_COMPLETED.equals(a) && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(a)) return;
        try {
            JSONObject cfg = new JSONObject(AlarmMonitorService.prefs(ctx).getString("config", "{}"));
            if (AlarmMonitorService.wanted(cfg)) AlarmMonitorService.start(ctx);
        } catch (Exception ignored) { }
    }
}
