package org.jetbrains.android.lint

import com.android.tools.lint.client.api.LintClient
import com.android.utils.Pair
import com.intellij.core.CoreApplicationEnvironment
import com.intellij.core.CoreProjectEnvironment
import com.intellij.openapi.Disposable
import com.intellij.openapi.util.Disposer
import org.junit.AfterClass
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.BeforeClass
import org.junit.Test
import org.w3c.dom.Document
import org.w3c.dom.Element
import org.w3c.dom.Node
import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.nio.file.Path
import java.util.Comparator

class AndroidLintManifestTest {

    private open class TestLintClient : LintClient(CLIENT_UNIT_TESTS) {
        private val parser = AndroidLintXmlParser(this)

        override val xmlParser: com.android.tools.lint.client.api.XmlParser = parser

        override fun getUastParser(project: com.android.tools.lint.detector.api.Project?): com.android.tools.lint.client.api.UastParser {
            return com.android.tools.lint.helpers.DefaultUastParser(project, environment.project)
        }

        override fun getGradleVisitor(): com.android.tools.lint.client.api.GradleVisitor {
            return com.android.tools.lint.client.api.GradleVisitor()
        }

        override fun getResources(
            project: com.android.tools.lint.detector.api.Project,
            scope: com.android.tools.lint.client.api.ResourceRepositoryScope
        ): com.android.ide.common.resources.ResourceRepository = throw AssertionError("Unexpected resource lookup")

        override fun report(
            context: com.android.tools.lint.detector.api.Context,
            incident: com.android.tools.lint.detector.api.Incident,
            format: com.android.tools.lint.detector.api.TextFormat
        ) {
        }

        override fun log(
            severity: com.android.tools.lint.detector.api.Severity,
            exception: Throwable?,
            format: String?,
            vararg args: Any
        ) {
        }

        override fun readFile(file: File): CharSequence {
            return try {
                Files.readString(file.toPath())
            } catch (_: IOException) {
                ""
            }
        }
    }

    @Test
    fun cleanManifestProvidesSourceDomWithoutPretendingMerged() {
        val client = TestLintClient()
        val helper = AndroidLintManifest(null, environment.project, client)

        assertFalse(helper.isValidBuiltSnapshot())

        val srcFile = File("src/main/AndroidManifest.xml")
        val xml = """
            <?xml version="1.0" encoding="utf-8"?>
            <manifest xmlns:android="http://schemas.android.com/apk/res/android"
                package="com.example.app">
                <application android:debuggable="true"/>
            </manifest>
        """.trimIndent()
        val doc = client.xmlParser.parseXml(xml, srcFile)
        assertNotNull(doc)

        val result = helper.getMergedManifest(null, srcFile, doc)
        assertSame(doc, result)
        assertFalse(helper.isMergeManifestNode(doc!!.documentElement))
        assertNull(doc.getUserData(LintClient.MERGED_MANIFEST))

        val app = doc.getElementsByTagName("application").item(0) as Element
        val source = helper.findManifestSourceNode(app)
        assertNotNull(source)
        assertEquals(srcFile, source!!.first)
        assertSame(app, source.second)
    }

