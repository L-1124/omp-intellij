package org.jetbrains.android

import com.intellij.debugger.settings.NodeRendererSettings
import com.intellij.ide.plugins.ContentModuleDescriptor
import com.intellij.ide.plugins.cl.PluginAwareClassLoader
import com.intellij.lang.xml.XMLLanguage
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.util.registry.Registry
import com.intellij.xdebugger.settings.XDebuggerSettingsManager
import com.jetbrains.ls.api.features.LanguageServerExtension
import com.jetbrains.ls.api.features.language.LSConfigurationPiece
import com.jetbrains.ls.api.features.language.LSLanguage
import org.jetbrains.android.compose.ComposeSuppressor
import org.jetbrains.android.debug.AndroidDebugCommands
import org.jetbrains.android.lint.AndroidLintProvider
import org.jetbrains.android.navigation.AndroidCompiledResourceClassFinder
import org.jetbrains.android.navigation.AndroidDefinitionProvider
import org.jetbrains.android.navigation.AndroidReferencesProvider
import org.jetbrains.android.navigation.AndroidResourceCommands
import org.jetbrains.android.navigation.AndroidResourceNavigation
import org.jetbrains.android.xml.AndroidDocumentSymbols

class AndroidExtension : LanguageServerExtension {
    override val configuration: LSConfigurationPiece
        get() {
            Logger.getInstance(AndroidExtension::class.java).info("OMP Android providers loaded for ILS 271.2085.0")
            try {
                // ART cannot load the host JVM's BatchEvaluatorServer class.
                Registry.get("debugger.batch.evaluation").setValue(false)
                Registry.get("debugger.batch.evaluation.force").setValue(false)

                // Evaluating Android UI objects can block JDWP.
                NodeRendererSettings.getInstance()?.let { settings ->
                    settings.toStringRenderer?.let { renderer ->
                        renderer.isEnabled = false
                        settings.fireRenderersChanged()
                    }
                }
                XDebuggerSettingsManager.getInstance()?.dataViewSettings?.isAutoExpressions = false
            } catch (_: Throwable) {
            }

            val loader = AndroidExtension::class.java.classLoader as? PluginAwareClassLoader
            val module = loader?.pluginDescriptor as? ContentModuleDescriptor
                ?: error("Android extension content module descriptor unavailable")
            return LSConfigurationPiece(
                listOf(
                    AndroidDocumentSymbols(XML), AndroidReferencesProvider(), AndroidDefinitionProvider(),
                    ComposeSuppressor.Entry(), AndroidDebugCommands(), AndroidResourceCommands(),
                    AndroidCompiledResourceClassFinder.Entry(), AndroidResourceNavigation.Entry(), AndroidLintProvider()
                ),
                listOf(module.parent),
                emptyList()
            )
        }

    companion object {
        @JvmField
        val XML = LSLanguage("xml", XMLLanguage.INSTANCE, listOf("xml"))
    }
}
