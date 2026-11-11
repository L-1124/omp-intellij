package org.jetbrains.android.lint

import com.android.ide.common.rendering.api.AttrResourceValue
import com.android.ide.common.rendering.api.AttributeFormat
import com.android.ide.common.rendering.api.ResourceNamespace
import com.android.ide.common.rendering.api.ResourceValueImpl
import com.android.ide.common.rendering.api.StyleItemResourceValue
import com.android.ide.common.rendering.api.StyleItemResourceValueImpl
import com.android.ide.common.rendering.api.StyleResourceValue
import com.android.ide.common.rendering.api.StyleResourceValueImpl
import com.android.ide.common.resources.ResourceItem
import com.android.ide.common.resources.ResourceRepository
import com.android.ide.common.resources.configuration.FolderConfiguration
import com.android.ide.common.util.PathString
import com.android.resources.ResourceFolderType
import com.android.resources.ResourceType
import com.android.tools.lint.client.api.ResourceRepositoryScope
import com.android.tools.lint.detector.api.Scope
import com.intellij.core.CoreApplicationEnvironment
import com.intellij.core.CoreProjectEnvironment
import com.intellij.ide.highlighter.XmlFileType
import com.intellij.lang.xml.XMLLanguage
import com.intellij.lang.xml.XMLParserDefinition
import com.intellij.openapi.Disposable
import com.intellij.openapi.module.Module
import com.intellij.openapi.util.Disposer
import com.intellij.psi.PsiManager
import com.intellij.psi.SingleRootFileViewProvider
import com.intellij.psi.xml.XmlFile
import com.intellij.testFramework.LightVirtualFile
import org.jetbrains.android.context.AndroidQueryException
import org.junit.AfterClass
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.BeforeClass
import org.junit.Test
import java.lang.reflect.Proxy
import java.nio.file.Path

class AndroidLintResourcesTest {

    @Test
    fun folderTypeMatchesFolderNames() {
        assertEquals(
            ResourceFolderType.LAYOUT,
            AndroidLintResources.folderType(Path.of("src/main/res/layout/activity_main.xml"))
        )
        assertEquals(
            ResourceFolderType.LAYOUT,
            AndroidLintResources.folderType(Path.of("src/main/res/layout-sw600dp/activity_main.xml"))
        )
        assertEquals(
            ResourceFolderType.VALUES,
            AndroidLintResources.folderType(Path.of("src/main/res/values/strings.xml"))
        )
        assertEquals(
            ResourceFolderType.VALUES,
            AndroidLintResources.folderType(Path.of("src/main/res/values-v21/styles.xml"))
        )
        assertEquals(
            ResourceFolderType.DRAWABLE,
            AndroidLintResources.folderType(Path.of("src/main/res/drawable-hdpi/icon.png"))
        )
        assertNull(AndroidLintResources.folderType(Path.of("src/main/res/unknown-folder/file.xml")))
    }

    @Test
    fun scopeDistinguishesManifestsAndResourcesAndRejectsInvalidPaths() {
        val moduleRoot = Path.of("/app").toAbsolutePath().normalize()
        val mainRes = moduleRoot.resolve("src/main/res")
        val mainMf = moduleRoot.resolve("src/main/AndroidManifest.xml")
        val customMf = moduleRoot.resolve("src/custom/AndroidManifest.xml")

        val inputs = AndroidLintResources.Inputs(
            listOf(mainRes),
            listOf(mainMf, customMf),
            null,
            null,
            "test-fingerprint",
            true,
        )

        val model = AndroidLintModel(
            module = null,
            androidModule = null,
            moduleRoot = moduleRoot,
            projectRoot = moduleRoot,
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
            ruleJars = emptyList(),
            ruleJarFingerprints = emptyList(),
            fingerprint = "model-fp",
            lintXmlFingerprint = "lint-fp",
            xmlInputs = inputs,
        )

        assertEquals(Scope.MANIFEST, AndroidLintResources.scope(model, mainMf))
        assertEquals(Scope.MANIFEST, AndroidLintResources.scope(model, customMf))

        val layoutXml = mainRes.resolve("layout/activity_main.xml")
        assertEquals(Scope.RESOURCE_FILE, AndroidLintResources.scope(model, layoutXml))

        val valuesXml = mainRes.resolve("values/strings.xml")
        assertEquals(Scope.RESOURCE_FILE, AndroidLintResources.scope(model, valuesXml))

        val layoutPng = mainRes.resolve("layout/image.png")
        assertNull(AndroidLintResources.scope(model, layoutPng))

        val nestedXml = mainRes.resolve("layout/nested/item.xml")
        assertNull(AndroidLintResources.scope(model, nestedXml))

        val buildMf = moduleRoot.resolve("build/intermediates/merged_manifests/AndroidManifest.xml")
        assertNull(AndroidLintResources.scope(model, buildMf))

        val outsideXml = Path.of("/other/res/layout/activity_main.xml")
        assertNull(AndroidLintResources.scope(model, outsideXml))
    }

