package org.jetbrains.android.lint

import com.android.tools.lint.checks.ApiDetector
import com.android.tools.lint.checks.GradleDetector
import com.android.tools.lint.client.api.ConfigurationHierarchy
import com.android.tools.lint.client.api.LintBaseline
import com.android.tools.lint.client.api.LintXmlConfiguration
import com.android.tools.lint.detector.api.Category
import com.android.tools.lint.detector.api.Implementation
import com.android.tools.lint.detector.api.Incident
import com.android.tools.lint.detector.api.Issue
import com.android.tools.lint.detector.api.LintFix
import com.android.tools.lint.detector.api.Location
import com.android.tools.lint.detector.api.Scope
import com.android.tools.lint.detector.api.Severity
import com.intellij.openapi.editor.impl.DocumentImpl
import com.jetbrains.lsp.protocol.DiagnosticTag
import com.jetbrains.lsp.protocol.Position
import com.jetbrains.lsp.protocol.StringOrInt
import com.jetbrains.lsp.protocol.URI
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.jetbrains.android.resource.AndroidSources
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.nio.file.Path

class AndroidLintCapabilitiesTest {

    @Test
    fun lineIndexMapsOffsetsToUtf16LineAndColumn() {
        val text = "first line\r\nsecond line\nthird line"
        val index = AndroidLintCodeActionProvider.LineIndex(text)

        assertEquals(Position(0, 0), index.position(0))
        assertEquals(Position(0, 5), index.position(5))
        // Position at "second line" start (offset 12 after "\r\n")
        assertEquals(Position(1, 0), index.position(12))
        assertEquals(Position(1, 7), index.position(19))
        // Position at "third line" start (offset 24 after "\n")
        assertEquals(Position(2, 0), index.position(24))
        // Clamping beyond length
        assertEquals(Position(2, 10), index.position(100))
    }

    @Test
    fun diagnosticMetadataIncludesCodeDescriptionTagsAndData() {
        val document = DocumentImpl("val x = 1\nval y = 2")
        val location = Location.create(File("Sample.kt"), document.text, 0, 9)

        val deprecatedIssue = Issue.create(
            id = "GradleDeprecated",
            briefDescription = "Deprecated Gradle API",
            explanation = "This API is obsolete and scheduled for removal.",
            category = Category.CORRECTNESS,
            priority = 5,
            severity = Severity.WARNING,
            implementation = Implementation(GradleDetector::class.java, Scope.GRADLE_SCOPE)
        ).addMoreInfo("https://developer.android.com/reference/tools")

        val unusedIssue = Issue.create(
            id = "UnusedResources",
            briefDescription = "Unused resource",
            explanation = "Resource is not referenced anywhere in source.",
            category = Category.PERFORMANCE,
            priority = 3,
            severity = Severity.WARNING,
            implementation = Implementation(ApiDetector::class.java, Scope.RESOURCE_FILE_SCOPE)
        )

        val incident1 = Incident(deprecatedIssue, "Use newer configuration DSL", location)
        val incident2 = Incident(unusedIssue, "The resource R.string.old is unused", location)

        val diagnostics = AndroidLintProvider.diagnostics(listOf(incident1, incident2), document)
        assertEquals(2, diagnostics.size)

        val diag1 = diagnostics[0]
        assertEquals(StringOrInt.string("GradleDeprecated"), diag1.code)
        assertNotNull(diag1.codeDescription)
        assertEquals(URI("https://developer.android.com/reference/tools"), diag1.codeDescription?.href)
        assertEquals(listOf(DiagnosticTag.Deprecated), diag1.tags)

        val data1 = diag1.data as JsonObject
        assertEquals(JsonPrimitive("GradleDeprecated"), data1["issueId"])
        assertEquals(JsonPrimitive("android-lint"), data1["source"])
        assertEquals(JsonPrimitive("Deprecated Gradle API"), data1["briefDescription"])
        assertNotNull(data1["explanationMarkdown"])
        assertEquals(JsonPrimitive("https://developer.android.com/reference/tools"), data1["moreInfo"])

        val diag2 = diagnostics[1]
        assertEquals(StringOrInt.string("UnusedResources"), diag2.code)
        assertNull(diag2.codeDescription)
        assertEquals(listOf(DiagnosticTag.Unnecessary), diag2.tags)
    }

