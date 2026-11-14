package org.jetbrains.android.testing

import com.android.tools.lint.client.api.LintClient
import com.intellij.psi.augment.PsiAugmentProvider
import com.intellij.psi.impl.search.PsiSearchHelperImpl
import com.intellij.psi.search.PsiSearchHelper
import javax.swing.SwingUtilities
import com.intellij.psi.search.UseScopeEnlarger
import com.intellij.openapi.vfs.findDocument
import com.intellij.psi.search.ScopeOptimizer
import com.intellij.core.CoreApplicationEnvironment
import com.intellij.core.JavaCoreApplicationEnvironment
import com.intellij.core.JavaCoreProjectEnvironment
import com.intellij.ide.highlighter.JavaFileType
import com.intellij.ide.highlighter.XmlFileType
import com.intellij.javaee.CoreExternalResourceManager
import com.intellij.javaee.ExternalResourceManager
import com.intellij.javaee.ImplicitNamespaceDescriptorProvider
import com.intellij.lang.LanguageASTFactory
import com.intellij.lang.MetaLanguage
import com.intellij.lang.java.JavaLanguage
import com.intellij.lang.xml.XMLLanguage
import com.intellij.lang.xml.XMLParserDefinition
import com.intellij.lang.xml.XmlASTFactory
import com.intellij.lang.jvm.facade.JvmElementProvider
import com.intellij.lang.xml.XmlSyntaxDefinitionExtension
import com.intellij.navigation.DirectNavigationProvider
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.extensions.ExtensionPointName
import com.intellij.openapi.fileTypes.FileType
import com.intellij.openapi.module.Module
import com.intellij.openapi.module.ModuleManager
import com.intellij.openapi.progress.ProcessCanceledException
import com.intellij.openapi.project.Project
import com.intellij.openapi.roots.ModuleRootManager
import com.intellij.openapi.roots.OrderEntry
import com.intellij.openapi.roots.ProjectFileIndex
import com.intellij.openapi.roots.ProjectRootManager
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.util.ModificationTracker
import com.intellij.openapi.util.SimpleModificationTracker
import com.intellij.openapi.vfs.VfsUtilCore
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.platform.syntax.psi.CommonElementTypeConverterFactory
import com.intellij.platform.syntax.psi.ElementTypeConverters
import com.intellij.psi.impl.PsiElementFinderImpl
import com.intellij.platform.syntax.psi.LanguageSyntaxDefinitions
import com.intellij.psi.JavaPsiFacade
import com.intellij.psi.JavaRecursiveElementWalkingVisitor
import com.intellij.psi.PsiClass
import com.intellij.psi.PsiDocumentManager
import com.intellij.psi.PsiElement
import com.intellij.psi.PsiElementFinder
import com.intellij.psi.PsiField
import com.intellij.psi.PsiFile
import com.intellij.psi.PsiManager
import com.intellij.psi.PsiReference
import com.intellij.psi.PsiReferenceBase
import com.intellij.psi.PsiReferenceExpression
import com.intellij.psi.SingleRootFileViewProvider
import com.intellij.psi.impl.light.LightElement
import com.intellij.psi.search.GlobalSearchScope
import com.intellij.psi.search.searches.ReferencesSearch
import com.intellij.psi.impl.source.xml.XmlElementDescriptorProvider
import com.intellij.psi.xml.StartTagEndTokenProvider
import com.intellij.psi.xml.XmlFileNSInfoProvider
import com.intellij.psi.xml.XmlFile
import com.intellij.testFramework.LightVirtualFile
import com.intellij.testIntegration.TestFinder
import com.intellij.util.Processor
import com.intellij.util.QueryExecutor
import com.intellij.xml.DefaultXmlExtension
import com.intellij.xml.XmlAttributeDescriptorsProvider
import com.intellij.xml.XmlExtension
import com.intellij.xml.XmlSchemaProvider
import com.intellij.xml.util.XmlIdContributor
import com.jetbrains.lsp.protocol.Location
import com.jetbrains.lsp.protocol.Position
import com.jetbrains.lsp.protocol.Range
import org.jetbrains.android.context.AndroidQueryException
import org.jetbrains.android.navigation.AndroidCompiledResourceClassFinder
import org.jetbrains.android.resource.AndroidSources
import org.jetbrains.kotlin.asJava.KotlinAsJavaSupport
import org.jetbrains.kotlin.asJava.classes.KtFakeLightClass
import org.jetbrains.kotlin.asJava.classes.KtLightClass
import org.jetbrains.kotlin.asJava.classes.KtLightClassForFacade
import org.jetbrains.kotlin.asJava.elements.FakeFileForLightClass
import org.jetbrains.kotlin.idea.KotlinFileType
import org.jetbrains.kotlin.idea.KotlinLanguage
import org.jetbrains.kotlin.name.FqName
import org.jetbrains.kotlin.parsing.KotlinParserDefinition
import org.jetbrains.kotlin.psi.KtClass
import org.jetbrains.kotlin.psi.KtClassOrObject
import org.jetbrains.kotlin.psi.KtFile
import org.jetbrains.kotlin.psi.KtNameReferenceExpression
import org.jetbrains.kotlin.psi.KtScript
import org.jetbrains.kotlin.psi.KtTreeVisitorVoid
import org.jetbrains.org.objectweb.asm.ClassWriter
import org.junit.After
import org.jetbrains.org.objectweb.asm.Opcodes
import org.junit.AfterClass
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.BeforeClass
import org.junit.Test
import java.lang.reflect.Proxy
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.CancellationException
import java.util.jar.JarEntry
import java.util.jar.JarOutputStream

class AndroidXmlRelatedTestsProviderTest {
    @Before
    fun resetFixtures() {
        fixtureState.reset()
        createProjectEnvironment()
    }

    @After
    fun disposeFixtures() {
        disposeProjectEnvironment()
    }

    @Test
    fun manifestResolvesComponentsAndAliasesAndPropagatesModelFailure() {
        val root = Files.createTempDirectory("xml_rel_manifest")
        try {
            val moduleDir = root.resolve("app")
            val mainDir = moduleDir.resolve("src/main")
            val javaDir = mainDir.resolve("java/com/example/app")
            val testDir = moduleDir.resolve("src/test/java/com/example/app")
            Files.createDirectories(javaDir)
            Files.createDirectories(testDir)
            Files.createDirectories(moduleDir.resolve("src/debug"))

            val gradleScript = """
                plugins { id("com.android.application") }
                android {
                    namespace = "com.example.app"
                    compileSdk = 34
                }
            """.trimIndent()
            Files.writeString(moduleDir.resolve("build.gradle.kts"), gradleScript)

            val manifestText = """
                <?xml version="1.0" encoding="utf-8"?>
                <manifest xmlns:android="http://schemas.android.com/apk/res/android">
                    <application>
                        <activity android:name=".MainActivity" />
                        <activity-alias android:name=".MainAlias" android:targetActivity=".TargetActivity" />
                        <activity android:name=".MissingActivity" />
                        <activity android:name=".DuplicateActivity" />
                    </application>
                </manifest>
            """.trimIndent()
            val manifestPath = mainDir.resolve("AndroidManifest.xml")
            Files.writeString(manifestPath, manifestText)

            val mainActivityPath = javaDir.resolve("MainActivity.java")
            val targetActivityPath = javaDir.resolve("TargetActivity.java")
            val debugJavaDir = moduleDir.resolve("src/debug/java/com/example/app")
            Files.createDirectories(debugJavaDir)
            val dup1Path = javaDir.resolve("DuplicateActivity.java")
            val dup2Path = debugJavaDir.resolve("DuplicateActivity.java")
            val mainTestPath = testDir.resolve("MainActivityTest.java")
            val targetTestPath = testDir.resolve("TargetActivityTest.java")
            val dupTestPath = testDir.resolve("DuplicateActivityTest.java")

            Files.writeString(mainActivityPath, "package com.example.app; public class MainActivity {}")
            Files.writeString(targetActivityPath, "package com.example.app; public class TargetActivity {}")
            Files.writeString(dup1Path, "package com.example.app; public class DuplicateActivity {}")
            Files.writeString(dup2Path, "package com.example.app; public class DuplicateActivity {}")
            Files.writeString(mainTestPath, "package com.example.app; public class MainActivityTest {}")
            Files.writeString(targetTestPath, "package com.example.app; public class TargetActivityTest {}")
            Files.writeString(dupTestPath, "package com.example.app; public class DuplicateActivityTest {}")

            val module = configureModule(
                name = "project.app.debug",
                moduleRoot = moduleDir,
                mainSources = listOf(mainActivityPath, targetActivityPath, dup1Path, dup2Path),
                testSources = listOf(mainTestPath, targetTestPath, dupTestPath),
                extraFiles = listOf(manifestPath),
                sourceRootPaths = listOf(javaDir.parent.parent.parent, debugJavaDir.parent.parent.parent),
                contentRootPaths = listOf(moduleDir.resolve("src/debug"))
            )
            registerTestMapping("MainActivity", listOf(psiClassIn(mainTestPath, "MainActivityTest")))
            registerTestMapping("TargetActivity", listOf(psiClassIn(targetTestPath, "TargetActivityTest")))
            registerTestMapping("DuplicateActivity", listOf(psiClassIn(dupTestPath, "DuplicateActivityTest")))
            val manifestXml = openXmlFile(manifestPath)
            AndroidSources.Scope(null, manifestXml.virtualFile).use {
                val mainResult = AndroidXmlRelatedTestsProvider.findRelatedTests(
                    project,
                    manifestXml,
                    manifestText.indexOf(".MainActivity") + 2
                )
                assertFalse(mainResult.isTest)
                assertEquals("MainActivity", mainResult.sourceName)
                assertEquals(1, mainResult.targets.size)
                assertTrue(mainResult.targets[0].uri.uri.uri.endsWith("/MainActivityTest.java"))

                val aliasResult = AndroidXmlRelatedTestsProvider.findRelatedTests(
                    project,
                    manifestXml,
                    manifestText.indexOf(".TargetActivity") + 2
                )
                assertEquals("TargetActivity", aliasResult.sourceName)
                assertEquals(1, aliasResult.targets.size)
                assertTrue(aliasResult.targets[0].uri.uri.uri.endsWith("/TargetActivityTest.java"))

                val missingResult = AndroidXmlRelatedTestsProvider.findRelatedTests(
                    project,
                    manifestXml,
                    manifestText.indexOf(".MissingActivity") + 2
                )
                assertEquals(AndroidXmlRelatedTestsProvider.emptyResult(), missingResult)

                val duplicateResult = AndroidXmlRelatedTestsProvider.findRelatedTests(
                    project,
                    manifestXml,
                    manifestText.indexOf(".DuplicateActivity") + 2
                )
                assertEquals(AndroidXmlRelatedTestsProvider.emptyResult(), duplicateResult)

                val nonAttrResult = AndroidXmlRelatedTestsProvider.findRelatedTests(
                    project,
                    manifestXml,
                    manifestText.indexOf("<activity") + 1
                )
                assertEquals(AndroidXmlRelatedTestsProvider.emptyResult(), nonAttrResult)
            }

            Files.writeString(
                moduleDir.resolve("build.gradle.kts"),
                """
                    plugins { id("com.android.application") }
                    android {
                        namespace = providers.gradleProperty("runtimeNs").get()
                        compileSdk = 34
                    }
                """.trimIndent()
            )
            createProjectEnvironment()
            configureModule(
                name = "project.app.debug",
                moduleRoot = moduleDir,
                mainSources = listOf(mainActivityPath, targetActivityPath, dup1Path, dup2Path),
                testSources = listOf(mainTestPath, targetTestPath, dupTestPath),
                extraFiles = listOf(manifestPath),
                sourceRootPaths = listOf(javaDir.parent.parent.parent, debugJavaDir.parent.parent.parent),
                contentRootPaths = listOf(moduleDir.resolve("src/debug"))
            )
            val refreshedManifest = openXmlFile(manifestPath)
            assertNotNull(module)
            AndroidSources.Scope(null, refreshedManifest.virtualFile).use {
                val ex = assertThrows(AndroidQueryException::class.java) {
                    AndroidXmlRelatedTestsProvider.findRelatedTests(
                        project,
                        refreshedManifest,
                        manifestText.indexOf(".MainActivity") + 2
                    )
                }
                assertTrue(ex.reason.startsWith(AndroidQueryException.REASON_MODEL_UNAVAILABLE))
            }
        } finally {
            deleteRecursively(root)
        }
    }

