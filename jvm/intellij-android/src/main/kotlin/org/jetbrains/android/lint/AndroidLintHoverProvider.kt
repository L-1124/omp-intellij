package org.jetbrains.android.lint

import com.android.tools.lint.detector.api.TextFormat
import com.intellij.openapi.application.readAction
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.project.Project
import com.intellij.psi.PsiDocumentManager
import com.intellij.psi.PsiManager
import com.jetbrains.ls.api.core.LSAnalysisContext
import com.jetbrains.ls.api.core.LSServer
import com.jetbrains.ls.api.core.util.findVirtualFile
import com.jetbrains.ls.api.features.hover.LSHoverProvider
import com.jetbrains.ls.api.features.language.LSLanguage
import com.jetbrains.lsp.implementation.LspHandlerContext
import com.jetbrains.lsp.protocol.Hover
import com.jetbrains.lsp.protocol.HoverParams
import com.jetbrains.lsp.protocol.MarkupContent
import com.jetbrains.lsp.protocol.MarkupKindType
import com.jetbrains.lsp.protocol.Position
import com.jetbrains.lsp.protocol.Range
import org.jetbrains.android.AndroidExtension

class AndroidLintHoverProvider : LSHoverProvider {

    override val supportedLanguages: Set<LSLanguage> = setOf(
        AndroidExtension.JAVA,
        AndroidExtension.KOTLIN,
        AndroidExtension.XML,
        AndroidExtension.PROPERTIES,
        AndroidExtension.TOML,
        AndroidExtension.GROOVY,
        AndroidExtension.PROGUARD
    )

    context(server: LSServer, handlerContext: LspHandlerContext)
    override suspend fun getHover(params: HoverParams): Hover? =
        server.withAnalysisContext {
            readAction {
                ProgressManager.checkCanceled()
                val project = contextOf<LSAnalysisContext>().project
                val virtualFile = params.textDocument.findVirtualFile() ?: return@readAction null
                val file = PsiManager.getInstance(project).findFile(virtualFile) ?: return@readAction null
                val document = PsiDocumentManager.getInstance(project).getDocument(file) ?: return@readAction null

                val items = AndroidLintProvider.getLiveIncidents(project, file, document)
                if (items.isEmpty()) return@readAction null

                val targetPos = params.position
                val matching = items.firstOrNull { (diag, _) ->
                    containsPosition(diag.range, targetPos)
                } ?: return@readAction null

                val (diagnostic, incident) = matching
                val issue = incident.issue
                val brief = issue.getBriefDescription(TextFormat.RAW)
                val explanation = issue.getExplanation(TextFormat.RAW)
                val moreInfo = issue.moreInfo.firstOrNull()

                val markdown = buildString {
                    appendLine("**${issue.id}**: $brief")
                    appendLine()
                    if (incident.message.isNotBlank() && incident.message != brief) {
                        appendLine(incident.message)
                        appendLine()
                    }
                    if (explanation.isNotBlank()) {
                        appendLine(explanation)
                        appendLine()
                    }
                    if (!moreInfo.isNullOrBlank()) {
                        appendLine("[More information]($moreInfo)")
                    }
                }.trimEnd()

                Hover(
                    contents = Hover.Content.Markup(MarkupContent(MarkupKindType.Markdown, markdown)),
                    range = diagnostic.range
                )
            }
        }

    private fun containsPosition(range: Range, pos: Position): Boolean {
        if (pos.line < range.start.line || pos.line > range.end.line) return false
        if (pos.line == range.start.line && pos.character < range.start.character) return false
        if (pos.line == range.end.line && pos.character > range.end.character) return false
        return true
    }
}
