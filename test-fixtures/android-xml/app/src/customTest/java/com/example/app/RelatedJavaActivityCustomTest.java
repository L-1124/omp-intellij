package com.example.app;

import org.junit.Assert;
import org.junit.Test;

public class RelatedJavaActivityCustomTest {
    @Test
    public void customRootTestMustNotExecuteDuringQuery() {
        if (Boolean.parseBoolean("true")) {
            throw new IllegalStateException("relatedTests must not execute customTest");
        }
        Assert.assertEquals(4, new RelatedJavaActivity().computeScore(3));
    }
}
