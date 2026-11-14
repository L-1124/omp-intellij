package com.example.app;

import org.junit.Assert;
import org.junit.Test;

public class RelatedJavaActivityDeviceTest {
    @Test
    public void deviceTestMustNotExecuteDuringQuery() {
        if (Boolean.parseBoolean("true")) {
            throw new IllegalStateException("relatedTests must not execute androidTest");
        }
        Assert.assertEquals(3, new RelatedJavaActivity().computeScore(2));
    }
}
