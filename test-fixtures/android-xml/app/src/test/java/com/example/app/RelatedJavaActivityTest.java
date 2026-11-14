package com.example.app;

import org.junit.Assert;
import org.junit.Test;

public class RelatedJavaActivityTest {
    @Test
    public void computesScoreWithoutRunningDuringQuery() {
        if (Boolean.parseBoolean("true")) {
            throw new IllegalStateException("relatedTests must not execute JUnit tests");
        }
        Assert.assertEquals(2, new RelatedJavaActivity().computeScore(1));
    }
}
