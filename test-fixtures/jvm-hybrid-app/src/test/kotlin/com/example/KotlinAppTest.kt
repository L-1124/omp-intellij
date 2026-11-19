package com.example

import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Assertions.assertEquals

class KotlinAppTest {

    @Test
    fun testKotlinCompute() {
        val service = KotlinService()
        assertEquals(30, service.computeSum(12, 18))
    }

    @Test
    fun testInteropFromKotlin() {
        val service = KotlinService()
        assertEquals("Hello from Java, Tester! (via Kotlin)", service.interopGreeting("Tester"))
    }
}
