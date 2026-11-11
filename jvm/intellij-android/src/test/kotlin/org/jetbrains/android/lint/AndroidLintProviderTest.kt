package org.jetbrains.android.lint

import com.android.ide.common.resources.ResourceRepository
import com.android.tools.lint.checks.ApiDetector
import com.android.tools.lint.client.api.ConfigurationHierarchy
import com.android.tools.lint.client.api.GradleVisitor
import com.android.tools.lint.client.api.IssueRegistry
import com.android.tools.lint.client.api.LintClient
import com.android.tools.lint.client.api.LintXmlConfiguration
import com.android.tools.lint.client.api.ResourceRepositoryScope
import com.android.tools.lint.client.api.UastParser
import com.android.tools.lint.client.api.XmlParser
import com.android.tools.lint.detector.api.Category
import com.android.tools.lint.detector.api.Context
import com.android.tools.lint.detector.api.Detector
import com.android.tools.lint.detector.api.Implementation
import com.android.tools.lint.detector.api.Incident
import com.android.tools.lint.detector.api.Issue
import com.android.tools.lint.detector.api.Location
import com.android.tools.lint.detector.api.Scope
import com.android.tools.lint.detector.api.Severity
import com.android.tools.lint.detector.api.TextFormat
import com.android.tools.lint.detector.api.XmlScanner
import com.intellij.core.CoreApplicationEnvironment
import com.intellij.core.CoreProjectEnvironment
import com.intellij.openapi.Disposable
import com.intellij.openapi.editor.impl.DocumentImpl
import com.intellij.openapi.util.Disposer
import com.jetbrains.lsp.protocol.DiagnosticSeverity
import com.jetbrains.lsp.protocol.Position
import com.jetbrains.lsp.protocol.Range
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.jetbrains.kotlin.idea.KotlinFileType
import org.jetbrains.kotlin.parsing.KotlinParserDefinition
import org.jetbrains.kotlin.psi.KtPsiFactory
import org.junit.AfterClass
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.BeforeClass
import org.junit.Test
import java.io.File
import java.util.ArrayList
import java.util.EnumSet
import java.util.concurrent.CancellationException
import java.util.concurrent.atomic.AtomicInteger

class AndroidLintProviderTest {

    companion object {
        private var disposable: Disposable? = null
        private var environment: CoreProjectEnvironment? = null

        @JvmStatic
        @BeforeClass
        fun createPsiEnvironment() {
            LintClient.clientName = LintClient.CLIENT_UNIT_TESTS
            val disp = Disposer.newDisposable()
            disposable = disp
            val application = CoreApplicationEnvironment(disp)
            application.registerFileType(KotlinFileType.INSTANCE, "kt;kts")
            application.registerParserDefinition(KotlinParserDefinition())
            environment = CoreProjectEnvironment(disp, application)
        }

        @JvmStatic
        @AfterClass
        fun disposePsiEnvironment() {
            disposable?.let { Disposer.dispose(it) }
        }

        private fun clean(script: String): AndroidLintModelResolver.CleanAstResult {
            val file = KtPsiFactory(environment!!.project, false)
                .createFile("build.gradle.kts", script)
            return AndroidLintModelResolver.parseCleanAst(file)
        }
    }

    @Test
    fun cleanModelAcceptsOnlyUnambiguousDecimalLiterals() {
        val model = clean("android { compileSdk = 37; defaultConfig { minSdk = 21; targetSdkVersion(37) } }")
        assertEquals(21, model.minSdk)
        assertEquals(37, model.targetSdk)
        assertEquals(37, model.compileSdk)
        assertFalse(model.minSdkPremiseMissing)
    }

    @Test
    fun cleanModelPreservesMissingPremiseForFlavorsAndBuildTypeOverrides() {
        for (override in listOf(
            "productFlavors { create(\"demo\") { minSdk = 26 } }",
            "buildTypes { getByName(\"debug\") { minSdkVersion(26) } }"
        )) {
            val model = clean("android { defaultConfig { minSdk = 21 }; $override }")
            assertNull(model.minSdk)
            assertTrue(model.minSdkPremiseMissing)
        }
    }

    @Test
    fun cleanModelDoesNotEvaluateDynamicExpressionsOrInventSdkDefaults() {
        for (expression in listOf("libs.versions.minSdk.get().toInt()", "20 + 1", "minimumSdk()")) {
            val model = clean("android { defaultConfig { minSdk = $expression } }")
            assertNull(model.minSdk)
            assertNull(model.targetSdk)
            assertTrue(model.minSdkPremiseMissing)
        }
        val empty = clean("android { compileSdk = 37 }")
        assertNull(empty.minSdk)
        assertNull(empty.targetSdk)
        assertTrue(empty.minSdkPremiseMissing)
    }

