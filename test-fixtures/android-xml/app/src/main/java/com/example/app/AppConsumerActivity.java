package com.example.app;

import android.app.Activity;
import android.os.Bundle;

public class AppConsumerActivity extends Activity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(com.example.lib.R.layout.lib_layout_only);
    }
}
