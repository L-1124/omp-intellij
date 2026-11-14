package com.example.app;

import android.app.Activity;
import android.os.Bundle;

public class OtherMethodActivity extends Activity {
    private void bindLayout(int layoutId) {
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        bindLayout(R.layout.layout_isolated_negatives);
    }
}
