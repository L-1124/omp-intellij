package com.example.app

import com.example.app.R.color.*
import com.example.app.R.string as ResString

class ResourceUsageReference {
    fun exerciseUsages(): Int {
        val layoutRes = R.layout.activity_main
        val boolRes = R.bool.feature_enabled
        val intRes = R.integer.max_retry_count
        val arrayRes = R.array.planets
        val pluralsRes = R.plurals.items_count
        val styleRes = R.style.AppTheme
        val dottedStyle = R.style.Dotted_Theme
        val drawable = R.drawable.reference_drawable
        val mipmap = R.mipmap.reference_icon
        val animation = R.anim.reference_alpha
        val animator = R.animator.reference_animator
        val raw = R.raw.reference_raw
        val configuration = R.xml.reference_config
        val idRes = R.id.custom_view_id
        val libRef = com.example.lib.R.string.lib_greeting
        val coreRef = com.example.core.R.string.core_title
        val aliased = ResString.hello_message
        val wildcard = primary_color
        val app_name = "local_shadowed_variable"
        return layoutRes + boolRes + intRes + arrayRes + pluralsRes + styleRes + idRes + libRef + coreRef + aliased + wildcard + app_name.length
    }
}
