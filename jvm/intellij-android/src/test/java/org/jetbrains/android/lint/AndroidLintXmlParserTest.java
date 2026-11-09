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
package org.jetbrains.android.lint;

import com.android.tools.lint.client.api.LintClient;
import com.android.tools.lint.detector.api.Context;
import com.android.tools.lint.detector.api.Incident;
import com.android.tools.lint.detector.api.Location;
import com.android.tools.lint.detector.api.Severity;
import com.android.tools.lint.detector.api.TextFormat;
import com.android.utils.PositionXmlParser;
import com.intellij.core.CoreApplicationEnvironment;
import com.intellij.core.CoreProjectEnvironment;
import com.intellij.ide.highlighter.XmlFileType;
import com.intellij.javaee.CoreExternalResourceManager;
import com.intellij.javaee.ExternalResourceManager;
import com.intellij.javaee.ImplicitNamespaceDescriptorProvider;
import com.intellij.psi.XmlElementFactory;
import com.intellij.psi.XmlElementFactoryImpl;
import com.intellij.psi.impl.source.xml.XmlElementDescriptorProvider;
import com.intellij.psi.xml.StartTagEndTokenProvider;
import com.intellij.psi.xml.XmlFileNSInfoProvider;
import com.intellij.xml.DefaultXmlExtension;
import com.intellij.xml.XmlAttributeDescriptorsProvider;
import com.intellij.xml.XmlExtension;
import com.intellij.xml.XmlSchemaProvider;
import com.intellij.xml.util.XmlIdContributor;
import com.intellij.lang.xml.XMLLanguage;
import com.intellij.lang.xml.XMLParserDefinition;
import com.intellij.openapi.Disposable;
import com.intellij.openapi.progress.ProgressManager;
import com.intellij.openapi.util.Disposer;
import com.intellij.psi.PsiManager;
import com.intellij.psi.SingleRootFileViewProvider;
import com.intellij.psi.xml.XmlFile;
import com.intellij.testFramework.LightVirtualFile;
import com.android.ide.common.rendering.api.ResourceNamespace;
import com.android.ide.common.resources.ResourceItem;
import com.android.ide.common.resources.configuration.FolderConfiguration;
import com.android.ide.common.util.PathString;
import com.android.resources.ResourceType;
import com.android.tools.lint.client.api.GradleVisitor;
import com.android.tools.lint.client.api.UastParser;
import com.android.tools.lint.client.api.XmlParser;
import org.jetbrains.android.context.AndroidQueryException;
import org.junit.AfterClass;
import org.junit.BeforeClass;
import org.junit.Test;
import org.w3c.dom.Attr;
import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.Node;
import org.w3c.dom.NodeList;

import java.io.File;
import java.util.concurrent.CancellationException;

import static org.junit.Assert.*;

/**
 * Regression tests for AndroidLintXmlParser and AndroidDomPsiConverter covering:
 * - Offsets: tag name vs element range, attribute name vs value range
 * - Multi-line attribute values (start line and end line on different lines)
 * - Single quotes, UTF-16 emoji surrogate pairs, CRLF line counting, entities, CDATA
 * - Incomplete XML recovery: unclosed tags producing valid navigable DOM elements
 * - Suppression-facing namespace structure: arbitrary tools prefix resolution via URI, ancestor traversal
 * - Location.Handle resolution and findNodeAt
 * - Fallback disk parsing for lint.xml
 * - CancellationException propagation
 */
public class AndroidLintXmlParserTest {
    private static Disposable disposable;
    private static CoreProjectEnvironment environment;

