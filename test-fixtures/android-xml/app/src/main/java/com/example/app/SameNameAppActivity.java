package com.example.app;

import android.app.Activity;
import android.os.Bundle;

public class SameNameAppActivity extends Activity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.layout_same_name_unreferenced);
    }
}
