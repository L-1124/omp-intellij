package com.example;

public class AttachTarget {
    public static void main(String[] args) {
        long count = 0;
        while (!Thread.currentThread().isInterrupted()) {
            System.out.println("ATTACH_HEARTBEAT=" + count++);
            System.out.flush();
            try {
                Thread.sleep(250);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                break;
            }
        }
    }
}
