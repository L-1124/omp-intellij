package com.example.app

import android.app.Activity
import android.view.Menu

class FallbackInflaterActivity : Activity() {
    override fun onCreateOptionsMenu(menu: Menu): Boolean {
        menuInflater.inflate(R.menu.menu_context_priority, menu)
        return true
    }
}