    @Test
    fun repositoryPrecedenceRetainsVariantOverMainForSameConfig() {
        val repo = AndroidLintResources.LintResourceRepository(
            ResourceNamespace.fromPackageName("com.example.app"),
            "com.example.app",
        )

        val defaultConfig = FolderConfiguration.createDefault()
        val ns = ResourceNamespace.fromPackageName("com.example.app")

        // Variant item added first (higher precedence)
        val variantValue = ResourceValueImpl(ns, ResourceType.STRING, "app_name", "Variant App", null)
        val variantItem = AndroidLintResources.LintResourceItem(
            "app_name",
            ResourceType.STRING,
            ns,
            null,
            defaultConfig,
            variantValue,
            PathString("/app/src/debug/res/values/strings.xml"),
            false,
            true,
        )
        repo.add(variantItem)

        // Main item added second (lower precedence)
        val mainValue = ResourceValueImpl(ns, ResourceType.STRING, "app_name", "Main App", null)
        val mainItem = AndroidLintResources.LintResourceItem(
            "app_name",
            ResourceType.STRING,
            ns,
            null,
            defaultConfig,
            mainValue,
            PathString("/app/src/main/res/values/strings.xml"),
            false,
            true,
        )
        repo.add(mainItem)

        val items = repo.getResources(ns, ResourceType.STRING, "app_name")
        assertEquals(1, items.size)
        assertEquals("Variant App", items[0].resourceValue?.value)

        val autoItems = repo.getResources(ResourceNamespace.RES_AUTO, ResourceType.STRING, "app_name")
        assertEquals(1, autoItems.size)
        assertEquals("Variant App", autoItems[0].resourceValue?.value)
    }

    @Test
    fun repositoryPreservesDistinctConfigurations() {
        val repo = AndroidLintResources.LintResourceRepository(
            ResourceNamespace.fromPackageName("com.example.app"),
            "com.example.app",
        )

        val ns = ResourceNamespace.fromPackageName("com.example.app")
        val defaultConfig = FolderConfiguration.createDefault()
        val esConfig = FolderConfiguration.getConfigForFolder("values-es")

        val defaultValue = ResourceValueImpl(ns, ResourceType.STRING, "greeting", "Hello", null)
        repo.add(
            AndroidLintResources.LintResourceItem(
                "greeting",
                ResourceType.STRING,
                ns,
                null,
                defaultConfig,
                defaultValue,
                PathString("/app/res/values/strings.xml"),
                false,
                true
            )
        )

        val esValue = ResourceValueImpl(ns, ResourceType.STRING, "greeting", "Hola", null)
        repo.add(
            AndroidLintResources.LintResourceItem(
                "greeting",
                ResourceType.STRING,
                ns,
                null,
                esConfig,
                esValue,
                PathString("/app/res/values-es/strings.xml"),
                false,
                true
            )
        )

        val items = repo.getResources(ns, ResourceType.STRING, "greeting")
        assertEquals(2, items.size)
    }

