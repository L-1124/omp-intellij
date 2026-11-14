@file:Suppress("UnstableApiUsage")

package org.jetbrains.android.lint

import com.android.tools.lint.checks.ApiDetector
import com.android.tools.lint.client.api.Configuration
import com.android.tools.lint.client.api.LintClient
import com.android.tools.lint.detector.api.Category
import com.android.tools.lint.detector.api.Context
import com.android.tools.lint.detector.api.Detector
import com.android.tools.lint.detector.api.Implementation
import com.android.tools.lint.detector.api.Incident
import com.android.tools.lint.detector.api.Issue
import com.android.tools.lint.detector.api.Location
import com.android.tools.lint.detector.api.Scope
import com.android.tools.lint.detector.api.Severity
import com.android.tools.lint.model.LintModelLintOptions
import com.android.tools.lint.model.LintModelModule
import com.android.tools.lint.model.LintModelSeverity
import com.intellij.core.CoreApplicationEnvironment
import com.intellij.core.CoreProjectEnvironment
import com.intellij.ide.highlighter.XmlFileType
import com.intellij.lang.xml.XMLLanguage
import com.intellij.lang.xml.XMLParserDefinition
import com.intellij.openapi.Disposable
import com.intellij.openapi.util.Disposer
import com.intellij.psi.PsiManager
import com.intellij.psi.SingleRootFileViewProvider
import com.intellij.psi.xml.XmlFile
import com.intellij.testFramework.LightVirtualFile
import org.jetbrains.android.resource.AndroidSources
import org.junit.AfterClass
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
        private var disposable: Disposable? = null
        private var environment: CoreProjectEnvironment? = null

        private val TEST_ISSUE = Issue.create(
            "CustomCheck",
            "Custom check summary",
            "Custom check explanation",
            Category.CORRECTNESS,
            5,
            Severity.WARNING,
            Implementation(Detector::class.java, EnumSet.of(Scope.RESOURCE_FILE))
        )

        private val SELECTED_DISABLED_ISSUE = Issue.create(
            "SelectedDisabled",
            "Selected disabled summary",
            "Selected disabled explanation",
            Category.CORRECTNESS,
            5,
            Severity.WARNING,
            Implementation(Detector::class.java, EnumSet.of(Scope.RESOURCE_FILE))
        )

        private val UNSELECTED_ENABLED_ISSUE = Issue.create(
            "UnselectedEnabled",
            "Unselected enabled summary",
            "Unselected enabled explanation",
            Category.CORRECTNESS,
            5,
            Severity.WARNING,
            Implementation(Detector::class.java, EnumSet.of(Scope.RESOURCE_FILE))
        )

        @JvmStatic
        @BeforeClass
        fun setUp() {
            LintClient.clientName = LintClient.CLIENT_UNIT_TESTS
            val disp = Disposer.newDisposable()
            disposable = disp
            val application = CoreApplicationEnvironment(disp)
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
        fun tearDown() {
            disposable?.let { Disposer.dispose(it) }
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
                val client = AndroidLintClient(model, null, null, null, null)
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
                val client = AndroidLintClient(model, null, null, null, null)
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
                val client = AndroidLintClient(model, null, null, null, null)
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
                val client = AndroidLintClient(model, null, null, null, null)
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

    @Test
    fun selectionSetGatesConfigurationWhileDelegatingSeverityOptionsIgnoreAndParent() {
        val tempDir = Files.createTempDirectory("lint_config_selection_test")
        try {
            AndroidSources.Scope(null, null).use {
                val projectRoot = tempDir.resolve("project")
                val moduleDir = projectRoot.resolve("app")
                val resDir = moduleDir.resolve("src/main/res/layout")
                Files.createDirectories(resDir)

                Files.writeString(
                    projectRoot.resolve("lint.xml"),
                    """
                    <lint>
                        <issue id="NewApi" severity="warning"/>
                        <issue id="CustomCheck" severity="error">
                            <option name="maxItems" value="7"/>
                            <ignore path="app/src/main/res/layout/ignored.xml"/>
                        </issue>
                    </lint>
                    """.trimIndent()
                )
                Files.writeString(
                    moduleDir.resolve("lint.xml"),
                    """
                    <lint>
                        <issue id="SelectedDisabled" severity="ignore"/>
                        <issue id="UnselectedEnabled" severity="error"/>
                    </lint>
                    """.trimIndent()
                )

                val model = createModel(projectRoot, moduleDir, null)
                val client = AndroidLintClient(
                    model,
                    null,
                    null,
                    null,
                    setOf("NewApi", "CustomCheck", "SelectedDisabled")
                )
                val project = AndroidLintProject(client, moduleDir.toFile(), null, model, null, null)
                val config = client.getConfiguration(project, null)
                assertNotNull(config)

                // Parent lint.xml severity preserved for selected issue
                assertTrue(config.isEnabled(ApiDetector.UNSUPPORTED))
                assertEquals(Severity.WARNING, config.getSeverity(ApiDetector.UNSUPPORTED))

                // Selected issue preserves severity, options, and ignore paths
                assertTrue(config.isEnabled(TEST_ISSUE))
                assertEquals(Severity.ERROR, config.getSeverity(TEST_ISSUE))
                assertEquals("7", config.getOption(TEST_ISSUE, "maxItems", null))

                val ignoredFile = resDir.resolve("ignored.xml").toFile()
                val activeFile = resDir.resolve("active.xml").toFile()
                val driver = com.android.tools.lint.client.api.LintDriver(
                    AndroidLintIssueRegistry.create(false, Scope.RESOURCE_FILE),
                    client,
                    com.android.tools.lint.client.api.LintRequest(client, listOf(ignoredFile, activeFile))
                )
                val ignoredContext = Context(driver, project, project, ignoredFile, "<LinearLayout/>")
                val ignoredIncident = Incident(TEST_ISSUE, Location.create(ignoredFile), "ignored msg")
                assertTrue(config.isIgnored(ignoredContext, ignoredIncident))

                val activeContext = Context(driver, project, project, activeFile, "<LinearLayout/>")
                val activeIncident = Incident(TEST_ISSUE, Location.create(activeFile), "active msg")
                assertFalse(config.isIgnored(activeContext, activeIncident))

                // Selected issue disabled by module lint.xml stays disabled
                assertFalse(config.isEnabled(SELECTED_DISABLED_ISSUE))
                assertEquals(Severity.IGNORE, config.getSeverity(SELECTED_DISABLED_ISSUE))

                // Unselected issue stays disabled even if module lint.xml enables it with error severity
                assertFalse(config.isEnabled(UNSELECTED_ENABLED_ISSUE))
            }
        } finally {
            deleteRecursively(tempDir)
        }
    }

    @Test
    fun selectionSetWithLintOptionsPreservesGradlePrecedenceAndDisablesUnselected() {
        val tempDir = Files.createTempDirectory("lint_config_selection_gradle_test")
        try {
            AndroidSources.Scope(null, null).use {
                val projectRoot = tempDir.resolve("project")
                val moduleDir = projectRoot.resolve("app")
                Files.createDirectories(moduleDir)

                Files.writeString(
                    moduleDir.resolve("lint.xml"),
                    """
                    <lint>
                        <issue id="CustomCheck" severity="warning"/>
                        <issue id="SelectedDisabled" severity="error"/>
                    </lint>
                    """.trimIndent()
                )

                val lintOptions = createLintOptions(
                    disable = setOf("SelectedDisabled"),
                    enable = setOf("UnselectedEnabled"),
                    severityOverrides = mapOf("CustomCheck" to LintModelSeverity.FATAL)
                )
                val buildModule = createBuildModule(moduleDir.toFile(), lintOptions)
                val model = createModel(projectRoot, moduleDir, buildModule)
                val client = AndroidLintClient(
                    model,
                    null,
                    null,
                    null,
                    setOf("CustomCheck", "SelectedDisabled")
                )
                val project = AndroidLintProject(client, moduleDir.toFile(), null, model, buildModule, null)
                val config = client.getConfiguration(project, null)

                assertTrue(config.isEnabled(TEST_ISSUE))
                assertEquals(Severity.FATAL, config.getSeverity(TEST_ISSUE))

                assertFalse(config.isEnabled(SELECTED_DISABLED_ISSUE))
                assertEquals(Severity.IGNORE, config.getSeverity(SELECTED_DISABLED_ISSUE))

                assertFalse(config.isEnabled(UNSELECTED_ENABLED_ISSUE))
            }
        } finally {
            deleteRecursively(tempDir)
        }
    }

    @Test
    fun subsetAnalysisDoesNotReportUnknownIssueIdForUnselectedOrUnknownConfiguredIds() {
        val tempDir = Files.createTempDirectory("lint_config_unknown_id_test")
        try {
            AndroidSources.Scope(null, null).use {
                val projectRoot = tempDir.resolve("project")
                val moduleDir = projectRoot.resolve("app")
                val layoutDir = moduleDir.resolve("src/main/res/layout")
                Files.createDirectories(layoutDir)

                Files.writeString(
                    projectRoot.resolve("lint.xml"),
                    """
                    <lint>
                        <issue id="UnknownConfiguredRule" severity="ignore"/>
                        <issue id="NewApi" severity="warning"/>
                    </lint>
                    """.trimIndent()
                )
                Files.writeString(
                    moduleDir.resolve("lint.xml"),
                    "<lint><issue id=\"AnotherUnknownRule\" severity=\"error\"/></lint>"
                )
                val layoutPath = layoutDir.resolve("activity_main.xml")
                val layoutXml = """
                    <LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"
                        android:layout_width="match_parent"
                        android:layout_height="match_parent">
                        <TextView
                            android:layout_width="wrap_content"
                            android:layout_height="wrap_content"
                            android:text="Hardcoded label" />
                    </LinearLayout>
                """.trimIndent()
                Files.writeString(layoutPath, layoutXml)

                val lintOptions = createLintOptions(
                    disable = setOf("UnknownGradleDisableId"),
                    enable = emptySet()
                )
                val buildModule = createBuildModule(moduleDir.toFile(), lintOptions)
                val model = createModel(projectRoot, moduleDir, buildModule)
                val psiFile = createXmlFile(layoutPath, layoutXml)

                val client = AndroidLintClient(
                    model,
                    psiFile,
                    layoutXml,
                    Scope.RESOURCE_FILE,
                    setOf("HardcodedText")
                )
                val incidents = client.analyze()
                assertTrue(client.isAnalysisComplete())
                assertEquals(listOf("HardcodedText"), incidents.map { it.issue.id })
                assertTrue(incidents.none { it.issue.id == "UnknownIssueId" || it.issue.id == "LintError" })
            }
        } finally {
            deleteRecursively(tempDir)
        }
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
            isLibrary = false,
            minSdkPremiseMissing = false,
            buildModule,
            null,
            emptyList(),
            emptyList(),
            "test-fingerprint",
            "test-xml-fingerprint",
            null
        )
    }

    private fun createLintOptions(
        disable: Set<String>,
        enable: Set<String>,
        severityOverrides: Map<String, LintModelSeverity>? = null
    ): LintModelLintOptions {
        return Proxy.newProxyInstance(
            LintModelLintOptions::class.java.classLoader,
            arrayOf(LintModelLintOptions::class.java)
        ) { proxy, method, args ->
            val name = method.name
            if ("getDisable" == name) return@newProxyInstance disable
            if ("getEnable" == name) return@newProxyInstance enable
            if ("getCheck" == name) return@newProxyInstance null
            if ("getSeverityOverrides" == name) return@newProxyInstance severityOverrides
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