    @Test
    fun cleanModelRejectsPreviewAndLaterDynamicAssignments() {
        val preview = clean("android { defaultConfig { minSdk = 21; minSdkPreview = \"Future\" } }")
        assertNull(preview.minSdk)
        assertTrue(preview.minSdkPremiseMissing)
        val dynamic =
            clean("android { compileSdk = 37; compileSdk = selectedCompileSdk; defaultConfig { minSdk = 21; targetSdk = 37; targetSdk = selectedTarget } }")
        assertNull(dynamic.compileSdk)
        assertNull(dynamic.targetSdk)
        assertEquals(21, dynamic.minSdk)

        val dynamicFirst =
            clean("android { compileSdk = selectedCompileSdk; compileSdk = 37; defaultConfig { minSdk = selectedMin; minSdk = 21; targetSdk = selectedTarget; targetSdk = 37 } }")
        assertNull(dynamicFirst.compileSdk)
        assertNull(dynamicFirst.targetSdk)
        assertNull(dynamicFirst.minSdk)
        assertTrue(dynamicFirst.compileSdkUnsafe)
        assertTrue(dynamicFirst.targetSdkUnsafe)
        assertTrue(dynamicFirst.minSdkUnsafe)
        assertTrue(dynamicFirst.minSdkPremiseMissing)

        val targetPreview = clean("android { defaultConfig { targetSdk = 37; targetSdkPreview = \"Future\" } }")
        assertNull(targetPreview.targetSdk)
        assertTrue(targetPreview.targetSdkUnsafe)
    }

    @Test
    fun cleanModelDoesNotBorrowConfigurationFromNestedProjects() {
        val nested = clean("subprojects { android { defaultConfig { minSdk = 21 } } }")
        assertNull(nested.minSdk)
        assertTrue(nested.minSdkPremiseMissing)
    }

    @Test
    fun rangesUseUtf16OffsetsAndClampAtDocumentEnd() {
        val document = DocumentImpl("a\uD83D\uDE00z\nnext")
        assertEquals(
            Range(Position(0, 1), Position(0, 3)),
            AndroidLintProvider.range(document, 1, 3)
        )
        assertEquals(
            Range(Position(0, 3), Position(1, 4)),
            AndroidLintProvider.range(document, 3, 100)
        )
        assertEquals(
            Range(Position(1, 0), Position(1, 4)),
            AndroidLintProvider.range(document, 5, 9)
        )
    }

    @Test
    fun invalidOrEmptyRangesDoNotProduceDiagnostics() {
        val document = DocumentImpl("abc")
        assertNull(AndroidLintProvider.range(document, -1, 2))
        assertNull(AndroidLintProvider.range(document, 1, 1))
        assertNull(AndroidLintProvider.range(document, 2, 1))
        assertNull(AndroidLintProvider.range(document, 3, 8))
    }

    @Test
    fun editorRegistryRetainsNewApiAndRejectsBytecodeOnlyRules() {
        val issues = AndroidLintIssueRegistry().issues
        assertTrue(issues.contains(ApiDetector.UNSUPPORTED))
        for (issue in issues) {
            val implementation = issue.implementation
            if (implementation.detectorClass == ApiDetector::class.java) continue
            val bytecode = EnumSet.of(Scope.CLASS_FILE, Scope.ALL_CLASS_FILES, Scope.JAVA_LIBRARIES)
            if (implementation.scope.none { bytecode.contains(it) }) continue
            assertTrue(
                issue.id,
                implementation.analysisScopes.any { scope ->
                    scope.contains(Scope.JAVA_FILE) && scope.none { bytecode.contains(it) }
                }
            )
        }
    }

    @Test
    fun editorScopesRequireAllPrerequisitesOrACompleteAnalysisAlternative() {
        val mixed = Implementation(
            TestDetector::class.java,
            EnumSet.of(Scope.RESOURCE_FILE, Scope.JAVA_FILE)
        )
        val issue = Issue.create(
            "MixedInputs", "Mixed inputs", "Needs both inputs.",
            Category.CORRECTNESS, 5, Severity.WARNING, mixed
        )
        assertFalse(AndroidLintIssueRegistry.isIssueSupported(issue, Scope.RESOURCE_FILE))
        assertFalse(AndroidLintIssueRegistry.isIssueSupported(issue, Scope.JAVA_FILE))
        val incremental = Implementation(
            TestDetector::class.java,
            EnumSet.of(Scope.RESOURCE_FILE, Scope.JAVA_FILE), EnumSet.of(Scope.RESOURCE_FILE)
        )
        val partial = Issue.create(
            "IncrementalInputs", "Incremental inputs", "Supports a single XML file.",
            Category.CORRECTNESS, 5, Severity.WARNING, incremental
        )
        assertTrue(AndroidLintIssueRegistry.isIssueSupported(partial, Scope.RESOURCE_FILE))
        assertFalse(AndroidLintIssueRegistry.isIssueSupported(partial, Scope.MANIFEST))
    }