    @Test
    fun validBuiltSnapshotResolvesMergedManifestAndBlame() {
        val tempDir = Files.createTempDirectory("lint_manifest_test")
        try {
            val srcDir = tempDir.resolve("src/main")
            Files.createDirectories(srcDir)
            val srcManifest = srcDir.resolve("AndroidManifest.xml")
            val srcXml = """
                <?xml version="1.0" encoding="utf-8"?>
                <manifest xmlns:android="http://schemas.android.com/apk/res/android"
                    package="com.example.app">
                    <application android:debuggable="true"/>
                </manifest>
            """.trimIndent()
            Files.writeString(srcManifest, srcXml)

            Thread.sleep(50)

            val mergedDir = tempDir.resolve("build/intermediates/merged_manifests/debug/processDebugManifest")
            Files.createDirectories(mergedDir)
            val mergedManifest = mergedDir.resolve("AndroidManifest.xml")
            val mergedXml = """
                <?xml version="1.0" encoding="utf-8"?>
                <manifest xmlns:android="http://schemas.android.com/apk/res/android"
                    package="com.example.app"
                    android:versionCode="1" >
                    <application
                        android:debuggable="true" />
                </manifest>
            """.trimIndent()
            Files.writeString(mergedManifest, mergedXml)

            val logDir = tempDir.resolve("build/outputs/logs")
            Files.createDirectories(logDir)
            val blameReport = logDir.resolve("manifest-merger-debug-report.txt")
            val blameText = """
                -- Merging decision tree log ---
                manifest
                ADDED from ${srcManifest.toAbsolutePath()}:2:1-6:12
                application
                ADDED from ${srcManifest.toAbsolutePath()}:4:5-5:41
                	android:debuggable
                	ADDED from ${srcManifest.toAbsolutePath()}:4:18-42
            """.trimIndent() + "\n"
            Files.writeString(blameReport, blameText)

            val model = AndroidLintModel(
                module = null,
                androidModule = null,
                moduleRoot = tempDir,
                projectRoot = tempDir,
                variant = "debug",
                sdkHome = null,
                compileSdk = 34,
                compileTarget = "android-34",
                minSdk = 26,
                targetSdk = 34,
                namespace = "com.example.app",
                isLibrary = false,
                minSdkPremiseMissing = false,
                lintModelModule = null,
                lintModelVariant = null,
                ruleJars = emptyList(),
                ruleJarFingerprints = emptyList(),
                fingerprint = "fingerprint",
                lintXmlFingerprint = "lintXmlFingerprint",
                xmlInputs = null,
            )

            val client = TestLintClient()
            val helper = AndroidLintManifest(model, environment.project, client)

            assertTrue(helper.isValidBuiltSnapshot())
            assertEquals(mergedManifest.toFile(), helper.getMergedManifestFile())
            assertEquals(blameReport.toFile(), helper.getManifestMergeReportFile())

            val mergedDoc = helper.getMergedManifest(null, null, null)
            assertNotNull(mergedDoc)
            assertTrue(helper.isMergeManifestNode(mergedDoc!!.documentElement))
            assertNotNull(mergedDoc.getUserData(LintClient.MERGED_MANIFEST))

            val appElement = mergedDoc.getElementsByTagName("application").item(0) as Element
            assertNotNull(appElement)
            assertTrue(helper.isMergeManifestNode(appElement))

            val source = helper.findManifestSourceNode(appElement)
            assertNotNull("Source mapping should succeed via BlameFile", source)
            assertEquals(srcManifest.toFile().canonicalPath, source!!.first.canonicalPath)

            val location = helper.findManifestSourceLocation(appElement)
            assertNotNull(location)
            assertEquals(srcManifest.toFile().canonicalPath, location!!.file.canonicalPath)

            // Freshness test: touching the source manifest makes it newer than merged manifest -> invalidates!
            Thread.sleep(50)
            Files.writeString(srcManifest, "$srcXml\n<!-- edited -->")
            assertFalse("Modified source manifest must invalidate merged snapshot", helper.isValidBuiltSnapshot())
        } finally {
            deleteRecursively(tempDir)
        }
    }

