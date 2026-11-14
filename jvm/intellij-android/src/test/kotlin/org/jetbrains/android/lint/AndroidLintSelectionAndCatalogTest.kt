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
import com.android.tools.lint.detector.api.Issue
import com.android.tools.lint.detector.api.Platform
import com.android.tools.lint.detector.api.Scope
import com.android.tools.lint.detector.api.Severity
import com.android.tools.lint.detector.api.StringOption
import com.android.tools.lint.detector.api.XmlContext
import com.android.tools.lint.detector.api.XmlScanner
import com.intellij.core.CoreApplicationEnvironment
import com.intellij.core.CoreProjectEnvironment
import com.intellij.ide.highlighter.XmlFileType
import com.intellij.lang.java.JavaLanguage
import com.intellij.lang.xml.XMLLanguage
import com.intellij.lang.xml.XMLParserDefinition
import com.intellij.openapi.Disposable
import com.intellij.openapi.util.Disposer
import com.intellij.psi.PsiManager
import com.intellij.psi.SingleRootFileViewProvider
import com.intellij.psi.xml.XmlFile
import com.intellij.testFramework.LightVirtualFile
import com.jetbrains.ls.api.features.language.LSLanguage
import org.jetbrains.android.AndroidExtension
import org.jetbrains.android.context.AndroidQueryException
import org.jetbrains.android.resource.AndroidSources
import org.jetbrains.kotlin.idea.KotlinLanguage
import org.junit.AfterClass
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.BeforeClass
import org.junit.Test
import org.w3c.dom.Document
import java.io.IOException
import java.nio.file.Files
import java.nio.file.Path
import java.util.Comparator
import java.util.EnumSet
import java.util.UUID
import java.util.concurrent.CancellationException
import java.util.concurrent.atomic.AtomicInteger
import java.util.jar.Attributes
import java.util.jar.JarOutputStream
import java.util.jar.Manifest
import java.util.zip.ZipEntry

class AndroidLintSelectionAndCatalogTest {

