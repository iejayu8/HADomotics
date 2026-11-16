package com.hadomotics.standalone;

import static org.junit.Assert.assertEquals;

import java.util.LinkedHashMap;
import java.util.Map;

import org.junit.Test;

/** Vectores del ejemplo oficial de Tuya («Sign requests for Cloud authorization»). Valores públicos de la documentación. */
public class TuyaSignerTest {
    static final String ID = "1KAD46OrT9HafiKdsXeg", SECRET = "4OHBOnWOqaEC1mWXOpVL3yV50s0qGSRC";
    static final String T = "1588925778000", NONCE = "5138cc3a9033d69856923fd07b491173";

    Map<String, String> headers() {
        Map<String, String> h = new LinkedHashMap<>();
        h.put("area_id", "29a33e8796834b1efa6");
        h.put("call_id", "8afdb70ab2ed11eb85290242ac130003");
        return h;
    }

    @Test public void tokenRequest() throws Exception {
        String sts = TuyaSigner.stringToSign("GET", "", headers(), "/v1.0/token?grant_type=1");
        assertEquals("9E48A3E93B302EEECC803C7241985D0A34EB944F40FB573C7B5C2A82158AF13E", TuyaSigner.sign(ID, SECRET, "", T, NONCE, sts));
    }

    @Test public void businessRequest() throws Exception {
        String sts = TuyaSigner.stringToSign("GET", "", headers(), "/v2.0/apps/schema/users?page_no=1&page_size=50");
        assertEquals("AE4481C692AA80B25F3A7E12C3A5FD9BBF6251539DD78E565A1A72A508A88784", TuyaSigner.sign(ID, SECRET, "3f4eda2bdec17232f67c0b188af3eec1", T, NONCE, sts));
    }

    @Test public void canonicalQuerySorted() {
        Map<String, String> q = new LinkedHashMap<>();
        q.put("page_size", "50");
        q.put("page_no", "1");
        q.put("empty", "");
        assertEquals("/v2.0/apps/schema/users?page_no=1&page_size=50", TuyaSigner.canonicalUrl("/v2.0/apps/schema/users", q));
    }

    @Test public void emptyBodyHash() throws Exception {
        assertEquals("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", TuyaSigner.sha256Hex(""));
    }
}
