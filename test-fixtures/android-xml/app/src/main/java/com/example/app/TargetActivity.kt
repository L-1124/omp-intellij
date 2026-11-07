package com.example.app

import android.app.Activity
import android.os.Bundle

/**
 * Target activity documentation.
 * References:
 * See also [com.example.app.TargetActivity] for FQN reference.
 * See also [TargetActivity] for simple reference.
 */
class TargetActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
    }

    companion object {
        fun createInstance(): TargetActivity = TargetActivity()
    }
}
