package org.omp.intellij.android;

import com.intellij.lang.xml.XMLLanguage;
import com.jetbrains.ls.api.features.LanguageServerExtension;
import com.jetbrains.ls.api.features.language.LSConfigurationPiece;
import com.jetbrains.ls.api.features.language.LSLanguage;

import java.util.List;

public final class AndroidExtension implements LanguageServerExtension {
    static final LSLanguage XML = new LSLanguage("xml", XMLLanguage.INSTANCE, List.of("xml"));

    @Override
    public LSConfigurationPiece getConfiguration() {
        com.intellij.openapi.diagnostic.Logger.getInstance(AndroidExtension.class).info("OMP Android providers loaded for ILS 271.2085.0");
        var plugin = ((com.intellij.ide.plugins.cl.PluginAwareClassLoader) AndroidExtension.class.getClassLoader()).getPluginDescriptor();
        if (!(plugin instanceof com.intellij.ide.plugins.PluginMainDescriptor descriptor))
            throw new IllegalStateException("Android extension plugin descriptor unavailable");
        return new LSConfigurationPiece(
                List.of(new AndroidDocumentSymbols(XML), new AndroidReferencesProvider(), new AndroidDefinitionProvider(), new ComposeSuppressor.Entry()),
                List.of(descriptor),
                List.of()
        );
    }
}
