package com.hadomotics.standalone;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Almacén seguro de la app: los valores (Access ID / Access Secret de Tuya) se cifran
 * con AES-256-GCM usando una clave que vive en el Android Keystore (no se puede
 * extraer del dispositivo). En SharedPreferences solo queda el texto cifrado.
 * Si la clave se pierde (restauración en otro móvil), los valores se descartan.
 */
public final class SecureStore {
    private static final String ALIAS = "hadomotics_secrets_v1";
    private static final String PREFS = "hadomotics_secure";

    private SecureStore() {}

    private static SecretKey key() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        if (ks.containsAlias(ALIAS)) {
            return ((KeyStore.SecretKeyEntry) ks.getEntry(ALIAS, null)).getSecretKey();
        }
        KeyGenerator kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        kg.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build());
        return kg.generateKey();
    }

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    public static synchronized void set(Context ctx, String k, String v) throws Exception {
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.ENCRYPT_MODE, key());
        byte[] iv = c.getIV();
        byte[] ct = c.doFinal(v.getBytes(StandardCharsets.UTF_8));
        byte[] out = new byte[iv.length + ct.length];
        System.arraycopy(iv, 0, out, 0, iv.length);
        System.arraycopy(ct, 0, out, iv.length, ct.length);
        prefs(ctx).edit().putString(k, Base64.encodeToString(out, Base64.NO_WRAP)).apply();
    }

    public static synchronized String get(Context ctx, String k) {
        String b64 = prefs(ctx).getString(k, null);
        if (b64 == null) return null;
        try {
            byte[] all = Base64.decode(b64, Base64.NO_WRAP);
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, all, 0, 12));
            return new String(c.doFinal(all, 12, all.length - 12), StandardCharsets.UTF_8);
        } catch (Exception e) {
            prefs(ctx).edit().remove(k).apply(); // ilegible (otra clave): se descarta, nunca se registra
            return null;
        }
    }

    public static synchronized void remove(Context ctx, String k) {
        prefs(ctx).edit().remove(k).apply();
    }
}
