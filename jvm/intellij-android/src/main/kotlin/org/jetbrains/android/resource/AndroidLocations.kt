package org.jetbrains.android.resource

import com.intellij.openapi.vfs.VfsUtilCore
import com.jetbrains.ls.api.core.util.intellijUriToLspUri
import com.jetbrains.ls.api.core.util.lspUriToIntellijUri
import com.jetbrains.lsp.protocol.DocumentUri
import com.jetbrains.lsp.protocol.Location
import com.jetbrains.lsp.protocol.Range
import com.jetbrains.lsp.protocol.URI
import java.nio.file.Path

object AndroidLocations {
    @JvmStatic
    fun at(path: Path, range: Range): Location {
        val url = VfsUtilCore.pathToUrl(path.toAbsolutePath().normalize().toString())
        val uri = url.intellijUriToLspUri()
        return Location(DocumentUri(uri), range)
    }

    @JvmStatic
    fun path(location: Location): Path {
        val url = location.uri.uri.lspUriToIntellijUri()
            ?: throw IllegalStateException("Cannot convert LSP URI to IntelliJ URI: ${location.uri}")
        return Path.of(VfsUtilCore.urlToPath(url))
    }
}
