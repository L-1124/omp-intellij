package com.example;

public class JavaGreeter {
    public static String greet(String name) {
        return "Hello from Java, " + name + "!";
    }

    public static void main(String[] args) {
        String msg = greet("OMP");
        System.out.println("JAVA_MAIN_OUTPUT=" + msg);
        System.out.println("JAVA_VERSION=" + System.getProperty("java.version"));
    }
}