    @BeforeClass
    public static void setUp() {
        LintClient.setClientName(LintClient.CLIENT_UNIT_TESTS);
        disposable = Disposer.newDisposable();
        CoreApplicationEnvironment application = new CoreApplicationEnvironment(disposable);
        application.registerFileType(XmlFileType.INSTANCE, "xml");
        application.registerParserDefinition(new XMLParserDefinition());
        application.registerApplicationService(
                com.intellij.platform.syntax.psi.PsiSyntaxBuilderFactory.class,
                new com.intellij.platform.syntax.psi.PsiSyntaxBuilderFactoryImpl());
        CoreApplicationEnvironment.registerApplicationExtensionPoint(
                com.intellij.openapi.extensions.ExtensionPointName.create("com.intellij.metaLanguage"),
                com.intellij.lang.MetaLanguage.class);
        application.addExplicitExtension(com.intellij.platform.syntax.psi.ElementTypeConverters.getInstance(),
                XMLLanguage.INSTANCE, new com.intellij.psi.xml.XmlElementTypeConverterExtension());
        application.addExplicitExtension(com.intellij.platform.syntax.psi.LanguageSyntaxDefinitions.getINSTANCE(),
                XMLLanguage.INSTANCE, new com.intellij.lang.xml.XmlSyntaxDefinitionExtension());
        application.addExplicitExtension(com.intellij.lang.LanguageASTFactory.INSTANCE,
                XMLLanguage.INSTANCE, new com.intellij.lang.xml.XmlASTFactory());

        CoreApplicationEnvironment.registerApplicationExtensionPoint(
                XmlExtension.EP_NAME,
                XmlExtension.class);
        application.addExtension(XmlExtension.EP_NAME, new DefaultXmlExtension());
        CoreApplicationEnvironment.registerApplicationExtensionPoint(
                XmlFileNSInfoProvider.EP_NAME,
                XmlFileNSInfoProvider.class);
        CoreApplicationEnvironment.registerApplicationExtensionPoint(
                XmlElementDescriptorProvider.EP_NAME,
                XmlElementDescriptorProvider.class);
        CoreApplicationEnvironment.registerApplicationExtensionPoint(
                XmlAttributeDescriptorsProvider.EP_NAME,
                XmlAttributeDescriptorsProvider.class);
        CoreApplicationEnvironment.registerApplicationExtensionPoint(
                XmlSchemaProvider.EP_NAME,
                XmlSchemaProvider.class);
        CoreApplicationEnvironment.registerApplicationExtensionPoint(
                ImplicitNamespaceDescriptorProvider.EP_NAME,
                ImplicitNamespaceDescriptorProvider.class);
        CoreApplicationEnvironment.registerApplicationExtensionPoint(
                StartTagEndTokenProvider.EP_NAME,
                StartTagEndTokenProvider.class);
        CoreApplicationEnvironment.registerApplicationExtensionPoint(
                XmlIdContributor.EP_NAME,
                XmlIdContributor.class);

        application.registerApplicationService(
                ExternalResourceManager.class,
                new CoreExternalResourceManager());
        environment = new CoreProjectEnvironment(disposable, application);
        environment.getProject().registerService(
                XmlElementFactory.class,
                new XmlElementFactoryImpl(environment.getProject()));
    }

    @AfterClass
    public static void tearDown() {
        Disposer.dispose(disposable);
    }

    private static XmlFile createXmlFile(String name, String content) {
        LightVirtualFile virtualFile = new LightVirtualFile(name, XmlFileType.INSTANCE, content);
        SingleRootFileViewProvider.doNotCheckFileSizeLimit(virtualFile);
        SingleRootFileViewProvider provider = new SingleRootFileViewProvider(
                PsiManager.getInstance(environment.getProject()), virtualFile, false, XmlFileType.INSTANCE);
        return (XmlFile) provider.getPsi(XMLLanguage.INSTANCE);
    }

    @Test
    public void multiLineAttributeValueCalculatesAccurateEndLineAndOffset() {
        String xml = """
                <TextView
                    android:id="@+id/text"
                    android:text="First line
                Second line
                Third line" />
                """;
        XmlFile xmlFile = createXmlFile("multiline.xml", xml);
        assertNotNull("XmlFile should be parsed", xmlFile);

        Document doc = AndroidDomPsiConverter.convert(xmlFile);
        assertNotNull("DOM Document should be converted", doc);

        Element root = doc.getDocumentElement();
        assertEquals("TextView", root.getTagName());

        Attr textAttr = root.getAttributeNode("android:text");
        assertNotNull("android:text attribute should exist", textAttr);

        AndroidLintXmlParser parser = new AndroidLintXmlParser(null);
        File dummyFile = new File("multiline.xml");
        Location valueLocation = parser.getValueLocation(null, dummyFile, textAttr);

        assertNotNull(valueLocation.getStart());
        assertNotNull(valueLocation.getEnd());

        int startOffset = valueLocation.getStart().getOffset();
        int endOffset = valueLocation.getEnd().getOffset();
        assertTrue("Start offset must be less than end offset", startOffset < endOffset);

        // Verify quotes are stripped from value location
        assertEquals("First line\nSecond line\nThird line", xmlFile.getText().substring(startOffset, endOffset));

        int startLine = valueLocation.getStart().getLine();
        int endLine = valueLocation.getEnd().getLine();
        assertEquals(2, startLine);
        assertEquals(4, endLine);
        assertTrue("End line must be greater than start line for multi-line values", endLine > startLine);
    }

