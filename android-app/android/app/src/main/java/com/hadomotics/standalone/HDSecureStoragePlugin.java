package com.hadomotics.standalone;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;

/** Puente JS -> SecureStore. Solo admite las claves conocidas; nunca registra valores. */
@CapacitorPlugin(name = "HDSecureStorage")
public class HDSecureStoragePlugin extends Plugin {
    private static final Set<String> KEYS = new HashSet<>(Arrays.asList("tuya_access_id", "tuya_access_secret"));

    private String keyOf(PluginCall call) {
        String k = call.getString("key");
        if (k == null || !KEYS.contains(k)) {
            call.reject("clave no permitida");
            return null;
        }
        return k;
    }

    @PluginMethod
    public void get(PluginCall call) {
        String k = keyOf(call);
        if (k == null) return;
        JSObject r = new JSObject();
        r.put("value", SecureStore.get(getContext(), k));
        call.resolve(r);
    }

    @PluginMethod
    public void set(PluginCall call) {
        String k = keyOf(call);
        if (k == null) return;
        String v = call.getString("value");
        if (v == null) { call.reject("valor vacío"); return; }
        try {
            SecureStore.set(getContext(), k, v);
            call.resolve();
        } catch (Exception e) {
            call.reject("no se pudo cifrar");
        }
    }

    @PluginMethod
    public void remove(PluginCall call) {
        String k = keyOf(call);
        if (k == null) return;
        SecureStore.remove(getContext(), k);
        call.resolve();
    }
}
