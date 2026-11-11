package org.jetbrains.android.lint

import com.android.sdklib.AndroidTargetHash
import com.android.sdklib.AndroidVersion
import com.android.tools.lint.client.api.LintClient
import com.intellij.core.CoreApplicationEnvironment
import com.intellij.core.CoreProjectEnvironment
import com.intellij.openapi.Disposable
import com.intellij.openapi.util.Disposer
import com.intellij.testFramework.LightVirtualFile
import org.codehaus.groovy.ast.ModuleNode
import org.codehaus.groovy.control.SourceUnit
import org.jetbrains.android.resource.AndroidLayout
import org.jetbrains.android.resource.AndroidSources
import org.jetbrains.kotlin.idea.KotlinFileType
import org.jetbrains.kotlin.parsing.KotlinParserDefinition
import org.junit.AfterClass
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.BeforeClass
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.nio.file.Path

class AndroidGradleModelTest {

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
            val disp = disposable
            if (disp != null) {
                Disposer.dispose(disp)
            }
        }

        private fun cleanGroovy(script: String): AndroidLintModelResolver.CleanAstResult {
            return AndroidLintModelResolver.parseCleanGroovyAst(script)
        }

        private fun parseGroovyModule(script: String): ModuleNode {
            val unit = SourceUnit.create("build.gradle", script)
            unit.parse()
            unit.completePhase()
            unit.convert()
            return unit.ast
        }

        private fun createLayout(
            projectRoot: Path,
            variant: String?,
            importedSourceSets: Set<String>,
            groovyScript: String
        ): AndroidLayout {
            Files.createDirectories(projectRoot)
            Files.writeString(projectRoot.resolve("build.gradle"), groovyScript)
            val rootVf = object : LightVirtualFile("module") {
                override fun getPath(): String {
                    return projectRoot.toString().replace('\\', '/')
                }
            }
            AndroidSources.Scope(null, null).use { scope ->
                scope.useSavedModelInputs()
                return AndroidLayout(environment!!.project, rootVf, variant, importedSourceSets)
            }
        }

        private fun deleteRecursively(path: Path) {
            try {
                if (Files.isDirectory(path)) {
                    Files.list(path).use { s ->
                        for (p in s.toList()) deleteRecursively(p)
                    }
                }
                Files.deleteIfExists(path)
            } catch (_: Exception) {
            }
        }

        private fun createModel(compileSdk: Int?, compileTarget: String?): AndroidLintModel {
            return AndroidLintModel(
                null, null, null, null, null, null,
                compileSdk, compileTarget, 21, 34, "com.example",
                false, false, null, null,
                emptyList(), emptyList(), "fp", "xmlfp", null
            )
        }
    }

    @Test
    fun groovyCleanModelMatchesKotlinForUnambiguousLiterals() {
        val script = "plugins {\n" +
                "    id 'com.android.application'\n" +
                "}\n" +
                "android {\n" +
                "    compileSdk 34\n" +
                "    namespace 'com.example.groovyapp'\n" +
                "    defaultConfig {\n" +
                "        minSdk 21\n" +
                "        targetSdk 34\n" +
                "    }\n" +
                "}\n"

        val model = cleanGroovy(script)
        assertEquals(21, model.minSdk)
        assertEquals(34, model.targetSdk)
        assertEquals(34, model.compileSdk)
        assertEquals("android-34", model.compileTarget)
        assertEquals("com.example.groovyapp", model.namespace)
        assertEquals(false, model.isLibrary)
        assertFalse(model.minSdkPremiseMissing)
        assertFalse(model.minSdkUnsafe)
        assertFalse(model.compileSdkUnsafe)
        assertFalse(model.targetSdkUnsafe)
    }

    @Test
    fun groovyCleanModelHandlesAssignmentSyntaxAndLibraryPlugin() {
        val script = "apply plugin: 'com.android.library'\n" +
                "android {\n" +
                "    compileSdkVersion = 35\n" +
                "    namespace = 'com.example.groovylib'\n" +
                "    defaultConfig {\n" +
                "        minSdkVersion = 24\n" +
                "        targetSdkVersion = 35\n" +
                "    }\n" +
                "}\n"

        val model = cleanGroovy(script)
        assertEquals(24, model.minSdk)
        assertEquals(35, model.targetSdk)
        assertEquals(35, model.compileSdk)
        assertEquals("android-35", model.compileTarget)
        assertEquals("com.example.groovylib", model.namespace)
        assertEquals(true, model.isLibrary)
        assertFalse(model.minSdkPremiseMissing)
    }

    @Test
    fun groovyDynamicAssignmentsAreStickyAndNotOverwrittenByLaterLiterals() {
        val script = "android {\n" +
                "    compileSdk = selectedCompileSdk\n" +
                "    compileSdk 34\n" +
                "    defaultConfig {\n" +
                "        minSdk = selectedMin\n" +
                "        minSdk 21\n" +
                "        targetSdk = selectedTarget\n" +
                "        targetSdk 34\n" +
                "    }\n" +
                "}\n"

        val model = cleanGroovy(script)
        assertNull(model.compileSdk)
        assertNull(model.compileTarget)
        assertNull(model.minSdk)
        assertNull(model.targetSdk)
        assertTrue(model.compileSdkUnsafe)
        assertTrue(model.targetSdkUnsafe)
        assertTrue(model.minSdkUnsafe)
        assertTrue(model.minSdkPremiseMissing)
    }

    @Test
    fun groovyPreviewSdkPreservesPreviewTargetWithoutNumericGuess() {
        val script = "android {\n" +
                "    compileSdkPreview 'Baklava'\n" +
                "    defaultConfig {\n" +
                "        minSdk 21\n" +
                "        targetSdkPreview 'Baklava'\n" +
                "    }\n" +
                "}\n"

        val model = cleanGroovy(script)
        assertNull(model.compileSdk)
        assertEquals("android-Baklava", model.compileTarget)
        assertEquals(21, model.minSdk)
        assertNull(model.targetSdk)
        assertTrue(model.targetSdkUnsafe)
    }

    @Test
    fun groovyUntrustedScriptDoesNotExecuteGrabOrTransformations() {
        val script = "@Grab('nonexistent.malicious:dependency:9.9.9')\n" +
                "import nonexistent.malicious.Package\n" +
                "android {\n" +
                "    compileSdk 34\n" +
                "    defaultConfig {\n" +
                "        minSdk 21\n" +
                "    }\n" +
                "}\n"

        val model = cleanGroovy(script)
        assertEquals(34, model.compileSdk)
        assertEquals(21, model.minSdk)
    }

    @Test
    fun groovyLayoutMatchesCustomResourceRootsAndManifest() {
        val script = "android {\n" +
                "    namespace 'com.example.customlayout'\n" +
                "    sourceSets {\n" +
                "        main {\n" +
                "            res.srcDirs = ['src/main/res', 'src/custom/res']\n" +
                "            manifest.srcFile 'custom/AndroidManifest.xml'\n" +
                "        }\n" +
                "        debug {\n" +
                "            res.srcDir 'src/debug/res'\n" +
                "        }\n" +
                "    }\n" +
                "}\n"

        val projectRoot = Files.createTempDirectory("groovy_layout_custom").toAbsolutePath().normalize()
        try {
            val layout = createLayout(projectRoot, "debug", setOf("main", "debug"), script)

            assertTrue(layout.android)
            assertEquals("com.example.customlayout", layout.namespace)
            assertTrue(layout.resources.contains(projectRoot.resolve("src/main/res").normalize()))
            assertTrue(layout.resources.contains(projectRoot.resolve("src/custom/res").normalize()))
            assertTrue(layout.resources.contains(projectRoot.resolve("src/debug/res").normalize()))
            assertTrue(layout.manifests.contains(projectRoot.resolve("custom/AndroidManifest.xml").normalize()))
            assertFalse(layout.manifests.contains(projectRoot.resolve("src/main/AndroidManifest.xml").normalize()))
        } finally {
            deleteRecursively(projectRoot)
        }
    }

    @Test
    fun groovyLayoutReplacesResourcesOnSetSrcDirs() {
        val script = "android {\n" +
                "    sourceSets {\n" +
                "        getByName('main') {\n" +
                "            res.setSrcDirs(['res-override'])\n" +
                "        }\n" +
                "    }\n" +
                "}\n"

        val projectRoot = Files.createTempDirectory("groovy_layout_replace").toAbsolutePath().normalize()
        try {
            val layout = createLayout(projectRoot, null, setOf("main"), script)

            assertTrue(layout.android)
            assertEquals(setOf(projectRoot.resolve("res-override").normalize()), layout.resources)
        } finally {
            deleteRecursively(projectRoot)
        }
    }

    @Test
    fun groovyLayoutHandlesBracketAndPropertySourceSets() {
        val script = "android {\n" +
                "    sourceSets['main'].res.srcDirs = ['bracket/res']\n" +
                "    sourceSets.debug.res.srcDirs = ['property/res']\n" +
                "}\n"

        val projectRoot = Files.createTempDirectory("groovy_layout_bracket").toAbsolutePath().normalize()
        try {
            val layout = createLayout(projectRoot, "debug", setOf("main", "debug"), script)

            assertTrue(layout.android)
            assertTrue(layout.resources.contains(projectRoot.resolve("bracket/res").normalize()))
            assertTrue(layout.resources.contains(projectRoot.resolve("property/res").normalize()))
        } finally {
            deleteRecursively(projectRoot)
        }
    }

    @Test
    fun groovyLayoutInvalidatesOnDynamicExpressions() {
        val script = "android {\n" +
                "    sourceSets {\n" +
                "        main {\n" +
                "            res.srcDirs = dynamicPaths()\n" +
                "        }\n" +
                "    }\n" +
                "}\n"

        val projectRoot = Files.createTempDirectory("groovy_layout_dynamic").toAbsolutePath().normalize()
        try {
            val layout = createLayout(projectRoot, null, setOf("main"), script)

            assertTrue(layout.android)
            assertTrue(layout.resources.isEmpty())
        } finally {
            deleteRecursively(projectRoot)
        }
    }

    @Test
    fun androidLintProjectResolvesTargetHashAndBuildSdkWithoutNumericGuess() {
        // Standard platform
        val standard = createModel(34, "android-34")
        val standardProject = AndroidLintProject(null, File("."), null, standard, null, null)
        assertEquals("android-34", standardProject.buildTargetHash)
        assertEquals(34, standardProject.buildSdk)

        // Preview platform
        val preview = createModel(null, "android-Baklava")
        val previewProject = AndroidLintProject(null, File("."), null, preview, null, null)
        assertEquals("android-Baklava", previewProject.buildTargetHash)
        val baklavaVersion = AndroidTargetHash.getPlatformVersion("android-Baklava")
        assertNotNull(baklavaVersion)
        assertEquals(baklavaVersion!!.featureLevel, previewProject.buildSdk)

        // Add-on target
        val addon = createModel(null, "Google Inc.:Google APIs:34")
        val addonProject = AndroidLintProject(null, File("."), null, addon, null, null)
        assertEquals("Google Inc.:Google APIs:34", addonProject.buildTargetHash)
        assertEquals(34, addonProject.buildSdk)
    }
}
