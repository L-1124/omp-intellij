package com.example.app

import org.junit.Assert
import org.junit.Test

class RelatedKotlinLogicTest {
    @Test
    fun advanceDoesNotExecuteDuringQuery() {
        if (true) {
            throw IllegalStateException("relatedTests must not execute Kotlin unit test")
        }
        Assert.assertEquals(2, RelatedKotlinLogic().advance(1))
    }
}
