package com.example.ompattachfixture.lib;

public final class LibHelper {
    private static volatile int lastCount = 0;

    public static int record(int value) {
        int computed = value + 999;
        lastCount = computed;
        return computed;
    }
}
