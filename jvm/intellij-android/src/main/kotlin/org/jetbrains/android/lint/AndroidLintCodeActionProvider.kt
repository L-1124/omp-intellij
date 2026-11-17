package org.jetbrains.android.lint

import com.android.tools.lint.client.api.ConfigurationHierarchy
import com.android.tools.lint.client.api.LintClient
import com.android.tools.lint.client.api.LintFixPerformer
import com.android.tools.lint.client.api.LintXmlConfiguration
import com.android.tools.lint.detector.api.Incident
import com.android.tools.lint.detector.api.LintFix
import com.android.tools.lint.detector.api.Severity
import com.android.utils.XmlUtils
import com.intellij.openapi.editor.Document
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.project.Project
import com.intellij.psi.PsiFile
import com.intellij.psi.util.PsiTreeUtil
import com.intellij.psi.xml.XmlFile
import com.intellij.psi.xml.XmlTag
import com.intellij.xml.util.XmlTagUtil
import com.jetbrains.ls.api.core.LSServer
import com.jetbrains.ls.api.core.util.uri
import com.jetbrains.ls.api.features.codeActions.LSCodeActionProvider
import com.jetbrains.ls.api.features.language.LSLanguage
import com.jetbrains.lsp.implementation.LspHandlerContext
import com.jetbrains.lsp.protocol.*
import kotlinx.coroutines.flow.Flow
import org.jetbrains.android.AndroidExtension
import org.jetbrains.android.context.AndroidRequests
import java.io.File
import java.nio.file.Files

class AndroidLintCodeActionProvider : LSCodeActionProvider {

    override val supportedLanguages: Set<LSLanguage> = setOf(
        AndroidExtension.JAVA,
        AndroidExtension.KOTLIN,
        AndroidExtension.XML,
        AndroidExtension.PROPERTIES,
        AndroidExtension.TOML,
        AndroidExtension.GROOVY,
        AndroidExtension.PROGUARD
    )

    override val providesOnlyKinds: Set<CodeActionKind> = setOf(CodeActionKind.QuickFix)

    context(server: LSServer, handlerContext: LspHandlerContext)
    override fun getCodeActions(params: CodeActionParams): Flow<CodeAction> =
        AndroidRequests.diagnosticQuery(server, params.textDocument) { project, file, document ->
            val virtualFile = file.virtualFile
            val items = AndroidLintProvider.getLiveIncidents(project, file, document)
            if (items.isEmpty()) return@diagnosticQuery AndroidRequests.DiagnosticResult(emptyList())

            val matching = items.filter { (diag, _) ->
                (params.context.diagnostics.isNotEmpty() && params.context.diagnostics.any { d ->
                    d.range == diag.range && (d.code == diag.code || d.message == diag.message)
                }) || rangesIntersect(diag.range, params.range)
            }

            if (matching.isEmpty()) return@diagnosticQuery AndroidRequests.DiagnosticResult(emptyList())

            val result = ArrayList<CodeAction>()
            val docUri = DocumentUri(virtualFile.uri)
            val client = AndroidLintProvider.getLiveClient(virtualFile.uri.uri)

            val fileContentsMap = mutableMapOf<File, String>()
            runCatching {
                val ioFile = file.virtualFile.toNioPath().toFile()
                fileContentsMap[ioFile] = document.text
            }
            val fileProvider = InMemoryFileProvider { f -> fileContentsMap[f] }

            for ((diag, incident) in matching) {
                ProgressManager.checkCanceled()

                val fix = incident.fix
                if (fix != null && client != null) {
                    val performer = InactiveLintFixPerformer(client)
                    val alternatives = unpackFixes(incident, fix)
                    for (altFix in alternatives) {
                        val codeAction =
                            buildCodeActionForFix(incident, altFix, diag, performer, fileProvider, document, docUri)
                        if (codeAction != null) {
                            result.add(codeAction)
                        }
                    }
                }

                val codeSuppress = computeCodeSuppress(file, document, diag, incident)
                if (codeSuppress != null) {
                    result.add(codeSuppress)
                }

                if (client != null) {
                    val lintXmlSuppress = computeLintXmlSuppress(project, file, diag, incident, client)
                    if (lintXmlSuppress != null) {
                        result.add(lintXmlSuppress)
                    }
                }
            }

            AndroidRequests.DiagnosticResult(result)
        }

