package com.example;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;

class EngineeringPropertiesTest {
    @Test
    void preservesSurefireProfileProperties() {
        String actual = System.getProperty("engineering.message");
        System.out.println("MAVEN_MESSAGE=" + actual);
        assertEquals(System.getProperty("engineering.expected", "maven-default"), actual);
    }
}