    @Test
    fun layoutAndMenuRequireCompiledRFieldAndValidProvenanceBeforeToolsContext() {
        val root = Files.createTempDirectory("xml_rel_r_prov")
        try {
            val moduleDir = root.resolve("app")
            val mainDir = moduleDir.resolve("src/main")
            val javaDir = mainDir.resolve("java/com/example/app")
            val testDir = moduleDir.resolve("src/test/java/com/example/app")
            val layoutDir = mainDir.resolve("res/layout")
            val menuDir = mainDir.resolve("res/menu")
            val valuesDir = mainDir.resolve("res/values")
            val drawableDir = mainDir.resolve("res/drawable")
            Files.createDirectories(javaDir)
            Files.createDirectories(testDir)
            Files.createDirectories(layoutDir)
            Files.createDirectories(menuDir)
            Files.createDirectories(valuesDir)
            Files.createDirectories(drawableDir)
            Files.createDirectories(moduleDir.resolve("src/debug"))

            Files.writeString(
                moduleDir.resolve("build.gradle.kts"),
                """
                    plugins { id("com.android.application") }
                    android {
                        namespace = "com.example.app"
                        compileSdk = 34
                    }
                """.trimIndent()
            )
            val manifestPath = mainDir.resolve("AndroidManifest.xml")
            Files.writeString(
                manifestPath,
                """<manifest xmlns:android="http://schemas.android.com/apk/res/android"/>"""
            )

            val layoutText = """
                <LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"
                    xmlns:tools="http://schemas.android.com/tools"
                    tools:context=".ContextActivity">
                    <TextView android:id="@+id/label" />
                </LinearLayout>
            """.trimIndent()
            val layoutPath = layoutDir.resolve("activity_main.xml")
            val uncompiledLayoutPath = layoutDir.resolve("activity_uncompiled.xml")
            val menuPath = menuDir.resolve("main_menu.xml")
            val stringsPath = valuesDir.resolve("strings.xml")
            val drawablePath = drawableDir.resolve("bg.xml")
            Files.writeString(layoutPath, layoutText)
            Files.writeString(uncompiledLayoutPath, layoutText)
            Files.writeString(
                menuPath,
                """
                    <menu xmlns:tools="http://schemas.android.com/tools" tools:context=".MenuActivity">
                        <item/>
                    </menu>
                """.trimIndent()
            )
            Files.writeString(stringsPath, """<resources><string name="app_name">App</string></resources>""")
            Files.writeString(drawablePath, """<shape xmlns:android="http://schemas.android.com/apk/res/android"/>""")

            val contextActPath = javaDir.resolve("ContextActivity.java")
            val menuActPath = javaDir.resolve("MenuActivity.java")
            val contextTestPath = testDir.resolve("ContextActivityTest.java")
            val menuTestPath = testDir.resolve("MenuActivityTest.java")
            Files.writeString(contextActPath, "package com.example.app; public class ContextActivity {}")
            Files.writeString(menuActPath, "package com.example.app; public class MenuActivity {}")
            Files.writeString(contextTestPath, "package com.example.app; public class ContextActivityTest {}")
            Files.writeString(menuTestPath, "package com.example.app; public class MenuActivityTest {}")

            configureModule(
                name = "project.app.debug",
                moduleRoot = moduleDir,
                mainSources = listOf(contextActPath, menuActPath),
                testSources = listOf(contextTestPath, menuTestPath),
                extraFiles = listOf(
                    manifestPath,
                    layoutPath,
                    uncompiledLayoutPath,
                    menuPath,
                    stringsPath,
                    drawablePath
                ),
                sourceRootPaths = listOf(javaDir.parent.parent.parent),
                contentRootPaths = listOf(moduleDir.resolve("src/debug"))
            )
            registerTestMapping("ContextActivity", listOf(psiClassIn(contextTestPath, "ContextActivityTest")))
            registerTestMapping("MenuActivity", listOf(psiClassIn(menuTestPath, "MenuActivityTest")))

            val layoutXml = openXmlFile(layoutPath)
            val uncompiledXml = openXmlFile(uncompiledLayoutPath)
            val menuXml = openXmlFile(menuPath)
            val stringsXml = openXmlFile(stringsPath)
            val drawableXml = openXmlFile(drawablePath)

            // 1. No R.jar compiled yet -> returns empty even when tools:context is valid.
            AndroidSources.Scope(null, layoutXml.virtualFile).use {
                assertEquals(
                    AndroidXmlRelatedTestsProvider.emptyResult(),
                    AndroidXmlRelatedTestsProvider.findRelatedTests(project, layoutXml, layoutText.indexOf("TextView"))
                )
            }

            // Build real R.jar (without activity_uncompiled) and merger.xml.
            val rJar =
                moduleDir.resolve("build/intermediates/compile_and_runtime_r_class_jar/debug/processDebugResources/R.jar")
            writeRJar(
                rJar,
                "com.example.app",
                mapOf(
                    "layout" to listOf("activity_main"),
                    "menu" to listOf("main_menu")
                )
            )
            val mergerPath = moduleDir.resolve("build/intermediates/incremental/debug/mergeDebugResources/merger.xml")
            writeMergerXml(
                mergerPath,
                mainDir.resolve("res"),
                listOf(
                    Triple(layoutPath, "activity_main", "layout"),
                    Triple(menuPath, "main_menu", "menu")
                )
            )

            // 2. Compiled R.jar exists, but field R.layout.activity_uncompiled is absent -> empty despite valid tools:context.
            AndroidSources.Scope(null, uncompiledXml.virtualFile).use {
                assertEquals(
                    AndroidXmlRelatedTestsProvider.emptyResult(),
                    AndroidXmlRelatedTestsProvider.findRelatedTests(project, uncompiledXml, 0)
                )
            }

            // 3. Compiled R.jar + valid merger.xml -> child tag offset in layout and menu both resolve.
            AndroidSources.Scope(null, layoutXml.virtualFile).use {
                val res = AndroidXmlRelatedTestsProvider.findRelatedTests(
                    project,
                    layoutXml,
                    layoutText.indexOf("TextView")
                )
                assertEquals("ContextActivity", res.sourceName)
                assertEquals(1, res.targets.size)
                assertTrue(res.targets[0].uri.uri.uri.endsWith("/ContextActivityTest.java"))
            }
            AndroidSources.Scope(null, menuXml.virtualFile).use {
                val res = AndroidXmlRelatedTestsProvider.findRelatedTests(project, menuXml, 0)
                assertEquals("MenuActivity", res.sourceName)
                assertEquals(1, res.targets.size)
                assertTrue(res.targets[0].uri.uri.uri.endsWith("/MenuActivityTest.java"))
            }

            // 4. Non-layout / non-menu XML files return empty.
            AndroidSources.Scope(null, stringsXml.virtualFile).use {
                assertEquals(
                    AndroidXmlRelatedTestsProvider.emptyResult(),
                    AndroidXmlRelatedTestsProvider.findRelatedTests(project, stringsXml, 0)
                )
            }
            AndroidSources.Scope(null, drawableXml.virtualFile).use {
                assertEquals(
                    AndroidXmlRelatedTestsProvider.emptyResult(),
                    AndroidXmlRelatedTestsProvider.findRelatedTests(project, drawableXml, 0)
                )
            }

            // 5. Missing merger.xml when R field exists -> propagates missing_snapshot.
            val displaced = mergerPath.resolveSibling("merger.xml.bak")
            Files.move(mergerPath, displaced)
            try {
                AndroidSources.Scope(null, layoutXml.virtualFile).use {
                    val ex = assertThrows(AndroidQueryException::class.java) {
                        AndroidXmlRelatedTestsProvider.findRelatedTests(project, layoutXml, 0)
                    }
                    assertTrue(ex.reason.startsWith(AndroidQueryException.REASON_MISSING_SNAPSHOT))
                }
            } finally {
                Files.move(displaced, mergerPath)
            }

            // 6. Stale merger.xml (build.gradle.kts modified after merger.xml) -> propagates stale_snapshot.
            Thread.sleep(50)
            Files.writeString(
                moduleDir.resolve("build.gradle.kts"),
                Files.readString(moduleDir.resolve("build.gradle.kts")) + "\n// touched"
            )
            AndroidSources.Scope(null, layoutXml.virtualFile).use {
                val ex = assertThrows(AndroidQueryException::class.java) {
                    AndroidXmlRelatedTestsProvider.findRelatedTests(project, layoutXml, 0)
                }
                assertTrue(ex.reason.startsWith(AndroidQueryException.REASON_STALE_SNAPSHOT))
            }
        } finally {
            deleteRecursively(root)
        }
    }