    @Test
    fun repositorySupportsStyleItemsAndNamespaceAliases() {
        val repo = AndroidLintResources.LintResourceRepository(
            ResourceNamespace.fromPackageName("com.example.app"),
            "com.example.app",
        )

        val ns = ResourceNamespace.fromPackageName("com.example.app")
        val style = StyleResourceValueImpl(ns, "AppTheme", "Theme.AppCompat", null)
        style.addItem(StyleItemResourceValueImpl(ResourceNamespace.ANDROID, "windowNoTitle", "true", null))
        style.addItem(StyleItemResourceValueImpl(ResourceNamespace.RES_AUTO, "colorPrimary", "#123456", null))

        repo.add(
            AndroidLintResources.LintResourceItem(
                "AppTheme",
                ResourceType.STYLE,
                ns,
                null,
                FolderConfiguration.createDefault(),
                style,
                PathString("/app/res/values/styles.xml"),
                false,
                true
            )
        )

        val items = repo.getResources(ns, ResourceType.STYLE, "AppTheme")
        assertEquals(1, items.size)

        val retrieved = items[0].resourceValue as StyleResourceValue
        assertEquals("Theme.AppCompat", retrieved.parentStyleName)

        val androidItem = retrieved.getItem(ResourceNamespace.ANDROID, "windowNoTitle")
        assertNotNull(androidItem)
        assertEquals("true", androidItem!!.value)

        val customItem = retrieved.getItem(ResourceNamespace.RES_AUTO, "colorPrimary")
        assertNotNull(customItem)
        assertEquals("#123456", customItem!!.value)
    }

    @Test
    fun publicResourcesDistinguishesPublicFromPrivate() {
        val repo = AndroidLintResources.LintResourceRepository(
            ResourceNamespace.fromPackageName("com.example.lib"),
            "com.example.lib",
        )
        val ns = ResourceNamespace.fromPackageName("com.example.lib")

        val pubVal = ResourceValueImpl(ns, ResourceType.STRING, "public_string", "Public", null)
        repo.add(
            AndroidLintResources.LintResourceItem(
                "public_string",
                ResourceType.STRING,
                ns,
                "lib",
                FolderConfiguration.createDefault(),
                pubVal,
                PathString("/lib/res/values/strings.xml"),
                false,
                true
            )
        )

        val privVal = ResourceValueImpl(ns, ResourceType.STRING, "private_string", "Private", null)
        repo.add(
            AndroidLintResources.LintResourceItem(
                "private_string",
                ResourceType.STRING,
                ns,
                "lib",
                FolderConfiguration.createDefault(),
                privVal,
                PathString("/lib/res/values/strings.xml"),
                false,
                false
            )
        )

        val publicOnly = repo.getPublicResources(ns, ResourceType.STRING)
        assertEquals(1, publicOnly.size)
        assertEquals("public_string", publicOnly.iterator().next().name)
        val all = repo.getResources(ns, ResourceType.STRING)
        assertEquals(2, all.size())
    }

    @Test(expected = AndroidQueryException::class)
    fun getRepositoryThrowsWhenModelInputsIncomplete() {
        val root = Path.of("/app").toAbsolutePath().normalize()
        val incompleteInputs = AndroidLintResources.Inputs(
            listOf(root.resolve("src/main/res")),
            listOf(root.resolve("src/main/AndroidManifest.xml")),
            null,
            null,
            "fingerprint",
            false, // incomplete
        )

        val model = AndroidLintModel(
            module = null,
            androidModule = null,
            moduleRoot = root,
            projectRoot = root,
            variant = "debug",
            sdkHome = null,
            compileSdk = 34,
            compileTarget = "android-34",
            minSdk = null,
            targetSdk = 34,
            namespace = null,
            isLibrary = false,
            minSdkPremiseMissing = true,
            lintModelModule = null,
            lintModelVariant = null,
            ruleJars = emptyList(),
            ruleJarFingerprints = emptyList(),
            fingerprint = "fp",
            lintXmlFingerprint = "lint-fp",
            xmlInputs = incompleteInputs,
        )

        AndroidLintResources.getRepository(model, ResourceRepositoryScope.PROJECT_ONLY)
    }