    private fun unpackFixes(incident: Incident, fix: LintFix): List<LintFix> {
        if (fix is LintFix.LintFixGroup && fix.type == LintFix.GroupType.ALTERNATIVES) {
            val result = ArrayList<LintFix>()
            for (child in fix.fixes) {
                result.addAll(unpackFixes(incident, child))
            }
            return result
        }
        return listOf(fix)
    }

    private fun buildCodeActionForFix(
        incident: Incident,
        fix: LintFix,
        diag: Diagnostic,
        performer: InactiveLintFixPerformer,
        fileProvider: InMemoryFileProvider,
        currentDocument: Document,
        currentDocUri: DocumentUri
    ): CodeAction? {
        val pendingEditFiles = runCatching { performer.computeEdits(incident, fix, fileProvider) }.getOrNull()
            ?: return null
        if (pendingEditFiles.isEmpty()) return null

        val changes = LinkedHashMap<DocumentUri, List<TextEdit>>()
        for (editFile in pendingEditFiles) {
            val textEdits = ArrayList<TextEdit>()
            val fileText = fileProvider.getFileContents(editFile)
            val lineIndex = LineIndex(fileText)

            for (edit in editFile.edits) {
                val range = lineIndex.range(edit.startOffset, edit.endOffset)
                textEdits.add(TextEdit(range = range, newText = edit.replacement))
            }

            if (editFile.createText && textEdits.isEmpty()) {
                val bytes = editFile.createBytes
                val newContent = if (bytes != null) String(bytes, Charsets.UTF_8) else ""
                textEdits.add(TextEdit(range = Range(Position(0, 0), Position(0, 0)), newText = newContent))
            }

            if (textEdits.isNotEmpty()) {
                textEdits.sortWith(
                    compareBy<TextEdit> { it.range.start.line }
                        .thenBy { it.range.start.character }
                        .thenBy { it.range.end.line }
                        .thenBy { it.range.end.character }
                )
                val targetUri = DocumentUri(URI(editFile.file.toURI().toString()))
                changes[targetUri] = textEdits
            }
        }

        if (changes.isEmpty()) return null
        val title = fix.getDisplayName() ?: fix.getFamilyName() ?: "Fix ${incident.issue.id}"
        val isPreferred = fix.robot && fix.independent

        return CodeAction(
            title = title,
            kind = CodeActionKind.QuickFix,
            diagnostics = listOf(diag),
            isPreferred = isPreferred,
            edit = WorkspaceEdit(changes = changes)
        )
    }

