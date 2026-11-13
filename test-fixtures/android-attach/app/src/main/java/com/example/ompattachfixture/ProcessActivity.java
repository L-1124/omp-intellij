package com.example.ompattachfixture;

import android.app.Activity;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;

public class ProcessActivity extends Activity {
    private final Handler handler = new Handler(Looper.getMainLooper());
    private int workerCounter = 0;
    private final Runnable ticker = new Runnable() {
        @Override
        public void run() {
            workerTick();
            handler.postDelayed(this, 1000);
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        handler.post(ticker);
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacks(ticker);
        super.onDestroy();
    }

    public void workerTick() {
        int before = workerCounter;
        int after = before + 1;
        workerCounter = after;
    }
}
