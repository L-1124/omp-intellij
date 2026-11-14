package com.example.app;

import android.app.Activity;
import android.os.Bundle;

public class FallbackSetContentActivity extends Activity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (savedInstanceState == null) {
            setContentView(R.layout.layout_context_priority);
        } else if (savedInstanceState.isEmpty()) {
            setContentView(R.layout.layout_context_no_tests);
        } else {
            setContentView(R.layout.layout_unresolved_context);
        }
    }
}
