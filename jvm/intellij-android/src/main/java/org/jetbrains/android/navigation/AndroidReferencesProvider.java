package org.jetbrains.android.navigation;

import com.jetbrains.ls.api.core.LSServer;
import com.jetbrains.ls.api.features.language.LSLanguage;
import com.jetbrains.ls.api.features.references.LSReferencesProvider;
import com.jetbrains.lsp.implementation.LspHandlerContext;
import com.jetbrains.lsp.protocol.Location;
import com.jetbrains.lsp.protocol.ReferenceParams;
import kotlinx.coroutines.flow.Flow;
import org.jetbrains.android.AndroidExtension;
import org.jetbrains.android.context.AndroidRequests;

import java.util.Set;

public final class AndroidReferencesProvider implements LSReferencesProvider {
    @Override
    public Set<LSLanguage> getSupportedLanguages() {
        return Set.of(AndroidExtension.XML);
    }

    @Override
    public Flow<Location> getReferences(LSServer server, LspHandlerContext handlerContext, ReferenceParams params) {
        return AndroidRequests.query(server, params.getTextDocument(), params.getPosition(),
                (project, file, offset) -> AndroidNavigationService.getInstance().getReferences(project, file, offset, params.getContext().getIncludeDeclaration()));
    }
}