    @Test
    fun resolvesSingleCompiledVariantAndRejectsAmbiguousVariantsWhenOrderEntriesOmitR() {
        val root = Files.createTempDirectory("xml_rel_variant_disk")
        try {
            val moduleDir = root.resolve("app")
            val mainDir = moduleDir.resolve("src/main")
            val javaDir = mainDir.resolve("java/com/example/app")
            val testDir = moduleDir.resolve("src/test/java/com/example/app")
            val layoutDir = mainDir.resolve("res/layout")
            Files.createDirectories(javaDir)
            Files.createDirectories(testDir)
            Files.createDirectories(layoutDir)

            Files.writeString(
                moduleDir.resolve("build.gradle.kts"),
                """
                    plugins { id("com.android.application") }
                    android { namespace = "com.example.app"; compileSdk = 34 }
                """.trimIndent()
            )
            val manifestPath = mainDir.resolve("AndroidManifest.xml")
            Files.writeString(
                manifestPath,
                """<manifest xmlns:android="http://schemas.android.com/apk/res/android"/>"""
            )
            val layoutPath = layoutDir.resolve("activity_main.xml")
            Files.writeString(
                layoutPath,
                """<LinearLayout xmlns:tools="http://schemas.android.com/tools" tools:context=".MainActivity"/>"""
            )
            val activityPath = javaDir.resolve("MainActivity.java")
            val testPath = testDir.resolve("MainActivityTest.java")
            Files.writeString(activityPath, "package com.example.app; public class MainActivity {}")
            Files.writeString(testPath, "package com.example.app; public class MainActivityTest {}")

            val rJarDebug =
                moduleDir.resolve("build/intermediates/compile_and_runtime_r_class_jar/debug/processDebugResources/R.jar")
            writeRJar(rJarDebug, "com.example.app", mapOf("layout" to listOf("activity_main")))
            val mergerPath = moduleDir.resolve("build/intermediates/incremental/debug/mergeDebugResources/merger.xml")
            writeMergerXml(mergerPath, mainDir.resolve("res"), listOf(Triple(layoutPath, "activity_main", "layout")))

            // Module name ends in ".main" without src/main as contentRootUrl and with empty orderEntries -> info.variant is null.
            configureModule(
                name = "project.app.main",
                moduleRoot = moduleDir,
                mainSources = listOf(activityPath),
                testSources = listOf(testPath),
                extraFiles = listOf(manifestPath, layoutPath),
                sourceRootPaths = listOf(javaDir.parent.parent.parent),
                contentRootPaths = emptyList()
            )
            registerTestMapping("MainActivity", listOf(psiClassIn(testPath, "MainActivityTest")))

            val layoutXml = openXmlFile(layoutPath)
            AndroidSources.Scope(null, layoutXml.virtualFile).use {
                val res = AndroidXmlRelatedTestsProvider.findRelatedTests(project, layoutXml, 0)
                assertEquals("MainActivity", res.sourceName)
                assertEquals(1, res.targets.size)
                assertTrue(res.targets[0].uri.uri.uri.endsWith("/MainActivityTest.java"))
            }

            val rJarRelease =
                moduleDir.resolve("build/intermediates/compile_and_runtime_r_class_jar/release/processReleaseResources/R.jar")
            writeRJar(rJarRelease, "com.example.app", mapOf("layout" to listOf("activity_main")))
            AndroidSources.Scope(null, layoutXml.virtualFile).use {
                val ex = assertThrows(AndroidQueryException::class.java) {
                    AndroidXmlRelatedTestsProvider.findRelatedTests(project, layoutXml, 0)
                }
                assertTrue(ex.reason.startsWith(AndroidQueryException.REASON_AMBIGUOUS_VARIANT))
            }
        } finally {
            deleteRecursively(root)
        }
    }

    @Test
    fun toolsContextPrecedenceAndFallbackBoundary() {
        val root = Files.createTempDirectory("xml_rel_context")
        try {
            val moduleDir = root.resolve("app")
            val mainDir = moduleDir.resolve("src/main")
            val javaDir = mainDir.resolve("java/com/example/app")
            val androidStubDir = mainDir.resolve("java/android/app")
            val testDir = moduleDir.resolve("src/test/java/com/example/app")
            val layoutDir = mainDir.resolve("res/layout")
            Files.createDirectories(javaDir)
            Files.createDirectories(androidStubDir)
            Files.createDirectories(testDir)
            Files.createDirectories(layoutDir)
            Files.createDirectories(moduleDir.resolve("src/debug"))

            Files.writeString(
                moduleDir.resolve("build.gradle.kts"),
                """
                    plugins { id("com.android.application") }
                    android { namespace = "com.example.app"; compileSdk = 34 }
                """.trimIndent()
            )
            val manifestPath = mainDir.resolve("AndroidManifest.xml")
            Files.writeString(
                manifestPath,
                """<manifest xmlns:android="http://schemas.android.com/apk/res/android"/>"""
            )

            val activityStub = androidStubDir.resolve("Activity.java")
            Files.writeString(
                activityStub,
                "package android.app; public class Activity { public void setContentView(int id) {} }"
            )

            val fallbackActivityPath = javaDir.resolve("FallbackActivity.java")
            Files.writeString(
                fallbackActivityPath,
                """
                    package com.example.app;
                    import android.app.Activity;
                    public class FallbackActivity extends Activity {
                        void init() { setContentView(R.layout.activity_shared); }
                    }
                """.trimIndent()
            )
            val plainHelperPath = javaDir.resolve("PlainHelper.java")
            Files.writeString(plainHelperPath, "package com.example.app; public class PlainHelper {}")
            val noTestsActivityPath = javaDir.resolve("NoTestsActivity.java")
            Files.writeString(noTestsActivityPath, "package com.example.app; public class NoTestsActivity {}")

            val fallbackTestPath = testDir.resolve("FallbackActivityTest.java")
            val plainTestPath = testDir.resolve("PlainHelperTest.java")
            Files.writeString(fallbackTestPath, "package com.example.app; public class FallbackActivityTest {}")
            Files.writeString(plainTestPath, "package com.example.app; public class PlainHelperTest {}")

            val layoutHelperContextPath = layoutDir.resolve("activity_helper_ctx.xml")
            val layoutNoTestContextPath = layoutDir.resolve("activity_notest_ctx.xml")
            val layoutUnresolvedContextPath = layoutDir.resolve("activity_unresolved_ctx.xml")
            val layoutNoContextPath = layoutDir.resolve("activity_shared.xml")
            Files.writeString(
                layoutHelperContextPath,
                """<LinearLayout xmlns:tools="http://schemas.android.com/tools" tools:context=".PlainHelper"/>"""
            )
            Files.writeString(
                layoutNoTestContextPath,
                """<LinearLayout xmlns:tools="http://schemas.android.com/tools" tools:context=".NoTestsActivity"/>"""
            )
            Files.writeString(
                layoutUnresolvedContextPath,
                """<LinearLayout xmlns:tools="http://schemas.android.com/tools" tools:context=".MissingContext"/>"""
            )
            Files.writeString(layoutNoContextPath, """<LinearLayout/>""")

            val rJar =
                moduleDir.resolve("build/intermediates/compile_and_runtime_r_class_jar/debug/processDebugResources/R.jar")
            writeRJar(
                rJar,
                "com.example.app",
                mapOf(
                    "layout" to listOf(
                        "activity_helper_ctx",
                        "activity_notest_ctx",
                        "activity_unresolved_ctx",
                        "activity_shared"
                    )
                )
            )
            val mergerPath = moduleDir.resolve("build/intermediates/incremental/debug/mergeDebugResources/merger.xml")
            writeMergerXml(
                mergerPath,
                mainDir.resolve("res"),
                listOf(
                    Triple(layoutHelperContextPath, "activity_helper_ctx", "layout"),
                    Triple(layoutNoTestContextPath, "activity_notest_ctx", "layout"),
                    Triple(layoutUnresolvedContextPath, "activity_unresolved_ctx", "layout"),
                    Triple(layoutNoContextPath, "activity_shared", "layout")
                )
            )

            configureModule(
                name = "project.app.debug",
                moduleRoot = moduleDir,
                mainSources = listOf(activityStub, fallbackActivityPath, plainHelperPath, noTestsActivityPath),
                testSources = listOf(fallbackTestPath, plainTestPath),
                extraFiles = listOf(
                    manifestPath,
                    layoutHelperContextPath,
                    layoutNoTestContextPath,
                    layoutUnresolvedContextPath,
                    layoutNoContextPath
                ),
                sourceRootPaths = listOf(javaDir.parent.parent.parent),
                contentRootPaths = listOf(moduleDir.resolve("src/debug"))
            )
            registerTestMapping("PlainHelper", listOf(psiClassIn(plainTestPath, "PlainHelperTest")))
            registerTestMapping("FallbackActivity", listOf(psiClassIn(fallbackTestPath, "FallbackActivityTest")))

            // 1. Explicit tools:context to PlainHelper does NOT apply fallback host filter.
            val helperCtxXml = openXmlFile(layoutHelperContextPath)
            AndroidSources.Scope(null, helperCtxXml.virtualFile).use {
                val res = AndroidXmlRelatedTestsProvider.findRelatedTests(project, helperCtxXml, 0)
                assertEquals("PlainHelper", res.sourceName)
                assertEquals(1, res.targets.size)
                assertTrue(res.targets[0].uri.uri.uri.endsWith("/PlainHelperTest.java"))
            }

            // 2. Resolved tools:context with no tests does NOT fall back to referencing FallbackActivity.
            val noTestCtxXml = openXmlFile(layoutNoTestContextPath)
            val sharedField = AndroidXmlRelatedTestsProvider.findVerifiedOwnerRFields(
                project,
                fixtureState.modules.first(),
                listOf(rJar.toAbsolutePath().normalize()),
                "com.example.app",
                "layout",
                "activity_shared"
            ).single()
            // Also make FallbackActivity reference activity_notest_ctx to prove no fallback occurs.
            val noTestFieldRefSource = javaDir.resolve("ExtraFallback.java")
            Files.writeString(
                noTestFieldRefSource,
                """
                    package com.example.app;
                    import android.app.Activity;
                    public class ExtraFallback extends Activity {
                        void init() { setContentView(R.layout.activity_notest_ctx); }
                    }
                """.trimIndent()
            )
            fixtureState.addMainSource(noTestFieldRefSource)
            registerTestMapping("ExtraFallback", listOf(psiClassIn(fallbackTestPath, "FallbackActivityTest")))

            AndroidSources.Scope(null, noTestCtxXml.virtualFile).use {
                val res = AndroidXmlRelatedTestsProvider.findRelatedTests(project, noTestCtxXml, 0)
                assertEquals("NoTestsActivity", res.sourceName)
                assertTrue(res.targets.isEmpty())
            }
            assertNotNull(sharedField)

            // 3. Unresolved tools:context falls back to ReferencesSearch.
            val unresolvedFile = javaDir.resolve("UnresolvedCtxHost.java")
            Files.writeString(
                unresolvedFile,
                """
                    package com.example.app;
                    import android.app.Activity;
                    public class UnresolvedCtxHost extends Activity {
                        void init() { setContentView(R.layout.activity_unresolved_ctx); }
                    }
                """.trimIndent()
            )
            fixtureState.addMainSource(unresolvedFile)
            registerTestMapping("UnresolvedCtxHost", listOf(psiClassIn(fallbackTestPath, "FallbackActivityTest")))

            val unresolvedXml = openXmlFile(layoutUnresolvedContextPath)
            AndroidSources.Scope(null, unresolvedXml.virtualFile).use {
                val res = AndroidXmlRelatedTestsProvider.findRelatedTests(project, unresolvedXml, 0)
                assertEquals("UnresolvedCtxHost", res.sourceName)
                assertEquals(1, res.targets.size)
                assertTrue(res.targets[0].uri.uri.uri.endsWith("/FallbackActivityTest.java"))
            }
        } finally {
            deleteRecursively(root)
        }
    }

