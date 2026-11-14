package com.example.app

import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.BaseAdapter

class KotlinCandidateAdapter : BaseAdapter() {
    override fun getCount(): Int = 0
    override fun getItem(position: Int): Any? = null
    override fun getItemId(position: Int): Long = position.toLong()

    override fun getView(position: Int, convertView: View?, parent: ViewGroup): View {
        return LayoutInflater.from(parent.context).inflate(R.layout.layout_multi_candidates, parent, false)
    }
}
