package com.hadomotics.standalone;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Cliente Tuya Cloud mínimo para el servicio en segundo plano (sin WebView):
 * token, estado por lotes y órdenes. Mismas rutas que src/tuya/cloud.js.
 * Los mensajes de error nunca incluyen el secreto ni el token.
 */
public class TuyaHttp {
    public static String endpoint(String region) {
        if (region == null) region = "eu";
        switch (region) {
            case "eu-w": return "https://openapi-weaz.tuyaeu.com";
            case "us": return "https://openapi.tuyaus.com";
            case "us-e": return "https://openapi-ueaz.tuyaus.com";
            case "cn": return "https://openapi.tuyacn.com";
            case "in": return "https://openapi.tuyain.com";
            case "sg": return "https://openapi-sg.iotbing.com";
            default: return "https://openapi.tuyaeu.com";
        }
    }

    private final String accessId;
    private final String secret;
    private final String base;
    private String token;
    private long tokenExp;
    public int calls;

    public TuyaHttp(String accessId, String secret, String region) {
        this.accessId = accessId;
        this.secret = secret;
        this.base = endpoint(region);
    }

    private JSONObject raw(String method, String path, Map<String, String> query, String body, boolean withToken) throws Exception {
        String url = TuyaSigner.canonicalUrl(path, query);
        String t = String.valueOf(System.currentTimeMillis());
        String nonce = UUID.randomUUID().toString().replace("-", "");
        String sts = TuyaSigner.stringToSign(method, body == null ? "" : body, null, url);
        String sign = TuyaSigner.sign(accessId, secret, withToken ? token : "", t, nonce, sts);
        HttpURLConnection c = (HttpURLConnection) new URL(base + url).openConnection();
        c.setConnectTimeout(15000);
        c.setReadTimeout(15000);
        c.setRequestMethod(method);
        c.setRequestProperty("client_id", accessId);
        c.setRequestProperty("sign", sign);
        c.setRequestProperty("t", t);
        c.setRequestProperty("nonce", nonce);
        c.setRequestProperty("sign_method", "HMAC-SHA256");
        if (withToken && token != null) c.setRequestProperty("access_token", token);
        if (body != null && !body.isEmpty()) {
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json");
            try (OutputStream os = c.getOutputStream()) { os.write(body.getBytes(StandardCharsets.UTF_8)); }
        }
        calls++;
        InputStream in = c.getResponseCode() < 400 ? c.getInputStream() : c.getErrorStream();
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        byte[] buf = new byte[4096];
        int n;
        while (in != null && (n = in.read(buf)) > 0) bo.write(buf, 0, n);
        c.disconnect();
        return new JSONObject(bo.size() > 0 ? bo.toString("UTF-8") : "{}");
    }

    private void ensureToken() throws Exception {
        if (token != null && System.currentTimeMillis() < tokenExp - 60000) return;
        Map<String, String> q = new HashMap<>();
        q.put("grant_type", "1");
        JSONObject r = raw("GET", "/v1.0/token", q, null, false);
        if (!r.optBoolean("success")) throw new Exception("Tuya token " + r.optInt("code") + ": " + r.optString("msg"));
        JSONObject res = r.getJSONObject("result");
        token = res.getString("access_token");
        tokenExp = System.currentTimeMillis() + res.optLong("expire_time", 7200) * 1000;
    }

    private Object request(String method, String path, Map<String, String> q, String body) throws Exception {
        ensureToken();
        JSONObject r = raw(method, path, q, body, true);
        int code = r.optInt("code");
        if (!r.optBoolean("success") && (code == 1010 || code == 1011)) {
            token = null;
            ensureToken();
            r = raw(method, path, q, body, true);
        }
        if (!r.optBoolean("success")) throw new Exception("Tuya " + r.optInt("code") + ": " + r.optString("msg") + " (" + path + ")");
        return r.opt("result");
    }

    /** {device_id: [{code, value}]} */
    public Map<String, JSONArray> statuses(List<String> ids) throws Exception {
        Map<String, JSONArray> out = new HashMap<>();
        for (int i = 0; i < ids.size(); i += 20) {
            List<String> chunk = ids.subList(i, Math.min(ids.size(), i + 20));
            Map<String, String> q = new HashMap<>();
            q.put("device_ids", String.join(",", chunk));
            Object res = request("GET", "/v1.0/iot-03/devices/status", q, null);
            if (res instanceof JSONArray) {
                JSONArray arr = (JSONArray) res;
                for (int k = 0; k < arr.length(); k++) {
                    JSONObject d = arr.getJSONObject(k);
                    out.put(d.getString("id"), d.optJSONArray("status"));
                }
            }
        }
        return out;
    }

    public void command(String deviceId, String code, Object value) throws Exception {
        JSONObject cmd = new JSONObject().put("code", code).put("value", value);
        JSONObject body = new JSONObject().put("commands", new JSONArray().put(cmd));
        request("POST", "/v1.0/iot-03/devices/" + deviceId + "/commands", null, body.toString());
    }
}