    private fun computeCodeSuppress(
        file: PsiFile,
        document: Document,
        diagnostic: Diagnostic,
        incident: Incident
    ): CodeAction? {
        val issueId = incident.issue.id
        val startOffset = incident.location.start?.offset ?: return null
        val clamped = startOffset.coerceIn(0, document.textLength)
        val line = document.getLineNumber(clamped)
        val lineStart = document.getLineStartOffset(line)
        val lineEnd = document.getLineEndOffset(line)
        val lineText = document.charsSequence.subSequence(lineStart, lineEnd).toString()
        val indent = lineText.takeWhile { it == ' ' || it == '\t' }
        val docUri = DocumentUri(file.virtualFile.uri)

        if (file is XmlFile || file.name.endsWith(".xml")) {
            val rootTag = (file as? XmlFile)?.rootTag ?: return null
            val element = file.findElementAt(clamped)
            val targetTag = PsiTreeUtil.getParentOfType(element, XmlTag::class.java, false) ?: rootTag
            val existingIgnore = targetTag.getAttribute("tools:ignore")
            val edits = ArrayList<TextEdit>()

            if (rootTag.getAttribute("xmlns:tools") == null) {
                val rootNameEnd = XmlTagUtil.getStartTagNameElement(rootTag)?.textRange?.endOffset ?: return null
                val pos = position(document, rootNameEnd)
                edits.add(TextEdit(Range(pos, pos), " xmlns:tools=\"http://schemas.android.com/tools\""))
            }

            if (existingIgnore != null) {
                val valueElement = existingIgnore.valueElement
                if (valueElement != null) {
                    val valRange = AndroidLintProvider.range(
                        document,
                        valueElement.textOffset,
                        valueElement.textOffset + valueElement.textLength
                    )
                    if (valRange != null) {
                        val currentVal = existingIgnore.value ?: ""
                        edits.add(TextEdit(valRange, "\"$currentVal,$issueId\""))
                    }
                }
            } else {
                val insertOffset = XmlTagUtil.getStartTagNameElement(targetTag)?.textRange?.endOffset ?: return null
                val pos = position(document, insertOffset)
                edits.add(TextEdit(Range(pos, pos), " tools:ignore=\"$issueId\""))
            }

            if (edits.isEmpty()) return null
            return CodeAction(
                title = "Suppress '$issueId' with tools:ignore",
                kind = CodeActionKind.QuickFix,
                diagnostics = listOf(diagnostic),
                isPreferred = false,
                edit = WorkspaceEdit(changes = mapOf(docUri to edits))
            )
        }

        if (file.name.endsWith(".java") || file.name.endsWith(".kt")) {
            val edit = TextEdit(
                range = Range(Position(line, 0), Position(line, 0)),
                newText = "${indent}@SuppressLint(\"$issueId\")\n"
            )
            return CodeAction(
                title = "Suppress '$issueId' with @SuppressLint",
                kind = CodeActionKind.QuickFix,
                diagnostics = listOf(diagnostic),
                isPreferred = false,
                edit = WorkspaceEdit(changes = mapOf(docUri to listOf(edit)))
            )
        }

        val commentPrefix = if (file.name.endsWith(".gradle") || file.name.endsWith(".gradle.kts")) "//" else "#"
        val edit = TextEdit(
            range = Range(Position(line, 0), Position(line, 0)),
            newText = "${indent}${commentPrefix}noinspection $issueId\n"
        )
        return CodeAction(
            title = "Suppress '$issueId' with comment",
            kind = CodeActionKind.QuickFix,
            diagnostics = listOf(diagnostic),
            isPreferred = false,
            edit = WorkspaceEdit(changes = mapOf(docUri to listOf(edit)))
        )
    }

