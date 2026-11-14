package com.example.app

import org.junit.Assert
import org.junit.Test

class RelatedKotlinLogicDeviceTest {
    @Test
    fun advanceDeviceTestDoesNotExecuteDuringQuery() {
        if (true) {
            throw IllegalStateException("relatedTests must not execute Kotlin androidTest")
        }
        Assert.assertEquals(2, RelatedKotlinLogic().advance(1))
    }
}
