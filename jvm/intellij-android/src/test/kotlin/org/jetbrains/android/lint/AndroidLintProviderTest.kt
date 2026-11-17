@file:Suppress("UnstableApiUsage")

package org.jetbrains.android.lint

import com.android.resources.ResourceFolderType
import com.android.tools.lint.checks.ApiDetector
import com.android.tools.lint.client.api.IssueRegistry
import com.android.tools.lint.client.api.LintClient
import com.android.tools.lint.client.api.Vendor
import com.android.tools.lint.detector.api.CURRENT_API
import com.android.tools.lint.detector.api.Category
import com.android.tools.lint.detector.api.Detector
import com.android.tools.lint.detector.api.Implementation
import com.android.tools.lint.detector.api.Incident
import com.android.tools.lint.detector.api.GradleContext
import com.android.tools.lint.detector.api.GradleScanner
import com.android.tools.lint.detector.api.Issue
import com.android.tools.lint.detector.api.Location
import com.android.tools.lint.detector.api.Scope
import com.android.tools.lint.detector.api.Severity
import com.android.tools.lint.detector.api.XmlContext
import com.android.tools.lint.detector.api.XmlScanner
import com.intellij.core.CoreApplicationEnvironment
import com.intellij.core.CoreProjectEnvironment
import com.intellij.ide.highlighter.XmlFileType
import com.intellij.lang.xml.XMLLanguage
import com.intellij.lang.xml.XMLParserDefinition
import com.intellij.openapi.Disposable
import com.intellij.openapi.editor.impl.DocumentImpl
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.fileTypes.PlainTextFileType
import com.intellij.psi.PsiManager
import com.intellij.psi.PsiFile
import com.intellij.psi.impl.source.PsiPlainTextFileImpl
import com.intellij.psi.SingleRootFileViewProvider
import com.intellij.psi.xml.XmlFile
import com.intellij.testFramework.LightVirtualFile
import com.jetbrains.lsp.protocol.DiagnosticSeverity
import com.jetbrains.lsp.protocol.Position
import com.jetbrains.lsp.protocol.Range
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.jetbrains.android.resource.AndroidSources
import org.jetbrains.kotlin.idea.KotlinFileType
import org.jetbrains.kotlin.parsing.KotlinParserDefinition
import org.jetbrains.kotlin.psi.KtPsiFactory
import org.junit.AfterClass
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.BeforeClass
import org.junit.Test
import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.nio.file.Path
import java.util.ArrayList
import java.util.Comparator
import java.util.EnumSet
import java.util.UUID
import java.util.concurrent.CancellationException
import java.util.concurrent.atomic.AtomicInteger
import java.util.jar.Attributes
import java.util.jar.JarOutputStream
import java.util.jar.Manifest
import java.util.zip.ZipEntry

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
            application.registerFileType(XmlFileType.INSTANCE, "xml")
            application.registerParserDefinition(XMLParserDefinition())
            application.registerApplicationService(
                com.intellij.platform.syntax.psi.PsiSyntaxBuilderFactory::class.java,
                com.intellij.platform.syntax.psi.PsiSyntaxBuilderFactory.defaultBuilderFactory()
            )
            CoreApplicationEnvironment.registerApplicationExtensionPoint(
                com.intellij.openapi.extensions.ExtensionPointName.create("com.intellij.metaLanguage"),
                com.intellij.lang.MetaLanguage::class.java
            )
            application.addExplicitExtension(
                com.intellij.platform.syntax.psi.ElementTypeConverters.instance,
                XMLLanguage.INSTANCE,
                object : com.intellij.platform.syntax.psi.ElementTypeConverterFactory {
                    override fun getElementTypeConverter() = com.intellij.psi.xml.xmlElementTypeConverter
                }
            )
            application.addExplicitExtension(
                com.intellij.platform.syntax.psi.LanguageSyntaxDefinitions.INSTANCE,
                XMLLanguage.INSTANCE,
                com.intellij.lang.xml.XmlSyntaxDefinitionExtension()
            )
            application.addExplicitExtension(
                com.intellij.lang.LanguageASTFactory.INSTANCE,
                XMLLanguage.INSTANCE,
                com.intellij.lang.xml.XmlASTFactory()
            )
            CoreApplicationEnvironment.registerApplicationExtensionPoint(
                com.intellij.xml.XmlExtension.EP_NAME,
                com.intellij.xml.XmlExtension::class.java
            )
            application.addExtension(
                com.intellij.xml.XmlExtension.EP_NAME,
                com.intellij.xml.DefaultXmlExtension()
            )
            CoreApplicationEnvironment.registerApplicationExtensionPoint(
                com.intellij.psi.xml.XmlFileNSInfoProvider.EP_NAME,
                com.intellij.psi.xml.XmlFileNSInfoProvider::class.java
            )
            CoreApplicationEnvironment.registerApplicationExtensionPoint(
                com.intellij.psi.impl.source.xml.XmlElementDescriptorProvider.EP_NAME,
                com.intellij.psi.impl.source.xml.XmlElementDescriptorProvider::class.java
            )
            CoreApplicationEnvironment.registerApplicationExtensionPoint(
                com.intellij.xml.XmlAttributeDescriptorsProvider.EP_NAME,
                com.intellij.xml.XmlAttributeDescriptorsProvider::class.java
            )
            CoreApplicationEnvironment.registerApplicationExtensionPoint(
                com.intellij.xml.XmlSchemaProvider.EP_NAME,
                com.intellij.xml.XmlSchemaProvider::class.java
            )
            CoreApplicationEnvironment.registerApplicationExtensionPoint(
                com.intellij.javaee.ImplicitNamespaceDescriptorProvider.EP_NAME,
                com.intellij.javaee.ImplicitNamespaceDescriptorProvider::class.java
            )
            CoreApplicationEnvironment.registerApplicationExtensionPoint(
                com.intellij.psi.xml.StartTagEndTokenProvider.EP_NAME,
                com.intellij.psi.xml.StartTagEndTokenProvider::class.java
            )
            CoreApplicationEnvironment.registerApplicationExtensionPoint(
                com.intellij.xml.util.XmlIdContributor.EP_NAME,
                com.intellij.xml.util.XmlIdContributor::class.java
            )
            application.registerApplicationService(
                com.intellij.javaee.ExternalResourceManager::class.java,
                com.intellij.javaee.CoreExternalResourceManager()
            )
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

    @Test
    fun explicitXmlContentsOverrideSourcePsi() {
        val tempDir = Files.createTempDirectory("lint_explicit_xml")
        try {
            val (model, xmlFile, sourceText) = prepareXmlProject(tempDir, emptyList())
            val client = AndroidLintClient(model, xmlFile, sourceText, Scope.RESOURCE_FILE, null)
            val merged = "<manifest><application label=\"Merged Label\"/></manifest>"
            val file = xmlFile.virtualFile.toNioPath().toFile()
            val document = client.getXmlDocument(file, merged)!!
            val application = document.getElementsByTagName("application").item(0) as org.w3c.dom.Element
            assertEquals("Merged Label", application.getAttribute("label"))
            val location = client.xmlParser.getLocation(file, application.getAttributeNode("label"))
            assertEquals(merged.indexOf("label="), location.start!!.offset)
            assertEquals(merged.indexOf("/>"), location.end!!.offset)
        } finally {
            deleteRecursively(tempDir)
        }
    }

    @Test
    fun differentDetectorsSelectOneDoesNotExecuteOther() {
        val tempDir = Files.createTempDirectory("lint_provider_two_detectors")
        try {
            TwoDetectorsRegistry.alphaCalls.set(0)
            TwoDetectorsRegistry.betaCalls.set(0)
            val jarPath = writeLintRegistryJar(tempDir.resolve("lint.jar"), TwoDetectorsRegistry::class.java.name)
            val (model, xmlFile, xmlText) = prepareXmlProject(tempDir, listOf(jarPath))

            AndroidSources.Scope(null, null).use {
                val client = AndroidLintClient(
                    model,
                    xmlFile,
                    xmlText,
                    Scope.RESOURCE_FILE,
                    setOf(TwoDetectorsRegistry.ISSUE_ALPHA.id)
                )
                val incidents = client.analyze()
                assertTrue(client.isAnalysisComplete())
                assertEquals(listOf(TwoDetectorsRegistry.ISSUE_ALPHA.id), incidents.map { it.issue.id })
                assertEquals(1, TwoDetectorsRegistry.alphaCalls.get())
                assertEquals(0, TwoDetectorsRegistry.betaCalls.get())
            }
        } finally {
            deleteRecursively(tempDir)
        }
    }

    @Test
    fun sharedDetectorTwoIssuesSelectOneReportsOnlySelectedAndRespectsProjectDisable() {
        val tempDir = Files.createTempDirectory("lint_provider_shared_detector")
        try {
            SharedDetectorRegistry.calls.set(0)
            val jarPath = writeLintRegistryJar(tempDir.resolve("lint.jar"), SharedDetectorRegistry::class.java.name)
            val (model, xmlFile, xmlText) = prepareXmlProject(tempDir, listOf(jarPath))

            AndroidSources.Scope(null, null).use {
                val selectedOnly = AndroidLintClient(
                    model,
                    xmlFile,
                    xmlText,
                    Scope.RESOURCE_FILE,
                    setOf(SharedDetectorRegistry.ISSUE_FIRST.id)
                )
                val incidents = selectedOnly.analyze()
                assertTrue(selectedOnly.isAnalysisComplete())
                assertEquals(listOf(SharedDetectorRegistry.ISSUE_FIRST.id), incidents.map { it.issue.id })
                assertEquals(1, SharedDetectorRegistry.calls.get())
            }

            Files.writeString(
                model.moduleRoot!!.resolve("lint.xml"),
                "<lint><issue id=\"${SharedDetectorRegistry.ISSUE_FIRST.id}\" severity=\"ignore\"/></lint>"
            )

            AndroidSources.Scope(null, null).use {
                val disabledInProject = AndroidLintClient(
                    model,
                    xmlFile,
                    xmlText,
                    Scope.RESOURCE_FILE,
                    setOf(SharedDetectorRegistry.ISSUE_FIRST.id)
                )
                val incidents = disabledInProject.analyze()
                assertTrue(disabledInProject.isAnalysisComplete())
                assertTrue(incidents.isEmpty())
            }
        } finally {
            deleteRecursively(tempDir)
        }
    }

    @Test
    fun emptySelectionSkipsRuleLoadingAndDetectorExecutionAndNullRunsAll() {
        val tempDir = Files.createTempDirectory("lint_provider_empty_null")
        try {
            TwoDetectorsRegistry.registryCreations.set(0)
            TwoDetectorsRegistry.alphaCalls.set(0)
            TwoDetectorsRegistry.betaCalls.set(0)
            val jarPath = writeLintRegistryJar(tempDir.resolve("lint.jar"), TwoDetectorsRegistry::class.java.name)
            val (model, xmlFile, xmlText) = prepareXmlProject(tempDir, listOf(jarPath))

            AndroidSources.Scope(null, null).use {
                val emptyClient = AndroidLintClient(
                    model,
                    xmlFile,
                    xmlText,
                    Scope.RESOURCE_FILE,
                    emptySet()
                )
                val emptyIncidents = emptyClient.analyze()
                assertTrue(emptyClient.isAnalysisComplete())
                assertTrue(emptyIncidents.isEmpty())
                assertEquals(0, TwoDetectorsRegistry.registryCreations.get())
                assertEquals(0, TwoDetectorsRegistry.alphaCalls.get())
                assertEquals(0, TwoDetectorsRegistry.betaCalls.get())
            }

            AndroidSources.Scope(null, null).use {
                val allClient = AndroidLintClient(
                    model,
                    xmlFile,
                    xmlText,
                    Scope.RESOURCE_FILE,
                    null
                )
                val allIncidents = allClient.analyze()
                assertTrue(allClient.isAnalysisComplete())
                val ids = allIncidents.map { it.issue.id }.toSet()
                assertTrue(ids.contains(TwoDetectorsRegistry.ISSUE_ALPHA.id))
                assertTrue(ids.contains(TwoDetectorsRegistry.ISSUE_BETA.id))
                assertTrue(ids.contains("HardcodedText"))
                assertEquals(1, TwoDetectorsRegistry.alphaCalls.get())
                assertEquals(1, TwoDetectorsRegistry.betaCalls.get())
            }
        } finally {
            deleteRecursively(tempDir)
        }
    }

    @Test
    fun groovyGradleReportsOctalAssignmentsAtTheirSourceRange() {
        val tempDir = Files.createTempDirectory("lint_groovy_octal")
        try {
            val (model) = prepareXmlProject(tempDir, emptyList())
            val text = "android {\n    defaultConfig {\n        minSdkVersion = 0777\n    }\n}"
            val path = model.moduleRoot!!.resolve("build.gradle")
            Files.writeString(path, text)
            AndroidSources.Scope(null, null).use {
                val client = AndroidLintClient(
                    model, createGradleFile(path, text), text, Scope.GRADLE_FILE, setOf("AccidentalOctal")
                )
                val incidents = client.analyze()
                assertTrue(client.isAnalysisComplete())
                assertEquals(listOf("AccidentalOctal"), incidents.map { it.issue.id })
                val location = incidents.single().location
                assertEquals(path.toFile(), location.file)
                assertEquals(2, location.start!!.line)
                assertEquals(
                    "0777",
                    text.substring(location.start!!.offset, location.end!!.offset)
                )
            }
        } finally {
            deleteRecursively(tempDir)
        }
    }

    @Test
    fun groovyGradleLegacyDetectorReportsEachMethodOnce() {
        val tempDir = Files.createTempDirectory("lint_groovy_legacy")
        try {
            LegacyGradleRegistry.calls.set(0)
            val jar = writeLintRegistryJar(tempDir.resolve("lint.jar"), LegacyGradleRegistry::class.java.name)
            val (model) = prepareXmlProject(tempDir, listOf(jar))
            val text =
                "dependencies {\n    legacyDependency 'example:library:1'\n}\nandroid { defaultConfig { versionCode = 7 } }"
            val path = model.moduleRoot!!.resolve("build.gradle")
            Files.writeString(path, text)
            AndroidSources.Scope(null, null).use {
                val client = AndroidLintClient(
                    model, createGradleFile(path, text), text, Scope.GRADLE_FILE,
                    setOf(LegacyGradleRegistry.ISSUE.id)
                )
                val incidents = client.analyze()
                assertTrue(client.isAnalysisComplete())
                assertEquals(1, LegacyGradleRegistry.calls.get())
                assertEquals(
                    listOf(LegacyGradleRegistry.ISSUE.id, LegacyGradleRegistry.ISSUE.id),
                    incidents.map { it.issue.id }
                )
                assertEquals(
                    listOf("legacyDependency 'example:library:1'", "versionCode"),
                    incidents.map { text.substring(it.location.start!!.offset, it.location.end!!.offset) }
                )
            }
        } finally {
            deleteRecursively(tempDir)
        }
    }

    private fun createGradleFile(path: Path, content: String): PsiFile {
        val env = environment ?: error("Environment not initialized")
        val virtualFile = object : LightVirtualFile(path.fileName.toString(), PlainTextFileType.INSTANCE, content) {
            override fun getPath(): String = path.toString()
            override fun toNioPath(): Path = path
        }
        val provider = SingleRootFileViewProvider(
            PsiManager.getInstance(env.project), virtualFile, true, PlainTextFileType.INSTANCE
        )
        return PsiPlainTextFileImpl(provider)
    }

    class LegacyGradleDetector : Detector(), GradleScanner {
        override fun checkMethodCall(
            context: GradleContext,
            statement: String,
            parent: String?,
            namedArguments: Map<String, String>,
            unnamedArguments: List<String>,
            cookie: Any
        ) {
            if (statement != "legacyDependency") return
            LegacyGradleRegistry.calls.incrementAndGet()
            context.report(Incident(LegacyGradleRegistry.ISSUE, "Legacy dependency", context.getLocation(cookie)))
        }

        override fun checkDslPropertyAssignment(
            context: GradleContext,
            property: String,
            value: String,
            parent: String,
            parentParent: String?,
            propertyCookie: Any,
            valueCookie: Any,
            statementCookie: Any
        ) {
            if (property != "versionCode") return
            context.report(
                Incident(
                    LegacyGradleRegistry.ISSUE,
                    "Version property",
                    context.getLocation(propertyCookie)
                )
            )
        }
    }

    class LegacyGradleRegistry : IssueRegistry() {
        override val api: Int = CURRENT_API
        override val issues: List<Issue> = listOf(ISSUE)

        companion object {
            val calls = AtomicInteger()
            val ISSUE = Issue.create(
                "LegacyGradleDependency", "Legacy dependency", "Use the supported dependency declaration.",
                Category.CORRECTNESS, 5, Severity.WARNING,
                Implementation(LegacyGradleDetector::class.java, Scope.GRADLE_SCOPE)
            )
        }
    }

    private fun prepareXmlProject(
        tempDir: Path,
        ruleJars: List<Path>
    ): Triple<AndroidLintModel, XmlFile, String> {
        val projectRoot = tempDir.resolve("project")
        val moduleRoot = projectRoot.resolve("app")
        val resDir = moduleRoot.resolve("src/main/res")
        val layoutDir = resDir.resolve("layout")
        Files.createDirectories(layoutDir)
        val manifestPath = moduleRoot.resolve("src/main/AndroidManifest.xml")
        Files.writeString(
            manifestPath,
            "<manifest xmlns:android=\"http://schemas.android.com/apk/res/android\" package=\"com.example.test\"/>"
        )
        val layoutPath = layoutDir.resolve("activity_main.xml")
        val layoutText = """
            <LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"
                android:layout_width="match_parent"
                android:layout_height="match_parent">
                <TextView
                    android:layout_width="wrap_content"
                    android:layout_height="wrap_content"
                    android:text="Hardcoded text" />
            </LinearLayout>
        """.trimIndent()
        Files.writeString(layoutPath, layoutText)
        val xmlInputs = AndroidLintResources.Inputs(
            listOf(resDir),
            listOf(manifestPath),
            null,
            null,
            "xml-inputs-fp",
            true
        )

        val model = AndroidLintModel(
            module = null,
            androidModule = null,
            moduleRoot = moduleRoot,
            projectRoot = projectRoot,
            variant = "debug",
            sdkHome = null,
            compileSdk = 34,
            compileTarget = "android-34",
            minSdk = 21,
            targetSdk = 34,
            namespace = "com.example.test",
            isLibrary = false,
            minSdkPremiseMissing = false,
            lintModelModule = null,
            lintModelVariant = null,
            ruleJars = ruleJars,
            ruleJarFingerprints = emptyList(),
            fingerprint = "fp",
            lintXmlFingerprint = "xml-fp",
            xmlInputs = xmlInputs
        )
        val xmlFile = createXmlFile(layoutPath, layoutText)
        return Triple(model, xmlFile, layoutText)
    }

    private fun createXmlFile(path: Path, content: String): XmlFile {
        val env = environment ?: error("Environment not initialized")
        val virtualFile = object : LightVirtualFile(path.fileName.toString(), XmlFileType.INSTANCE, content) {
            override fun getPath(): String = path.toString()
            override fun toNioPath(): Path = path
        }
        SingleRootFileViewProvider.doNotCheckFileSizeLimit(virtualFile)
        val provider = SingleRootFileViewProvider(
            PsiManager.getInstance(env.project),
            virtualFile,
            true,
            XmlFileType.INSTANCE
        )
        return provider.getPsi(XMLLanguage.INSTANCE) as XmlFile
    }

    private fun writeLintRegistryJar(jarPath: Path, registryClassName: String): Path {
        val manifest = Manifest()
        val attrs = manifest.mainAttributes
        attrs[Attributes.Name.MANIFEST_VERSION] = "1.0"
        attrs[Attributes.Name("Lint-Registry-v2")] = registryClassName
        attrs[Attributes.Name.IMPLEMENTATION_VERSION] = UUID.randomUUID().toString()
        JarOutputStream(Files.newOutputStream(jarPath), manifest).use { jos ->
            jos.putNextEntry(ZipEntry("marker.txt"))
            jos.write(registryClassName.toByteArray())
            jos.closeEntry()
        }
        return jarPath
    }

    private fun deleteRecursively(path: Path) {
        if (!Files.exists(path)) return
        try {
            Files.walk(path).use { stream ->
                stream.sorted(Comparator.reverseOrder()).forEach { p ->
                    try {
                        Files.deleteIfExists(p)
                    } catch (_: IOException) {
                    }
                }
            }
        } catch (_: IOException) {
        }
    }

    class AlphaDetector : Detector(), XmlScanner {
        override fun appliesTo(folderType: ResourceFolderType): Boolean = true
        override fun visitDocument(context: XmlContext, document: org.w3c.dom.Document) {
            TwoDetectorsRegistry.alphaCalls.incrementAndGet()
            val root = document.documentElement ?: return
            context.report(TwoDetectorsRegistry.ISSUE_ALPHA, root, context.getLocation(root), "Alpha hit")
        }
    }

    class BetaDetector : Detector(), XmlScanner {
        override fun appliesTo(folderType: ResourceFolderType): Boolean = true
        override fun visitDocument(context: XmlContext, document: org.w3c.dom.Document) {
            TwoDetectorsRegistry.betaCalls.incrementAndGet()
            val root = document.documentElement ?: return
            context.report(TwoDetectorsRegistry.ISSUE_BETA, root, context.getLocation(root), "Beta hit")
        }
    }

    class TwoDetectorsRegistry : IssueRegistry() {
        init {
            registryCreations.incrementAndGet()
        }

        override val api: Int = CURRENT_API
        override val vendor: Vendor = Vendor(vendorName = "Test", identifier = "test-two-detectors")
        override val issues: List<Issue> = listOf(ISSUE_ALPHA, ISSUE_BETA)

        companion object {
            val registryCreations = AtomicInteger()
            val alphaCalls = AtomicInteger()
            val betaCalls = AtomicInteger()
            val ISSUE_ALPHA = Issue.create(
                "CustomAlphaIssue",
                "Alpha summary",
                "Alpha explanation",
                Category.CORRECTNESS,
                6,
                Severity.WARNING,
                Implementation(AlphaDetector::class.java, EnumSet.of(Scope.RESOURCE_FILE))
            )
            val ISSUE_BETA = Issue.create(
                "CustomBetaIssue",
                "Beta summary",
                "Beta explanation",
                Category.CORRECTNESS,
                6,
                Severity.WARNING,
                Implementation(BetaDetector::class.java, EnumSet.of(Scope.RESOURCE_FILE))
            )
        }
    }

    class SharedXmlDetector : Detector(), XmlScanner {
        override fun appliesTo(folderType: ResourceFolderType): Boolean = true
        override fun visitDocument(context: XmlContext, document: org.w3c.dom.Document) {
            SharedDetectorRegistry.calls.incrementAndGet()
            val root = document.documentElement ?: return
            val loc = context.getLocation(root)
            // Intentionally report both without checking context.isEnabled to verify driver/config gating
            context.report(SharedDetectorRegistry.ISSUE_FIRST, root, loc, "First shared issue")
            context.report(SharedDetectorRegistry.ISSUE_SECOND, root, loc, "Second shared issue")
        }
    }

    class SharedDetectorRegistry : IssueRegistry() {
        override val api: Int = CURRENT_API
        override val vendor: Vendor = Vendor(vendorName = "Test", identifier = "test-shared-detector")
        override val issues: List<Issue> = listOf(ISSUE_FIRST, ISSUE_SECOND)

        companion object {
            val calls = AtomicInteger()
            val ISSUE_FIRST = Issue.create(
                "SharedFirstIssue",
                "Shared first summary",
                "Shared first explanation",
                Category.CORRECTNESS,
                6,
                Severity.WARNING,
                Implementation(SharedXmlDetector::class.java, EnumSet.of(Scope.RESOURCE_FILE))
            )
            val ISSUE_SECOND = Issue.create(
                "SharedSecondIssue",
                "Shared second summary",
                "Shared second explanation",
                Category.CORRECTNESS,
                6,
                Severity.WARNING,
                Implementation(SharedXmlDetector::class.java, EnumSet.of(Scope.RESOURCE_FILE))
            )
        }
    }
}