    @Test
    public void singleQuotedAttributeValueStripsQuotes() {
        String xml = "<Button android:text='Single Quoted Value' />";
        XmlFile xmlFile = createXmlFile("single_quote.xml", xml);
        Document doc = AndroidDomPsiConverter.convert(xmlFile);
        assertNotNull(doc);

        Element root = doc.getDocumentElement();
        Attr attr = root.getAttributeNode("android:text");
        assertNotNull(attr);

        AndroidLintXmlParser parser = new AndroidLintXmlParser(null);
        Location valueLocation = parser.getValueLocation(null, new File("single_quote.xml"), attr);

        int start = valueLocation.getStart().getOffset();
        int end = valueLocation.getEnd().getOffset();
        assertEquals("Single Quoted Value", xmlFile.getText().substring(start, end));
    }

    @Test
    public void utf16SurrogatePairsAndEmojiPreservePreciseOffsets() {
        String xml = "<TextView android:text=\"Hello 😀 World\" />";
        XmlFile xmlFile = createXmlFile("emoji.xml", xml);
        Document doc = AndroidDomPsiConverter.convert(xmlFile);
        assertNotNull(doc);

        Element root = doc.getDocumentElement();
        Attr attr = root.getAttributeNode("android:text");
        assertNotNull(attr);

        AndroidLintXmlParser parser = new AndroidLintXmlParser(null);
        Location valueLocation = parser.getValueLocation(null, new File("emoji.xml"), attr);

        int start = valueLocation.getStart().getOffset();
        int end = valueLocation.getEnd().getOffset();
        assertEquals("Hello 😀 World", xmlFile.getText().substring(start, end));

        // Emoji 😀 is 2 UTF-16 code units (surrogate pair)
        assertEquals(2, "😀".length());
    }

    @Test
    public void crlfLineEndingsCountLinesCorrectly() {
        String xml = "<root>\r\n    <child\r\n        name=\"value\" />\r\n</root>";
        XmlFile xmlFile = createXmlFile("crlf.xml", xml);
        Document doc = AndroidDomPsiConverter.convert(xmlFile);
        assertNotNull(doc);

        Element root = doc.getDocumentElement();
        NodeList children = root.getElementsByTagName("child");
        assertEquals(1, children.getLength());

        Element child = (Element) children.item(0);
        AndroidLintXmlParser parser = new AndroidLintXmlParser(null);
        Location nameLocation = parser.getNameLocation(null, new File("crlf.xml"), child);

        // Line 1 is 0-indexed line 1 (second line)
        assertEquals(1, nameLocation.getStart().getLine());
    }

    @Test
    public void entitiesAndCDataPreserveRawOffsetsAndDecodedContent() {
        String xml = "<resources>\n" +
                "    <string name=\"ent\">Fish &amp; Chips</string>\n" +
                "    <string name=\"cd\"><![CDATA[Raw <Unescaped> Content]]></string>\n" +
                "</resources>";
        XmlFile xmlFile = createXmlFile("strings.xml", xml);
        Document doc = AndroidDomPsiConverter.convert(xmlFile);
        assertNotNull(doc);

        Element root = doc.getDocumentElement();
        NodeList strings = root.getElementsByTagName("string");
        assertEquals(2, strings.getLength());

        Element entElement = (Element) strings.item(0);
        assertEquals("Fish & Chips", entElement.getTextContent());

        Element cdElement = (Element) strings.item(1);
        assertEquals("Raw <Unescaped> Content", cdElement.getTextContent());

        AndroidLintXmlParser parser = new AndroidLintXmlParser(null);
        Location nameLoc = parser.getNameLocation(null, new File("strings.xml"), entElement);
        int start = nameLoc.getStart().getOffset();
        int end = nameLoc.getEnd().getOffset();
        assertEquals("string", xmlFile.getText().substring(start, end));
        assertEquals("string", xml.substring(start, end));
    }

