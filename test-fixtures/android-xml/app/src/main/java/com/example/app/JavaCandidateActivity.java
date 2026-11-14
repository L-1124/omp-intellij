package com.example.app;

import android.app.Activity;
import android.os.Bundle;

public class JavaCandidateActivity extends Activity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.layout_multi_candidates);
    }

    public void reloadLayout() {
        setContentView(R.layout.layout_multi_candidates);
    }
}
