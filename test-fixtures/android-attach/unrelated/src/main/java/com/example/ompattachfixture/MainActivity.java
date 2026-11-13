package com.example.ompattachfixture;

public class MainActivity {
    private int counter = 0;

    public void tick() {
        int before = counter;
        int after = before + 1;
        counter = after;
    }
}