    @Test
    fun valuesXmlParsesEscapedStringsAndCdata() {
        val root = Path.of("/app").toAbsolutePath().normalize()
        val resDir = root.resolve("src/main/res")
        val stringsXmlPath = resDir.resolve("values/strings.xml")

        val xmlContent = """
            <resources>
              <string name="escaped_str">Line 1\nLine 2\tTab \'quote\' \"double\"</string>
              <string name="quoted_str">"  leading and trailing  "</string>
              <string name="unicode_str">Unicode \u0041\u0042</string>
              <string name="entities_str">&lt;b&gt;Bold&lt;/b&gt; &amp; &quot;quote&quot;</string>
              <string name="cdata_str"><![CDATA[<b>CDATA Content</b> & raw]]></string>
              <string name="formatted_str">Hello %1${'$'}s, count %2${'$'}d</string>
              <string name="ref_str">@string/other_str</string>
              <string-array name="item_list">
                <item>First\nItem</item>
                <item>" Second Item "</item>
              </string-array>
            </resources>
        """.trimIndent()

        val xmlFile = createXmlFile("strings.xml", xmlContent)
        val inputs = AndroidLintResources.Inputs(
            listOf(resDir),
            listOf(root.resolve("src/main/AndroidManifest.xml")),
            null,
            null,
            "fp-values-strings",
            true,
        )
        val model = AndroidLintModel(
            module = createLightModule(),
            androidModule = null,
            moduleRoot = root,
            projectRoot = root,
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
            ruleJars = emptyList(),
            ruleJarFingerprints = emptyList(),
            fingerprint = "model-fp",
            lintXmlFingerprint = "lint-fp",
            xmlInputs = inputs,
        )

        val repo =
            AndroidLintResources.getRepository(model, ResourceRepositoryScope.PROJECT_ONLY, stringsXmlPath, xmlFile)
        val ns = ResourceNamespace.fromPackageName("com.example.app")

        val escapedItems = repo.getResources(ns, ResourceType.STRING, "escaped_str")
        assertEquals(1, escapedItems.size)
        assertEquals("Line 1\nLine 2\tTab 'quote' \"double\"", escapedItems[0].resourceValue?.value)

        val quotedItems = repo.getResources(ns, ResourceType.STRING, "quoted_str")
        assertEquals("  leading and trailing  ", quotedItems[0].resourceValue?.value)

        val unicodeItems = repo.getResources(ns, ResourceType.STRING, "unicode_str")
        assertEquals("Unicode AB", unicodeItems[0].resourceValue?.value)

        val entitiesItems = repo.getResources(ns, ResourceType.STRING, "entities_str")
        assertEquals("<b>Bold</b> & \"quote\"", entitiesItems[0].resourceValue?.value)

        val cdataItems = repo.getResources(ns, ResourceType.STRING, "cdata_str")
        assertEquals("<b>CDATA Content</b> & raw", cdataItems[0].resourceValue?.value)

        val formattedItems = repo.getResources(ns, ResourceType.STRING, "formatted_str")
        assertEquals("Hello %1\$s, count %2\$d", formattedItems[0].resourceValue?.value)

        val refItems = repo.getResources(ns, ResourceType.STRING, "ref_str")
        assertEquals("@string/other_str", refItems[0].resourceValue?.value)

        val arrayItems = repo.getResources(ns, ResourceType.ARRAY, "item_list")
        assertEquals(1, arrayItems.size)
        val arrayVal = arrayItems[0].resourceValue as com.android.ide.common.rendering.api.ArrayResourceValue
        assertEquals(2, arrayVal.elementCount)
        assertEquals("First\nItem", arrayVal.getElement(0))
        assertEquals(" Second Item ", arrayVal.getElement(1))
    }

