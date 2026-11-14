package org.jetbrains.android.testing.slim

import com.intellij.ide.plugins.PluginMainDescriptor
import com.jetbrains.analyzer.java.javaPlugin
import com.jetbrains.analyzer.kotlin.kotlinPlugin
import com.jetbrains.analyzer.xml.xmlPlugin
import java.util.function.Supplier

class AndroidSlimPlugins : Supplier<List<PluginMainDescriptor>> {
    override fun get(): List<PluginMainDescriptor> = listOf(javaPlugin, kotlinPlugin, xmlPlugin)
}
