package com.example.app;

import android.app.Activity;
import android.os.Bundle;

public class CustomInflateActivity extends Activity {
    private void inflate(int layoutId) {
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        inflate(R.layout.layout_custom_inflate);
    }
}
