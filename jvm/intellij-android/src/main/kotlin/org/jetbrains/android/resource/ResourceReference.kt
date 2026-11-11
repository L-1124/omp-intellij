package org.jetbrains.android.resource

import com.jetbrains.lsp.protocol.Range
import java.nio.file.Path

@JvmRecord
data class ResourceReference @JvmOverloads constructor(
    val type: String,
    val name: String,
    val namespace: String?,
    val isFramework: Boolean,
    val originRange: Range?,
    val classOrigin: Path? = null
)
