package com.example.app

import org.junit.Assert
import org.junit.Test

class RelatedKotlinLogicCustomTest {
    @Test
    fun advanceCustomTestDoesNotExecuteDuringQuery() {
        if (true) {
            throw IllegalStateException("relatedTests must not execute Kotlin customTest")
        }
        Assert.assertEquals(2, RelatedKotlinLogic().advance(1))
    }
}
