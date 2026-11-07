package com.example.lib

import android.app.Activity
import android.os.Bundle

open class LibActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
    }

    fun libAction(): String {
        return "lib-action"
    }
}