    @Test
    fun fallbackBindingHeuristicsKotlinLightClassAndModuleOnlyScope() {
        val root = Files.createTempDirectory("xml_rel_heuristics")
        try {
            val appDir = root.resolve("app")
            val appMainDir = appDir.resolve("src/main")
            val appJavaDir = appMainDir.resolve("java/com/example/app")
            val appTestDir = appDir.resolve("src/test/java/com/example/app")
            val layoutDir = appMainDir.resolve("res/layout")
            val consumerDir = root.resolve("feature")
            val consumerJavaDir = consumerDir.resolve("src/main/java/com/example/feature")
            Files.createDirectories(appJavaDir)
            Files.createDirectories(appTestDir)
            Files.createDirectories(layoutDir)
            Files.createDirectories(consumerJavaDir)
            Files.createDirectories(appDir.resolve("src/debug"))
            Files.createDirectories(consumerDir.resolve("src/debug"))

            // Android host base stubs
            val stubs = listOf(
                appMainDir.resolve("java/android/app/Activity.java") to "package android.app; public class Activity { public void setContentView(int id) {} }",
                appMainDir.resolve("java/android/app/Fragment.java") to "package android.app; public class Fragment {}",
                appMainDir.resolve("java/android/support/v4/app/Fragment.java") to "package android.support.v4.app; public class Fragment {}",
                appMainDir.resolve("java/androidx/fragment/app/Fragment.java") to "package androidx.fragment.app; public class Fragment {}",
                appMainDir.resolve("java/android/widget/Adapter.java") to "package android.widget; public interface Adapter {}"
            )
            for ((path, content) in stubs) {
                Files.createDirectories(path.parent)
                Files.writeString(path, content)
            }

            Files.writeString(
                appDir.resolve("build.gradle.kts"),
                """
                    plugins { id("com.android.application") }
                    android { namespace = "com.example.app"; compileSdk = 34 }
                """.trimIndent()
            )
            Files.writeString(
                consumerDir.resolve("build.gradle.kts"),
                """
                    plugins { id("com.android.library") }
                    android { namespace = "com.example.feature"; compileSdk = 34 }
                """.trimIndent()
            )
            val appManifest = appMainDir.resolve("AndroidManifest.xml")
            Files.writeString(appManifest, """<manifest xmlns:android="http://schemas.android.com/apk/res/android"/>""")

            val layoutPath = layoutDir.resolve("item_card.xml")
            Files.writeString(layoutPath, """<FrameLayout/>""")

            // Matching hosts (Java: Activity user-defined inflate, Fragment variants, Adapter; Kotlin: KtActivity)
            val userInflateAct = appJavaDir.resolve("CustomInflateActivity.java")
            Files.writeString(
                userInflateAct,
                """
                    package com.example.app;
                    import android.app.Activity;
                    public class CustomInflateActivity extends Activity {
                        void inflate(int layout) {}
                        void run() { inflate(R.layout.item_card); }
                    }
                """.trimIndent()
            )
            val androidXFrag = appJavaDir.resolve("HomeFragment.java")
            Files.writeString(
                androidXFrag,
                """
                    package com.example.app;
                    import androidx.fragment.app.Fragment;
                    public class HomeFragment extends Fragment {
                        Object inflate(int layout) { return null; }
                        void create() { inflate(R.layout.item_card); }
                    }
                """.trimIndent()
            )
            val cardAdapter = appJavaDir.resolve("CardAdapter.java")
            Files.writeString(
                cardAdapter,
                """
                    package com.example.app;
                    import android.widget.Adapter;
                    public class CardAdapter implements Adapter {
                        Object inflate(int layout) { return null; }
                        void view() { inflate(R.layout.item_card); }
                    }
                """.trimIndent()
            )
            val ktActivity = appJavaDir.resolve("KtCardActivity.kt")
            Files.writeString(
                ktActivity,
                """
                    package com.example.app
                    import android.app.Activity
                    class KtCardActivity : Activity() {
                        fun show() {
                            setContentView(R.layout.item_card)
                        }
                    }
                """.trimIndent()
            )

            // Non-matching cases: wrong method name, nested call masking outer setContentView, non-host class, Kotlin non-host, test scope, consumer module
            val wrongMethodAct = appJavaDir.resolve("WrongMethodActivity.java")
            Files.writeString(
                wrongMethodAct,
                """
                    package com.example.app;
                    import android.app.Activity;
                    public class WrongMethodActivity extends Activity {
                        int bindLayout(int id) { return id; }
                        void init() {
                            bindLayout(R.layout.item_card);
                            setContentView(bindLayout(R.layout.item_card));
                        }
                    }
                """.trimIndent()
            )
            val nonHost = appJavaDir.resolve("NonHostHelper.java")
            Files.writeString(
                nonHost,
                """
                    package com.example.app;
                    public class NonHostHelper {
                        void setContentView(int id) {}
                        void init() { setContentView(R.layout.item_card); }
                    }
                """.trimIndent()
            )
            val ktNonHost = appJavaDir.resolve("KtNonHost.kt")
            Files.writeString(
                ktNonHost,
                """
                    package com.example.app
                    class KtNonHost {
                        fun setContentView(id: Int) {}
                        fun show() { setContentView(R.layout.item_card) }
                    }
                """.trimIndent()
            )
            val testRef = appTestDir.resolve("TestScopeActivity.java")
            Files.writeString(
                testRef,
                """
                    package com.example.app;
                    import android.app.Activity;
                    public class TestScopeActivity extends Activity {
                        void init() { setContentView(R.layout.item_card); }
                    }
                """.trimIndent()
            )
            val consumerRef = consumerJavaDir.resolve("ConsumerActivity.java")
            Files.writeString(
                consumerRef,
                """
                    package com.example.feature;
                    import android.app.Activity;
                    import com.example.app.R;
                    public class ConsumerActivity extends Activity {
                        void init() { setContentView(R.layout.item_card); }
                    }
                """.trimIndent()
            )

            val sharedTestFile = appTestDir.resolve("SharedItemCardTest.java")
            val ktTestFile = appTestDir.resolve("KtCardActivityTest.kt")
            val excludedTestFile = appTestDir.resolve("ExcludedTest.java")
            Files.writeString(sharedTestFile, "package com.example.app; public class SharedItemCardTest {}")
            Files.writeString(ktTestFile, "package com.example.app\nclass KtCardActivityTest")
            Files.writeString(excludedTestFile, "package com.example.app; public class ExcludedTest {}")

            val rJar =
                appDir.resolve("build/intermediates/compile_and_runtime_r_class_jar/debug/processDebugResources/R.jar")
            writeRJar(rJar, "com.example.app", mapOf("layout" to listOf("item_card")))
            val mergerPath = appDir.resolve("build/intermediates/incremental/debug/mergeDebugResources/merger.xml")
            writeMergerXml(mergerPath, appMainDir.resolve("res"), listOf(Triple(layoutPath, "item_card", "layout")))

            configureModule(
                name = "project.app.debug",
                moduleRoot = appDir,
                mainSources = stubs.map { it.first } + listOf(
                    userInflateAct,
                    androidXFrag,
                    cardAdapter,
                    ktActivity,
                    wrongMethodAct,
                    nonHost,
                    ktNonHost
                ),
                testSources = listOf(testRef, sharedTestFile, ktTestFile, excludedTestFile),
                extraFiles = listOf(appManifest, layoutPath),
                sourceRootPaths = listOf(appJavaDir.parent.parent.parent),
                contentRootPaths = listOf(appDir.resolve("src/debug"))
            )
            configureModule(
                name = "project.feature.debug",
                moduleRoot = consumerDir,
                mainSources = listOf(consumerRef),
                testSources = emptyList(),
                extraFiles = emptyList(),
                sourceRootPaths = listOf(consumerJavaDir.parent.parent.parent),
                contentRootPaths = listOf(consumerDir.resolve("src/debug")),
                append = true
            )

            // Register Kotlin light class mirror for KtCardActivity (inherits Activity) and KtNonHost (no supertype)
            val ktCardMirrorDir = root.resolve("mirrors")
            Files.createDirectories(ktCardMirrorDir)
            val ktCardMirror = ktCardMirrorDir.resolve("KtCardActivityMirror.java")
            val ktNonHostMirror = ktCardMirrorDir.resolve("KtNonHostMirror.java")
            Files.writeString(
                ktCardMirror,
                "package com.example.app; import android.app.Activity; public class KtCardActivity extends Activity {}"
            )
            Files.writeString(ktNonHostMirror, "package com.example.app; public class KtNonHost {}")
            registerKtLightMirror("KtCardActivity", psiClassIn(ktCardMirror, "KtCardActivity"))
            registerKtLightMirror("KtNonHost", psiClassIn(ktNonHostMirror, "KtNonHost"))

            // Map matching hosts to tests (with deliberate overlap to verify dedup) + excluded classes to ExcludedTest
            val sharedTestClass = psiClassIn(sharedTestFile, "SharedItemCardTest")
            val ktTestClass = openKtFile(ktTestFile).declarations.filterIsInstance<KtClass>().single()
            registerTestMapping("CustomInflateActivity", listOf(sharedTestClass))
            registerTestMapping("HomeFragment", listOf(sharedTestClass))
            registerTestMapping("CardAdapter", listOf(sharedTestClass))
            registerTestMapping("KtCardActivity", listOf(ktTestClass, sharedTestClass))
            registerTestMapping("WrongMethodActivity", listOf(psiClassIn(excludedTestFile, "ExcludedTest")))
            registerTestMapping("NonHostHelper", listOf(psiClassIn(excludedTestFile, "ExcludedTest")))
            registerTestMapping("KtNonHost", listOf(psiClassIn(excludedTestFile, "ExcludedTest")))
            registerTestMapping("TestScopeActivity", listOf(psiClassIn(excludedTestFile, "ExcludedTest")))
            registerTestMapping("ConsumerActivity", listOf(psiClassIn(excludedTestFile, "ExcludedTest")))

            val layoutXml = openXmlFile(layoutPath)
            AndroidSources.Scope(null, layoutXml.virtualFile).use {
                val res = AndroidXmlRelatedTestsProvider.findRelatedTests(project, layoutXml, 0)
                assertFalse(res.isTest)
                assertEquals("item_card.xml", res.sourceName)
                assertEquals(2, res.targets.size)
                val uris = res.targets.map { it.uri.uri.uri }
                assertTrue(uris.any { it.endsWith("/SharedItemCardTest.java") })
                assertTrue(uris.any { it.endsWith("/KtCardActivityTest.kt") })
                assertFalse(uris.any { it.endsWith("/ExcludedTest.java") })
            }
        } finally {
            deleteRecursively(root)
        }
    }