    @Test
    fun crlfDoesNotFalselyInvalidateFreshSnapshot() {
        val tempDir = Files.createTempDirectory("lint_manifest_crlf_test")
        try {
            val srcDir = tempDir.resolve("src/main")
            Files.createDirectories(srcDir)
            val srcManifest = srcDir.resolve("AndroidManifest.xml")
            // Disk file has CRLF
            Files.writeString(srcManifest, "<manifest package=\"com.example.app\">\r\n<application/>\r\n</manifest>")

            Thread.sleep(50)

            val mergedDir = tempDir.resolve("build/intermediates/merged_manifests/debug/processDebugManifest")
            Files.createDirectories(mergedDir)
            val mergedManifest = mergedDir.resolve("AndroidManifest.xml")
            Files.writeString(mergedManifest, "<manifest package=\"com.example.app\">\n<application/>\n</manifest>")

            val logDir = tempDir.resolve("build/outputs/logs")
            Files.createDirectories(logDir)
            val blameReport = logDir.resolve("manifest-merger-debug-report.txt")
            Files.writeString(
                blameReport,
                "-- Merging decision tree log ---\nmanifest\nADDED from ${srcManifest.toAbsolutePath()}:1:1\n"
            )

            val model = AndroidLintModel(
                module = null,
                androidModule = null,
                moduleRoot = tempDir,
                projectRoot = tempDir,
                variant = "debug",
                sdkHome = null,
                compileSdk = 34,
                compileTarget = "android-34",
                minSdk = 26,
                targetSdk = 34,
                namespace = "com.example.app",
                isLibrary = false,
                minSdkPremiseMissing = false,
                lintModelModule = null,
                lintModelVariant = null,
                ruleJars = emptyList(),
                ruleJarFingerprints = emptyList(),
                fingerprint = "fp",
                lintXmlFingerprint = "xmlFp",
                xmlInputs = null,
            )

            // Client returns normalized LF from in-memory document
            val client = object : TestLintClient() {
                override fun readFile(file: File): CharSequence {
                    if (file == srcManifest.toFile()) {
                        return "<manifest package=\"com.example.app\">\n<application/>\n</manifest>"
                    }
                    return super.readFile(file)
                }
            }

            val helper = AndroidLintManifest(model, environment.project, client)
            assertTrue(
                "CRLF vs LF line endings must not trigger false dirty detection",
                helper.isValidBuiltSnapshot(srcManifest.toFile(), null)
            )
        } finally {
            deleteRecursively(tempDir)
        }
    }

    @Test
    fun nonAgpDecisionLogRejectsBuiltSnapshot() {
        val tempDir = Files.createTempDirectory("lint_manifest_non_agp_log")
        try {
            val srcDir = tempDir.resolve("src/main")
            Files.createDirectories(srcDir)
            val srcManifest = srcDir.resolve("AndroidManifest.xml")
            Files.writeString(srcManifest, "<manifest package=\"com.example.app\"/>")

            Thread.sleep(50)

            val mergedDir = tempDir.resolve("build/intermediates/merged_manifests/debug/processDebugManifest")
            Files.createDirectories(mergedDir)
            val mergedManifest = mergedDir.resolve("AndroidManifest.xml")
            Files.writeString(mergedManifest, "<manifest package=\"com.example.app\"/>")

            val logDir = tempDir.resolve("build/outputs/logs")
            Files.createDirectories(logDir)
            val wrongLog = logDir.resolve("manifest-merger-debug-report.txt")
            // Write a generic XML/log file that is NOT an AGP decision tree log
            Files.writeString(wrongLog, "Some random build summary or resource log without decision tree markers")

            val model = AndroidLintModel(
                module = null,
                androidModule = null,
                moduleRoot = tempDir,
                projectRoot = tempDir,
                variant = "debug",
                sdkHome = null,
                compileSdk = 34,
                compileTarget = "android-34",
                minSdk = 26,
                targetSdk = 34,
                namespace = "com.example.app",
                isLibrary = false,
                minSdkPremiseMissing = false,
                lintModelModule = null,
                lintModelVariant = null,
                ruleJars = emptyList(),
                ruleJarFingerprints = emptyList(),
                fingerprint = "fp",
                lintXmlFingerprint = "xmlFp",
                xmlInputs = null,
            )

            val client = TestLintClient()
            val helper = AndroidLintManifest(model, environment.project, client)

            assertFalse("Non-AGP decision log must be rejected", helper.isValidBuiltSnapshot())
        } finally {
            deleteRecursively(tempDir)
        }
    }

