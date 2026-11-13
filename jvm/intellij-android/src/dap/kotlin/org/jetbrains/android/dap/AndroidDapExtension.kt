package org.jetbrains.android.dap

import com.intellij.ide.plugins.ContentModuleDescriptor
import com.intellij.ide.plugins.cl.PluginAwareClassLoader
import com.intellij.openapi.diagnostic.Logger
import com.jetbrains.ls.api.features.LanguageServerExtension
import com.jetbrains.ls.api.features.dap.DapPluginsProvider
import com.jetbrains.ls.api.features.language.LSConfigurationPiece
import org.jetbrains.android.debug.AndroidDapServer
import org.jetbrains.annotations.ApiStatus
import org.jetbrains.android.run.AndroidRunCommands

@Suppress("UnstableApiUsage")
@ApiStatus.Internal
class AndroidDapExtension : LanguageServerExtension {
    @get:ApiStatus.Internal
    override val configuration: LSConfigurationPiece
        get() {
            Logger.getInstance(AndroidDapExtension::class.java)
                .info("OMP Android DAP providers loaded for ILS 271.2085.0")
            val loader = AndroidDapExtension::class.java.classLoader as? PluginAwareClassLoader
            val module = loader?.pluginDescriptor as? ContentModuleDescriptor
                ?: error("Android DAP extension content module descriptor unavailable")
            return LSConfigurationPiece(
                entries = listOf(
                    AndroidDapServer(),
                    AndroidRunCommands(),
                    DapPluginsProvider(listOf(module.parent))
                )
            )
        }
}