    private fun computeLintXmlSuppress(
        project: Project,
        file: PsiFile,
        diagnostic: Diagnostic,
        incident: Incident,
        client: LintClient
    ): CodeAction? {
        val model = AndroidLintModelResolver.resolve(project, file.virtualFile) ?: return null
        val targetLintXml = model.moduleRoot?.resolve("lint.xml")
            ?: model.projectRoot?.resolve("lint.xml")
            ?: return null

        val tempDir = runCatching { Files.createTempDirectory("omp-lint-suppress").toFile() }.getOrNull() ?: return null
        val newXmlText = try {
            val tempXml = File(tempDir, "lint.xml")
            val initialText = if (Files.isRegularFile(targetLintXml)) {
                Files.readString(targetLintXml)
            } else {
                "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<lint>\n</lint>\n"
            }
            tempXml.writeText(initialText)
            val hierarchy = ConfigurationHierarchy(client, tempDir)
            val config = LintXmlConfiguration.create(hierarchy, tempXml)
            config.startBulkEditing()
            val ioFile = runCatching { file.virtualFile.toNioPath().toFile() }.getOrNull() ?: File(file.name)
            config.ignore(incident.issue, ioFile)
            config.finishBulkEditing()
            tempXml.readText()
        } catch (_: Throwable) {
            return null
        } finally {
            tempDir.deleteRecursively()
        }

        val lintXmlUri = DocumentUri(URI(targetLintXml.toUri().toString()))
        val edit = if (Files.isRegularFile(targetLintXml)) {
            val oldText = Files.readString(targetLintXml)
            val oldIndex = LineIndex(oldText)
            val fullRange = oldIndex.range(0, oldText.length)
            TextEdit(range = fullRange, newText = newXmlText)
        } else {
            TextEdit(range = Range(Position(0, 0), Position(0, 0)), newText = newXmlText)
        }

        return CodeAction(
            title = "Suppress '${incident.issue.id}' in lint.xml",
            kind = CodeActionKind.QuickFix,
            diagnostics = listOf(diagnostic),
            isPreferred = false,
            edit = WorkspaceEdit(changes = mapOf(lintXmlUri to listOf(edit)))
        )
    }

    private fun rangesIntersect(r1: Range, r2: Range): Boolean {
        if (r1.start.line > r2.end.line || (r1.start.line == r2.end.line && r1.start.character > r2.end.character)) return false
        if (r2.start.line > r1.end.line || (r2.start.line == r1.end.line && r2.start.character > r1.end.character)) return false
        return true
    }

    private fun position(document: Document, offset: Int): Position {
        val line = document.getLineNumber(offset)
        return Position(line, offset - document.getLineStartOffset(line))
    }

    class LineIndex(private val text: String) {
        private val lineStarts: IntArray

        init {
            val starts = ArrayList<Int>()
            starts.add(0)
            var i = 0
            while (i < text.length) {
                val c = text[i]
                if (c == '\n') {
                    starts.add(i + 1)
                } else if (c == '\r') {
                    if (i + 1 < text.length && text[i + 1] == '\n') {
                        starts.add(i + 2)
                        i++
                    } else {
                        starts.add(i + 1)
                    }
                }
                i++
            }
            lineStarts = starts.toIntArray()
        }

        fun position(offset: Int): Position {
            val clamped = offset.coerceIn(0, text.length)
            var low = 0
            var high = lineStarts.size - 1
            var line = 0
            while (low <= high) {
                val mid = (low + high) ushr 1
                if (lineStarts[mid] <= clamped) {
                    line = mid
                    low = mid + 1
                } else {
                    high = mid - 1
                }
            }
            val col = clamped - lineStarts[line]
            return Position(line, col)
        }

        fun range(startOffset: Int, endOffset: Int): Range =
            Range(position(startOffset), position(endOffset))
    }

    class InMemoryFileProvider(
        private val getContents: (File) -> String?
    ) : LintFixPerformer.FileProvider {
        override fun getFileContents(file: LintFixPerformer.PendingEditFile): String {
            return getContents(file.file) ?: runCatching { file.file.readText() }.getOrDefault("")
        }

        override fun getXmlDocument(file: LintFixPerformer.PendingEditFile): org.w3c.dom.Document? {
            val text = getFileContents(file)
            return try {
                XmlUtils.parseDocumentSilently(text, true)
            } catch (_: Throwable) {
                null
            }
        }

        override fun createBinaryFile(fileData: LintFixPerformer.PendingEditFile, contents: ByteArray) {}

        override fun deleteFile(fileData: LintFixPerformer.PendingEditFile) {}
    }

    class InactiveLintFixPerformer(
        client: LintClient
    ) : LintFixPerformer(client, false) {
        override fun log(severity: Severity, message: String) {}

        override fun applyEdits(
            fileProvider: FileProvider,
            fileData: PendingEditFile,
            edits: List<PendingEdit>
        ) {
        }
    }
}
