package org.jetbrains.android.navigation;

import com.intellij.openapi.module.Module;
import com.jetbrains.lsp.protocol.Location;

public record ResourceDeclarationTarget(
        Module module,
        String namespace,
        String variant,
        String type,
        String name,
        Location declarationLocation
) {
}
