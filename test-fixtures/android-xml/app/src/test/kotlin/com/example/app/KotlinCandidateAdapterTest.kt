package com.example.app

import org.junit.Assert
import org.junit.Test

class KotlinCandidateAdapterTest {
    @Test
    fun kotlinAdapterCandidate() {
        Assert.assertNotNull(KotlinCandidateAdapter::class.java)
    }
}
