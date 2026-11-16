package com.hadomotics.standalone;

import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;

/**
 * Suscripción al servicio de mensajes de Tuya (Pulsar por WebSocket, puerto 8285):
 * cambios de estado al instante sin gastar llamadas a la API (cuota de mensajes
 * aparte: ~68.000/mes en la edición Trial). Hay que activar «Message Service» en
 * el proyecto Cloud. EXPERIMENTAL: no probado contra el servicio real.
 * URL: wss://mqe.<región>:8285/ws/v2/consumer/persistent/{accessId}/out/event/{accessId}-sub
 * Cabeceras: username = accessId, password = md5(accessId + md5(secret))[8:24].
 * Cada mensaje: {messageId, payload(base64), properties{em}} -> ack {messageId}.
 */
public class PulsarClient {
    public interface Listener {
        void onStatus(String deviceId, JSONArray status);
        void onOnline(String deviceId, boolean online);
        void onState(boolean connected, String info);
    }

    public static String wsBase(String region) {
        if (region == null) region = "eu";
        if (region.startsWith("us")) return "wss://mqe.tuyaus.com:8285/";
        if (region.equals("cn")) return "wss://mqe.tuyacn.com:8285/";
        if (region.equals("in")) return "wss://mqe.tuyain.com:8285/";
        return "wss://mqe.tuyaeu.com:8285/";
    }

    private final String accessId, secret, region;
    private final Listener listener;
    private final OkHttpClient http = new OkHttpClient.Builder().pingInterval(30, TimeUnit.SECONDS).readTimeout(0, TimeUnit.MILLISECONDS).build();
    private WebSocket ws;
    private volatile boolean stopped;
    private int backoff = 5;

    public PulsarClient(String accessId, String secret, String region, Listener listener) {
        this.accessId = accessId;
        this.secret = secret;
        this.region = region;
        this.listener = listener;
    }

    public void start() {
        stopped = false;
        connect();
    }

    public void stop() {
        stopped = true;
        if (ws != null) ws.close(1000, "stop");
    }

    private void connect() {
        if (stopped) return;
        String url = wsBase(region) + "ws/v2/consumer/persistent/" + accessId + "/out/event/" + accessId + "-sub?ackTimeoutMillis=3000&subscriptionType=Failover";
        Request.Builder rb = new Request.Builder().url(url).header("Connection", "Upgrade").header("username", accessId);
        try {
            rb.header("password", PulsarCrypto.password(accessId, secret));
        } catch (Exception e) {
            listener.onState(false, "md5");
            return;
        }
        ws = http.newWebSocket(rb.build(), new WebSocketListener() {
            @Override public void onOpen(WebSocket w, Response r) { backoff = 5; listener.onState(true, "open"); }
            @Override public void onMessage(WebSocket w, String text) { handle(w, text); }
            @Override public void onFailure(WebSocket w, Throwable t, Response r) { listener.onState(false, "failure " + (r != null ? r.code() : "")); retry(); }
            @Override public void onClosed(WebSocket w, int code, String reason) { listener.onState(false, "closed " + code); retry(); }
        });
    }

    private void retry() {
        if (stopped) return;
        int wait = backoff;
        backoff = Math.min(300, backoff * 2);
        new Thread(() -> {
            try { Thread.sleep(wait * 1000L); } catch (InterruptedException ignored) { }
            connect();
        }).start();
    }

    void handle(WebSocket w, String text) {
        try {
            JSONObject msg = new JSONObject(text);
            String id = msg.optString("messageId");
            if (!id.isEmpty()) w.send(new JSONObject().put("messageId", id).toString());
            JSONObject props = msg.optJSONObject("properties");
            String em = props != null ? props.optString("em", "") : "";
            String payload = new String(Base64.getDecoder().decode(msg.getString("payload")), StandardCharsets.UTF_8);
            JSONObject outer = new JSONObject(payload);
            JSONObject data = new JSONObject(PulsarCrypto.decrypt(outer.getString("data"), secret, em));
            dispatch(outer.optInt("protocol"), data, listener);
        } catch (Exception e) {
            Log.w("HDPulsar", "mensaje ilegible: " + e.getClass().getSimpleName());
        }
    }

    /** protocol 4: informe de estado; 20: eventos (online/offline). */
    static void dispatch(int protocol, JSONObject data, Listener l) {
        String dev = data.optString("devId", data.optString("dev_id", ""));
        if (dev.isEmpty()) {
            JSONObject biz = data.optJSONObject("bizData");
            if (biz != null) dev = biz.optString("devId", "");
        }
        if (dev.isEmpty()) return;
        if (protocol == 4 || data.has("status")) {
            JSONArray st = data.optJSONArray("status");
            if (st != null) l.onStatus(dev, st);
        } else if (protocol == 20) {
            String biz = data.optString("bizCode", "");
            if ("online".equals(biz)) l.onOnline(dev, true);
            if ("offline".equals(biz)) l.onOnline(dev, false);
        }
    }
}
