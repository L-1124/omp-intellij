package com.example.app;

import android.app.Activity;
import android.os.Bundle;

public class RelatedJavaActivity extends Activity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.layout_related_java);
    }

    public int computeScore(int base) {
        return base + 1;
    }
}