    @Test
    fun valuesXmlParsesAttrFormatsAndEnumFlagMetadata() {
        val root = Path.of("/app").toAbsolutePath().normalize()
        val resDir = root.resolve("src/main/res")
        val attrsXmlPath = resDir.resolve("values/attrs.xml")

        val xmlContent = """
            <resources>
              <attr name="customColor" format="reference|color" />
              <attr name="gravity">
                <flag name="top" value="0x01" />
                <flag name="bottom" value="0x02" />
                <flag name="fill" value="0x80000000" />
              </attr>
              <attr name="alignment">
                <enum name="left" value="1" />
                <enum name="right" value="2" />
              </attr>
              <declare-styleable name="CustomView">
                <attr name="customColor" />
                <attr name="mode" format="enum">
                  <enum name="auto" value="0" />
                  <enum name="manual" value="1" />
                </attr>
              </declare-styleable>
            </resources>
        """.trimIndent()

        val xmlFile = createXmlFile("attrs.xml", xmlContent)
        val inputs = AndroidLintResources.Inputs(
            listOf(resDir),
            listOf(root.resolve("src/main/AndroidManifest.xml")),
            null,
            null,
            "fp-values-attrs",
            true,
        )
        val model = AndroidLintModel(
            module = createLightModule(),
            androidModule = null,
            moduleRoot = root,
            projectRoot = root,
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
            ruleJars = emptyList(),
            ruleJarFingerprints = emptyList(),
            fingerprint = "model-fp",
            lintXmlFingerprint = "lint-fp",
            xmlInputs = inputs,
        )

        val repo =
            AndroidLintResources.getRepository(model, ResourceRepositoryScope.PROJECT_ONLY, attrsXmlPath, xmlFile)
        val ns = ResourceNamespace.fromPackageName("com.example.app")

        val customColorItems = repo.getResources(ns, ResourceType.ATTR, "customColor")
        assertEquals(1, customColorItems.size)
        val customColor = customColorItems[0].resourceValue as AttrResourceValue
        assertTrue(customColor.formats.contains(AttributeFormat.COLOR))
        assertTrue(customColor.formats.contains(AttributeFormat.REFERENCE))

        val gravityItems = repo.getResources(ns, ResourceType.ATTR, "gravity")
        assertEquals(1, gravityItems.size)
        val gravity = gravityItems[0].resourceValue as AttrResourceValue
        assertTrue(gravity.formats.contains(AttributeFormat.FLAGS))
        assertEquals(Integer.valueOf(1), gravity.attributeValues["top"])
        assertEquals(Integer.valueOf(2), gravity.attributeValues["bottom"])
        assertEquals(Integer.valueOf(-2147483648), gravity.attributeValues["fill"])

        val alignmentItems = repo.getResources(ns, ResourceType.ATTR, "alignment")
        assertEquals(1, alignmentItems.size)
        val alignment = alignmentItems[0].resourceValue as AttrResourceValue
        assertTrue(alignment.formats.contains(AttributeFormat.ENUM))
        assertEquals(Integer.valueOf(1), alignment.attributeValues["left"])
        assertEquals(Integer.valueOf(2), alignment.attributeValues["right"])

        val modeItems = repo.getResources(ns, ResourceType.ATTR, "mode")
        assertEquals(1, modeItems.size)
        val modeAttr = modeItems[0].resourceValue as AttrResourceValue
        assertTrue(modeAttr.formats.contains(AttributeFormat.ENUM))
        assertEquals(Integer.valueOf(0), modeAttr.attributeValues["auto"])
        assertEquals(Integer.valueOf(1), modeAttr.attributeValues["manual"])
    }

    @Test
    fun collectIdsFromTagUsesResourceUrlAndRejectsMalformed() {
        val root = Path.of("/app").toAbsolutePath().normalize()
        val resDir = root.resolve("src/main/res")
        val layoutXmlPath = resDir.resolve("layout/activity_main.xml")

        val layoutContent = """
            <LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"
                android:id="@+id/container">
              <Button android:id="@+id/btn_ok" />
              <Button android:id="@+android:id/button1" />
              <TextView android:id="@+id/" />
              <TextView android:id="@+id/123invalid" />
            </LinearLayout>
        """.trimIndent()

        val xmlFile = createXmlFile("activity_main.xml", layoutContent)
        val inputs = AndroidLintResources.Inputs(
            listOf(resDir),
            listOf(root.resolve("src/main/AndroidManifest.xml")),
            null,
            null,
            "fp-layout-ids",
            true,
        )
        val model = AndroidLintModel(
            module = createLightModule(),
            androidModule = null,
            moduleRoot = root,
            projectRoot = root,
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
            ruleJars = emptyList(),
            ruleJarFingerprints = emptyList(),
            fingerprint = "model-fp",
            lintXmlFingerprint = "lint-fp",
            xmlInputs = inputs,
        )

        val repo =
            AndroidLintResources.getRepository(model, ResourceRepositoryScope.PROJECT_ONLY, layoutXmlPath, xmlFile)
        val ns = ResourceNamespace.fromPackageName("com.example.app")

        assertTrue(repo.hasResources(ns, ResourceType.ID, "container"))
        assertTrue(repo.hasResources(ns, ResourceType.ID, "btn_ok"))
        assertFalse(
            "App declarations must not inject into framework namespace",
            repo.hasResources(ResourceNamespace.ANDROID, ResourceType.ID, "button1")
        )
        assertFalse(repo.hasResources(ns, ResourceType.ID, "button1"))
        assertFalse(repo.hasResources(ns, ResourceType.ID, ""))
        assertFalse(repo.hasResources(ns, ResourceType.ID, "123invalid"))
    }

