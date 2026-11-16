package com.hadomotics.standalone;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.List;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

/** Fixtures generadas con la librería «cryptography» de Python siguiendo el SDK oficial (claves de demo, no reales). */
public class PulsarTest {
    static final String ID = "demo-access-id", KEY = "demo-secret-no-real-0123456789ab";
    static final String PLAIN = "{\"devId\":\"pir1\",\"status\":[{\"code\":\"pir\",\"value\":\"pir\",\"t\":1}]}";

    @Test public void password() throws Exception {
        assertEquals("f69215e5092821f8", PulsarCrypto.password(ID, KEY));
    }

    @Test public void gcm() throws Exception {
        String b64 = "AAECAwQFBgcICQoLWGU6EAkldy5RxvsSYRanpa7tk4BEQWyIyX0O4j5e1lvCPovgoynAMLFYuux1TR4Zg7aAN2KcMgMGOOfniH0lx6FO10gJS0/DzD9LAPW1";
        assertEquals(PLAIN, PulsarCrypto.decrypt(b64, KEY, "aes_gcm"));
    }

    @Test public void ecb() throws Exception {
        String b64 = "zGv18HUudFYml7GJZgiM6BGKiTHuLNtskFL6qfMlMhh3LoKiOWrW3lfFR5li6tsUZHdwxAw/2GF3COd2OSbIIw==";
        assertEquals(PLAIN, PulsarCrypto.decrypt(b64, KEY, ""));
    }

    @Test public void dispatch() throws Exception {
        List<String> got = new ArrayList<>();
        PulsarClient.Listener l = new PulsarClient.Listener() {
            public void onStatus(String d, JSONArray s) { got.add("status:" + d + ":" + s.length()); }
            public void onOnline(String d, boolean on) { got.add("online:" + d + ":" + on); }
            public void onState(boolean c, String i) { }
        };
        PulsarClient.dispatch(4, new JSONObject(PLAIN), l);
        PulsarClient.dispatch(20, new JSONObject("{\"bizCode\":\"offline\",\"devId\":\"sir1\"}"), l);
        PulsarClient.dispatch(20, new JSONObject("{\"bizCode\":\"online\",\"bizData\":{\"devId\":\"sir2\"}}"), l);
        assertEquals("[status:pir1:1, online:sir1:false, online:sir2:true]", got.toString());
        assertTrue(PulsarClient.wsBase("eu-w").startsWith("wss://mqe.tuyaeu.com:8285"));
    }
}
