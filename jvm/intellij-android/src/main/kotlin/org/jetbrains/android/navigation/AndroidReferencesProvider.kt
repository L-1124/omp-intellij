package org.jetbrains.android.navigation

import com.jetbrains.ls.api.core.LSServer
import com.jetbrains.ls.api.features.language.LSLanguage
import com.jetbrains.ls.api.features.references.LSReferencesProvider
import com.jetbrains.lsp.implementation.LspHandlerContext
import com.jetbrains.lsp.protocol.Location
import com.jetbrains.lsp.protocol.ReferenceParams
import kotlinx.coroutines.flow.Flow
import org.jetbrains.android.AndroidExtension
import org.jetbrains.android.context.AndroidRequests

class AndroidReferencesProvider : LSReferencesProvider {
    override val supportedLanguages: Set<LSLanguage>
        get() = setOf(AndroidExtension.XML)

    context(server: LSServer, handlerContext: LspHandlerContext)
    override fun getReferences(params: ReferenceParams): Flow<Location> {
        return AndroidRequests.query(
            server,
            params.textDocument,
            params.position
        ) { project, file, offset ->
            AndroidNavigationService.getInstance().getReferences(
                project,
                file,
                offset,
                params.context.includeDeclaration
            )
        }
    }
}