    @Test
    public void incompleteXmlRecoversValidPsiNodes() {
        // XML with missing closing tags and unclosed TextView
        String xml = """
                <LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"
                    android:layout_width="match_parent">
                    <TextView
                        android:id="@+id/title"
                        android:text="Unfinished"
                """;
        XmlFile xmlFile = createXmlFile("incomplete.xml", xml);
        assertNotNull(xmlFile);

        Document doc = AndroidDomPsiConverter.convert(xmlFile);
        assertNotNull("Incomplete XML should still produce recovered DOM Document", doc);

        Element root = doc.getDocumentElement();
        assertNotNull("Root element should be recovered", root);
        assertEquals("LinearLayout", root.getTagName());

        NodeList textViews = root.getElementsByTagName("TextView");
        assertEquals(1, textViews.getLength());

        Element textView = (Element) textViews.item(0);
        assertEquals("TextView", textView.getTagName());
        assertEquals("Unfinished", textView.getAttribute("android:text"));

        Attr textAttr = textView.getAttributeNode("android:text");
        assertNotNull(textAttr);

        AndroidLintXmlParser parser = new AndroidLintXmlParser(null);
        Location valLoc = parser.getValueLocation(null, new File("incomplete.xml"), textAttr);
        int start = valLoc.getStart().getOffset();
        int end = valLoc.getEnd().getOffset();
        assertEquals("Unfinished", xmlFile.getText().substring(start, end));
        assertEquals("Unfinished", xml.substring(start, end));
    }

    @Test
    public void suppressionNamespaceStructureAndAncestorTraversal() {
        String xml = """
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
                """;
        XmlFile xmlFile = createXmlFile("suppression.xml", xml);
        Document doc = AndroidDomPsiConverter.convert(xmlFile);
        assertNotNull(doc);

        Element root = doc.getDocumentElement();
        assertEquals("FrameLayout", root.getTagName());

        // Verify tools namespace resolution by URI regardless of prefix
        String toolsUri = "http://schemas.android.com/tools";
        assertTrue("root should have t:ignore by URI", root.hasAttributeNS(toolsUri, "ignore"));
        assertEquals("HardcodedText,ContentDescription", root.getAttributeNS(toolsUri, "ignore"));

        Attr ignoreAttr = root.getAttributeNodeNS(toolsUri, "ignore");
        assertNotNull(ignoreAttr);
        assertEquals("t:ignore", ignoreAttr.getName());
        assertEquals("ignore", ignoreAttr.getLocalName());
        assertEquals("t", ignoreAttr.getPrefix());
        assertEquals(toolsUri, ignoreAttr.getNamespaceURI());

        // Traverse down to ImageView
        NodeList images = root.getElementsByTagName("ImageView");
        assertEquals(1, images.getLength());
        Element imageView = (Element) images.item(0);

        // Verify ancestor traversal towards root can find suppression attribute on FrameLayout
        Node current = imageView;
        String foundSuppression = null;
        while (current != null) {
            if (current instanceof Element el && el.hasAttributeNS(toolsUri, "ignore")) {
                foundSuppression = el.getAttributeNS(toolsUri, "ignore");
                break;
            }
            current = current.getParentNode();
        }
        assertEquals("HardcodedText,ContentDescription", foundSuppression);

        // Verify prefix lookups
        assertEquals("t", root.lookupPrefix(toolsUri));
        assertEquals(toolsUri, root.lookupNamespaceURI("t"));
    }

    @Test
    public void findNodeAtLocatesElementsAttributesAndText() {
        String xml = "<LinearLayout><Button android:text=\"ClickMe\" /></LinearLayout>";
        XmlFile xmlFile = createXmlFile("findnode.xml", xml);
        Document doc = AndroidDomPsiConverter.convert(xmlFile);
        assertNotNull(doc);

        AndroidLintXmlParser parser = new AndroidLintXmlParser(null);

        // Find node inside "Button" tag
        int buttonOffset = xml.indexOf("Button") + 2;
        Node buttonNode = parser.findNodeAt(doc, buttonOffset);
        assertNotNull(buttonNode);
        assertTrue(buttonNode instanceof Element);
        assertEquals("Button", buttonNode.getNodeName());

        // Find node inside "ClickMe" attribute value
        int attrValOffset = xml.indexOf("ClickMe") + 3;
        Node attrNode = parser.findNodeAt(doc, attrValOffset);
        assertNotNull(attrNode);
        assertTrue(attrNode instanceof Attr);
        assertEquals("android:text", attrNode.getNodeName());
    }

