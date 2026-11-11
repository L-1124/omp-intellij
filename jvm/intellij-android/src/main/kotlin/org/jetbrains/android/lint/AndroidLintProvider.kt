package org.jetbrains.android.lint

import com.android.tools.lint.detector.api.Incident
import com.android.tools.lint.detector.api.Location
import com.android.tools.lint.detector.api.Scope
import com.android.tools.lint.detector.api.Severity
import com.google.common.hash.Hashing
import com.intellij.lang.java.JavaLanguage
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.editor.Document
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.vfs.VfsUtilCore
import com.intellij.openapi.vfs.VirtualFileManager
import com.jetbrains.ls.api.core.LSServer
import com.jetbrains.ls.api.core.util.uri
import com.jetbrains.ls.api.features.diagnostics.LSDiagnosticProvider
import com.jetbrains.ls.api.features.language.LSLanguage
import com.jetbrains.lsp.implementation.LspHandlerContext
import com.jetbrains.lsp.protocol.Diagnostic
import com.jetbrains.lsp.protocol.DiagnosticRelatedInformation
import com.jetbrains.lsp.protocol.DiagnosticSeverity
import com.jetbrains.lsp.protocol.DocumentDiagnosticParams
import com.jetbrains.lsp.protocol.Position
import com.jetbrains.lsp.protocol.Range
import com.jetbrains.lsp.protocol.StringOrInt
import kotlinx.coroutines.flow.Flow
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.jetbrains.android.AndroidExtension
import org.jetbrains.android.context.AndroidRequests
import org.jetbrains.android.resource.AndroidLocations
import org.jetbrains.android.resource.AndroidSources
import org.jetbrains.kotlin.idea.KotlinLanguage
import java.nio.file.Files
import java.nio.file.Path
import java.util.Collections
import java.util.IdentityHashMap
import java.util.LinkedHashMap

class AndroidLintProvider : LSDiagnosticProvider {

    private data class CacheKey(
        val projectLocationHash: String,
        val fileUri: String,
        val lspDocVersion: Int?,
        val documentModificationStamp: Long,
        val scope: Scope?,
        val modelFingerprint: String?,
        val ruleJarFingerprints: List<String>?,
        val lintXmlFingerprint: String?,
        val contentFingerprint: String
    )

    private val cache: MutableMap<CacheKey, List<Diagnostic>> = Collections.synchronizedMap(
        object : LinkedHashMap<CacheKey, List<Diagnostic>>(64, 0.75f, true) {
            override fun removeEldestEntry(eldest: MutableMap.MutableEntry<CacheKey, List<Diagnostic>>?): Boolean {
                return size > 64
            }
        }
    )

    override val supportedLanguages: Set<LSLanguage> = setOf(
        LSLanguage("java", JavaLanguage.INSTANCE, listOf("java")),
        LSLanguage("kotlin", KotlinLanguage.INSTANCE, listOf("kt", "kts")),
        AndroidExtension.XML
    )

    context(server: LSServer, handlerContext: LspHandlerContext)
    override fun getDiagnostics(params: DocumentDiagnosticParams): Flow<Diagnostic> {
        return AndroidRequests.diagnosticQuery(server, params.textDocument) { project, file, document ->
            val xml = file is com.intellij.psi.xml.XmlFile
            if (!xml && !file.name.endsWith(".java") && !file.name.endsWith(".kt")) {
                return@diagnosticQuery AndroidRequests.DiagnosticResult(emptyList())
            }
            if (xml && !Files.isRegularFile(file.virtualFile.toNioPath())) {
                return@diagnosticQuery AndroidRequests.DiagnosticResult(emptyList())
            }
            val model = AndroidLintModelResolver.resolve(project, file.virtualFile)
                ?: return@diagnosticQuery AndroidRequests.DiagnosticResult(emptyList())
            val scope = if (xml) {
                AndroidLintResources.scope(model, file.virtualFile.toNioPath())
            } else {
                Scope.JAVA_FILE
            } ?: return@diagnosticQuery AndroidRequests.DiagnosticResult(emptyList())
            val uri = file.virtualFile.uri.uri
            val key = CacheKey(
                project.locationHash,
                uri,
                AndroidSources.version(server, uri),
                document.modificationStamp,
                scope,
                model.fingerprint,
                model.ruleJarFingerprints,
                model.lintXmlFingerprint,
                Hashing.sha256().hashUnencodedChars(document.immutableCharSequence).toString()
            )
            val existing = cache[key]
            if (existing != null) {
                Logger.getInstance(AndroidLintProvider::class.java).debug("Android lint cache hit: $uri")
                return@diagnosticQuery AndroidRequests.DiagnosticResult(java.util.List.copyOf(existing))
            }
            val client = AndroidLintClient(model, file, document.text, scope)
            val incidents = client.analyze()
            val values = diagnostics(incidents, document)
            AndroidRequests.DiagnosticResult(values, Runnable {
                if (client.isAnalysisComplete()) {
                    cache[key] = values
                }
            })
        }
    }

