package com.hadomotics.standalone;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(HDSecureStoragePlugin.class);
        registerPlugin(HDAlarmServicePlugin.class);
        super.onCreate(savedInstanceState);
    }

    @Override
    public void onResume() {
        super.onResume();
        AlarmMonitorService.appVisible = true;
    }

    @Override
    public void onPause() {
        AlarmMonitorService.appVisible = false;
        super.onPause();
    }
}
