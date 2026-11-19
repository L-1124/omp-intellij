package com.example;

public final class App {
    public static final String PROJECT_ID = "jdk17";

    public static void main(String[] args) throws Exception {
        int breakpointLine = 42;
        System.out.println("JAVA_VERSION=" + System.getProperty("java.version"));
        System.out.println("PROJECT_ID=" + PROJECT_ID);
        System.out.println("RUN_MARKER=" + System.getProperty("omp.intellij.run.id"));
        long count = 0;
        while (!Thread.currentThread().isInterrupted()) {
            System.out.println("HEARTBEAT_17=" + count++);
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
