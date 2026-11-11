package org.jetbrains.android.lint

import com.android.tools.lint.checks.ApiDetector
import com.android.tools.lint.client.api.Configuration
import com.android.tools.lint.client.api.LintClient
import com.android.tools.lint.detector.api.Category
import com.android.tools.lint.detector.api.Detector
import com.android.tools.lint.detector.api.Implementation
import com.android.tools.lint.detector.api.Issue
import com.android.tools.lint.detector.api.Scope
import com.android.tools.lint.detector.api.Severity
import com.android.tools.lint.model.LintModelLintOptions
import com.android.tools.lint.model.LintModelModule
import org.jetbrains.android.resource.AndroidSources
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.BeforeClass
import org.junit.Test
import java.io.File
import java.io.IOException
import java.lang.reflect.Proxy
import java.nio.file.Files
import java.nio.file.Path
import java.util.Comparator
import java.util.EnumSet

class AndroidLintConfigurationTest {

    companion object {
        private val TEST_ISSUE = Issue.create(
            "CustomCheck",
            "Custom check summary",
            "Custom check explanation",
            Category.CORRECTNESS,
            5,
            Severity.WARNING,
            Implementation(Detector::class.java, EnumSet.of(Scope.RESOURCE_FILE))
        )

        @JvmStatic
        @BeforeClass
        fun setUp() {
            LintClient.clientName = LintClient.CLIENT_UNIT_TESTS
        }
    }

    @Test
    fun intermediateLintXmlAffectsSeverityWhenRootDoesNotConfigureIssue() {
        val tempDir = Files.createTempDirectory("lint_config_inter_test")
        try {
            AndroidSources.Scope(null, null).use {
                val projectRoot = tempDir.resolve("project")
                val intermediateDir = projectRoot.resolve("features")
                val moduleDir = intermediateDir.resolve("chat")
                Files.createDirectories(moduleDir)

                Files.writeString(projectRoot.resolve("lint.xml"), "<lint></lint>")
                Files.writeString(
                    intermediateDir.resolve("lint.xml"),
                    "<lint><issue id=\"NewApi\" severity=\"warning\"/></lint>"
                )

                val model = createModel(projectRoot, moduleDir, null)
                val client = AndroidLintClient(model, null, null, null)
                val project = AndroidLintProject(client, moduleDir.toFile(), null, model, null, null)

                val config = client.getConfiguration(project, null)
                assertNotNull(config)
                assertEquals(Severity.WARNING, config.getSeverity(ApiDetector.UNSUPPORTED))
                assertTrue(config.isEnabled(ApiDetector.UNSUPPORTED))
            }
        } finally {
            deleteRecursively(tempDir)
        }
    }

    @Test
    fun nearerModuleOverridesIntermediateAndRootConfigurations() {
        val tempDir = Files.createTempDirectory("lint_config_override_test")
        try {
            AndroidSources.Scope(null, null).use {
                val projectRoot = tempDir.resolve("project")
                val intermediateDir = projectRoot.resolve("features")
                val moduleDir = intermediateDir.resolve("chat")
                Files.createDirectories(moduleDir)

                Files.writeString(
                    projectRoot.resolve("lint.xml"),
                    "<lint><issue id=\"NewApi\" severity=\"warning\"/><issue id=\"CustomCheck\" severity=\"warning\"/></lint>"
                )
                Files.writeString(
                    intermediateDir.resolve("lint.xml"),
                    "<lint><issue id=\"NewApi\" severity=\"error\"/><issue id=\"CustomCheck\" severity=\"error\"/></lint>"
                )
                Files.writeString(
                    moduleDir.resolve("lint.xml"),
                    "<lint><issue id=\"NewApi\" severity=\"ignore\"/></lint>"
                )

                val model = createModel(projectRoot, moduleDir, null)
                val client = AndroidLintClient(model, null, null, null)
                val project = AndroidLintProject(client, moduleDir.toFile(), null, model, null, null)

                val config = client.getConfiguration(project, null)
                assertNotNull(config)

                // Module specifies 'ignore' -> overrides intermediate 'error' and root 'warning'
                assertEquals(Severity.IGNORE, config.getSeverity(ApiDetector.UNSUPPORTED))
                assertFalse(config.isEnabled(ApiDetector.UNSUPPORTED))

                // Module does not configure CustomCheck -> intermediate 'error' overrides root 'warning'
                assertEquals(Severity.ERROR, config.getSeverity(TEST_ISSUE))
                assertTrue(config.isEnabled(TEST_ISSUE))
            }
        } finally {
            deleteRecursively(tempDir)
        }
    }