    private data class Mapped(val diagnostic: Diagnostic, val code: String)

    companion object {
        @JvmStatic
        fun diagnostics(incidents: List<Incident>, document: Document): List<Diagnostic> {
            val values = ArrayList<Mapped>()
            for (incident in incidents) {
                ProgressManager.checkCanceled()
                val location = incident.location ?: continue
                val start = location.start ?: continue
                val end = location.end ?: continue
                if (incident.severity == Severity.IGNORE) {
                    continue
                }
                val range = range(document, start.offset, end.offset) ?: continue
                val code = incident.issue.id
                val severity = when (incident.severity) {
                    Severity.FATAL, Severity.ERROR -> DiagnosticSeverity.Error
                    Severity.WARNING -> DiagnosticSeverity.Warning
                    else -> DiagnosticSeverity.Information
                }
                val related = ArrayList<DiagnosticRelatedInformation>()
                val seen = Collections.newSetFromMap(IdentityHashMap<Location, Boolean>())
                var secondary = location.secondary
                while (secondary != null && seen.add(secondary)) {
                    val secStart = secondary.start
                    val secEnd = secondary.end
                    if (secStart != null && secEnd != null) {
                        val path = secondary.file.toPath().toAbsolutePath().normalize()
                        val vf = VirtualFileManager.getInstance().findFileByUrl(VfsUtilCore.pathToUrl(path.toString()))
                        if (vf != null) {
                            AndroidSources.observeCompiledArchive(path)
                            AndroidSources.observe(vf)
                            val secondaryDocument = FileDocumentManager.getInstance().getDocument(vf)
                            if (secondaryDocument != null) {
                                val secondaryRange = range(secondaryDocument, secStart.offset, secEnd.offset)
                                if (secondaryRange != null) {
                                    related.add(
                                        DiagnosticRelatedInformation(
                                            AndroidLocations.at(path, secondaryRange),
                                            secondary.message ?: code
                                        )
                                    )
                                }
                            }
                        }
                    }
                    secondary = secondary.secondary
                }
                val data = JsonObject(
                    mapOf(
                        "issueId" to JsonPrimitive(code),
                        "source" to JsonPrimitive("android-lint")
                    )
                )
                val diagnostic = Diagnostic(
                    range = range,
                    severity = severity,
                    code = StringOrInt.string(code),
                    source = "android-lint",
                    message = incident.message,
                    relatedInformation = if (related.isEmpty()) null else java.util.List.copyOf(related),
                    data = data
                )
                values.add(Mapped(diagnostic, code))
            }

            values.sortWith(
                compareBy<Mapped> { it.diagnostic.range.start.line }
                    .thenBy { it.diagnostic.range.start.character }
                    .thenBy { it.diagnostic.range.end.line }
                    .thenBy { it.diagnostic.range.end.character }
                    .thenBy { it.code }
                    .thenBy { it.diagnostic.message }
            )

            val result = ArrayList<Diagnostic>()
            var previous: Mapped? = null
            for (value in values) {
                if (previous == null || previous.code != value.code ||
                    previous.diagnostic.range != value.diagnostic.range ||
                    previous.diagnostic.message != value.diagnostic.message
                ) {
                    result.add(value.diagnostic)
                }
                previous = value
            }
            return java.util.List.copyOf(result)
        }

        @JvmStatic
        fun range(document: Document, start: Int, end: Int): Range? {
            if (start < 0 || end <= start) return null
            val length = document.textLength
            val clampedStart = start.coerceAtMost(length)
            val clampedEnd = end.coerceAtMost(length)
            if (clampedStart >= clampedEnd) return null
            return Range(position(document, clampedStart), position(document, clampedEnd))
        }

        private fun position(document: Document, offset: Int): Position {
            val line = document.getLineNumber(offset)
            return Position(line, offset - document.getLineStartOffset(line))
        }
    }
}
