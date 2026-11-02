package com.example;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.assertTrue;

class GradleExecutionTest {
    @Test
    void testGradleDebugJvm() {
        System.out.println("GRADLE_TEST_RUNNING");
        assertTrue(true);
    }
}
