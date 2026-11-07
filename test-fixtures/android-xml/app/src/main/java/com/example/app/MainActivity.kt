package com.example.app

import android.app.Activity
import android.app.Service
import android.content.Intent
import android.os.Bundle
import android.os.IBinder
import com.example.lib.LibActivity

class MainActivity : Activity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val appName = getString(R.string.app_name)
        val customResource = getString(R.string.custom_root_string)
        val helloMsg = getString(R.string.hello_message)
        val primaryColor = getColor(R.color.primary_color)
        val margin = resources.getDimension(R.dimen.default_margin)
        val intent = Intent(this, TargetActivity::class.java)
        val libIntent = Intent(this, LibActivity::class.java)
    }

    class InnerService : Service() {
        override fun onBind(intent: Intent?): IBinder? = null
    }
}
