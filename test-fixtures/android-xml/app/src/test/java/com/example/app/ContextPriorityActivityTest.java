package com.example.app;

import org.junit.Assert;
import org.junit.Test;

public class ContextPriorityActivityTest {
    @Test
    public void priorityLabel() {
        Assert.assertEquals("context-priority", new ContextPriorityActivity().label());
    }
}