    companion object {
        private var disposable: Disposable? = null
        private var environment: CoreProjectEnvironment? = null

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
    fun nonMatchingSelectionSkipsDetectorExecutionWithoutFailure() {
        val tempDir = Files.createTempDirectory("lint_selection_nomatch")
        try {
            MultiScopeRegistry.creations.set(0)
            MultiScopeDetector.calls.set(0)
            val jarPath = writeLintRegistryJar(tempDir.resolve("lint.jar"), MultiScopeRegistry::class.java.name)
            val (model, xmlFile, xmlText) = prepareXmlProject(
                tempDir,
                listOf(jarPath),
                "src/main/res/layout/activity_main.xml"
            )

            AndroidSources.Scope(null, null).use {
                val client = AndroidLintClient(
                    model,
                    xmlFile,
                    xmlText,
                    Scope.RESOURCE_FILE,
                    setOf("NonExistentRuleId")
                )
                val incidents = client.analyze()
                assertTrue(client.isAnalysisComplete())
                assertTrue(incidents.isEmpty())
                assertEquals(0, MultiScopeDetector.calls.get())
            }
        } finally {
            deleteRecursively(tempDir)
        }
    }

    @Test
    fun perFileLintXmlOptionsIgnoreAndSiblingBlockingWorkDuringDriverExecution() {
        val tempDir = Files.createTempDirectory("lint_selection_per_file")
        try {
            PerFileSharedRegistry.calls.set(0)
            val jarPath = writeLintRegistryJar(tempDir.resolve("lint.jar"), PerFileSharedRegistry::class.java.name)

            val projectRoot = tempDir.resolve("project")
            val moduleRoot = projectRoot.resolve("app")
            val layoutDir = moduleRoot.resolve("src/main/res/layout")
            val valuesDir = moduleRoot.resolve("src/main/res/values")
            Files.createDirectories(layoutDir)
            Files.createDirectories(valuesDir)

            Files.writeString(
                projectRoot.resolve("lint.xml"),
                "<lint><issue id=\"${PerFileSharedRegistry.ISSUE_PRIMARY.id}\" severity=\"warning\"/></lint>"
            )
            Files.writeString(
                layoutDir.resolve("lint.xml"),
                """
                <lint>
                    <issue id="${PerFileSharedRegistry.ISSUE_PRIMARY.id}" severity="error">
                        <option name="customFlag" value="from-per-file"/>
                        <ignore path="ignored.xml"/>
                    </issue>
                    <issue id="${PerFileSharedRegistry.ISSUE_SIBLING.id}" severity="error"/>
                </lint>
                """.trimIndent()
            )
            Files.writeString(
                valuesDir.resolve("lint.xml"),
                "<lint><issue id=\"${PerFileSharedRegistry.ISSUE_PRIMARY.id}\" severity=\"ignore\"/></lint>"
            )

            val layoutContent = "<LinearLayout xmlns:android=\"http://schemas.android.com/apk/res/android\"/>"
            val activeLayoutPath = layoutDir.resolve("active.xml")
            val ignoredLayoutPath = layoutDir.resolve("ignored.xml")
            val valuesContent = "<resources><string name=\"app_name\">App</string></resources>"
            val valuesPath = valuesDir.resolve("strings.xml")
            Files.writeString(activeLayoutPath, layoutContent)
            Files.writeString(ignoredLayoutPath, layoutContent)
            Files.writeString(valuesPath, valuesContent)

            val model = createModel(projectRoot, moduleRoot, listOf(jarPath), minSdkPremiseMissing = false)

            AndroidSources.Scope(null, null).use {
                val activeClient = AndroidLintClient(
                    model,
                    createXmlFile(activeLayoutPath, layoutContent),
                    layoutContent,
                    Scope.RESOURCE_FILE,
                    setOf(PerFileSharedRegistry.ISSUE_PRIMARY.id)
                )
                val incidents = activeClient.analyze()
                assertTrue(activeClient.isAnalysisComplete())
                assertEquals(1, incidents.size)
                assertEquals(PerFileSharedRegistry.ISSUE_PRIMARY.id, incidents[0].issue.id)
                assertEquals(Severity.ERROR, incidents[0].severity)
                assertTrue(incidents[0].message.contains("from-per-file"))
            }

            AndroidSources.Scope(null, null).use {
                val ignoredClient = AndroidLintClient(
                    model,
                    createXmlFile(ignoredLayoutPath, layoutContent),
                    layoutContent,
                    Scope.RESOURCE_FILE,
                    setOf(PerFileSharedRegistry.ISSUE_PRIMARY.id)
                )
                val incidents = ignoredClient.analyze()
                assertTrue(ignoredClient.isAnalysisComplete())
                assertTrue(incidents.isEmpty())
            }

            AndroidSources.Scope(null, null).use {
                val disabledClient = AndroidLintClient(
                    model,
                    createXmlFile(valuesPath, valuesContent),
                    valuesContent,
                    Scope.RESOURCE_FILE,
                    setOf(PerFileSharedRegistry.ISSUE_PRIMARY.id)
                )
                val incidents = disabledClient.analyze()
                assertTrue(disabledClient.isAnalysisComplete())
                assertTrue(incidents.isEmpty())
            }
        } finally {
            deleteRecursively(tempDir)
        }
    }

    @Test
    fun aarFaultIsolationPreservesHealthySubsetAndPropagatesCancellation() {
        val tempDir = Files.createTempDirectory("lint_selection_aar_isolation")
        try {
            MultiScopeRegistry.creations.set(0)
            MultiScopeDetector.calls.set(0)
            val healthyJar =
                writeLintRegistryJar(tempDir.resolve("healthy-lint.jar"), MultiScopeRegistry::class.java.name)
            val corruptJar = tempDir.resolve("corrupt-lint.jar")
            Files.writeString(corruptJar, "not-a-valid-jar")

            val (model, xmlFile, xmlText) = prepareXmlProject(
                tempDir,
                listOf(healthyJar, corruptJar),
                "src/main/res/layout/activity_main.xml"
            )

            AndroidSources.Scope(null, null).use {
                val client = AndroidLintClient(
                    model,
                    xmlFile,
                    xmlText,
                    Scope.RESOURCE_FILE,
                    setOf(MultiScopeRegistry.ISSUE_RES.id)
                )
                val incidents = client.analyze()
                assertTrue(client.isAnalysisComplete())
                assertEquals(listOf(MultiScopeRegistry.ISSUE_RES.id), incidents.map { it.issue.id })
            }

            val canceled = CancellationException("aar canceled")
            val throwingJar =
                writeLintRegistryJar(tempDir.resolve("cancel-lint.jar"), CancelingAarRegistry::class.java.name)
            CancelingAarRegistry.toThrow = canceled
            val cancelModel = createModel(
                model.projectRoot!!,
                model.moduleRoot!!,
                listOf(throwingJar),
                minSdkPremiseMissing = false
            )
            AndroidSources.Scope(null, null).use {
                val cancelClient = AndroidLintClient(
                    cancelModel,
                    xmlFile,
                    xmlText,
                    Scope.RESOURCE_FILE,
                    setOf(CancelingAarRegistry.ISSUE_CANCEL.id)
                )
                val thrown = assertThrows(CancellationException::class.java) {
                    cancelClient.analyze()
                }
                assertSame(canceled, thrown)
            }

            CancelingRegistry.toThrow = canceled
            val isolationThrown = assertThrows(CancellationException::class.java) {
                AndroidLintClient.runWithIsolation(listOf(CancelingRegistry())) { reg ->
                    reg.issues
                    emptyList()
                }
            }
            assertSame(canceled, isolationThrown)

            val canceledJob = kotlinx.coroutines.Job()
            assertThrows(CancellationException::class.java) {
                com.intellij.openapi.progress.jobToIndicator(
                    canceledJob,
                    com.intellij.openapi.progress.EmptyProgressIndicator()
                ) {
                    canceledJob.cancel()
                    AndroidSources.Scope(null, null).use {
                        AndroidLintClient(cancelModel, null, null, null, null).availableIssues(Scope.RESOURCE_FILE)
                    }
                }
            }
        } finally {
            CancelingRegistry.toThrow = null
            CancelingAarRegistry.toThrow = null
            deleteRecursively(tempDir)
        }
    }

    @Test
    fun availableIssuesReusesAarAssemblyAcrossScopesWithNullDriverAndReportsCompleteness() {
        val tempDir = Files.createTempDirectory("lint_available_issues_reuse")
        try {
            MultiScopeRegistry.creations.set(0)
            MultiScopeDetector.calls.set(0)
            val jarPath = writeLintRegistryJar(tempDir.resolve("lint.jar"), MultiScopeRegistry::class.java.name)
            val projectRoot = tempDir.resolve("project")
            val moduleRoot = projectRoot.resolve("app")
            Files.createDirectories(moduleRoot)

            val model = createModel(projectRoot, moduleRoot, listOf(jarPath), minSdkPremiseMissing = false)
            AndroidSources.Scope(null, null).use {
                val client = AndroidLintClient(model, null, null, null, null)
                val javaIssues = client.availableIssues(Scope.JAVA_FILE)
                val resIssues = client.availableIssues(Scope.RESOURCE_FILE)
                val manifestIssues = client.availableIssues(Scope.MANIFEST)

                assertTrue(client.isIssueEnumerationComplete())
                assertEquals(1, MultiScopeRegistry.creations.get())
                assertEquals(0, MultiScopeDetector.calls.get())

                val javaIds = javaIssues.map { it.id }.toSet()
                val resIds = resIssues.map { it.id }.toSet()
                val manifestIds = manifestIssues.map { it.id }.toSet()

                assertTrue(javaIds.contains(MultiScopeRegistry.ISSUE_JAVA.id))
                assertTrue(javaIds.contains(ApiDetector.UNSUPPORTED.id))
                assertFalse(javaIds.contains(MultiScopeRegistry.ISSUE_CLASS_ONLY.id))
                assertFalse(javaIds.contains(MultiScopeRegistry.ISSUE_JDK_ONLY.id))

                assertTrue(resIds.contains(MultiScopeRegistry.ISSUE_RES.id))
                assertFalse(resIds.contains(MultiScopeRegistry.ISSUE_JAVA.id))
                assertFalse(resIds.contains(MultiScopeRegistry.ISSUE_CLASS_ONLY.id))

                assertTrue(manifestIds.contains(MultiScopeRegistry.ISSUE_MANIFEST.id))
                assertFalse(manifestIds.contains(MultiScopeRegistry.ISSUE_RES.id))
            }

            val noApiModel = createModel(projectRoot, moduleRoot, listOf(jarPath), minSdkPremiseMissing = true)
            AndroidSources.Scope(null, null).use {
                val client = AndroidLintClient(noApiModel, null, null, null, null)
                val javaIssues = client.availableIssues(Scope.JAVA_FILE)
                assertTrue(client.isIssueEnumerationComplete())
                assertFalse(javaIssues.any { it.id == ApiDetector.UNSUPPORTED.id })
            }
        } finally {
            deleteRecursively(tempDir)
        }
    }

    @Test
    fun availableIssuesFollowsOfficialGetIssueRepresentativeAndMarksPartialCatalogIncomplete() {
        val tempDir = Files.createTempDirectory("lint_available_issues_dup_partial")
        try {
            val overrideJar = writeLintRegistryJar(
                tempDir.resolve("override-lint.jar"),
                DuplicateBuiltinIdRegistry::class.java.name
            )
            val projectRoot = tempDir.resolve("project")
            val moduleRoot = projectRoot.resolve("app")
            Files.createDirectories(moduleRoot)

            val dupModel = createModel(projectRoot, moduleRoot, listOf(overrideJar), minSdkPremiseMissing = false)
            AndroidSources.Scope(null, null).use {
                val client = AndroidLintClient(dupModel, null, null, null, null)
                val resIssues = client.availableIssues(Scope.RESOURCE_FILE)
                assertTrue(client.isIssueEnumerationComplete())
                val matches = resIssues.filter { it.id == "HardcodedText" }
                assertEquals(1, matches.size)
                assertEquals(
                    DuplicateBuiltinIdRegistry.OVERRIDE_HARDCODED.getBriefDescription(
                        com.android.tools.lint.detector.api.TextFormat.RAW
                    ),
                    matches[0].getBriefDescription(com.android.tools.lint.detector.api.TextFormat.RAW)
                )
            }

            // Corrupt AAR fails load -> healthy/builtin issues still returned, completeness is false
            val corruptJar = tempDir.resolve("corrupt-lint.jar")
            Files.writeString(corruptJar, "corrupt")
            val partialModel = createModel(
                projectRoot,
                moduleRoot,
                listOf(overrideJar, corruptJar),
                minSdkPremiseMissing = false
            )
            AndroidSources.Scope(null, null).use {
                val client = AndroidLintClient(partialModel, null, null, null, null)
                val javaIssues = client.availableIssues(Scope.JAVA_FILE)
                val resIssues = client.availableIssues(Scope.RESOURCE_FILE)
                val manifestIssues = client.availableIssues(Scope.MANIFEST)
                assertFalse(client.isIssueEnumerationComplete())
                assertTrue(javaIssues.isNotEmpty())
                assertTrue(resIssues.any { it.id == "HardcodedText" })
                assertTrue(manifestIssues.isNotEmpty())
            }

            // Missing AAR jar -> completeness is false
            val missingModel = createModel(
                projectRoot,
                moduleRoot,
                listOf(tempDir.resolve("missing-lint.jar")),
                minSdkPremiseMissing = false
            )
            AndroidSources.Scope(null, null).use {
                val client = AndroidLintClient(missingModel, null, null, null, null)
                val resIssues = client.availableIssues(Scope.RESOURCE_FILE)
                assertFalse(client.isIssueEnumerationComplete())
                assertTrue(resIssues.isNotEmpty())
            }

            // Registry whose getIssues throws NoSuchMethodError during load -> completeness is false
            val brokenJar = writeLintRegistryJar(
                tempDir.resolve("broken-metadata.jar"),
                BrokenMetadataRegistry::class.java.name
            )
            val brokenModel = createModel(
                projectRoot,
                moduleRoot,
                listOf(brokenJar),
                minSdkPremiseMissing = false
            )
            AndroidSources.Scope(null, null).use {
                val client = AndroidLintClient(brokenModel, null, null, null, null)
                val resIssues = client.availableIssues(Scope.RESOURCE_FILE)
                assertFalse(client.isIssueEnumerationComplete())
                assertTrue(resIssues.isNotEmpty())
            }
        } finally {
            deleteRecursively(tempDir)
        }
    }

    @Test
    fun aarModificationBetweenEnumerationAndVerifyThrowsContentModified() {
        val tempDir = Files.createTempDirectory("lint_available_issues_stamp")
        try {
            val jarPath = writeLintRegistryJar(tempDir.resolve("lint.jar"), MultiScopeRegistry::class.java.name)
            val projectRoot = tempDir.resolve("project")
            val moduleRoot = projectRoot.resolve("app")
            Files.createDirectories(moduleRoot)
            val model = createModel(projectRoot, moduleRoot, listOf(jarPath), minSdkPremiseMissing = false)

            AndroidSources.Scope(null, null).use { scope ->
                val client = AndroidLintClient(model, null, null, null, null)
                val issues = client.availableIssues(Scope.RESOURCE_FILE)
                assertTrue(issues.any { it.id == MultiScopeRegistry.ISSUE_RES.id })
                scope.verify()

                writeLintRegistryJar(jarPath, DuplicateBuiltinIdRegistry::class.java.name)
                assertThrows(AndroidQueryException::class.java) {
                    scope.verify()
                }
            }
        } finally {
            deleteRecursively(tempDir)
        }
    }

    @Test
    fun catalogMergesSameRawIdAcrossScopesAndAppliesLaterModelRepresentativeMetadata() {
        val tempDir = Files.createTempDirectory("lint_catalog_merge_test")
        try {
            val javaLang = LSLanguage("java", JavaLanguage.INSTANCE, listOf("java"))
            val kotlinLang = LSLanguage("kotlin", KotlinLanguage.INSTANCE, listOf("kt", "kts"))
            val catalog = AndroidLintInspections.Catalog(setOf(javaLang, kotlinLang))

            val jarA = writeLintRegistryJar(tempDir.resolve("lint-a.jar"), CatalogModelARegistry::class.java.name)
            val jarB = writeLintRegistryJar(tempDir.resolve("lint-b.jar"), CatalogModelBRegistry::class.java.name)
            val root = tempDir.resolve("project")
            val modA = root.resolve("modA")
            val modB = root.resolve("modB")
            Files.createDirectories(modA)
            Files.createDirectories(modB)

            val modelA = createModel(root, modA, listOf(jarA), minSdkPremiseMissing = false)
            val modelB = createModel(root, modB, listOf(jarB), minSdkPremiseMissing = false)

            AndroidSources.Scope(null, null).use {
                val clientA = AndroidLintClient(modelA, null, null, null, null)
                for (scope in listOf(Scope.JAVA_FILE, Scope.RESOURCE_FILE, Scope.MANIFEST)) {
                    for (issue in clientA.availableIssues(scope)) {
                        catalog.add(issue, scope)
                    }
                }
                assertTrue(clientA.isIssueEnumerationComplete())

                val clientB = AndroidLintClient(modelB, null, null, null, null)
                for (scope in listOf(Scope.JAVA_FILE, Scope.RESOURCE_FILE, Scope.MANIFEST)) {
                    for (issue in clientB.availableIssues(scope)) {
                        catalog.add(issue, scope)
                    }
                }
                assertTrue(clientB.isIssueEnumerationComplete())
            }

            val built = catalog.build()
            val sharedEntries = built.filter { it.info.id == "AndroidLint.CatalogSharedId" }
            assertEquals(1, sharedEntries.size)
            val shared = sharedEntries[0]
            assertEquals(setOf("CatalogSharedId"), shared.aliases)
            assertEquals(setOf(javaLang, kotlinLang, AndroidExtension.XML), shared.languages)
            assertEquals("Model B representative summary", shared.info.displayName)
            assertEquals(listOf("Android Lint", Category.SECURITY.fullName), shared.info.groupPath)
            assertEquals("ERROR", shared.info.defaultLevel)
            assertFalse(shared.info.enabledByDefault)

            val disabledEntry = built.firstOrNull { it.info.id == "AndroidLint.CatalogDisabledDefault" }
            assertNotNull(disabledEntry)
            assertEquals("WARNING", disabledEntry!!.info.defaultLevel)
            assertFalse(disabledEntry.info.enabledByDefault)
            assertEquals(setOf(AndroidExtension.XML), disabledEntry.languages)

            val infoEntry = built.firstOrNull { it.info.id == "AndroidLint.CatalogFatalRule" }
            assertNotNull(infoEntry)
            assertEquals("ERROR", infoEntry!!.info.defaultLevel)
            assertTrue(infoEntry.info.enabledByDefault)
            assertEquals(setOf(javaLang, kotlinLang), infoEntry.languages)
        } finally {
            deleteRecursively(tempDir)
        }
    }

    private fun prepareXmlProject(
        tempDir: Path,
        ruleJars: List<Path>,
        relativePath: String
    ): Triple<AndroidLintModel, XmlFile, String> {
        val projectRoot = tempDir.resolve("project")
        val moduleRoot = projectRoot.resolve("app")
        val xmlPath = moduleRoot.resolve(relativePath)
        Files.createDirectories(xmlPath.parent)
        val xmlText = "<LinearLayout xmlns:android=\"http://schemas.android.com/apk/res/android\"/>"
        Files.writeString(xmlPath, xmlText)
        val model = createModel(projectRoot, moduleRoot, ruleJars, minSdkPremiseMissing = false)
        return Triple(model, createXmlFile(xmlPath, xmlText), xmlText)
    }

    private fun createModel(
        projectRoot: Path,
        moduleRoot: Path,
        ruleJars: List<Path>,
        minSdkPremiseMissing: Boolean
    ): AndroidLintModel {
        return AndroidLintModel(
            module = null,
            androidModule = null,
            moduleRoot = moduleRoot,
            projectRoot = projectRoot,
            variant = "debug",
            sdkHome = null,
            compileSdk = 34,
            compileTarget = "android-34",
            minSdk = if (minSdkPremiseMissing) null else 21,
            targetSdk = 34,
            namespace = "com.example.test",
            isLibrary = false,
            minSdkPremiseMissing = minSdkPremiseMissing,
            lintModelModule = null,
            lintModelVariant = null,
            ruleJars = ruleJars,
            ruleJarFingerprints = emptyList(),
            fingerprint = "fp",
            lintXmlFingerprint = "xml-fp",
            xmlInputs = null
        )
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

    class PerFileSharedDetector : Detector(), XmlScanner {
        override fun appliesTo(folderType: ResourceFolderType): Boolean = true
        override fun visitDocument(context: XmlContext, document: Document) {
            PerFileSharedRegistry.calls.incrementAndGet()
            val root = document.documentElement ?: return
            val loc = context.getLocation(root)
            val opt = PerFileSharedRegistry.CUSTOM_OPTION.getValue(context) ?: "unset"
            context.report(PerFileSharedRegistry.ISSUE_PRIMARY, root, loc, "Primary option=$opt")
            context.report(PerFileSharedRegistry.ISSUE_SIBLING, root, loc, "Sibling option=$opt")
        }
    }

    class PerFileSharedRegistry : IssueRegistry() {
        override val api: Int = CURRENT_API
        override val vendor: Vendor = Vendor(vendorName = "Test", identifier = "test-per-file")
        override val issues: List<Issue> = listOf(ISSUE_PRIMARY, ISSUE_SIBLING)

        companion object {
            val calls = AtomicInteger()
            val CUSTOM_OPTION = StringOption("customFlag", "Custom flag", "default")
            val ISSUE_PRIMARY = Issue.create(
                "PerFileSiblingA",
                "Per-file primary",
                "Per-file primary explanation",
                Category.CORRECTNESS,
                5,
                Severity.WARNING,
                Implementation(PerFileSharedDetector::class.java, EnumSet.of(Scope.RESOURCE_FILE))
            ).setOptions(listOf(CUSTOM_OPTION))
            val ISSUE_SIBLING = Issue.create(
                "PerFileSiblingB",
                "Per-file sibling",
                "Per-file sibling explanation",
                Category.CORRECTNESS,
                5,
                Severity.WARNING,
                Implementation(PerFileSharedDetector::class.java, EnumSet.of(Scope.RESOURCE_FILE))
            )
        }
    }

    class MultiScopeDetector : Detector(), XmlScanner {
        override fun appliesTo(folderType: ResourceFolderType): Boolean = true
        override fun visitDocument(context: XmlContext, document: Document) {
            MultiScopeDetector.calls.incrementAndGet()
            val root = document.documentElement ?: return
            context.report(MultiScopeRegistry.ISSUE_RES, root, context.getLocation(root), "Multi-scope res hit")
        }

        companion object {
            val calls = AtomicInteger()
        }
    }

    class MultiScopeRegistry : IssueRegistry() {
        init {
            creations.incrementAndGet()
        }

        override val api: Int = CURRENT_API
        override val vendor: Vendor = Vendor(vendorName = "Test", identifier = "test-multi-scope")
        override val issues: List<Issue> = listOf(
            ISSUE_JAVA,
            ISSUE_RES,
            ISSUE_MANIFEST,
            ISSUE_CLASS_ONLY,
            ISSUE_JDK_ONLY
        )

        companion object {
            val creations = AtomicInteger()
            val ISSUE_JAVA = Issue.create(
                "MultiScopeJava",
                "Multi-scope Java",
                "Java issue",
                Category.CORRECTNESS,
                5,
                Severity.WARNING,
                Implementation(MultiScopeDetector::class.java, EnumSet.of(Scope.JAVA_FILE))
            )
            val ISSUE_RES = Issue.create(
                "MultiScopeRes",
                "Multi-scope Resource",
                "Resource issue",
                Category.CORRECTNESS,
                5,
                Severity.WARNING,
                Implementation(MultiScopeDetector::class.java, EnumSet.of(Scope.RESOURCE_FILE))
            )
            val ISSUE_MANIFEST = Issue.create(
                "MultiScopeManifest",
                "Multi-scope Manifest",
                "Manifest issue",
                Category.CORRECTNESS,
                5,
                Severity.WARNING,
                Implementation(MultiScopeDetector::class.java, EnumSet.of(Scope.MANIFEST))
            )
            val ISSUE_CLASS_ONLY = Issue.create(
                "MultiScopeClassOnly",
                "Multi-scope Class",
                "Class issue",
                Category.CORRECTNESS,
                5,
                Severity.WARNING,
                Implementation(MultiScopeDetector::class.java, EnumSet.of(Scope.CLASS_FILE))
            )
            val ISSUE_JDK_ONLY = Issue.create(
                id = "MultiScopeJdkOnly",
                briefDescription = "Multi-scope JDK",
                explanation = "JDK-only issue",
                implementation = Implementation(MultiScopeDetector::class.java, EnumSet.of(Scope.JAVA_FILE)),
                category = Category.CORRECTNESS,
                priority = 5,
                severity = Severity.WARNING,
                platforms = Platform.JDK_SET
            )
        }
    }

    class DuplicateBuiltinIdRegistry : IssueRegistry() {
        override val api: Int = CURRENT_API
        override val vendor: Vendor = Vendor(vendorName = "OverrideVendor", identifier = "override-vendor")
        override val issues: List<Issue> = listOf(OVERRIDE_HARDCODED)

        companion object {
            val OVERRIDE_HARDCODED = Issue.create(
                "HardcodedText",
                "Override hardcoded text summary",
                "Override explanation",
                Category.I18N,
                5,
                Severity.WARNING,
                Implementation(MultiScopeDetector::class.java, EnumSet.of(Scope.RESOURCE_FILE))
            )
        }
    }

    class BrokenMetadataRegistry : IssueRegistry() {
        override val api: Int = CURRENT_API
        override val issues: List<Issue>
            get() = throw NoSuchMethodError("broken registry metadata")
    }

    class CancelingRegistry : IssueRegistry() {
        override val api: Int = CURRENT_API
        override val issues: List<Issue>
            get() {
                toThrow?.let { throw it }
                return emptyList()
            }

        companion object {
            @Volatile
            var toThrow: CancellationException? = null
        }
    }

    class CancelingDetector : Detector(), XmlScanner {
        override fun appliesTo(folderType: ResourceFolderType): Boolean = true
        override fun visitDocument(context: XmlContext, document: Document) {
            CancelingAarRegistry.toThrow?.let { throw it }
        }
    }

    class CancelingAarRegistry : IssueRegistry() {
        override val api: Int = CURRENT_API
        override val vendor: Vendor = Vendor(vendorName = "CancelVendor", identifier = "cancel-vendor")
        override val issues: List<Issue> = listOf(ISSUE_CANCEL)

        companion object {
            @Volatile
            var toThrow: CancellationException? = null
            val ISSUE_CANCEL = Issue.create(
                "CancelingAarIssue",
                "Canceling AAR summary",
                "Canceling AAR explanation",
                Category.CORRECTNESS,
                5,
                Severity.WARNING,
                Implementation(CancelingDetector::class.java, EnumSet.of(Scope.RESOURCE_FILE))
            )
        }
    }

    class CatalogModelARegistry : IssueRegistry() {
        override val api: Int = CURRENT_API
        override val vendor: Vendor = Vendor(vendorName = "ModelA", identifier = "model-a")
        override val issues: List<Issue> = listOf(
            SHARED_MULTI_SCOPE_A,
            FATAL_JAVA,
            DISABLED_RES
        )

        companion object {
            val SHARED_MULTI_SCOPE_A = Issue.create(
                "CatalogSharedId",
                "Model A summary",
                "Model A explanation",
                Category.CORRECTNESS,
                4,
                Severity.WARNING,
                Implementation(
                    MultiScopeDetector::class.java,
                    EnumSet.of(Scope.JAVA_FILE, Scope.RESOURCE_FILE, Scope.MANIFEST),
                    EnumSet.of(Scope.JAVA_FILE),
                    EnumSet.of(Scope.RESOURCE_FILE),
                    EnumSet.of(Scope.MANIFEST)
                )
            )
            val FATAL_JAVA = Issue.create(
                "CatalogFatalRule",
                "Fatal Java summary",
                "Fatal Java explanation",
                Category.SECURITY,
                9,
                Severity.FATAL,
                Implementation(MultiScopeDetector::class.java, EnumSet.of(Scope.JAVA_FILE))
            )
            val DISABLED_RES = Issue.create(
                id = "CatalogDisabledDefault",
                briefDescription = "Disabled res summary",
                explanation = "Disabled res explanation",
                implementation = Implementation(MultiScopeDetector::class.java, EnumSet.of(Scope.RESOURCE_FILE)),
                category = Category.USABILITY,
                priority = 3,
                severity = Severity.WARNING,
                enabledByDefault = false
            )
        }
    }

    class CatalogModelBRegistry : IssueRegistry() {
        override val api: Int = CURRENT_API
        override val vendor: Vendor = Vendor(vendorName = "ModelB", identifier = "model-b")
        override val issues: List<Issue> = listOf(SHARED_JAVA_B)

        companion object {
            val SHARED_JAVA_B = Issue.create(
                id = "CatalogSharedId",
                briefDescription = "Model B representative summary",
                explanation = "Model B explanation",
                implementation = Implementation(MultiScopeDetector::class.java, EnumSet.of(Scope.JAVA_FILE)),
                category = Category.SECURITY,
                priority = 8,
                severity = Severity.ERROR,
                enabledByDefault = false
            )
        }
    }
}
