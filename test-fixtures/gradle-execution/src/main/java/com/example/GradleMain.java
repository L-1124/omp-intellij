package com.example;

import java.util.Properties;

public final class GradleMain {
    public static void main(String[] args) throws Exception {
        var properties = new Properties();
        try (var resource = GradleMain.class.getResourceAsStream("/engineering.properties")) {
            properties.load(resource);
        }
        System.out.println("GRADLE_MESSAGE=" + properties.getProperty("message"));
        System.out.println("GRADLE_ARGUMENTS=" + String.join(",", args));
        System.out.println("GRADLE_VM_PROPERTY=" + System.getProperty("engineering.vm", "unset"));
    }
}
