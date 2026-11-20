package com.hadomotics.standalone;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import java.util.List;

import org.json.JSONObject;
import org.junit.Test;

public class AlarmRuleTest {
    static final String CFG = "{\"mode\":\"tuya\",\"background\":{\"enabled\":true},"
            + "\"alarm\":{\"state\":\"armed_night\",\"armed_mode\":\"armed_night\",\"until\":0,\"siren_enabled\":true,\"trigger_time\":60,"
            + "\"zones\":[{\"id\":\"entrada\",\"name\":\"Entrada\",\"on\":true,\"entry_delay\":0},{\"id\":\"p1\",\"name\":\"Planta 1\",\"on\":false,\"entry_delay\":0},"
            + "{\"id\":\"garaje\",\"name\":\"Garaje\",\"on\":true,\"entry_delay\":20}]},"
            + "\"sensors\":[{\"entity_id\":\"binary_sensor.pir_entrada\",\"device_id\":\"d1\",\"code\":\"pir\",\"zone\":\"entrada\",\"label\":\"PIR entrada\",\"category\":\"pir\"},"
            + "{\"entity_id\":\"binary_sensor.pir_p1\",\"device_id\":\"d2\",\"code\":\"pir\",\"zone\":\"p1\",\"label\":\"PIR p1\",\"category\":\"pir\"},"
            + "{\"entity_id\":\"binary_sensor.puerta\",\"device_id\":\"d3\",\"code\":\"doorcontact_state\",\"zone\":\"garaje\",\"label\":\"Puerta garaje\",\"category\":\"mcs\"}]}";

    AlarmRule rule() throws Exception {
        AlarmRule r = new AlarmRule();
        AlarmMonitorService.loadRule(r, new JSONObject(CFG));
        r.sirenConfigured = true;
        return r;
    }

    @Test public void firstObservationNeverTriggers() throws Exception {
        AlarmRule r = rule();
        assertTrue(r.onStatus("d1", "pir", "pir", 1000).isEmpty());
        assertEquals("armed_night", r.state);
    }

    @Test public void activeZoneTriggersSirenAndNotify() throws Exception {
        AlarmRule r = rule();
        r.onStatus("d1", "pir", "none", 1000);
        List<AlarmRule.Action> a = r.onStatus("d1", "pir", "pir", 2000);
        assertEquals("[siren:on@entrada, triggered@entrada, notify@entrada]", a.toString());
        assertEquals("triggered", r.state);
        // segunda detección dentro del minuto: sin aviso repetido
        r.onStatus("d1", "pir", "none", 3000);
        assertEquals("[]", r.onStatus("d1", "pir", "pir", 4000).toString());
        // fin del disparo: sirena off y vuelta al modo armado
        assertEquals("[siren:off, rearmed]", r.tick(2000 + 60000).toString());
        assertEquals("armed_night", r.state);
    }

    @Test public void inactiveZoneIgnored() throws Exception {
        AlarmRule r = rule();
        r.onStatus("d2", "pir", "none", 1000);
        assertTrue(r.onStatus("d2", "pir", "pir", 2000).isEmpty());
    }

    @Test public void sirenDisabledOnlyNotifies() throws Exception {
        AlarmRule r = rule();
        r.sirenEnabled = false;
        r.onStatus("d1", "pir", "none", 1000);
        assertEquals("[triggered@entrada, notify@entrada]", r.onStatus("d1", "pir", "pir", 2000).toString());
    }

    @Test public void entryDelayThenTrigger() throws Exception {
        AlarmRule r = rule();
        r.onStatus("d3", "doorcontact_state", "false", 1000);
        assertEquals("[pending@garaje]", r.onStatus("d3", "doorcontact_state", "true", 2000).toString());
        assertEquals("pending", r.state);
        assertTrue(r.tick(10000).isEmpty());
        assertEquals("[siren:on@garaje, triggered@garaje, notify@garaje]", r.tick(22000).toString());
    }

    @Test public void armingCompletesBeforeDetection() throws Exception {
        AlarmRule r = rule();
        r.state = "arming"; r.target = "armed_away"; r.until = 5000;
        r.onStatus("d1", "pir", "none", 1000);
        assertTrue(r.onStatus("d1", "pir", "pir", 2000).isEmpty()); // aún en retardo de salida
        r.onStatus("d1", "pir", "none", 3000);
        assertEquals("triggered@entrada", r.onStatus("d1", "pir", "pir", 6000).get(1).toString());
    }

    @Test public void disarmedNeverTriggers() throws Exception {
        AlarmRule r = rule();
        r.state = "disarmed";
        r.onStatus("d1", "pir", "none", 1000);
        assertTrue(r.onStatus("d1", "pir", "pir", 2000).isEmpty());
        assertTrue(!r.watching());
    }

    @Test public void rememberDoesNotChangeState() throws Exception {
        AlarmRule r = rule();
        r.remember("d1", "pir", "none");
        r.remember("d1", "pir", "pir");
        assertEquals("armed_night", r.state);
    }

    @Test public void presenceRadarValues() {
        assertTrue(AlarmRule.isOn("hps", "presence_state", "presence"));
        assertTrue(!AlarmRule.isOn("hps", "presence_state", "none"));
        assertTrue(!AlarmRule.isOn("pir", "pir", "none"));
    }
}
