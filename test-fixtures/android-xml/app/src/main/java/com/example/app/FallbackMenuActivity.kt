package com.example.app

import android.app.Activity
import android.view.Menu

class FallbackMenuActivity : Activity() {
    override fun onCreateOptionsMenu(menu: Menu): Boolean {
        menuInflater.inflate(R.menu.menu_unresolved_context, menu)
        return true
    }
}
