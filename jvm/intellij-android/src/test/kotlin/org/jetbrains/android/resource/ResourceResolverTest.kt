package org.jetbrains.android.resource

import com.intellij.core.CoreApplicationEnvironment
import com.intellij.core.CoreProjectEnvironment
import com.intellij.ide.highlighter.XmlFileType
import com.intellij.lang.LanguageASTFactory
import com.intellij.lang.MetaLanguage
import com.intellij.lang.xml.XMLLanguage
import com.intellij.lang.xml.XmlASTFactory
import com.intellij.lang.xml.XMLParserDefinition
import com.intellij.lang.xml.XmlSyntaxDefinitionExtension
import com.intellij.openapi.Disposable
import com.intellij.openapi.extensions.ExtensionPointName
import com.intellij.openapi.util.Disposer
import com.intellij.platform.syntax.psi.ElementTypeConverters
import com.intellij.platform.syntax.psi.LanguageSyntaxDefinitions
import com.intellij.platform.syntax.psi.PsiSyntaxBuilderFactory
import com.intellij.psi.PsiManager
import com.intellij.psi.SingleRootFileViewProvider
import com.intellij.psi.xml.XmlAttribute
import com.intellij.psi.xml.XmlFile
import com.intellij.testFramework.LightVirtualFile
import org.junit.AfterClass
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.BeforeClass
import org.junit.Test

class ResourceResolverTest {

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
                PsiSyntaxBuilderFactory::class.java,
                PsiSyntaxBuilderFactory.defaultBuilderFactory()
            )
            CoreApplicationEnvironment.registerApplicationExtensionPoint(
                ExtensionPointName.create("com.intellij.metaLanguage"),
                MetaLanguage::class.java
            )
            application.addExplicitExtension(
                ElementTypeConverters.instance,
                XMLLanguage.INSTANCE,
                object : com.intellij.platform.syntax.psi.ElementTypeConverterFactory {
                    override fun getElementTypeConverter() = com.intellij.psi.xml.xmlElementTypeConverter
                }
            )
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
                XmlFileType.INSTANCE
            )
            return provider.getPsi(XMLLanguage.INSTANCE) as XmlFile
        }

        private fun findReferenceInAttr(file: XmlFile, attrName: String): ResourceReference? {
            val root = file.rootTag
            assertNotNull(root)
            val attr = root!!.getAttribute(attrName)
            assertNotNull("Attribute $attrName missing", attr)
            val valElement = attr!!.valueElement
            assertNotNull("Attribute value for $attrName missing", valElement)
            val offset = valElement!!.valueTextRange.startOffset + 1
            return ResourceResolver.findResourceReferenceAt(file, offset)
        }
    }

    @Test
    fun findResourceReferenceAtResolvesStandardAndThemeForms() {
        val xml = """
            <LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"
                xmlns:app="http://schemas.android.com/apk/res-auto"
                android:text="@string/app_name"
                android:id="@+id/btn_ok"
                android:src="@android:string/cancel"
                android:background="?attr/colorPrimary"
                android:textColor="?android:attr/textColorPrimary"
                android:tint="?android:textColorSecondary"
                android:theme="?themeColor"
                android:drawable="@*android:drawable/internal_asset"
                app:custom="@com.example.lib:string/lib_title"
                android:style="@style/Theme.AppCompat"
            />
            """.trimIndent()
        val file = createXmlFile("activity_main.xml", xml)

        val textRef = findReferenceInAttr(file, "android:text")
        assertNotNull(textRef)
        assertEquals("string", textRef!!.type)
        assertEquals("app_name", textRef.name)
        assertNull(textRef.namespace)
        assertFalse(textRef.isFramework)

        val idRef = findReferenceInAttr(file, "android:id")
        assertNotNull(idRef)
        assertEquals("id", idRef!!.type)
        assertEquals("btn_ok", idRef.name)
        assertNull(idRef.namespace)
        assertFalse(idRef.isFramework)

        val androidStringRef = findReferenceInAttr(file, "android:src")
        assertNotNull(androidStringRef)
        assertEquals("string", androidStringRef!!.type)
        assertEquals("cancel", androidStringRef.name)
        assertEquals("android", androidStringRef.namespace)
        assertTrue(androidStringRef.isFramework)

        val bgRef = findReferenceInAttr(file, "android:background")
        assertNotNull(bgRef)
        assertEquals("attr", bgRef!!.type)
        assertEquals("colorPrimary", bgRef.name)
        assertNull(bgRef.namespace)
        assertFalse(bgRef.isFramework)

        val textColorRef = findReferenceInAttr(file, "android:textColor")
        assertNotNull(textColorRef)
        assertEquals("attr", textColorRef!!.type)
        assertEquals("textColorPrimary", textColorRef.name)
        assertEquals("android", textColorRef.namespace)
        assertTrue(textColorRef.isFramework)

        val tintRef = findReferenceInAttr(file, "android:tint")
        assertNotNull(tintRef)
        assertEquals("attr", tintRef!!.type)
        assertEquals("textColorSecondary", tintRef.name)
        assertEquals("android", tintRef.namespace)
        assertTrue(tintRef.isFramework)

        val themeRef = findReferenceInAttr(file, "android:theme")
        assertNotNull(themeRef)
        assertEquals("attr", themeRef!!.type)
        assertEquals("themeColor", themeRef.name)
        assertNull(themeRef.namespace)
        assertFalse(themeRef.isFramework)

        val privateFwRef = findReferenceInAttr(file, "android:drawable")
        assertNotNull(privateFwRef)
        assertEquals("drawable", privateFwRef!!.type)
        assertEquals("internal_asset", privateFwRef.name)
        assertEquals("android", privateFwRef.namespace)
        assertTrue(privateFwRef.isFramework)

        val customNsRef = findReferenceInAttr(file, "app:custom")
        assertNotNull(customNsRef)
        assertEquals("string", customNsRef!!.type)
        assertEquals("lib_title", customNsRef.name)
        assertEquals("com.example.lib", customNsRef.namespace)
        assertFalse(customNsRef.isFramework)

        val styleRef = findReferenceInAttr(file, "android:style")
        assertNotNull(styleRef)
        assertEquals("style", styleRef!!.type)
        assertEquals("Theme.AppCompat", styleRef.name)
        assertNull(styleRef.namespace)
        assertFalse(styleRef.isFramework)
    }

    @Test
    fun findResourceReferenceAtRejectsMalformedReferences() {
        val xml = """
            <LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"
                android:a="@null"
                android:b="@empty"
                android:c="@invalid_type/item"
                android:d="@string/"
                android:e="@/app_name"
                android:f="@"
                android:g="?"
                android:h="@+"
                android:i="@android:string/foo:bar"
                android:j="plain_text"
                android:k="http://schemas.android.com"
                android:l="@string/123invalid"
                android:m="?attr/"
                android:n="?android:"
                android:o="@android:"
            />
            """.trimIndent()
        val file = createXmlFile("malformed.xml", xml)

        val attrs = arrayOf(
            "android:a", "android:b", "android:c", "android:d", "android:e",
            "android:f", "android:g", "android:h", "android:i", "android:j",
            "android:k", "android:l", "android:m", "android:n", "android:o"
        )
        for (attr in attrs) {
            val ref = findReferenceInAttr(file, attr)
            assertNull("Expected null reference for attribute $attr", ref)
        }
    }
}