    @Test
    public void locationHandleResolvesToExactSnapshot() {
        String xml = "<TextView android:text=\"Sample\" />";
        XmlFile xmlFile = createXmlFile("handle.xml", xml);
        Document doc = AndroidDomPsiConverter.convert(xmlFile);
        assertNotNull(doc);

        Element root = doc.getDocumentElement();
        Attr attr = root.getAttributeNode("android:text");
        assertNotNull(attr);

        AndroidLintXmlParser parser = new AndroidLintXmlParser(null);
        File file = new File("handle.xml");

        Location.Handle handle = new AndroidLintXmlParser.AndroidLocationHandle(parser, file, attr);
        Location resolvedLoc = handle.resolve();

        int expectedStart = xml.indexOf("android:text");
        int expectedEnd = expectedStart + "android:text=\"Sample\"".length();
        assertEquals(expectedStart, resolvedLoc.getStart().getOffset());
        assertEquals(expectedEnd, resolvedLoc.getEnd().getOffset());
        assertEquals(file, resolvedLoc.getFile());
    }

    @Test
    public void lintXmlDiskParsingFallbackSupported() {
        String lintXml = "<lint><issue id=\"NewApi\" severity=\"ignore\"/></lint>";
        AndroidLintXmlParser parser = new AndroidLintXmlParser(null);
        File lintFile = new File("lint.xml");

        Document doc = parser.parseXml(lintXml, lintFile);
        assertNotNull("lint.xml should be parsed by fallback parser", doc);

        Element root = doc.getDocumentElement();
        assertEquals("lint", root.getTagName());

        NodeList issues = doc.getElementsByTagName("issue");
        assertEquals(1, issues.getLength());

        Element issue = (Element) issues.item(0);
        assertEquals("NewApi", issue.getAttribute("id"));
        assertEquals("ignore", issue.getAttribute("severity"));

        Location loc = parser.getLocation(lintFile, issue);
        assertNotNull(loc.getStart());
        assertEquals(lintXml.indexOf("<issue"), loc.getStart().getOffset());
    }

    @Test
    public void cancellationPropagatesWithoutBeingSwallowed() {
        AndroidLintXmlParser parser = new AndroidLintXmlParser(null);
        try {
            ProgressManager.getInstance().executeNonCancelableSection(() -> {
                throw new CancellationException("Simulated cancel");
            });
        } catch (CancellationException e) {
            assertEquals("Simulated cancel", e.getMessage());
        }
    }

    @Test
    public void noDomAcrossRequestsCaching() {
        String xml = "<root><item/></root>";
        XmlFile xmlFile1 = createXmlFile("cache1.xml", xml);
        XmlFile xmlFile2 = createXmlFile("cache2.xml", xml);
        AndroidLintXmlParser parser = new AndroidLintXmlParser(null);
        Document doc1 = parser.parsePsi(xmlFile1);
        Document doc2 = parser.parsePsi(xmlFile2);
        assertNotNull(doc1);
        assertNotNull(doc2);
        assertNotSame("DOM documents must not be cached or shared across requests", doc1, doc2);
    }

    @Test
    public void positionXmlParserFallbackLocationAndOffsets() {
        String xml = "<lint><issue id=\"NewApi\" severity=\"ignore\"/></lint>";
        AndroidLintXmlParser parser = new AndroidLintXmlParser(null);
        File file = new File("lint.xml");
        Document doc = parser.parseXml(xml, file);
        assertNotNull(doc);

        Element issue = (Element) doc.getElementsByTagName("issue").item(0);
        assertNotNull(issue);

        int startOffset = parser.getNodeStartOffset(null, file, issue);
        int endOffset = parser.getNodeEndOffset(null, file, issue);
        assertEquals(xml.indexOf("<issue"), startOffset);
        assertEquals(xml.indexOf("/>") + 2, endOffset);

        assertEquals(-1, parser.getNodeStartOffset(null, file, null));
        assertEquals(-1, parser.getNodeEndOffset(null, file, null));

        Location nameLoc = parser.getNameLocation(null, file, issue);
        assertEquals(xml.indexOf("issue"), nameLoc.getStart().getOffset());
        assertEquals(xml.indexOf("issue") + "issue".length(), nameLoc.getEnd().getOffset());

        Attr idAttr = issue.getAttributeNode("id");
        Location valLoc = parser.getValueLocation(null, file, idAttr);
        assertEquals(xml.indexOf("NewApi"), valLoc.getStart().getOffset());
        assertEquals(xml.indexOf("NewApi") + "NewApi".length(), valLoc.getEnd().getOffset());

        Location.Handle handle = parser.createLocationHandle(null, issue);
        Location resolved = handle.resolve();
        assertEquals(startOffset, resolved.getStart().getOffset());
        assertEquals(endOffset, resolved.getEnd().getOffset());
    }

