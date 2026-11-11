package org.jetbrains.android.navigation

import com.intellij.lang.java.JavaLanguage
import com.jetbrains.ls.api.core.LSServer
import com.jetbrains.ls.api.core.features.LSDefinitionLocation
import com.jetbrains.ls.api.features.definition.LSDefinitionProvider
import com.jetbrains.ls.api.features.language.LSLanguage
import com.jetbrains.lsp.implementation.LspHandlerContext
import com.jetbrains.lsp.protocol.DefinitionParams
import kotlinx.coroutines.flow.Flow
import org.jetbrains.android.AndroidExtension
import org.jetbrains.android.context.AndroidRequests
import org.jetbrains.kotlin.idea.KotlinLanguage

class AndroidDefinitionProvider : LSDefinitionProvider {
    override val supportedLanguages: Set<LSLanguage>
        get() = setOf(
            AndroidExtension.XML,
            LSLanguage("java", JavaLanguage.INSTANCE, listOf("java")),
            LSLanguage("kotlin", KotlinLanguage.INSTANCE, listOf("kt", "kts"))
        )

    context(server: LSServer, handlerContext: LspHandlerContext)
    override fun provideDefinitions(params: DefinitionParams): Flow<LSDefinitionLocation> {
        return AndroidRequests.query(
            server,
            params.textDocument,
            params.position
        ) { project, file, offset ->
            AndroidNavigationService.getInstance().getDefinitions(project, file, offset)
        }
    }
}
