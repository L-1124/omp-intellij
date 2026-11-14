package com.example.app

import android.app.Activity
import android.os.Bundle

class OtherMethodActivityKt : Activity() {
    private fun bindLayout(layoutId: Int) {
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        bindLayout(R.layout.layout_isolated_negatives)
    }
}