    @Test
    public void resourceItemPositionMethodsForValueAndFileResources() {
        String xml = "<resources><string name=\"app_title\">Sample Title</string></resources>";
        File valuesFile = new File("src/main/res/values/strings.xml");
        File layoutFile = new File("src/main/res/layout/main.xml");

        AndroidLintXmlParser parser = new AndroidLintXmlParser(null);
        LintClient client = new TestLintClient(parser) {
            @Override
            public CharSequence readFile(File file) {
                return xml;
            }

            @Override
            public Document getXmlDocument(File file, CharSequence contents) {
                return parser.parseXml(contents != null ? contents : readFile(file), file);
            }
        };

        // 1. Value-based resource item
        ResourceItem valueItem = new AndroidLintResources.LintResourceItem(
                "app_title", ResourceType.STRING, ResourceNamespace.RES_AUTO, null,
                FolderConfiguration.createDefault(), null, new PathString(valuesFile), false, true);

        Location wholeLoc = parser.getLocation(client, valueItem);
        assertNotNull("ResourceItem location should be found", wholeLoc);
        assertEquals(xml.indexOf("<string"), wholeLoc.getStart().getOffset());
        assertEquals(xml.indexOf("</string>") + "</string>".length(), wholeLoc.getEnd().getOffset());

        Location nameLoc = parser.getNameLocation(client, valueItem);
        assertNotNull("ResourceItem name location should be found", nameLoc);
        assertEquals(xml.indexOf("name"), nameLoc.getStart().getOffset());
        assertEquals(xml.indexOf("name") + "name".length(), nameLoc.getEnd().getOffset());

        Location valLoc = parser.getValueLocation(client, valueItem);
        assertNotNull("ResourceItem value location should be found", valLoc);
        assertEquals(xml.indexOf("Sample Title"), valLoc.getStart().getOffset());
        assertEquals(xml.indexOf("Sample Title") + "Sample Title".length(), valLoc.getEnd().getOffset());

        // 2. File-based resource item
        ResourceItem fileItem = new AndroidLintResources.LintResourceItem(
                "main", ResourceType.LAYOUT, ResourceNamespace.RES_AUTO, null,
                FolderConfiguration.createDefault(), null, new PathString(layoutFile), true, true);

        Location layoutLoc = parser.getLocation(client, fileItem);
        assertNotNull(layoutLoc);
        assertEquals(layoutFile, layoutLoc.getFile());
    }

    @Test(expected = AndroidQueryException.class)
    public void androidQueryExceptionPropagatesWithoutBeingSwallowed() {
        LintClient client = new TestLintClient(null) {
            @Override
            public CharSequence readFile(File file) {
                throw new AndroidQueryException("model_unavailable", -32803);
            }
        };
        AndroidLintXmlParser parser = new AndroidLintXmlParser(client);
        parser.parseXml(new File("test.xml"));
    }