    @Test
    fun resultConversionDeduplicatesExactUriAndRangeAndPropagatesFailures() {
        val root = Files.createTempDirectory("xml_rel_dedup_cancel")
        try {
            val moduleDir = root.resolve("app")
            val mainDir = moduleDir.resolve("src/main")
            val javaDir = mainDir.resolve("java/com/example/app")
            val testDir = moduleDir.resolve("src/test/java/com/example/app")
            val layoutDir = mainDir.resolve("res/layout")
            Files.createDirectories(javaDir)
            Files.createDirectories(testDir)
            Files.createDirectories(layoutDir)
            Files.createDirectories(moduleDir.resolve("src/debug"))

            Files.writeString(
                moduleDir.resolve("build.gradle.kts"),
                """
                    plugins { id("com.android.application") }
                    android { namespace = "com.example.app"; compileSdk = 34 }
                """.trimIndent()
            )
            val manifestPath = mainDir.resolve("AndroidManifest.xml")
            Files.writeString(
                manifestPath,
                """<manifest xmlns:android="http://schemas.android.com/apk/res/android"/>"""
            )

            val layoutPath = layoutDir.resolve("activity_dedup.xml")
            Files.writeString(
                layoutPath,
                """<LinearLayout xmlns:tools="http://schemas.android.com/tools" tools:context=".DedupActivity"/>"""
            )
            val srcPath = javaDir.resolve("DedupActivity.java")
            Files.writeString(srcPath, "package com.example.app; public class DedupActivity {}")
            val testPath = testDir.resolve("DedupActivityTest.java")
            Files.writeString(testPath, "package com.example.app; public class DedupActivityTest {}")

            val rJar =
                moduleDir.resolve("build/intermediates/compile_and_runtime_r_class_jar/debug/processDebugResources/R.jar")
            writeRJar(rJar, "com.example.app", mapOf("layout" to listOf("activity_dedup")))
            val mergerPath = moduleDir.resolve("build/intermediates/incremental/debug/mergeDebugResources/merger.xml")
            writeMergerXml(mergerPath, mainDir.resolve("res"), listOf(Triple(layoutPath, "activity_dedup", "layout")))

            configureModule(
                name = "project.app.debug",
                moduleRoot = moduleDir,
                mainSources = listOf(srcPath),
                testSources = listOf(testPath),
                extraFiles = listOf(manifestPath, layoutPath),
                sourceRootPaths = listOf(javaDir.parent.parent.parent),
                contentRootPaths = listOf(moduleDir.resolve("src/debug"))
            )

            val testClass = psiClassIn(testPath, "DedupActivityTest")
            val testFile = testClass.containingFile
            registerTestMapping("DedupActivity", listOf(testClass, testClass, testFile, testFile))

            val layoutXml = openXmlFile(layoutPath)
            val observed = LinkedHashMap<VirtualFile, AndroidXmlRelatedTestsProvider.ObservedDocument>()
            AndroidSources.Scope(null, layoutXml.virtualFile).use {
                val res = AndroidXmlRelatedTestsProvider.findRelatedTests(project, layoutXml, 0, observed)
                assertEquals("DedupActivity", res.sourceName)
                // One entry for PsiClass nameIdentifier range, one entry for PsiFile (0:0..0:0).
                assertEquals(2, res.targets.size)
                assertEquals(
                    Location(res.targets[1].uri, Range(Position(0, 0), Position(0, 0))),
                    res.targets[1]
                )
                assertTrue(observed.containsKey(testFile.virtualFile))
            }

            // Simulate concurrent modification of observed source file between pass 1 and pass 2.
            val doc = testFile.virtualFile.findDocument()!!
            SwingUtilities.invokeAndWait {
                com.intellij.openapi.command.CommandProcessor.getInstance().runUndoTransparentAction {
                    ApplicationManager.getApplication().runWriteAction {
                        doc.replaceString(
                            0,
                            doc.textLength,
                            "package com.example.app; public class DedupActivityTest { int edited = 1; }"
                        )
                    }
                }
            }
            val modEx = assertThrows(AndroidQueryException::class.java) {
                AndroidXmlRelatedTestsProvider.verifyObservedDocuments(project, observed)
            }
            assertEquals(-32801, modEx.errorCode)
            assertEquals("content_modified", modEx.reason)

            // Propagate CancellationException / ProcessCanceledException from TestFinder.
            fixtureState.throwOnFindTests = ProcessCanceledException()
            AndroidSources.Scope(null, layoutXml.virtualFile).use {
                assertThrows(ProcessCanceledException::class.java) {
                    AndroidXmlRelatedTestsProvider.findRelatedTests(project, layoutXml, 0)
                }
            }
            fixtureState.throwOnFindTests = CancellationException("cancelled")
            AndroidSources.Scope(null, layoutXml.virtualFile).use {
                assertThrows(CancellationException::class.java) {
                    AndroidXmlRelatedTestsProvider.findRelatedTests(project, layoutXml, 0)
                }
            }
        } finally {
            deleteRecursively(root)
        }
    }

    private class FixtureState {
        val modules = ArrayList<Module>()
        val fileToModule = LinkedHashMap<String, Module>()
        val moduleRoots = LinkedHashMap<Module, List<VirtualFile>>()
        val moduleSourceRoots = LinkedHashMap<Module, List<String>>()
        val moduleContentUrls = LinkedHashMap<Module, List<String>>()
        val moduleMainFiles = LinkedHashMap<Module, MutableSet<String>>()
        val moduleTestFiles = LinkedHashMap<Module, MutableSet<String>>()
        val testsBySourceName = LinkedHashMap<String, List<PsiElement>>()
        val ktLightMirrors = LinkedHashMap<String, PsiClass>()
        var throwOnFindTests: RuntimeException? = null
        val modTracker = SimpleModificationTracker()

