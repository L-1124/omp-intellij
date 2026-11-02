package com.example;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;

public class JavaGreeterTest {

    @Test
    void testJavaGreeting() {
        assertEquals("Hello from Java, Unit!", JavaGreeter.greet("Unit"));
    }

    @Test
    void testKotlinServiceFromJava() {
        KotlinService service = new KotlinService();
        assertEquals(42, service.computeSum(20, 22));
    }
}
