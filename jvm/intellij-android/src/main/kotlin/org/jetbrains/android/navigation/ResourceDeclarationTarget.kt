package org.jetbrains.android.navigation

import com.intellij.openapi.module.Module
import com.jetbrains.lsp.protocol.Location

@JvmRecord
data class ResourceDeclarationTarget(
    val module: Module,
    val namespace: String,
    val variant: String,
    val type: String,
    val name: String,
    val declarationLocation: Location
)