    @Test
    fun modifiedBuildScriptInvalidatesBuiltSnapshot() {
        val tempDir = Files.createTempDirectory("lint_manifest_build_script_test")
        try {
            val srcDir = tempDir.resolve("src/main")
            Files.createDirectories(srcDir)
            val srcManifest = srcDir.resolve("AndroidManifest.xml")
            Files.writeString(srcManifest, "<manifest package=\"com.example.app\"/>")

            val buildGradle = tempDir.resolve("build.gradle.kts")
            Files.writeString(buildGradle, "android { compileSdk = 34 }")

            Thread.sleep(50)

            val mergedDir = tempDir.resolve("build/intermediates/merged_manifests/debug/processDebugManifest")
            Files.createDirectories(mergedDir)
            val mergedManifest = mergedDir.resolve("AndroidManifest.xml")
            Files.writeString(mergedManifest, "<manifest package=\"com.example.app\"/>")

            val logDir = tempDir.resolve("build/outputs/logs")
            Files.createDirectories(logDir)
            val blameReport = logDir.resolve("manifest-merger-debug-report.txt")
            Files.writeString(
                blameReport,
                "-- Merging decision tree log ---\nmanifest\nADDED from ${srcManifest.toAbsolutePath()}:1:1\n"
            )

            val model = AndroidLintModel(
                module = null,
                androidModule = null,
                moduleRoot = tempDir,
                projectRoot = tempDir,
                variant = "debug",
                sdkHome = null,
                compileSdk = 34,
                compileTarget = "android-34",
                minSdk = 26,
                targetSdk = 34,
                namespace = "com.example.app",
                isLibrary = false,
                minSdkPremiseMissing = false,
                lintModelModule = null,
                lintModelVariant = null,
                ruleJars = emptyList(),
                ruleJarFingerprints = emptyList(),
                fingerprint = "fp",
                lintXmlFingerprint = "xmlFp",
                xmlInputs = null,
            )

            val client = TestLintClient()
            val helper = AndroidLintManifest(model, environment.project, client)

            assertTrue(helper.isValidBuiltSnapshot())

            // Modify build.gradle.kts after merged manifest -> must invalidate!
            Thread.sleep(50)
            Files.writeString(buildGradle, "android { compileSdk = 35 }")
            assertFalse("Build script modification must invalidate built snapshot", helper.isValidBuiltSnapshot())
        } finally {
            deleteRecursively(tempDir)
        }
    }

    @Test
    fun openChangedSourcesInvalidateMergedSnapshot() {
        val tempDir = Files.createTempDirectory("lint_manifest_open_changed")
        try {
            val srcDir = tempDir.resolve("src/main")
            Files.createDirectories(srcDir)
            val srcManifest = srcDir.resolve("AndroidManifest.xml")
            val srcXml = "<manifest package=\"com.example.app\"/>"
            Files.writeString(srcManifest, srcXml)

            Thread.sleep(50)

            val mergedDir = tempDir.resolve("build/intermediates/merged_manifests/debug/processDebugManifest")
            Files.createDirectories(mergedDir)
            val mergedManifest = mergedDir.resolve("AndroidManifest.xml")
            Files.writeString(mergedManifest, "<manifest package=\"com.example.app\"/>")

            val logDir = tempDir.resolve("build/outputs/logs")
            Files.createDirectories(logDir)
            val blameReport = logDir.resolve("manifest-merger-debug-report.txt")
            Files.writeString(
                blameReport,
                "-- Merging decision tree log ---\nmanifest\nADDED from ${srcManifest.toAbsolutePath()}:1:1\n"
            )

            val model = AndroidLintModel(
                module = null,
                androidModule = null,
                moduleRoot = tempDir,
                projectRoot = tempDir,
                variant = "debug",
                sdkHome = null,
                compileSdk = 34,
                compileTarget = "android-34",
                minSdk = 26,
                targetSdk = 34,
                namespace = "com.example.app",
                isLibrary = false,
                minSdkPremiseMissing = false,
                lintModelModule = null,
                lintModelVariant = null,
                ruleJars = emptyList(),
                ruleJarFingerprints = emptyList(),
                fingerprint = "fingerprint",
                lintXmlFingerprint = "lintXmlFingerprint",
                xmlInputs = null,
            )

            // A client simulating open editor with unsaved content differing from disk
            val client = object : TestLintClient() {
                override fun readFile(file: File): CharSequence {
                    if (file == srcManifest.toFile()) {
                        return "<manifest package=\"com.example.app\"><application/></manifest>"
                    }
                    return super.readFile(file)
                }
            }

            val helper = AndroidLintManifest(model, environment.project, client)

            assertFalse(
                "Open changed sources must invalidate merged snapshot",
                helper.isValidBuiltSnapshot(srcManifest.toFile(), null)
            )

            val targetDom = client.xmlParser.parseXml(
                "<manifest package=\"com.example.app\"><application/></manifest>",
                srcManifest.toFile()
            )
            val result = helper.getMergedManifest(null, srcManifest.toFile(), targetDom)
            assertSame(targetDom, result)
            assertFalse(helper.isMergeManifestNode(result!!.documentElement))
        } finally {
            deleteRecursively(tempDir)
        }
    }

