package com.example.ompattachfixture;

import android.app.Activity;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import com.example.ompattachfixture.lib.LibHelper;

public class MainActivity extends Activity {
    private final Handler handler = new Handler(Looper.getMainLooper());
    private int counter = 0;
    private final Runnable ticker = new Runnable() {
        @Override
        public void run() {
            tick();
            LibHelper.record(counter);
            GeneratedCounter.record(counter);
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

    public void tick() {
        int before = counter;
        int after = before + 1;
        counter = after;
    }

    public int getCounter() {
        return counter;
    }
}
