package org.jetbrains.android;

import com.jetbrains.ls.api.core.LSServer;
import com.jetbrains.ls.api.core.features.LSDefinitionLocation;
import com.jetbrains.ls.api.features.definition.LSDefinitionProvider;
import com.jetbrains.ls.api.features.language.LSLanguage;
import com.jetbrains.lsp.implementation.LspHandlerContext;
import com.jetbrains.lsp.protocol.DefinitionParams;

import java.util.Set;

import kotlinx.coroutines.flow.Flow;

public final class AndroidDefinitionProvider implements LSDefinitionProvider {
    @Override
    public Set<LSLanguage> getSupportedLanguages() {
        return Set.of(AndroidExtension.XML,
                new LSLanguage("java", com.intellij.lang.java.JavaLanguage.INSTANCE, java.util.List.of("java")),
                new LSLanguage("kotlin", org.jetbrains.kotlin.idea.KotlinLanguage.INSTANCE, java.util.List.of("kt", "kts")));
    }

    @Override
    public Flow<LSDefinitionLocation> provideDefinitions(LSServer server, LspHandlerContext handlerContext, DefinitionParams params) {
        return AndroidRequests.query(server, params.getTextDocument(), params.getPosition(),
                (project, file, offset) -> AndroidNavigationService.getInstance().getDefinitions(project, file, offset));
    }
}