    @Test
    fun mismatchedVariantProvenanceRejectsMergedSnapshot() {
        val tempDir = Files.createTempDirectory("lint_manifest_variant_test")
        try {
            val srcDir = tempDir.resolve("src/main")
            Files.createDirectories(srcDir)
            val srcManifest = srcDir.resolve("AndroidManifest.xml")
            Files.writeString(srcManifest, "<manifest package=\"com.example.app\"/>")

            Thread.sleep(50)

            // Artifacts generated only for "debug"
            val mergedDir = tempDir.resolve("build/intermediates/merged_manifests/debug/processDebugManifest")
            Files.createDirectories(mergedDir)
            Files.writeString(mergedDir.resolve("AndroidManifest.xml"), "<manifest package=\"com.example.app\"/>")

            val logDir = tempDir.resolve("build/outputs/logs")
            Files.createDirectories(logDir)
            val blameReport = logDir.resolve("manifest-merger-debug-report.txt")
            Files.writeString(
                blameReport,
                "-- Merging decision tree log ---\nmanifest\nADDED from ${srcManifest.toAbsolutePath()}:1:1\n"
            )

            // Model is configured for variant "release"
            val releaseModel = AndroidLintModel(
                module = null,
                androidModule = null,
                moduleRoot = tempDir,
                projectRoot = tempDir,
                variant = "release",
                sdkHome = null,
                compileSdk = 34,
                compileTarget = "android-34",
                minSdk = 26,
                targetSdk = 34,
                namespace = "com.example.app",
                isLibrary = false,
                minSdkPremiseMissing = false,
                lintModelModule = null,
                lintModelVariant = null,
                ruleJars = emptyList(),
                ruleJarFingerprints = emptyList(),
                fingerprint = "fingerprint",
                lintXmlFingerprint = "lintXmlFingerprint",
                xmlInputs = null,
            )

            val client = TestLintClient()
            val helper = AndroidLintManifest(releaseModel, environment.project, client)

            assertFalse(
                "Mismatched variant must not accept artifacts of a different variant",
                helper.isValidBuiltSnapshot()
            )
            assertNull(helper.getMergedManifestFile())
        } finally {
            deleteRecursively(tempDir)
        }
    }

    companion object {
        private lateinit var disposable: Disposable
        private lateinit var environment: CoreProjectEnvironment

        @JvmStatic
        @BeforeClass
        fun setUp() {
            LintClient.clientName = LintClient.CLIENT_UNIT_TESTS
            disposable = Disposer.newDisposable()
            val application = CoreApplicationEnvironment(disposable)
            environment = CoreProjectEnvironment(disposable, application)
        }

        @JvmStatic
        @AfterClass
        fun tearDown() {
            Disposer.dispose(disposable)
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
    }
}