    @Test
    fun unchangedGradleLintOptionsPreservePrecedenceOverCascadedXml() {
        val tempDir = Files.createTempDirectory("lint_config_gradle_test")
        try {
            AndroidSources.Scope(null, null).use {
                val projectRoot = tempDir.resolve("project")
                val intermediateDir = projectRoot.resolve("features")
                val moduleDir = intermediateDir.resolve("chat")
                Files.createDirectories(moduleDir)

                Files.writeString(
                    intermediateDir.resolve("lint.xml"),
                    "<lint><issue id=\"NewApi\" severity=\"error\"/></lint>"
                )
                Files.writeString(
                    moduleDir.resolve("lint.xml"),
                    "<lint><issue id=\"NewApi\" severity=\"error\"/></lint>"
                )

                val lintOptions = createLintOptions(setOf("NewApi"), emptySet())
                val buildModule = createBuildModule(moduleDir.toFile(), lintOptions)

                val model = createModel(projectRoot, moduleDir, buildModule)
                val client = AndroidLintClient(model, null, null, null)
                val project = AndroidLintProject(client, moduleDir.toFile(), null, model, buildModule, null)

                val config = client.getConfiguration(project, null)
                assertNotNull(config)

                // Gradle lintOptions disables NewApi -> takes precedence over module & intermediate error
                assertEquals(Severity.IGNORE, config.getSeverity(ApiDetector.UNSUPPORTED))
                assertFalse(config.isEnabled(ApiDetector.UNSUPPORTED))
            }
        } finally {
            deleteRecursively(tempDir)
        }
    }

    @Test
    fun creatingIntermediateConfigurationInvalidatesTheReadSnapshot() {
        val tempDir = Files.createTempDirectory("lint_config_disk_absent_test")
        try {
            val projectRoot = tempDir.resolve("project")
            val intermediateDir = projectRoot.resolve("features")
            val moduleDir = intermediateDir.resolve("chat")
            Files.createDirectories(moduleDir)

            // Neither root nor intermediate nor module has lint.xml initially
            AndroidSources.Scope(null, null).use { scope ->
                val model = createModel(projectRoot, moduleDir, null)
                val client = AndroidLintClient(model, null, null, null)
                val project = AndroidLintProject(client, moduleDir.toFile(), null, model, null, null)

                client.getConfiguration(project, null)
                scope.verify()
                Files.writeString(
                    intermediateDir.resolve("lint.xml"),
                    "<lint><issue id=\"NewApi\" severity=\"ignore\"/></lint>"
                )
                assertThrows(org.jetbrains.android.context.AndroidQueryException::class.java) {
                    scope.verify()
                }
            }
        } finally {
            deleteRecursively(tempDir)
        }
    }

    private fun createModel(projectRoot: Path, moduleRoot: Path, buildModule: LintModelModule?): AndroidLintModel {
        return AndroidLintModel(
            null,
            null,
            moduleRoot,
            projectRoot,
            "debug",
            null,
            34,
            "android-34",
            21,
            34,
            "com.example.test",
            false,
            false,
            buildModule,
            null,
            emptyList(),
            emptyList(),
            "test-fingerprint",
            "test-xml-fingerprint",
            null
        )
    }

    private fun createLintOptions(disable: Set<String>, enable: Set<String>): LintModelLintOptions {
        return Proxy.newProxyInstance(
            LintModelLintOptions::class.java.classLoader,
            arrayOf(LintModelLintOptions::class.java)
        ) { proxy, method, args ->
            val name = method.name
            if ("getDisable" == name) return@newProxyInstance disable
            if ("getEnable" == name) return@newProxyInstance enable
            if ("getCheck" == name) return@newProxyInstance null
            if ("getSeverityOverrides" == name) return@newProxyInstance null
            if ("hashCode" == name) return@newProxyInstance System.identityHashCode(proxy)
            if ("equals" == name) return@newProxyInstance (proxy === (if (args != null && args.isNotEmpty()) args[0] else null))
            if ("toString" == name) return@newProxyInstance "ProxyLintOptions"
            if (method.returnType == Boolean::class.javaPrimitiveType) return@newProxyInstance false
            null
        } as LintModelLintOptions
    }

    private fun createBuildModule(dir: File, lintOptions: LintModelLintOptions): LintModelModule {
        return Proxy.newProxyInstance(
            LintModelModule::class.java.classLoader,
            arrayOf(LintModelModule::class.java)
        ) { proxy, method, args ->
            val name = method.name
            if ("getLintOptions" == name) return@newProxyInstance lintOptions
            if ("getDir" == name) return@newProxyInstance dir
            if ("hashCode" == name) return@newProxyInstance System.identityHashCode(proxy)
            if ("equals" == name) return@newProxyInstance (proxy === (if (args != null && args.isNotEmpty()) args[0] else null))
            if ("toString" == name) return@newProxyInstance "ProxyBuildModule"
            null
        } as LintModelModule
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
