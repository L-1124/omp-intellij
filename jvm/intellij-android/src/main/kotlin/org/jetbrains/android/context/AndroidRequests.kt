package org.jetbrains.android.context

import com.intellij.openapi.application.readAction
import com.intellij.openapi.editor.Document
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.project.Project
import com.intellij.psi.PsiDocumentManager
import com.intellij.psi.PsiFile
import com.intellij.psi.PsiManager
import com.jetbrains.ls.api.core.LSAnalysisContext
import com.jetbrains.ls.api.core.LSServer
import com.jetbrains.ls.api.core.util.findVirtualFile
import com.jetbrains.lsp.implementation.throwLspError
import com.jetbrains.lsp.protocol.Position
import com.jetbrains.lsp.protocol.TextDocumentIdentifier
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.serialization.json.JsonNull
import org.jetbrains.android.resource.AndroidSources
import java.nio.file.Path

object AndroidRequests {
    fun interface Query<T> {
        fun run(project: Project, file: PsiFile, offset: Int): List<T>
    }

    @JvmRecord
    data class DiagnosticResult<T> @JvmOverloads constructor(
        val values: List<T>,
        val onVerified: Runnable = Runnable {}
    )

    fun interface DiagnosticQuery<T> {
        fun run(project: Project, file: PsiFile, document: Document): DiagnosticResult<T>
    }

    @JvmStatic
    fun <T> query(server: LSServer, identifier: TextDocumentIdentifier, position: Position, query: Query<T>): Flow<T> =
        flow {
            val values = server.withAnalysisContext {
                readAction {
                    ProgressManager.checkCanceled()
                    val project = contextOf<LSAnalysisContext>().project
                    val virtualFile = identifier.findVirtualFile()
                    val file = virtualFile?.let { PsiManager.getInstance(project).findFile(it) }
                        ?: return@readAction emptyList<T>()
                    val document = PsiDocumentManager.getInstance(project).getDocument(file)
                        ?: return@readAction emptyList<T>()
                    val line = position.line
                    if (line < 0 || line >= document.lineCount) return@readAction emptyList<T>()
                    val character = position.character
                    if (character < 0 || character > document.getLineEndOffset(line) - document.getLineStartOffset(line))
                        return@readAction emptyList<T>()
                    val stamp = document.modificationStamp
                    val result = try {
                        AndroidSources.Scope(server, virtualFile).use { sources ->
                            val result = query.run(project, file, document.getLineStartOffset(line) + character)
                            sources.verify()
                            result
                        }
                    } catch (error: AndroidQueryException) {
                        error.throwAsLspError()
                    }
                    ProgressManager.checkCanceled()
                    if (stamp != document.modificationStamp)
                        throwLspError("content_modified", JsonNull, -32801)
                    result
                }
            }
            for (value in values) emit(value)
        }

    @JvmStatic
    fun <T> diagnosticQuery(server: LSServer, identifier: TextDocumentIdentifier, query: DiagnosticQuery<T>): Flow<T> =
        flow {
            val openVersions = AndroidSources.Scope.openVersions(server)
            val values = server.withAnalysisContext {
                readAction {
                    ProgressManager.checkCanceled()
                    val project = contextOf<LSAnalysisContext>().project
                    val virtualFile = identifier.findVirtualFile()
                    val file = virtualFile?.let { PsiManager.getInstance(project).findFile(it) }
                        ?: return@readAction DiagnosticResult<T>(emptyList())
                    val document = PsiDocumentManager.getInstance(project).getDocument(file)
                        ?: return@readAction DiagnosticResult<T>(emptyList())
                    val stamp = document.modificationStamp
                    val contents = document.immutableCharSequence
                    try {
                        AndroidSources.Scope(server, virtualFile, openVersions).use { sources ->
                            sources.useSavedModelInputs()
                            AndroidSources.observeCompiledArchive(Path.of(virtualFile.path))
                            val result = query.run(project, file, document)
                            ProgressManager.checkCanceled()
                            if (stamp != document.modificationStamp)
                                throwLspError("content_modified", JsonNull, -32801)
                            DiagnosticResult(result.values, Runnable {
                                sources.verify()
                                val latestVirtualFile = identifier.findVirtualFile()
                                val latestFile = latestVirtualFile?.let { PsiManager.getInstance(project).findFile(it) }
                                val latest = latestFile?.let { PsiDocumentManager.getInstance(project).getDocument(it) }
                                if (latest == null || java.lang.CharSequence.compare(
                                        contents,
                                        latest.immutableCharSequence
                                    ) != 0
                                )
                                    throw AndroidQueryException("content_modified", -32801)
                                result.onVerified.run()
                            })
                        }
                    } catch (error: AndroidQueryException) {
                        error.throwAsLspError()
                    }
                }
            }
            val verified = server.withAnalysisContext {
                readAction {
                    try {
                        values.onVerified.run()
                    } catch (error: AndroidQueryException) {
                        error.throwAsLspError()
                    }
                    values.values
                }
            }
            for (value in verified) emit(value)
        }
}
