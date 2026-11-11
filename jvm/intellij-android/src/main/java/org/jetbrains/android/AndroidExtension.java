package org.jetbrains.android;

import com.intellij.lang.xml.XMLLanguage;
import com.jetbrains.ls.api.features.LanguageServerExtension;
import com.jetbrains.ls.api.features.language.LSConfigurationPiece;
import com.jetbrains.ls.api.features.language.LSLanguage;
import org.jetbrains.android.compose.ComposeSuppressor;
import org.jetbrains.android.debug.AndroidDebugCommands;
import org.jetbrains.android.navigation.AndroidDefinitionProvider;
import org.jetbrains.android.lint.AndroidLintProvider;
import org.jetbrains.android.navigation.AndroidReferencesProvider;
import org.jetbrains.android.navigation.AndroidResourceCommands;
import org.jetbrains.android.xml.AndroidDocumentSymbols;
import java.util.List;

public final class AndroidExtension implements LanguageServerExtension {
    public static final LSLanguage XML = new LSLanguage("xml", XMLLanguage.INSTANCE, List.of("xml"));

    @Override
    public LSConfigurationPiece getConfiguration() {
        com.intellij.openapi.diagnostic.Logger.getInstance(AndroidExtension.class).info("OMP Android providers loaded for ILS 271.2085.0");
        try {
            // Disable batch evaluation so Android VM doesn't attempt to load BatchEvaluatorServer.class
            com.intellij.openapi.util.registry.Registry.get("debugger.batch.evaluation").setValue(false);
            com.intellij.openapi.util.registry.Registry.get("debugger.batch.evaluation.force").setValue(false);

            // Disable ToStringRenderer so Android UI objects (like MainActivity this) don't hang JDWP
            com.intellij.debugger.settings.NodeRendererSettings rendererSettings =
                    com.intellij.debugger.settings.NodeRendererSettings.getInstance();
            if (rendererSettings != null && rendererSettings.getToStringRenderer() != null) {
                rendererSettings.getToStringRenderer().setEnabled(false);
                rendererSettings.fireRenderersChanged();
            }

            // Disable autoExpressions
            com.intellij.xdebugger.settings.XDebuggerSettingsManager settingsManager =
                    com.intellij.xdebugger.settings.XDebuggerSettingsManager.getInstance();
            if (settingsManager != null && settingsManager.getDataViewSettings() != null) {
                settingsManager.getDataViewSettings().setAutoExpressions(false);
            }
        } catch (Throwable ignored) {
        }

        if (!(AndroidExtension.class.getClassLoader() instanceof com.intellij.ide.plugins.cl.PluginAwareClassLoader loader)
                || !(loader.getPluginDescriptor() instanceof com.intellij.ide.plugins.ContentModuleDescriptor module)) {
            throw new IllegalStateException("Android extension content module descriptor unavailable");
        }
        com.intellij.ide.plugins.PluginMainDescriptor descriptor = module.parent;
        return new LSConfigurationPiece(
                List.of(new AndroidDocumentSymbols(XML), new AndroidReferencesProvider(), new AndroidDefinitionProvider(), new ComposeSuppressor.Entry(), new AndroidDebugCommands(), new AndroidResourceCommands(), new org.jetbrains.android.navigation.AndroidCompiledResourceClassFinder.Entry(), new org.jetbrains.android.navigation.AndroidResourceNavigation.Entry(), new AndroidLintProvider()),
                List.of(descriptor),
                List.of()
        );
    }
}