    class TestDetector : Detector(), XmlScanner

    @Test
    fun xmlConfigurationAppliesIgnoreAndWarning() {
        val client: LintClient = XmlClient()
        val file = File("lint.xml")
        val ignored = "<lint><issue id=\"NewApi\" severity=\"ignore\"/></lint>"
        var configuration = LintXmlConfiguration.create(client.configurations, file, ignored)
        assertEquals(Severity.IGNORE, configuration.getSeverity(ApiDetector.UNSUPPORTED))
        val warning = "<lint><issue id=\"NewApi\" severity=\"warning\"/></lint>"
        configuration = LintXmlConfiguration.create(ConfigurationHierarchy(client, null), file, warning)
        assertEquals(Severity.WARNING, configuration.getSeverity(ApiDetector.UNSUPPORTED))
        val parser = AndroidLintXmlParser(client)
        val xml = parser.parseXml(warning, file)
        assertNotNull(xml)
        val issue = xml!!.getElementsByTagName("issue").item(0)
        val location = parser.getLocation(file, issue)
        val start = location.start
        val end = location.end
        assertEquals(warning.indexOf("<issue"), start!!.offset)
        assertEquals(warning.indexOf("/>") + 2, end!!.offset)
    }

    @Test
    fun diagnosticMappingPreservesSeverityAndDeduplicatesByRangeCodeAndMessage() {
        val document = DocumentImpl("abc\nnext")
        val location = Location.create(File("Main.java"), document.text, 4, 8)
        val warning = Incident(ApiDetector.UNSUPPORTED, "API requires 26", location).overrideSeverity(Severity.WARNING)
        val ignored = Incident(ApiDetector.UNSUPPORTED, "ignored", location).overrideSeverity(Severity.IGNORE)
        val values = AndroidLintProvider.diagnostics(listOf(warning, ignored, warning), document)
        assertEquals(1, values.size)
        assertEquals(Range(Position(1, 0), Position(1, 4)), values.first().range)
        assertEquals(DiagnosticSeverity.Warning, values.first().severity)
        assertEquals("android-lint", values.first().source)
        assertEquals("API requires 26", values.first().message)
        assertEquals(
            JsonPrimitive("NewApi"),
            (values.first().data as JsonObject)["issueId"]
        )
    }

    @Test
    fun registryIsolationDiscardsPartialOutputAndRetainsHealthyIncidents() {
        val healthy = object : IssueRegistry() {
            override val issues: List<Issue>
                get() = listOf(ApiDetector.UNSUPPORTED)
        }
        val broken = object : IssueRegistry() {
            override val issues: List<Issue>
                get() = throw NoSuchMethodError("incompatible lint API")
        }
        val location = Location.create(File("Main.java"), "call", 0, 4)
        val expected = Incident(ApiDetector.UNSUPPORTED, "requires API 26", location)
        val partial = ArrayList<Incident>()
        val incidents = AndroidLintClient.runWithIsolation(listOf(healthy, broken)) { registry ->
            partial.clear()
            partial.add(expected)
            registry.issues
            java.util.List.copyOf(partial)
        }
        assertEquals(listOf(expected), incidents)
    }

    @Test
    fun registryIsolationPropagatesCancellationWithoutRetry() {
        val canceled = CancellationException("request canceled")
        val attempts = AtomicInteger()
        val registry = AndroidLintIssueRegistry()
        val result = assertThrows(CancellationException::class.java) {
            AndroidLintClient.runWithIsolation(listOf(registry)) {
                attempts.incrementAndGet()
                throw canceled
            }
        }
        assertSame(canceled, result)
        assertEquals(1, attempts.get())
    }

    private class XmlClient : LintClient(CLIENT_UNIT_TESTS) {
        override val xmlParser: XmlParser = AndroidLintXmlParser(this)

        override fun readFile(file: File): CharSequence {
            throw AssertionError(file)
        }

        override fun report(context: Context, incident: Incident, format: TextFormat) {
            throw AssertionError(incident)
        }

        override fun log(severity: Severity, exception: Throwable?, format: String?, vararg args: Any) {
            throw AssertionError(format, exception)
        }

        override fun getUastParser(project: com.android.tools.lint.detector.api.Project?): UastParser {
            throw AssertionError()
        }

        override fun getGradleVisitor(): GradleVisitor {
            throw AssertionError()
        }

        override fun getResources(
            project: com.android.tools.lint.detector.api.Project,
            scope: ResourceRepositoryScope
        ): ResourceRepository {
            throw AssertionError()
        }
    }
}