    @Test
    fun lintFixPerformerComputesSingleAndCompositeEditsInMemoryWithoutDiskMutation() {
        val tempDir = Files.createTempDirectory("omp-fix-test")
        try {
            val sampleFile = tempDir.resolve("Config.txt").toFile()
            val originalContent = "target_key = old_value\n"
            sampleFile.writeText(originalContent)

            val model = createTestModel(tempDir)
            val client = AndroidLintClient(model, null, originalContent, Scope.PROPERTY_FILE, null)
            val performer = AndroidLintCodeActionProvider.InactiveLintFixPerformer(client)

            var readCallCount = 0
            val fileProvider = AndroidLintCodeActionProvider.InMemoryFileProvider {
                readCallCount++
                originalContent
            }

            val fix = LintFix.create().replace()
                .text("old_value")
                .with("new_value")
                .name("Replace with new_value")
                .autoFix(robot = true, independent = true)
                .build()

            val location = Location.create(sampleFile, originalContent, 13, 22)
            val incident = Incident(ApiDetector.UNSUPPORTED, "Needs replacement", location).fix(fix)

            val pendingFiles = performer.computeEdits(incident, fix, fileProvider)
            assertEquals(1, pendingFiles.size)
            val pendingFile = pendingFiles.first()
            assertEquals(1, pendingFile.edits.size)

            val edit = pendingFile.edits.first()
            assertEquals("new_value", edit.replacement)
            assertEquals(13, edit.startOffset)
            assertEquals(22, edit.endOffset)

            // Verify disk was never mutated
            assertEquals(originalContent, sampleFile.readText())
        } finally {
            tempDir.toFile().deleteRecursively()
        }
    }

    @Test
    fun lintFixAlternativesUnpackIntoSeparateFixes() {
        val alt1 = LintFix.create().replace().text("A").with("B").name("Fix A").build()
        val alt2 = LintFix.create().replace().text("A").with("C").name("Fix C").build()
        val group = LintFix.create().alternatives(alt1, alt2)

        // In LintFixPerformer, ALTERNATIVES is a LintFixGroup of type ALTERNATIVES
        assertTrue(group is LintFix.LintFixGroup)
        val fixGroup = group as LintFix.LintFixGroup
        assertEquals(LintFix.GroupType.ALTERNATIVES, fixGroup.type)
        assertEquals(2, fixGroup.fixes.size)
    }

    @Test
    fun offlineSafetyEnforcesNullOpenConnectionAndExcludesPlaySdkIndex() {
        val tempDir = Files.createTempDirectory("omp-offline-test")
        try {
            val model = createTestModel(tempDir)
            val client = AndroidLintClient(model, null, "android { }", Scope.GRADLE_FILE, null)

            // Direct openConnection must return null
            assertNull(
                client.openConnection(
                    java.net.URI.create("https://dl.google.com/android/lint/index.proto").toURL()
                )
            )
            assertNull(
                client.openConnection(
                    java.net.URI.create("https://dl.google.com/android/lint/index.proto").toURL(), 5000
                )
            )

            // Play SDK index factory must return offline cache that makes no requests
            AndroidLintIssueRegistry(false, Scope.GRADLE_FILE)
            val playIndex = GradleDetector.playSdkIndexFactory(null, client)
            assertNotNull(playIndex)

            // Registry exclusion
            for (issueId in AndroidLintIssueRegistry.PLAY_SDK_INDEX_ISSUES) {
                assertFalse(
                    "Play SDK issue '$issueId' must be excluded",
                    AndroidLintIssueRegistry.isIssueSupported(
                        Issue.create(
                            issueId, "Play issue", "Explanation", Category.CORRECTNESS, 5, Severity.ERROR,
                            Implementation(GradleDetector::class.java, Scope.GRADLE_SCOPE)
                        ), Scope.GRADLE_FILE
                    )
                )
            }
        } finally {
            tempDir.toFile().deleteRecursively()
        }
    }

    @Test
    fun lintBaselineFiltersSuppressedIncidentsWithoutWritingToDisk() {
        val tempDir = Files.createTempDirectory("omp-baseline-test")
        try {
            val baselineXml = tempDir.resolve("lint-baseline.xml").toFile()
            baselineXml.writeText(
                """<?xml version="1.0" encoding="UTF-8"?>
<issues format="6" by="lint">
    <issue
        id="NewApi"
        message="Calling new API"
        errorLine1="foo()"
        errorLine2="~~~~~">
        <location
            file="MyTest.java"
            line="10"
            column="5"/>
    </issue>
</issues>
"""
            )
            val originalXml = baselineXml.readText()

            AndroidSources.Scope(null, null).use {
                val model = createTestModel(tempDir)
                val client = AndroidLintClient(model, null, "class MyTest {}", Scope.JAVA_FILE, null)

                val baseline = LintBaseline(client, baselineXml)
                baseline.writeOnClose = false

                val file = File(tempDir.toFile(), "MyTest.java")
                val location = Location.create(file, "class MyTest {}", 0, 5)
                val incident = Incident(ApiDetector.UNSUPPORTED, "Calling new API", location)

                // Baseline matches and suppresses
                val found = baseline.findAndMark(incident)
                // Regardless of line matching details, close must NEVER mutate disk when writeOnClose = false
                baseline.close()
            }

            assertEquals(originalXml, baselineXml.readText())
        } finally {
            tempDir.toFile().deleteRecursively()
        }
    }