        fun reset() {
            modules.clear()
            fileToModule.clear()
            moduleRoots.clear()
            moduleSourceRoots.clear()
            moduleContentUrls.clear()
            moduleMainFiles.clear()
            moduleTestFiles.clear()
            testsBySourceName.clear()
            ktLightMirrors.clear()
            throwOnFindTests = null
        }

        fun addMainSource(path: Path) {
            val module = modules.firstOrNull() ?: return
            val vf = localFile(path) ?: return
            fileToModule[vf.path] = module
            moduleMainFiles.getValue(module).add(vf.path)
            environment.addSourcesToClasspath(vf.parent)
        }
    }

    companion object {
        private lateinit var disposable: Disposable
        private lateinit var application: JavaCoreApplicationEnvironment
        private var projectDisposable: Disposable? = null
        private lateinit var environment: JavaCoreProjectEnvironment
        private lateinit var project: Project
        private val fixtureState = FixtureState()

        @JvmStatic
        @BeforeClass
        fun setUp() {
            LintClient.clientName = LintClient.CLIENT_UNIT_TESTS
            disposable = Disposer.newDisposable()
            application = JavaCoreApplicationEnvironment(disposable)
            application.registerApplicationService(
                com.intellij.psi.util.JavaClassSupers::class.java,
                com.intellij.psi.impl.JavaClassSupersImpl()
            )
            application.registerApplicationService(
                com.intellij.openapi.application.TransactionGuard::class.java,
                com.intellij.openapi.application.TransactionGuardImpl()
            )
            application.registerFileType(XmlFileType.INSTANCE, "xml")
            application.registerParserDefinition(XMLParserDefinition())
            CoreApplicationEnvironment.registerApplicationExtensionPoint(XmlExtension.EP_NAME, XmlExtension::class.java)
            application.addExtension(XmlExtension.EP_NAME, DefaultXmlExtension())
            CoreApplicationEnvironment.registerApplicationExtensionPoint(
                PsiAugmentProvider.EP_NAME,
                PsiAugmentProvider::class.java
            )
            CoreApplicationEnvironment.registerApplicationExtensionPoint(
                UseScopeEnlarger.EP_NAME,
                UseScopeEnlarger::class.java
            )
            CoreApplicationEnvironment.registerApplicationExtensionPoint(
                com.intellij.openapi.extensions.ExtensionPointName.create<ScopeOptimizer>("com.intellij.useScopeOptimizer"),
                ScopeOptimizer::class.java
            )
            CoreApplicationEnvironment.registerApplicationExtensionPoint(
                XmlFileNSInfoProvider.EP_NAME,
                XmlFileNSInfoProvider::class.java
            )
            CoreApplicationEnvironment.registerApplicationExtensionPoint(
                XmlElementDescriptorProvider.EP_NAME,
                XmlElementDescriptorProvider::class.java
            )
            CoreApplicationEnvironment.registerApplicationExtensionPoint(
                XmlAttributeDescriptorsProvider.EP_NAME,
                XmlAttributeDescriptorsProvider::class.java
            )
            CoreApplicationEnvironment.registerApplicationExtensionPoint(
                XmlSchemaProvider.EP_NAME,
                XmlSchemaProvider::class.java
            )
            CoreApplicationEnvironment.registerApplicationExtensionPoint(
                ImplicitNamespaceDescriptorProvider.EP_NAME,
                ImplicitNamespaceDescriptorProvider::class.java
            )
            CoreApplicationEnvironment.registerApplicationExtensionPoint(
                StartTagEndTokenProvider.EP_NAME,
                StartTagEndTokenProvider::class.java
            )
            CoreApplicationEnvironment.registerApplicationExtensionPoint(
                XmlIdContributor.EP_NAME,
                XmlIdContributor::class.java
            )
            application.registerApplicationService(ExternalResourceManager::class.java, CoreExternalResourceManager())
            application.registerFileType(KotlinFileType.INSTANCE, "kt;kts")
            application.registerParserDefinition(KotlinParserDefinition())
            CoreApplicationEnvironment.registerApplicationExtensionPoint(
                ExtensionPointName.create<MetaLanguage>("com.intellij.metaLanguage"),
                MetaLanguage::class.java
            )
            val commonConverter = CommonElementTypeConverterFactory()
            application.addExplicitExtension(
                ElementTypeConverters.instance,
                JavaLanguage.INSTANCE,
                commonConverter
            )
            application.addExplicitExtension(
                ElementTypeConverters.instance,
                XMLLanguage.INSTANCE,
                commonConverter
            )
            application.addExplicitExtension(
                ElementTypeConverters.instance,
                XMLLanguage.INSTANCE,
                object : com.intellij.platform.syntax.psi.ElementTypeConverterFactory {
                    override fun getElementTypeConverter() = com.intellij.psi.xml.xmlElementTypeConverter
                }
            )
            ElementTypeConverters.instance.clearCache()
            application.addExplicitExtension(
                LanguageSyntaxDefinitions.INSTANCE,
                XMLLanguage.INSTANCE,
                XmlSyntaxDefinitionExtension()
            )
            application.addExplicitExtension(
                LanguageASTFactory.INSTANCE,
                XMLLanguage.INSTANCE,
                XmlASTFactory()
            )
            CoreApplicationEnvironment.registerApplicationExtensionPoint(
                DirectNavigationProvider.EP_NAME,
                DirectNavigationProvider::class.java
            )
            CoreApplicationEnvironment.registerApplicationExtensionPoint(
                TestFinder.EP_NAME,
                TestFinder::class.java
            )
            @Suppress("UNCHECKED_CAST")
            CoreApplicationEnvironment.registerApplicationExtensionPoint(
                ReferencesSearch.EP_NAME,
                QueryExecutor::class.java as Class<QueryExecutor<PsiReference, ReferencesSearch.SearchParameters>>
            )
            application.addExtension(
                TestFinder.EP_NAME,
                object : TestFinder {
                    override fun findSourceElement(from: PsiElement): PsiElement? = from

                    override fun findTestsForClass(element: PsiElement): Collection<PsiElement> {
                        fixtureState.throwOnFindTests?.let { throw it }
                        val name = (element as? com.intellij.navigation.NavigationItem)?.name ?: return emptyList()
                        return fixtureState.testsBySourceName[name] ?: emptyList()
                    }

                    override fun findClassesForTest(element: PsiElement): Collection<PsiElement> = emptyList()

                    override fun isTest(element: PsiElement): Boolean = false
                }
            )
            application.addExtension(
                ReferencesSearch.EP_NAME,
                QueryExecutor<PsiReference, ReferencesSearch.SearchParameters> { params, consumer ->
                    val targetField = params.elementToSearch as? PsiField ?: return@QueryExecutor true
                    val fieldName = targetField.name
                    val typeName = targetField.containingClass?.name ?: return@QueryExecutor true
                    val rFqn = targetField.containingClass?.containingClass?.qualifiedName ?: return@QueryExecutor true
                    val scope = params.effectiveSearchScope as? GlobalSearchScope ?: return@QueryExecutor true

                    val allFiles = LinkedHashSet<String>()
                    for (paths in fixtureState.moduleMainFiles.values) allFiles.addAll(paths)
                    for (paths in fixtureState.moduleTestFiles.values) allFiles.addAll(paths)

                    for (filePath in allFiles) {
                        val vf = application.localFileSystem.findFileByPath(filePath) ?: continue
                        if (!scope.contains(vf)) continue
                        val psiFile = PsiManager.getInstance(project).findFile(vf) ?: continue
                        if (psiFile.language == JavaLanguage.INSTANCE) {
                            psiFile.accept(object : JavaRecursiveElementWalkingVisitor() {
                                override fun visitReferenceExpression(expression: PsiReferenceExpression) {
                                    super.visitReferenceExpression(expression)
                                    if (expression.referenceName == fieldName &&
                                        expression.text.endsWith(".$typeName.$fieldName")
                                    ) {
                                        val resolved = expression.resolve()
                                        if (resolved == targetField ||
                                            (resolved is PsiField && resolved.name == fieldName &&
                                                    resolved.containingClass?.name == typeName &&
                                                    resolved.containingClass?.containingClass?.qualifiedName == rFqn)
                                        ) {
                                            consumer.process(expression)
                                        }
                                    }
                                }
                            })
                        } else if (psiFile is KtFile) {
                            psiFile.accept(object : KtTreeVisitorVoid() {
                                override fun visitSimpleNameExpression(expression: org.jetbrains.kotlin.psi.KtSimpleNameExpression) {
                                    super.visitSimpleNameExpression(expression)
                                    if (expression is KtNameReferenceExpression &&
                                        expression.getReferencedName() == fieldName &&
                                        expression.parent?.text?.endsWith(".$typeName.$fieldName") == true
                                    ) {
                                        consumer.process(object :
                                            PsiReferenceBase<PsiElement>(expression, expression.textRangeInParent) {
                                            override fun resolve(): PsiElement = targetField
                                        })
                                    }
                                }
                            })
                        }
                    }
                    true
                }
            )
            createProjectEnvironment()
        }

        private fun createProjectEnvironment() {
            disposeProjectEnvironment()
            val projDisp = Disposer.newDisposable(disposable)
            projectDisposable = projDisp
            environment = JavaCoreProjectEnvironment(projDisp, application)
            project = environment.project
            environment.project.registerService(PsiSearchHelper::class.java, PsiSearchHelperImpl(project))
            if (!project.extensionArea.hasExtensionPoint(PsiElementFinder.EP.name)) {
                CoreApplicationEnvironment.registerExtensionPoint(
                    project.extensionArea,
                    PsiElementFinder.EP.name,
                    PsiElementFinder::class.java
                )
            }
            if (!project.extensionArea.hasExtensionPoint(JvmElementProvider.EP_NAME.name)) {
                CoreApplicationEnvironment.registerExtensionPoint(
                    project.extensionArea,
                    JvmElementProvider.EP_NAME.name,
                    JvmElementProvider::class.java
                )
            }
            PsiElementFinder.EP.getPoint(project).registerExtension(
                PsiElementFinderImpl(project),
                projDisp
            )
            PsiElementFinder.EP.getPoint(project).registerExtension(
                AndroidCompiledResourceClassFinder(project),
                projDisp
            )
            registerProjectServices()
        }

        private fun disposeProjectEnvironment() {
            val projDisp = projectDisposable
            projectDisposable = null
            if (projDisp != null) {
                Disposer.dispose(projDisp)
            }
        }

        @JvmStatic
        @AfterClass
        fun tearDown() {
            disposeProjectEnvironment()
            ElementTypeConverters.instance.clearCache()
            Disposer.dispose(disposable)
        }

        private fun registerProjectServices() {
            val moduleManager = object : ModuleManager() {
                override fun newModule(filePath: String, moduleTypeId: String): Module =
                    throw UnsupportedOperationException()

                override fun loadModule(filePath: String): Module = throw UnsupportedOperationException()
                override fun loadModule(file: Path): Module = throw UnsupportedOperationException()
                override fun disposeModule(module: Module) {}
                override val modules: Array<Module>
                    get() = fixtureState.modules.toTypedArray()

                override fun findModuleByName(name: String): Module? =
                    fixtureState.modules.firstOrNull { it.name == name }

                override val sortedModules: Array<Module>
                    get() = modules

                override fun moduleDependencyComparator(): Comparator<Module> =
                    Comparator.comparing { it.name }

                override fun getModuleDependentModules(module: Module): List<Module> = emptyList()
                override fun isModuleDependent(module: Module, onModule: Module): Boolean = false
                override fun moduleGraph() = throw UnsupportedOperationException()
                override fun moduleGraph(includeTests: Boolean) = throw UnsupportedOperationException()
                override fun getModifiableModel() = throw UnsupportedOperationException()
                override val allModuleDescriptions: Collection<com.intellij.openapi.module.ModuleDescription>
                    get() = emptyList()

                override val unloadedModuleDescriptions: Collection<com.intellij.openapi.module.UnloadedModuleDescription>
                    get() = emptyList()

                override fun getUnloadedModuleDescription(moduleName: String) = null
                override fun getModuleGrouper(modifiableModel: com.intellij.openapi.module.ModifiableModuleModel?) =
                    throw UnsupportedOperationException()

                override suspend fun setUnloadedModules(unloadedModuleNames: List<String>) {}
                override fun setUnloadedModulesSync(unloadedModuleNames: List<String>) {}
            }
            environment.project.registerService(ModuleManager::class.java, moduleManager)

            val fileIndex = Proxy.newProxyInstance(
                ProjectFileIndex::class.java.classLoader,
                arrayOf(ProjectFileIndex::class.java)
            ) { _, method, args ->
                when (method.name) {
                    "getModuleForFile" -> {
                        val vf = args?.get(0) as? VirtualFile ?: return@newProxyInstance null
                        fixtureState.fileToModule[vf.path]
                    }

                    else -> null
                }
            } as ProjectFileIndex
            environment.project.registerService(ProjectFileIndex::class.java, fileIndex)

            val rootManager = object : ProjectRootManager() {
                override fun getModuleRootManager(module: Module): ModuleRootManager {
                    return object : ModuleRootManager() {
                        override fun getModule(): Module = module
                        override fun getContentEntries(): Array<com.intellij.openapi.roots.ContentEntry> = emptyArray()
                        override fun getOrderEntries(): Array<OrderEntry> = emptyArray()
                        override fun getSdk() = null
                        override fun isSdkInherited(): Boolean = false
                        override fun getContentRoots(): Array<VirtualFile> =
                            (fixtureState.moduleRoots[module] ?: emptyList()).toTypedArray()

                        override fun getContentRootUrls(): Array<String> =
                            (fixtureState.moduleContentUrls[module] ?: emptyList()).toTypedArray()

                        override fun getExcludeRoots(): Array<VirtualFile> = VirtualFile.EMPTY_ARRAY
                        override fun getExcludeRootUrls(): Array<String> = emptyArray()
                        override fun getSourceRoots(): Array<VirtualFile> = VirtualFile.EMPTY_ARRAY
                        override fun getSourceRoots(includingTests: Boolean): Array<VirtualFile> =
                            VirtualFile.EMPTY_ARRAY

                        override fun getSourceRoots(rootType: org.jetbrains.jps.model.module.JpsModuleSourceRootType<*>): List<VirtualFile> =
                            emptyList()

                        override fun getSourceRoots(rootTypes: Set<org.jetbrains.jps.model.module.JpsModuleSourceRootType<*>>): List<VirtualFile> =
                            emptyList()

                        override fun getSourceRootUrls(): Array<String> =
                            (fixtureState.moduleSourceRoots[module] ?: emptyList()).toTypedArray()

                        override fun getSourceRootUrls(includingTests: Boolean): Array<String> = getSourceRootUrls()
                        override fun <R> processOrder(
                            policy: com.intellij.openapi.roots.RootPolicy<R>,
                            initialValue: R
                        ): R = initialValue

                        override fun orderEntries() = throw UnsupportedOperationException()
                        override fun getDependencyModuleNames(): Array<String> = emptyArray()
                        override fun <T> getModuleExtension(klass: Class<T>): T? = null
                        override fun getModuleDependencies(): Array<Module> = emptyArray()
                        override fun getModuleDependencies(includingTests: Boolean): Array<Module> = emptyArray()
                        override fun getFileIndex() = throw UnsupportedOperationException()
                        override fun getModifiableModel() = throw UnsupportedOperationException()
                        override fun getDependencies(): Array<Module> = emptyArray()
                        override fun getDependencies(includingTests: Boolean): Array<Module> = emptyArray()
                        override fun isDependsOn(module: Module): Boolean = false
                        override fun getExternalSource() = null
                    }
                }

                override fun getProjectSdk() = null
                override fun getProjectSdkName() = null
                override fun getProjectSdkTypeName() = null
                override fun setProjectSdk(sdk: com.intellij.openapi.projectRoots.Sdk?) {}
                override fun setProjectSdkName(name: String, sdkTypeName: String) {}
                override fun getFileIndex(): ProjectFileIndex = fileIndex
                override fun orderEntries() = throw UnsupportedOperationException()
                override fun orderEntries(modules: Collection<Module>) = throw UnsupportedOperationException()
                override fun getModuleSourceRoots(types: Set<org.jetbrains.jps.model.module.JpsModuleSourceRootType<*>>): List<VirtualFile> =
                    emptyList()

                override fun getContentRoots(): Array<VirtualFile> = VirtualFile.EMPTY_ARRAY
                override fun getContentSourceRoots(): Array<VirtualFile> = VirtualFile.EMPTY_ARRAY
                override fun getContentRootUrls(): MutableList<String> = mutableListOf()
                override fun getContentRootsFromAllModules(): Array<VirtualFile> = VirtualFile.EMPTY_ARRAY
            }
            environment.project.registerService(ProjectRootManager::class.java, rootManager)

            environment.project.registerService(
                KotlinAsJavaSupport::class.java,
                object : KotlinAsJavaSupport() {
                    override fun getLightClass(
                        classOrObject: KtClassOrObject,
                        searchScope: GlobalSearchScope?
                    ): KtLightClass? {
                        val name = classOrObject.name ?: return null
                        val mirror = fixtureState.ktLightMirrors[name] ?: return null
                        return Proxy.newProxyInstance(
                            KtLightClass::class.java.classLoader,
                            arrayOf(KtLightClass::class.java)
                        ) { _, method, args ->
                            when (method.name) {
                                "getKotlinOrigin" -> classOrObject
                                "getNavigationElement" -> classOrObject
                                else -> if (args == null) method.invoke(mirror) else method.invoke(mirror, *args)
                            }
                        } as KtLightClass
                    }

                    override fun getLightClassForScript(
                        script: KtScript,
                        searchScope: GlobalSearchScope?
                    ): KtLightClass? =
                        null

                    override fun getFakeLightClass(classOrObject: KtClassOrObject): KtFakeLightClass {
                        throw UnsupportedOperationException()
                    }

                    override fun getLightFacade(file: KtFile, searchScope: GlobalSearchScope?): KtLightClassForFacade? =
                        null

                    override fun createFacadeForSyntheticFile(file: KtFile): KtLightClassForFacade {
                        throw UnsupportedOperationException()
                    }

                    override fun getFacadeClasses(
                        facadeFqName: FqName,
                        searchScope: GlobalSearchScope
                    ): Collection<KtLightClassForFacade> = emptyList()

                    override fun getScriptClasses(
                        scriptFqName: FqName,
                        searchScope: GlobalSearchScope
                    ): Collection<PsiClass> = emptyList()

                    override fun getKotlinInternalClasses(
                        fqName: FqName,
                        searchScope: GlobalSearchScope
                    ): Collection<PsiClass> = emptyList()

                    override fun findClassOrObjectDeclarationsInPackage(
                        packageFqName: FqName,
                        searchScope: GlobalSearchScope
                    ): Collection<KtClassOrObject> = emptyList()

                    override fun findClassOrObjectDeclarations(
                        fqName: FqName,
                        searchScope: GlobalSearchScope
                    ): Collection<KtClassOrObject> = emptyList()

                    override fun findFilesForPackage(
                        packageFqName: FqName,
                        searchScope: GlobalSearchScope
                    ): Collection<KtFile> = emptyList()

                    override fun findFilesForFacade(
                        facadeFqName: FqName,
                        searchScope: GlobalSearchScope
                    ): Collection<KtFile> = emptyList()

                    override fun findFilesForFacadeByPackage(
                        packageFqName: FqName,
                        searchScope: GlobalSearchScope
                    ): Collection<KtFile> = emptyList()

                    override fun findFilesForScript(
                        scriptFqName: FqName,
                        searchScope: GlobalSearchScope
                    ): Collection<KtScript> = emptyList()

                    override fun packageExists(fqn: FqName, scope: GlobalSearchScope): Boolean = false
                    override fun getSubPackages(fqName: FqName, scope: GlobalSearchScope): Collection<FqName> =
                        emptyList()

                    override fun getFacadeClassesInPackage(
                        packageFqName: FqName,
                        searchScope: GlobalSearchScope
                    ): Collection<KtLightClassForFacade> = emptyList()

                    override fun getFacadeNames(packageFqName: FqName, scope: GlobalSearchScope): Collection<String> =
                        emptyList()

                    override fun getResolutionScope(file: FakeFileForLightClass): GlobalSearchScope {
                        return GlobalSearchScope.allScope(project)
                    }

                    override fun sourceModificationTracker(): ModificationTracker = fixtureState.modTracker
                    override fun librariesModificationTracker(): ModificationTracker = fixtureState.modTracker
                }
            )
        }

        private fun configureModule(
            name: String,
            moduleRoot: Path,
            mainSources: List<Path>,
            testSources: List<Path>,
            extraFiles: List<Path>,
            sourceRootPaths: List<Path>,
            contentRootPaths: List<Path>,
            append: Boolean = false
        ): Module {
            if (!append) fixtureState.reset()
            lateinit var module: Module
            val mainSet = LinkedHashSet<String>()
            val testSet = LinkedHashSet<String>()
            val allModuleFiles = LinkedHashSet<String>()

            fun moduleScope(includeTests: Boolean): GlobalSearchScope {
                return object : GlobalSearchScope(project) {
                    override fun contains(file: VirtualFile): Boolean {
                        return mainSet.contains(file.path) || (includeTests && testSet.contains(file.path))
                    }

                    override fun isSearchInModuleContent(aModule: Module): Boolean = aModule === module
                    override fun isSearchInLibraries(): Boolean = false
                }
            }

            fun depLibScope(includeTests: Boolean): GlobalSearchScope {
                return object : GlobalSearchScope(project) {
                    override fun contains(file: VirtualFile): Boolean {
                        return mainSet.contains(file.path) ||
                                (includeTests && testSet.contains(file.path)) ||
                                allModuleFiles.contains(file.path)
                    }

                    override fun isSearchInModuleContent(aModule: Module): Boolean = aModule === module
                    override fun isSearchInLibraries(): Boolean = true
                }
            }

            module = Proxy.newProxyInstance(
                Module::class.java.classLoader,
                arrayOf(Module::class.java)
            ) { proxy, method, args ->
                when (method.name) {
                    "getName" -> name
                    "getProject" -> project
                    "isDisposed" -> false
                    "getModuleScope" -> moduleScope(args?.getOrNull(0) as? Boolean ?: true)
                    "getModuleWithDependenciesAndLibrariesScope" -> depLibScope(args?.getOrNull(0) as? Boolean ?: false)
                    "getModuleWithDependenciesScope" -> depLibScope(true)
                    "equals" -> proxy === args?.getOrNull(0)
                    "hashCode" -> System.identityHashCode(proxy)
                    else -> null
                }
            } as Module

            val moduleRootVf = localFile(moduleRoot)!!
            val contentRoots = mutableListOf(moduleRootVf)
            val contentUrls = mutableListOf(moduleRootVf.url)
            for (extraContent in contentRootPaths) {
                val vf = localFile(extraContent)
                if (vf != null) {
                    contentRoots.add(vf)
                    contentUrls.add(vf.url)
                }
            }
            fixtureState.modules.add(module)
            fixtureState.moduleRoots[module] = contentRoots
            fixtureState.moduleContentUrls[module] = contentUrls
            fixtureState.moduleSourceRoots[module] = sourceRootPaths.map {
                VfsUtilCore.pathToUrl(it.toAbsolutePath().normalize().toString().replace('\\', '/'))
            }
            fixtureState.moduleMainFiles[module] = mainSet
            fixtureState.moduleTestFiles[module] = testSet

            val cpDirs = LinkedHashSet<VirtualFile>()
            for (path in mainSources) {
                val vf = localFile(path)!!
                mainSet.add(vf.path)
                allModuleFiles.add(vf.path)
                fixtureState.fileToModule[vf.path] = module
                var rootParent = vf.parent
                while (rootParent != null && rootParent.name != "java" && rootParent.name != "kotlin" && rootParent.name != "mirrors") {
                    rootParent = rootParent.parent
                }
                if (rootParent != null) cpDirs.add(rootParent)
            }
            for (path in testSources) {
                val vf = localFile(path)!!
                testSet.add(vf.path)
                allModuleFiles.add(vf.path)
                fixtureState.fileToModule[vf.path] = module
            }
            for (path in extraFiles) {
                val vf = localFile(path)!!
                allModuleFiles.add(vf.path)
                fixtureState.fileToModule[vf.path] = module
            }
            for (cp in cpDirs) {
                environment.addSourcesToClasspath(cp)
            }
            return module
        }

        private fun localFile(path: Path): VirtualFile? =
            application.localFileSystem.findFileByIoFile(path.toFile())

        private fun openXmlFile(path: Path): XmlFile {
            val vf = localFile(path)!!
            return PsiManager.getInstance(project).findFile(vf) as XmlFile
        }

        private fun openKtFile(path: Path): KtFile {
            val vf = localFile(path)!!
            return PsiManager.getInstance(project).findFile(vf) as KtFile
        }

        private fun psiClassIn(path: Path, shortName: String): PsiClass {
            val vf = localFile(path)!!
            val psiFile = PsiManager.getInstance(project).findFile(vf) as com.intellij.psi.PsiClassOwner
            return psiFile.classes.first { it.name == shortName }
        }

        private fun registerTestMapping(sourceName: String, tests: List<PsiElement>) {
            fixtureState.testsBySourceName[sourceName] = tests
        }

        private fun registerKtLightMirror(name: String, mirror: PsiClass) {
            fixtureState.ktLightMirrors[name] = mirror
        }

        private fun writeRJar(jarPath: Path, namespace: String, resources: Map<String, List<String>>) {
            Files.createDirectories(jarPath.parent)
            val pkgPath = namespace.replace('.', '/')
            JarOutputStream(Files.newOutputStream(jarPath)).use { jos ->
                val outerCw = ClassWriter(0)
                outerCw.visit(
                    Opcodes.V17,
                    Opcodes.ACC_PUBLIC or Opcodes.ACC_FINAL,
                    "$pkgPath/R",
                    null,
                    "java/lang/Object",
                    null
                )
                for (type in resources.keys) {
                    outerCw.visitInnerClass(
                        "$pkgPath/R$$type",
                        "$pkgPath/R",
                        type,
                        Opcodes.ACC_PUBLIC or Opcodes.ACC_STATIC or Opcodes.ACC_FINAL
                    )
                }
                outerCw.visitEnd()
                jos.putNextEntry(JarEntry("$pkgPath/R.class"))
                jos.write(outerCw.toByteArray())
                jos.closeEntry()

                var nextId = 0x7f0a0001
                for ((type, names) in resources) {
                    val innerCw = ClassWriter(0)
                    innerCw.visit(
                        Opcodes.V17,
                        Opcodes.ACC_PUBLIC or Opcodes.ACC_STATIC or Opcodes.ACC_FINAL,
                        "$pkgPath/R$$type",
                        null,
                        "java/lang/Object",
                        null
                    )
                    innerCw.visitInnerClass(
                        "$pkgPath/R$$type",
                        "$pkgPath/R",
                        type,
                        Opcodes.ACC_PUBLIC or Opcodes.ACC_STATIC or Opcodes.ACC_FINAL
                    )
                    for (name in names) {
                        innerCw.visitField(
                            Opcodes.ACC_PUBLIC or Opcodes.ACC_STATIC or Opcodes.ACC_FINAL,
                            name,
                            "I",
                            null,
                            nextId++
                        ).visitEnd()
                    }
                    innerCw.visitEnd()
                    jos.putNextEntry(JarEntry("$pkgPath/R$$type.class"))
                    jos.write(innerCw.toByteArray())
                    jos.closeEntry()
                }
            }
        }

        private fun writeMergerXml(
            mergerPath: Path,
            resRoot: Path,
            entries: List<Triple<Path, String, String>>
        ) {
            Files.createDirectories(mergerPath.parent)
            val filesXml = entries.joinToString("\n") { (filePath, name, type) ->
                """<file name="$name" path="${filePath.toAbsolutePath().normalize()}" qualifiers="" type="$type"/>"""
            }
            val xml = """
                <?xml version="1.0" encoding="utf-8"?>
                <merger version="3">
                    <dataSet config="main" ignore_Pattern="!.svn:!.git:!.ds_store:!*.scc:.*:&lt;dir>_*:!CVS:!thumbs.db:!picasa.ini:!*~">
                        <source path="${resRoot.toAbsolutePath().normalize()}">
                            $filesXml
                        </source>
                    </dataSet>
                </merger>
            """.trimIndent()
            Files.writeString(mergerPath, xml)
        }

        private fun deleteRecursively(path: Path) {
            try {
                if (Files.isDirectory(path)) {
                    Files.list(path).use { stream ->
                        for (child in stream.toList()) {
                            deleteRecursively(child)
                        }
                    }
                }
                Files.deleteIfExists(path)
            } catch (_: Exception) {
            }
        }
    }
}
