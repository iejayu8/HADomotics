package com.hadomotics.standalone;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Map;
import java.util.TreeMap;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/** Firma HMAC-SHA256 de Tuya Cloud (misma especificación y vectores que src/tuya/sign.js). */
public final class TuyaSigner {
    private TuyaSigner() {}

    static String hex(byte[] b) {
        StringBuilder sb = new StringBuilder();
        for (byte x : b) sb.append(String.format("%02x", x));
        return sb.toString();
    }

    public static String sha256Hex(String s) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        return hex(md.digest((s == null ? "" : s).getBytes(StandardCharsets.UTF_8)));
    }

    public static String hmacUpper(String secret, String msg) throws Exception {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        return hex(mac.doFinal(msg.getBytes(StandardCharsets.UTF_8))).toUpperCase();
    }

    public static String canonicalUrl(String path, Map<String, String> query) {
        if (query == null || query.isEmpty()) return path;
        StringBuilder sb = new StringBuilder(path).append('?');
        boolean first = true;
        for (Map.Entry<String, String> e : new TreeMap<>(query).entrySet()) {
            if (e.getValue() == null || e.getValue().isEmpty()) continue;
            if (!first) sb.append('&');
            sb.append(e.getKey()).append('=').append(e.getValue());
            first = false;
        }
        return first ? path : sb.toString();
    }

    /** stringToSign con cabeceras firmadas opcionales (orden de inserción). */
    public static String stringToSign(String method, String body, Map<String, String> signHeaders, String url) throws Exception {
        StringBuilder h = new StringBuilder();
        if (signHeaders != null) for (Map.Entry<String, String> e : signHeaders.entrySet()) h.append(e.getKey()).append(':').append(e.getValue()).append('\n');
        return method.toUpperCase() + "\n" + sha256Hex(body) + "\n" + h + "\n" + url;
    }

    public static String sign(String clientId, String secret, String accessToken, String t, String nonce, String stringToSign) throws Exception {
        String str = clientId + (accessToken == null ? "" : accessToken) + t + (nonce == null ? "" : nonce) + stringToSign;
        return hmacUpper(secret, str);
    }
}