    @Test
    public void nodeUserDataIsolatedAndSupportsRemovalAndAttachment() {
        String xml = "<manifest package=\"com.example.app\"><application/></manifest>";
        XmlFile xmlFile1 = createXmlFile("manifest1.xml", xml);
        XmlFile xmlFile2 = createXmlFile("manifest2.xml", xml);
        Document doc1 = AndroidDomPsiConverter.convert(xmlFile1);
        Document doc2 = AndroidDomPsiConverter.convert(xmlFile2);
        assertNotNull(doc1);
        assertNotNull(doc2);

        Element root1 = doc1.getDocumentElement();
        Element root2 = doc2.getDocumentElement();
        assertNotNull(root1);
        assertNotNull(root2);

        // 1. Initial setUserData returns null
        Object old = root1.setUserData("test_key", "value_1", null);
        assertNull(old);
        assertEquals("value_1", root1.getUserData("test_key"));

        // 2. Overwriting setUserData returns previous value
        Object previous = root1.setUserData("test_key", "value_2", null);
        assertEquals("value_1", previous);
        assertEquals("value_2", root1.getUserData("test_key"));

        // 3. Removing by setting null returns previous value
        Object removed = root1.setUserData("test_key", null, null);
        assertEquals("value_2", removed);
        assertNull(root1.getUserData("test_key"));

        // 4. Isolation across documents
        root1.setUserData("isolated_key", "unique_to_1", null);
        assertNull("doc2 root must not have isolated_key from doc1 root", root2.getUserData("isolated_key"));

        // 5. Document-level metadata attachment
        File customFile = new File("custom/path/AndroidManifest.xml");
        doc1.setUserData(File.class.getName(), customFile, null);
        assertEquals(customFile, doc1.getUserData(File.class.getName()));

        doc1.setUserData(PositionXmlParser.CONTENT_KEY, "custom contents", null);
        assertEquals("custom contents", doc1.getUserData(PositionXmlParser.CONTENT_KEY));
    }

    @Test
    public void namespaceFreePsiElementsKeepOfficialManifestNodeKeys() {
        XmlFile source = createXmlFile("AndroidManifest.xml",
                "<manifest xmlns:android=\"http://schemas.android.com/apk/res/android\">"
                        + "<application android:label=\"Label\" /></manifest>");
        Document dom = AndroidDomPsiConverter.convert(source);
        Element app = (Element) dom.getElementsByTagName("application").item(0);
        assertNull(app.getNamespaceURI());
        assertNull(app.getPrefix());
        assertEquals("application", com.android.manifmerger.XmlNode.NodeKey.fromXml(
                app, new com.android.manifmerger.ManifestModel()).toString());
    }

    @Test
    public void unmappedMergedNodesDoNotBorrowSourceOffsets() throws Exception {
        var directory = java.nio.file.Files.createTempDirectory("unmapped-manifest");
        try {
            Document merged = PositionXmlParser.parse(
                    "<manifest xmlns:android=\"http://schemas.android.com/apk/res/android\">"
                            + "<application android:label=\"Merged label\" /></manifest>");
            merged.setUserData(LintClient.MERGED_MANIFEST, directory.resolve("missing-blame.txt").toFile(), null);
            Attr attr = ((Element) merged.getElementsByTagName("application").item(0))
                    .getAttributeNodeNS("http://schemas.android.com/apk/res/android", "label");
            TestLintClient client = new TestLintClient(null);
            AndroidLintXmlParser parser = new AndroidLintXmlParser(client);
            File source = new File("source/manifest.xml");
            assertSame(Location.NONE, parser.getLocation(source, attr));
            assertSame(Location.NONE, parser.getNameLocation(client, source, attr));
            assertSame(Location.NONE, parser.getValueLocation(client, source, attr));
            assertEquals(-1, parser.getNodeStartOffset(client, source, attr));
            assertEquals(-1, parser.getNodeEndOffset(client, source, attr));
        } finally {
            java.nio.file.Files.delete(directory);
        }
    }

    private static class TestLintClient extends LintClient {
        private final XmlParser parser;

        TestLintClient(XmlParser parser) {
            super(CLIENT_UNIT_TESTS);
            this.parser = parser;
        }

        @Override
        public XmlParser getXmlParser() {
            return parser;
        }

        @Override
        public CharSequence readFile(File file) {
            return "";
        }

        @Override
        public UastParser getUastParser(com.android.tools.lint.detector.api.Project project) {
            throw new AssertionError();
        }

        @Override
        public GradleVisitor getGradleVisitor() {
            return new GradleVisitor();
        }

        @Override
        public com.android.ide.common.resources.ResourceRepository getResources(
                com.android.tools.lint.detector.api.Project project,
                com.android.tools.lint.client.api.ResourceRepositoryScope scope) {
            throw new AssertionError();
        }

        @Override
        public void report(Context context, Incident incident, TextFormat format) {
        }

        @Override
        public void log(Severity severity, Throwable error, String format, Object... args) {
        }
    }
}
