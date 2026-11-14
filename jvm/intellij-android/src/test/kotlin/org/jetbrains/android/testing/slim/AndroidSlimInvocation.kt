package org.jetbrains.android.testing.slim

import com.intellij.openapi.application.readAction
import com.intellij.openapi.module.ModuleManager
import com.intellij.psi.JavaPsiFacade
import com.intellij.psi.search.GlobalSearchScope
import com.intellij.testIntegration.TestFinderHelper
import com.jetbrains.ls.api.core.LSAnalysisContext
import com.jetbrains.ls.api.core.LSServer
import com.jetbrains.ls.api.features.inspectCode.LSBatchInspectionProvider
import com.jetbrains.ls.api.features.relatedTests.LSRelatedTestsProvider
import com.jetbrains.ls.api.features.relatedTests.RelatedTestsParams
import com.jetbrains.lsp.implementation.LspHandlerContext
import com.jetbrains.lsp.protocol.DocumentUri
import com.jetbrains.lsp.protocol.Position
import com.jetbrains.lsp.protocol.TextDocumentIdentifier
import com.jetbrains.lsp.protocol.URI
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.jetbrains.android.AndroidExtension
import java.nio.file.Files
import java.nio.file.Path
import java.util.function.Consumer

class AndroidSlimInvocation : Consumer<Pair<LSServer, LspHandlerContext>> {
    override fun accept(value: Pair<LSServer, LspHandlerContext>) {
        val (server, handlers) = value
        check(AndroidExtension::class.java.classLoader.javaClass.name == "com.intellij.ide.plugins.cl.PluginClassLoader")
        runBlocking(server.handlersContext) {
            with(server) {
                with(handlers) {
                    val entries = AndroidExtension().configuration.entries
                    val batch = entries.filterIsInstance<LSBatchInspectionProvider>().single()
                    val related = entries.filterIsInstance<LSRelatedTestsProvider>().single()
                    val uri = URI(System.getProperty("slim.layoutUri"))
                    val path = Path.of(java.net.URI(uri.uri))
                    documents.didOpen(uri, Files.readString(path), 1, "xml")
                    try {
                        waitForHighWatermark()
                        val catalog = batch.inspections()
                        check(catalog.any { it.info.id == "AndroidLint.ContentDescription" }) {
                            val modules = withAnalysisContext {
                                readAction {
                                    ModuleManager.getInstance(contextOf<LSAnalysisContext>().project).modules.map { it.name }
                                }
                            }
                            "Missing ContentDescription: catalog=${catalog.map { it.info.id }}, modules=$modules"
                        }
                        val report = batch.inspectFile(uri, setOf("AndroidLint.ContentDescription"))
                        check(!report.skipped)
                        check(report.diagnostics.any {
                            Json.parseToJsonElement(
                                Json.encodeToString(
                                    com.jetbrains.lsp.protocol.Diagnostic.serializer(),
                                    it
                                )
                            )
                                .jsonObject["code"]?.jsonPrimitive?.content == "ContentDescription"
                        }) { "Selected batch did not report ContentDescription: ${report.diagnostics}" }
                        val targets = checkNotNull(
                            related.getRelatedTests(
                                RelatedTestsParams(TextDocumentIdentifier(DocumentUri(uri)), Position(2, 4))
                            )
                        ).targets
                        val expectedTest = Path.of(java.net.URI(System.getProperty("slim.expectedTestUri")))
                            .toAbsolutePath().normalize()
                        check(targets.any {
                            Path.of(java.net.URI(it.uri.uri.uri)).toAbsolutePath().normalize() == expectedTest
                        }) {
                            val nativeState = withAnalysisContext {
                                readAction {
                                    val project = contextOf<LSAnalysisContext>().project
                                    val scope = GlobalSearchScope.projectScope(project)
                                    val facade = JavaPsiFacade.getInstance(project)
                                    val source = facade.findClass("com.example.app.ContextPriorityActivity", scope)
                                    val test = facade.findClass("com.example.app.ContextPriorityActivityTest", scope)
                                    "finders=${TestFinderHelper.getFinders().map { it.javaClass.name }}, " +
                                            "source=$source, test=$test, isTest=${test?.let(TestFinderHelper::isTest)}, " +
                                            "nativeTests=${source?.let(TestFinderHelper::findTestsForClass)}"
                                }
                            }
                            "XML relatedTests did not return the context test: $targets; $nativeState"
                        }
                        println("SLIM_ANDROID_REQUESTS_OK inspections=${catalog.size} diagnostics=${report.diagnostics.size} targets=${targets.size}")
                    } finally {
                        documents.didClose(uri)
                    }
                }
            }
        }
    }
}