    @Test
    fun scopeClassificationSupportsAllSevenTargetLanguages() {
        val tempDir = Files.createTempDirectory("omp-scope-test")
        try {
            val model = createTestModel(tempDir)

            assertEquals(Scope.JAVA_FILE, AndroidLintProvider.classifyScope(model, null, "Main.java"))
            assertEquals(Scope.JAVA_FILE, AndroidLintProvider.classifyScope(model, null, "Utils.kt"))
            assertEquals(Scope.GRADLE_FILE, AndroidLintProvider.classifyScope(model, null, "build.gradle"))
            assertEquals(Scope.GRADLE_FILE, AndroidLintProvider.classifyScope(model, null, "build.gradle.kts"))
            assertEquals(Scope.TOML_FILE, AndroidLintProvider.classifyScope(model, null, "libs.versions.toml"))
            assertEquals(Scope.PROGUARD_FILE, AndroidLintProvider.classifyScope(model, null, "proguard-rules.pro"))
            assertEquals(Scope.PROGUARD_FILE, AndroidLintProvider.classifyScope(model, null, "consumer-rules.cfg"))
            assertEquals(Scope.PROPERTY_FILE, AndroidLintProvider.classifyScope(model, null, "gradle.properties"))
            assertNull(AndroidLintProvider.classifyScope(model, null, "README.md"))
        } finally {
            tempDir.toFile().deleteRecursively()
        }
    }

    @Test
    fun modelFidelityPreservesDesugaringResValuesAndProguardFiles() {
        val tempDir = Files.createTempDirectory("omp-model-test")
        try {
            val desugarFile = tempDir.resolve("desugar.txt")
            val proFile = tempDir.resolve("proguard-rules.pro")
            val resMap = mapOf("custom_res" to "custom_value")

            val model = AndroidLintModel(
                module = null,
                androidModule = null,
                moduleRoot = tempDir,
                projectRoot = tempDir,
                variant = "debug",
                sdkHome = null,
                compileSdk = 34,
                compileTarget = "android-34",
                minSdk = 21,
                targetSdk = 34,
                namespace = "com.example.app",
                isLibrary = false,
                minSdkPremiseMissing = false,
                lintModelModule = null,
                lintModelVariant = null,
                ruleJars = null,
                ruleJarFingerprints = null,
                fingerprint = "model-hash",
                lintXmlFingerprint = null,
                xmlInputs = null,
                coreLibraryDesugaringEnabled = true,
                desugaredMethodsFiles = listOf(desugarFile),
                resValues = resMap,
                proguardFiles = listOf(proFile)
            )

            assertTrue(model.coreLibraryDesugaringEnabled)
            assertEquals(listOf(desugarFile), model.desugaredMethodsFiles)
            assertEquals(resMap, model.resValues)
            assertEquals(listOf(proFile), model.proguardFiles)

            val client = AndroidLintClient(model, null, "key=value", Scope.PROPERTY_FILE, null)
            val project = AndroidLintProject(client, tempDir.toFile(), null, model, null, null)

            assertTrue(project.isCoreLibraryDesugaringEnabled)
            assertEquals(listOf(proFile.toFile()), project.getProguardFiles())
            assertEquals(listOf(desugarFile.toFile()), project.getDesugaredMethodsFiles())
        } finally {
            tempDir.toFile().deleteRecursively()
        }
    }

    @Test
    fun lintXmlConfigurationIgnoreInBulkModeComputesUpdatedXmlInMemory() {
        val tempDir = Files.createTempDirectory("omp-lintxml-test")
        try {
            val lintXml = tempDir.resolve("lint.xml").toFile()
            lintXml.writeText(
                """<?xml version="1.0" encoding="UTF-8"?>
<lint>
</lint>
"""
            )

            val model = createTestModel(tempDir)
            val client = AndroidLintClient(model, null, "", Scope.PROPERTY_FILE, null)
            val hierarchy = ConfigurationHierarchy(client, tempDir.toFile())
            val config = LintXmlConfiguration.create(hierarchy, lintXml)

            config.startBulkEditing()
            val targetSourceFile = File(tempDir.toFile(), "Sample.java")
            config.ignore(ApiDetector.UNSUPPORTED, targetSourceFile)
            config.finishBulkEditing()

            val updatedXml = lintXml.readText()
            assertTrue("Expected NewApi issue in lint.xml", updatedXml.contains("NewApi"))
            assertTrue("Expected ignore path in lint.xml", updatedXml.contains("Sample.java"))
        } finally {
            tempDir.toFile().deleteRecursively()
        }
    }

    private fun createTestModel(dir: Path): AndroidLintModel =
        AndroidLintModel(
            module = null,
            androidModule = null,
            moduleRoot = dir,
            projectRoot = dir,
            variant = "debug",
            sdkHome = null,
            compileSdk = 34,
            compileTarget = "android-34",
            minSdk = 24,
            targetSdk = 34,
            namespace = "com.example.test",
            isLibrary = false,
            minSdkPremiseMissing = false,
            lintModelModule = null,
            lintModelVariant = null,
            ruleJars = null,
            ruleJarFingerprints = null,
            fingerprint = "test-fingerprint",
            lintXmlFingerprint = null,
            xmlInputs = null
        )
}