    @Test
    fun inputsNormalizesNullAndGuaranteesImmutability() {
        val nullInputs = AndroidLintResources.Inputs(null, null, null, null, null, false)
        assertTrue(nullInputs.resourceRoots.isEmpty())
        assertTrue(nullInputs.manifests.isEmpty())

        val mutableRoots = ArrayList<Path>()
        mutableRoots.add(Path.of("/res1"))
        val inputs = AndroidLintResources.Inputs(mutableRoots, null, null, null, "fp", true)
        assertEquals(1, inputs.resourceRoots.size)

        mutableRoots.add(Path.of("/res2"))
        assertEquals("Defensive copy must not be affected by external list mutation", 1, inputs.resourceRoots.size)
    }

    companion object {
        private lateinit var disposable: Disposable
        private lateinit var environment: CoreProjectEnvironment

        @JvmStatic
        @BeforeClass
        fun setUp() {
            disposable = Disposer.newDisposable()
            val application = CoreApplicationEnvironment(disposable)
            application.registerFileType(XmlFileType.INSTANCE, "xml")
            application.registerParserDefinition(XMLParserDefinition())
            application.registerApplicationService(
                com.intellij.platform.syntax.psi.PsiSyntaxBuilderFactory::class.java,
                com.intellij.platform.syntax.psi.PsiSyntaxBuilderFactory.defaultBuilderFactory(),
            )
            CoreApplicationEnvironment.registerApplicationExtensionPoint(
                com.intellij.openapi.extensions.ExtensionPointName.create("com.intellij.metaLanguage"),
                com.intellij.lang.MetaLanguage::class.java,
            )
            application.addExplicitExtension(
                com.intellij.platform.syntax.psi.ElementTypeConverters.instance,
                XMLLanguage.INSTANCE,
                object : com.intellij.platform.syntax.psi.ElementTypeConverterFactory {
                    override fun getElementTypeConverter() = com.intellij.psi.xml.xmlElementTypeConverter
                },
            )
            application.addExplicitExtension(
                com.intellij.platform.syntax.psi.LanguageSyntaxDefinitions.INSTANCE,
                XMLLanguage.INSTANCE,
                com.intellij.lang.xml.XmlSyntaxDefinitionExtension(),
            )
            application.addExplicitExtension(
                com.intellij.lang.LanguageASTFactory.INSTANCE,
                XMLLanguage.INSTANCE,
                com.intellij.lang.xml.XmlASTFactory(),
            )

            environment = CoreProjectEnvironment(disposable, application)
        }

        @JvmStatic
        @AfterClass
        fun tearDown() {
            Disposer.dispose(disposable)
        }

        private fun createXmlFile(name: String, content: String): XmlFile {
            val virtualFile = LightVirtualFile(name, XmlFileType.INSTANCE, content)
            SingleRootFileViewProvider.doNotCheckFileSizeLimit(virtualFile)
            val provider = SingleRootFileViewProvider(
                PsiManager.getInstance(environment.project),
                virtualFile,
                false,
                XmlFileType.INSTANCE,
            )
            return provider.getPsi(XMLLanguage.INSTANCE) as XmlFile
        }

        private fun createLightModule(): Module {
            return Proxy.newProxyInstance(
                Module::class.java.classLoader,
                arrayOf<Class<*>>(Module::class.java),
            ) { _, method, _ ->
                when (method.name) {
                    "getProject" -> environment.project
                    "getName" -> "app"
                    "isDisposed" -> false
                    else -> null
                }
            } as Module
        }
    }
}
