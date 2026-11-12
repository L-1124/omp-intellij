/*
 * Copyright (C) 2019 The Android Open Source Project
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
package org.jetbrains.android.lint

import com.android.ide.common.rendering.api.ResourceNamespace
import com.android.ide.common.resources.ResourceItem
import com.android.ide.common.resources.configuration.FolderConfiguration
import com.android.ide.common.util.PathString
import com.android.manifmerger.ManifestModel
import com.android.manifmerger.XmlNode
import com.android.resources.ResourceType
import com.android.tools.lint.client.api.GradleVisitor
import com.android.tools.lint.client.api.LintClient
import com.android.tools.lint.client.api.UastParser
import com.android.tools.lint.client.api.XmlParser
import com.android.tools.lint.detector.api.Context
import com.android.tools.lint.detector.api.Incident
import com.android.tools.lint.detector.api.Location
import com.android.tools.lint.detector.api.Severity
import com.android.tools.lint.detector.api.TextFormat
import com.android.utils.PositionXmlParser
import com.intellij.core.CoreApplicationEnvironment
import com.intellij.core.CoreProjectEnvironment
import com.intellij.ide.highlighter.XmlFileType
import com.intellij.javaee.CoreExternalResourceManager
import com.intellij.javaee.ExternalResourceManager
import com.intellij.javaee.ImplicitNamespaceDescriptorProvider
import com.intellij.lang.xml.XMLLanguage
import com.intellij.lang.xml.XMLParserDefinition
import com.intellij.openapi.Disposable
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.util.Disposer
import com.intellij.psi.PsiManager
import com.intellij.psi.SingleRootFileViewProvider
import com.intellij.psi.XmlElementFactory
import com.intellij.psi.XmlElementFactoryImpl
import com.intellij.psi.impl.source.xml.XmlElementDescriptorProvider
import com.intellij.psi.xml.StartTagEndTokenProvider
import com.intellij.psi.xml.XmlFile
import com.intellij.psi.xml.XmlFileNSInfoProvider
import com.intellij.testFramework.LightVirtualFile
import com.intellij.xml.DefaultXmlExtension
import com.intellij.xml.XmlAttributeDescriptorsProvider
import com.intellij.xml.XmlExtension
import com.intellij.xml.XmlSchemaProvider
import com.intellij.xml.util.XmlIdContributor
import org.jetbrains.android.context.AndroidQueryException
import org.junit.AfterClass
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.BeforeClass
import org.junit.Test
import org.w3c.dom.Attr
import org.w3c.dom.Document
import org.w3c.dom.Element
import org.w3c.dom.Node
import java.io.File
import java.nio.file.Files
import java.util.concurrent.CancellationException

/**
 * Regression tests for AndroidLintXmlParser and AndroidDomPsiConverter covering:
 * - Offsets: tag name vs element range, attribute name vs value range
 * - Multi-line attribute values (start line and end line on different lines)
 * - Single quotes, UTF-16 emoji surrogate pairs, CRLF line counting, entities, CDATA
 * - Tolerance of incomplete XML (PSI error tolerance)
 * - Suppression-facing namespace structure: arbitrary tools prefix resolution via URI, ancestor traversal
 * - Location.Handle resolution and findNodeAt
 * - Fallback disk parsing for lint.xml
 * - CancellationException propagation
 */
class AndroidLintXmlParserTest {
    companion object {
        private var disposable: Disposable? = null
        private var environment: CoreProjectEnvironment? = null

        @BeforeClass
        @JvmStatic
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
                XmlExtension.EP_NAME,
                XmlExtension::class.java
            )
            application.addExtension(XmlExtension.EP_NAME, DefaultXmlExtension())
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

