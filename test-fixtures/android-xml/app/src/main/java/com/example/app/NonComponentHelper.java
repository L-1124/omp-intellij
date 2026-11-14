package com.example.app;

public class NonComponentHelper {
    public void setContentView(int layoutId) {
    }

    public void inflate(int layoutId) {
    }

    public void attach() {
        setContentView(R.layout.layout_isolated_negatives);
        inflate(R.layout.layout_isolated_negatives);
    }
}
