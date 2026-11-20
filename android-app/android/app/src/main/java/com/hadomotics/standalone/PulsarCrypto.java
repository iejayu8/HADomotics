package com.hadomotics.standalone;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Base64;

import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * Cifrado del servicio de mensajes de Tuya (Pulsar), según el SDK oficial
 * tuya-pulsar-sdk-python (message_util.py / mq_authentication.py):
 *  - contraseña = md5(accessId + md5(accessKey))[8:24]
 *  - clave AES  = accessKey[8:24]
 *  - "em" = "aes_gcm": nonce(12) | texto cifrado | tag(16); si no, AES-ECB.
 */
public final class PulsarCrypto {
    private PulsarCrypto() {}

    static String md5(String s) throws Exception {
        return TuyaSigner.hex(MessageDigest.getInstance("MD5").digest(s.getBytes(StandardCharsets.UTF_8)));
    }

    public static String password(String accessId, String accessKey) throws Exception {
        return md5(accessId + md5(accessKey)).substring(8, 24);
    }

    public static String decrypt(String b64, String accessKey, String em) throws Exception {
        byte[] raw = Base64.getDecoder().decode(b64);
        SecretKeySpec key = new SecretKeySpec(accessKey.substring(8, 24).getBytes(StandardCharsets.UTF_8), "AES");
        if ("aes_gcm".equals(em)) {
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, raw, 0, 12));
            return new String(c.doFinal(raw, 12, raw.length - 12), StandardCharsets.UTF_8);
        }
        byte[] plain;
        try {
            Cipher c = Cipher.getInstance("AES/ECB/PKCS5Padding");
            c.init(Cipher.DECRYPT_MODE, key);
            plain = c.doFinal(raw);
        } catch (javax.crypto.BadPaddingException e) {
            Cipher c = Cipher.getInstance("AES/ECB/NoPadding"); // como el SDK de Python: sin quitar relleno
            c.init(Cipher.DECRYPT_MODE, key);
            plain = c.doFinal(raw);
        }
        return new String(plain, StandardCharsets.UTF_8).replaceAll("[\\x00-\\x1f]", "").trim();
    }
}