            application.registerApplicationService(
                ExternalResourceManager::class.java,
                CoreExternalResourceManager()
            )
            val env = CoreProjectEnvironment(disp, application)
            environment = env
            env.project.registerService(
                XmlElementFactory::class.java,
                XmlElementFactoryImpl(env.project)
            )
        }

        @AfterClass
        @JvmStatic
        fun tearDown() {
            disposable?.let { Disposer.dispose(it) }
        }

        private fun createXmlFile(name: String, content: String): XmlFile {
            val env = environment ?: error("Environment not initialized")
            val virtualFile = LightVirtualFile(name, XmlFileType.INSTANCE, content)
            SingleRootFileViewProvider.doNotCheckFileSizeLimit(virtualFile)
            val provider = SingleRootFileViewProvider(
                PsiManager.getInstance(env.project), virtualFile, false, XmlFileType.INSTANCE
            )
            return provider.getPsi(XMLLanguage.INSTANCE) as XmlFile
        }
    }

    @Test
    fun multiLineAttributeValueCalculatesAccurateEndLineAndOffset() {
        val xml = """
                <TextView
                    android:id="@+id/text"
                    android:text="First line
                Second line
                Third line" />
                """.trimIndent()
        val xmlFile = createXmlFile("multiline.xml", xml)
        assertNotNull("XmlFile should be parsed", xmlFile)

        val doc = AndroidDomPsiConverter.convert(xmlFile)
        assertNotNull("DOM Document should be converted", doc)

        val root = doc!!.documentElement
        assertNotNull(root)
        assertEquals("TextView", root!!.tagName)

        val textAttr = root.getAttributeNode("android:text")
        assertNotNull("android:text attribute should exist", textAttr)

        val parser = AndroidLintXmlParser(null)
        val dummyFile = File("multiline.xml")
        val client = TestLintClient(parser)
        val valueLocation = parser.getValueLocation(client, dummyFile, textAttr!!)

        assertNotNull(valueLocation.start)
        assertNotNull(valueLocation.end)

        val startOffset = valueLocation.start!!.offset
        val endOffset = valueLocation.end!!.offset
        assertTrue("Start offset must be less than end offset", startOffset < endOffset)

        // Verify quotes are stripped from value location
        assertEquals("First line\nSecond line\nThird line", xmlFile.text.substring(startOffset, endOffset))

        val startLine = valueLocation.start!!.line
        val endLine = valueLocation.end!!.line
        assertEquals(2, startLine)
        assertEquals(4, endLine)
        assertTrue("End line must be greater than start line for multi-line values", endLine > startLine)
    }

    @Test
    fun singleQuotedAttributeValueStripsQuotes() {
        val xml = "<Button android:text='Single Quoted Value' />"
        val xmlFile = createXmlFile("single_quote.xml", xml)
        val doc = AndroidDomPsiConverter.convert(xmlFile)
        assertNotNull(doc)

        val root = doc!!.documentElement
        assertNotNull(root)
        val attr = root!!.getAttributeNode("android:text")
        assertNotNull(attr)

        val parser = AndroidLintXmlParser(null)
        val client = TestLintClient(parser)
        val valueLocation = parser.getValueLocation(client, File("single_quote.xml"), attr!!)

        val start = valueLocation.start!!.offset
        val end = valueLocation.end!!.offset
        assertEquals("Single Quoted Value", xmlFile.text.substring(start, end))
    }

    @Test
    fun utf16SurrogatePairsAndEmojiPreservePreciseOffsets() {
        val xml = "<TextView android:text=\"Hello 😀 World\" />"
        val xmlFile = createXmlFile("emoji.xml", xml)
        val doc = AndroidDomPsiConverter.convert(xmlFile)
        assertNotNull(doc)

        val root = doc!!.documentElement
        assertNotNull(root)
        val attr = root!!.getAttributeNode("android:text")
        assertNotNull(attr)

        val parser = AndroidLintXmlParser(null)
        val client = TestLintClient(parser)
        val valueLocation = parser.getValueLocation(client, File("emoji.xml"), attr!!)

        val start = valueLocation.start!!.offset
        val end = valueLocation.end!!.offset
        assertEquals("Hello 😀 World", xmlFile.text.substring(start, end))
    }

    @Test
    fun crlfLineEndingsCountLinesCorrectly() {
        val xml = "<root>\r\n    <child\r\n        name=\"value\" />\r\n</root>"
        val xmlFile = createXmlFile("crlf.xml", xml)
        val doc = AndroidDomPsiConverter.convert(xmlFile)
        assertNotNull(doc)

        val root = doc!!.documentElement
        assertNotNull(root)
        val children = root!!.getElementsByTagName("child")
        assertEquals(1, children.length)

        val child = children.item(0) as Element
        val parser = AndroidLintXmlParser(null)
        val client = TestLintClient(parser)
        val nameLocation = parser.getNameLocation(client, File("crlf.xml"), child)

        // Line 1 is 0-indexed line 1 (second line)
        assertEquals(1, nameLocation.start!!.line)
    }

    @Test
    fun entitiesAndCDataPreserveRawOffsetsAndDecodedContent() {
        val xml = "<resources>\n" +
                "    <string name=\"ent\">Fish &amp; Chips</string>\n" +
                "    <string name=\"cd\"><![CDATA[Raw <Unescaped> Content]]></string>\n" +
                "</resources>"
        val xmlFile = createXmlFile("strings.xml", xml)
        val doc = AndroidDomPsiConverter.convert(xmlFile)
        assertNotNull(doc)

        val root = doc!!.documentElement
        assertNotNull(root)
        val strings = root!!.getElementsByTagName("string")
        assertEquals(2, strings.length)

        val entElement = strings.item(0) as Element
        assertEquals("Fish & Chips", entElement.textContent)

        val cdElement = strings.item(1) as Element
        assertEquals("Raw <Unescaped> Content", cdElement.textContent)

        val parser = AndroidLintXmlParser(null)
        val client = TestLintClient(parser)
        val nameLoc = parser.getNameLocation(client, File("strings.xml"), entElement)
        val start = nameLoc.start!!.offset
        val end = nameLoc.end!!.offset
        assertEquals("string", xmlFile.text.substring(start, end))
    }

    @Test
    fun incompleteXmlRecoversValidPsiNodes() {
        // XML with missing closing tags and unclosed TextView
        val xml = """
                <LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"
                    android:layout_width="match_parent">
                    <TextView
                        android:id="@+id/title"
                        android:text="Unfinished"
                """.trimIndent()
        val xmlFile = createXmlFile("incomplete.xml", xml)
        assertNotNull(xmlFile)

        val doc = AndroidDomPsiConverter.convert(xmlFile)
        assertNotNull("Incomplete XML should still produce recovered DOM Document", doc)

        val root = doc!!.documentElement
        assertNotNull("Root element should be recovered", root)
        assertEquals("LinearLayout", root!!.tagName)

        val textViews = root.getElementsByTagName("TextView")
        assertEquals(1, textViews.length)

        val textView = textViews.item(0) as Element
        assertEquals("TextView", textView.tagName)
        assertEquals("Unfinished", textView.getAttribute("android:text"))

        val textAttr = textView.getAttributeNode("android:text")
        assertNotNull(textAttr)

        val parser = AndroidLintXmlParser(null)
        val client = TestLintClient(parser)
        val valLoc = parser.getValueLocation(client, File("incomplete.xml"), textAttr!!)
        val start = valLoc.start!!.offset
        val end = valLoc.end!!.offset
        assertEquals("Unfinished", xmlFile.text.substring(start, end))
    }

    @Test
    fun suppressionNamespaceStructureAndAncestorTraversal() {
        val xml = """
                <FrameLayout xmlns:android="http://schemas.android.com/apk/res/android"
                    xmlns:t="http://schemas.android.com/tools"
                    t:ignore="HardcodedText,ContentDescription">
                    <LinearLayout
                        android:layout_width="match_parent"
                        android:layout_height="wrap_content">
                        <ImageView
                            android:id="@+id/avatar"
                            android:contentDescription="Avatar" />
                    </LinearLayout>
                </FrameLayout>
                """.trimIndent()
        val xmlFile = createXmlFile("suppression.xml", xml)
        val doc = AndroidDomPsiConverter.convert(xmlFile)
        assertNotNull(doc)

        val root = doc!!.documentElement
        assertNotNull(root)
        assertEquals("FrameLayout", root!!.tagName)

        // Verify tools namespace resolution by URI regardless of prefix
        val toolsUri = "http://schemas.android.com/tools"
        assertTrue("root should have t:ignore by URI", root.hasAttributeNS(toolsUri, "ignore"))
        assertEquals("HardcodedText,ContentDescription", root.getAttributeNS(toolsUri, "ignore"))

        val ignoreAttr = root.getAttributeNodeNS(toolsUri, "ignore")
        assertNotNull(ignoreAttr)
        assertEquals("t:ignore", ignoreAttr!!.name)
        assertEquals("ignore", ignoreAttr.localName)
        assertEquals("t", ignoreAttr.prefix)
        assertEquals(toolsUri, ignoreAttr.namespaceURI)

        // Traverse down to ImageView
        val images = root.getElementsByTagName("ImageView")
        assertEquals(1, images.length)
        val imageView = images.item(0) as Element

        // Verify ancestor traversal towards root can find suppression attribute on FrameLayout
        var current: Node? = imageView
        var foundSuppression: String? = null
        while (current != null) {
            if (current is Element && current.hasAttributeNS(toolsUri, "ignore")) {
                foundSuppression = current.getAttributeNS(toolsUri, "ignore")
                break
            }
            current = current.parentNode
        }
        assertEquals("HardcodedText,ContentDescription", foundSuppression)

        // Verify prefix lookups
        assertEquals("t", root.lookupPrefix(toolsUri))
        assertEquals(toolsUri, root.lookupNamespaceURI("t"))
    }

    @Test
    fun findNodeAtLocatesElementsAndAttributes() {
        val xml = "<LinearLayout><Button android:text=\"ClickMe\" /></LinearLayout>"
        val xmlFile = createXmlFile("findnode.xml", xml)
        val doc = AndroidDomPsiConverter.convert(xmlFile)
        assertNotNull(doc)

        val parser = AndroidLintXmlParser(null)

        // Find node inside "Button" tag
        val buttonOffset = xml.indexOf("Button") + 2
        val buttonNode = parser.findNodeAt(doc!!, buttonOffset)
        assertNotNull(buttonNode)
        assertTrue(buttonNode is Element)
        assertEquals("Button", buttonNode!!.nodeName)

        // Find node inside "ClickMe" attribute value
        val attrValOffset = xml.indexOf("ClickMe") + 3
        val attrNode = parser.findNodeAt(doc, attrValOffset)
        assertNotNull(attrNode)
        assertTrue(attrNode is Attr)
        assertEquals("android:text", attrNode!!.nodeName)
    }

    @Test
    fun locationHandleResolvesToExactSnapshot() {
        val xml = "<TextView android:text=\"Sample\" />"
        val xmlFile = createXmlFile("handle.xml", xml)
        val doc = AndroidDomPsiConverter.convert(xmlFile)
        assertNotNull(doc)

        val root = doc!!.documentElement
        assertNotNull(root)
        val attr = root!!.getAttributeNode("android:text")
        assertNotNull(attr)

        val parser = AndroidLintXmlParser(null)
        val file = File("handle.xml")

        val handle: Location.Handle = AndroidLintXmlParser.AndroidLocationHandle(parser, file, attr)
        val resolvedLoc = handle.resolve()

        val expectedStart = xml.indexOf("android:text")
        val expectedEnd = expectedStart + "android:text=\"Sample\"".length
        assertEquals(expectedStart, resolvedLoc.start!!.offset)
        assertEquals(expectedEnd, resolvedLoc.end!!.offset)
        assertEquals(file, resolvedLoc.file)
    }

    @Test
    fun noDomAcrossRequestsCaching() {
        val xml = "<root><item/></root>"
        val xmlFile1 = createXmlFile("cache1.xml", xml)
        val xmlFile2 = createXmlFile("cache2.xml", xml)
        val parser = AndroidLintXmlParser(null)
        val doc1 = parser.parsePsi(xmlFile1)
        val doc2 = parser.parsePsi(xmlFile2)
        assertNotNull(doc1)
        assertNotNull(doc2)
        assertNotSame("DOM documents must not be cached or shared across requests", doc1, doc2)
    }

    @Test
    fun positionXmlParserFallbackLocationAndOffsets() {
        val xml = "<lint><issue id=\"NewApi\" severity=\"ignore\"/></lint>"
        val parser = AndroidLintXmlParser(null)
        val file = File("lint.xml")
        val doc = parser.parseXml(xml, file)
        assertNotNull(doc)

        val issue = doc!!.getElementsByTagName("issue").item(0) as Element
        assertNotNull(issue)

        val client = TestLintClient(parser)
        val startOffset = parser.getNodeStartOffset(client, file, issue)
        val endOffset = parser.getNodeEndOffset(client, file, issue)
        assertEquals(xml.indexOf("<issue"), startOffset)
        assertEquals(xml.indexOf("/>") + 2, endOffset)

        val nameLoc = parser.getNameLocation(client, file, issue)
        assertEquals(xml.indexOf("issue"), nameLoc.start!!.offset)
        assertEquals(xml.indexOf("issue") + "issue".length, nameLoc.end!!.offset)

        val idAttr = issue.getAttributeNode("id")
        assertNotNull(idAttr)
        val valLoc = parser.getValueLocation(client, file, idAttr!!)
        assertEquals(xml.indexOf("NewApi"), valLoc.start!!.offset)
        assertEquals(xml.indexOf("NewApi") + "NewApi".length, valLoc.end!!.offset)

        val handle = AndroidLintXmlParser.AndroidLocationHandle(parser, file, issue)
        val resolved = handle.resolve()
        assertEquals(startOffset, resolved.start!!.offset)
        assertEquals(endOffset, resolved.end!!.offset)
    }

    @Test
    fun resourceItemPositionMethodsForValueAndFileResources() {
        val xml = "<resources><string name=\"app_title\">Sample Title</string></resources>"
        val valuesFile = File("src/main/res/values/strings.xml")
        val layoutFile = File("src/main/res/layout/main.xml")

        val parser = AndroidLintXmlParser(null)
        val client = object : TestLintClient(parser) {
            override fun readFile(file: File): CharSequence {
                return xml
            }

            override fun getXmlDocument(file: File, contents: CharSequence?): Document? {
                return parser.parseXml(contents ?: readFile(file), file)
            }
        }

        // 1. Value-based resource item
        val valueItem: ResourceItem = AndroidLintResources.LintResourceItem(
            "app_title", ResourceType.STRING, ResourceNamespace.RES_AUTO, null,
            FolderConfiguration.createDefault(), null, PathString(valuesFile), false, true
        )

        val wholeLoc = parser.getLocation(client, valueItem)
        assertNotNull("ResourceItem location should be found", wholeLoc)
        assertEquals(xml.indexOf("<string"), wholeLoc!!.start!!.offset)
        assertEquals(xml.indexOf("</string>") + "</string>".length, wholeLoc.end!!.offset)

        val nameLoc = parser.getNameLocation(client, valueItem)
        assertNotNull("ResourceItem name location should be found", nameLoc)
        assertEquals(xml.indexOf("name"), nameLoc!!.start!!.offset)
        assertEquals(xml.indexOf("name") + "name".length, nameLoc.end!!.offset)

        val valLoc = parser.getValueLocation(client, valueItem)
        assertNotNull("ResourceItem value location should be found", valLoc)
        assertEquals(xml.indexOf("Sample Title"), valLoc!!.start!!.offset)
        assertEquals(xml.indexOf("Sample Title") + "Sample Title".length, valLoc.end!!.offset)

        // 2. File-based resource item
        val fileItem: ResourceItem = AndroidLintResources.LintResourceItem(
            "main", ResourceType.LAYOUT, ResourceNamespace.RES_AUTO, null,
            FolderConfiguration.createDefault(), null, PathString(layoutFile), true, true
        )

        val layoutLoc = parser.getLocation(client, fileItem)
        assertNotNull(layoutLoc)
        assertEquals(layoutFile, layoutLoc!!.file)
    }

    @Test(expected = AndroidQueryException::class)
    fun androidQueryExceptionPropagatesWithoutBeingSwallowed() {
        val client = object : TestLintClient(null) {
            override fun readFile(file: File): CharSequence {
                throw AndroidQueryException("model_unavailable", -32803)
            }
        }
        val parser = AndroidLintXmlParser(client)
        parser.parseXml(File("test.xml"))
    }

    @Test
    fun nodeUserDataIsolatedAndSupportsRemovalAndAttachment() {
        val xml = "<manifest package=\"com.example.app\"><application/></manifest>"
        val xmlFile1 = createXmlFile("manifest1.xml", xml)
        val xmlFile2 = createXmlFile("manifest2.xml", xml)
        val doc1 = AndroidDomPsiConverter.convert(xmlFile1)
        val doc2 = AndroidDomPsiConverter.convert(xmlFile2)
        assertNotNull(doc1)
        assertNotNull(doc2)

        val root1 = doc1!!.documentElement
        val root2 = doc2!!.documentElement
        assertNotNull(root1)
        assertNotNull(root2)

        // 1. Initial setUserData returns null
        val old = root1!!.setUserData("test_key", "value_1", null)
        assertNull(old)
        assertEquals("value_1", root1.getUserData("test_key"))

        // 2. Overwriting setUserData returns previous value
        val previous = root1.setUserData("test_key", "value_2", null)
        assertEquals("value_1", previous)
        assertEquals("value_2", root1.getUserData("test_key"))

        // 3. Removing by setting null returns previous value
        val removed = root1.setUserData("test_key", null, null)
        assertEquals("value_2", removed)
        assertNull(root1.getUserData("test_key"))

        // 4. Isolation across documents
        root1.setUserData("isolated_key", "unique_to_1", null)
        assertNull("doc2 root must not have isolated_key from doc1 root", root2!!.getUserData("isolated_key"))

        // 5. Document-level metadata attachment
        val customFile = File("custom/path/AndroidManifest.xml")
        doc1.setUserData(File::class.java.name, customFile, null)
        assertEquals(customFile, doc1.getUserData(File::class.java.name))

        doc1.setUserData(PositionXmlParser.CONTENT_KEY, "custom contents", null)
        assertEquals("custom contents", doc1.getUserData(PositionXmlParser.CONTENT_KEY))
    }

    @Test
    fun namespaceFreePsiElementsKeepOfficialManifestNodeKeys() {
        val source = createXmlFile(
            "AndroidManifest.xml",
            "<manifest xmlns:android=\"http://schemas.android.com/apk/res/android\">"
                    + "<application android:label=\"Label\" /></manifest>"
        )
        val dom = AndroidDomPsiConverter.convert(source)
        val app = dom!!.getElementsByTagName("application").item(0) as Element
        assertNull(app.namespaceURI)
        assertNull(app.prefix)
        assertEquals("application", XmlNode.NodeKey.fromXml(app, ManifestModel()).toString())
    }

    @Test
    fun unmappedMergedNodesDoNotBorrowSourceOffsets() {
        val directory = Files.createTempDirectory("unmapped-manifest")
        try {
            val merged = PositionXmlParser.parse(
                "<manifest xmlns:android=\"http://schemas.android.com/apk/res/android\">"
                        + "<application android:label=\"Merged label\" /></manifest>"
            )
            merged.setUserData(LintClient.MERGED_MANIFEST, directory.resolve("missing-blame.txt").toFile(), null)
            val attr = (merged.getElementsByTagName("application").item(0) as Element)
                .getAttributeNodeNS("http://schemas.android.com/apk/res/android", "label")
            val client = TestLintClient(null)
            val parser = AndroidLintXmlParser(client)
            val source = File("source/manifest.xml")
            assertSame(Location.NONE, parser.getLocation(source, attr))
            assertSame(Location.NONE, parser.getNameLocation(client, source, attr))
            assertSame(Location.NONE, parser.getValueLocation(client, source, attr))
            assertEquals(-1, parser.getNodeStartOffset(client, source, attr))
            assertEquals(-1, parser.getNodeEndOffset(client, source, attr))
        } finally {
            Files.delete(directory)
        }
    }

    private open class TestLintClient(
        private val parser: XmlParser?
    ) : LintClient(CLIENT_UNIT_TESTS) {

        override val xmlParser: XmlParser
            get() = parser ?: throw AssertionError("Unexpected XML parser access")

        override fun readFile(file: File): CharSequence = ""

        override fun getUastParser(project: com.android.tools.lint.detector.api.Project?): UastParser {
            throw AssertionError()
        }

        override fun getGradleVisitor(): GradleVisitor = GradleVisitor()

        override fun getResources(
            project: com.android.tools.lint.detector.api.Project,
            scope: com.android.tools.lint.client.api.ResourceRepositoryScope
        ): com.android.ide.common.resources.ResourceRepository {
            throw AssertionError()
        }

        override fun report(context: Context, incident: Incident, format: TextFormat) {}

        override fun log(severity: Severity, exception: Throwable?, format: String?, vararg args: Any) {}
    }
}
