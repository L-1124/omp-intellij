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

import com.android.ide.common.blame.SourcePosition;
import com.android.tools.lint.detector.api.Position;
import com.android.utils.PositionXmlParser;
import com.intellij.openapi.application.Application;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.progress.ProgressManager;
import com.intellij.openapi.util.Computable;
import com.intellij.openapi.util.TextRange;
import com.intellij.openapi.vfs.VfsUtilCore;
import com.intellij.psi.PsiElement;
import com.intellij.psi.PsiFile;
import com.intellij.psi.XmlRecursiveElementVisitor;
import com.intellij.psi.util.PsiTreeUtil;
import com.intellij.psi.xml.XmlAttribute;
import com.intellij.psi.xml.XmlAttributeValue;
import com.intellij.psi.xml.XmlComment;
import com.intellij.psi.xml.XmlDocument;
import com.intellij.psi.xml.XmlElement;
import com.intellij.psi.xml.XmlFile;
import com.intellij.psi.xml.XmlTag;
import com.intellij.psi.xml.XmlText;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;
import org.w3c.dom.Attr;
import org.w3c.dom.CDATASection;
import org.w3c.dom.Comment;
import org.w3c.dom.DOMConfiguration;
import org.w3c.dom.DOMException;
import org.w3c.dom.DOMImplementation;
import org.w3c.dom.Document;
import org.w3c.dom.DocumentFragment;
import org.w3c.dom.DocumentType;
import org.w3c.dom.Element;
import org.w3c.dom.EntityReference;
import org.w3c.dom.NamedNodeMap;
import org.w3c.dom.Node;
import org.w3c.dom.NodeList;
import org.w3c.dom.ProcessingInstruction;
import org.w3c.dom.Text;
import org.w3c.dom.TypeInfo;
import org.w3c.dom.UserDataHandler;

import java.io.File;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Converter which takes a PSI hierarchy for an XML file or document, and
 * creates a corresponding W3C DOM tree. It attempts to delegate as much
 * as possible to the original PSI tree. Note also that the {@link #getTextRange(Node)}
 * method allows us to look up source offsets for the DOM nodes (which plain XML
 * DOM parsers do not).
 * <p>
 * NOTE: The tree may not be semantically equivalent to the XML PSI structure; this
 * converter only attempts to make the DOM correct as far as Lint cares (meaning that it
 * only worries about the details Lint cares about; currently this means it only wraps elements,
 * text and comment nodes.)
 */
public final class AndroidDomPsiConverter {
    private AndroidDomPsiConverter() {
    }

    private static final AndroidDomNodeList EMPTY_NODE_LIST = new AndroidDomNodeList(new AndroidDomNode[0]);

    private static final NamedNodeMap EMPTY_ATTRIBUTES = new NamedNodeMap() {
        @Override
        public int getLength() {
            return 0;
        }

        @Nullable
        @Override
        public Node getNamedItem(String name) {
            return null;
        }

        @Nullable
        @Override
        public Node getNamedItemNS(String namespaceURI, String localName) throws DOMException {
            return null;
        }

        @NotNull
        @Override
        public Node setNamedItem(Node arg) throws DOMException {
            throw new UnsupportedOperationException("Read-only DOM bridge");
        }

        @NotNull
        @Override
        public Node removeNamedItem(String name) throws DOMException {
            throw new UnsupportedOperationException("Read-only DOM bridge");
        }

        @Nullable
        @Override
        public Node item(int index) {
            return null;
        }

        @NotNull
        @Override
        public Node setNamedItemNS(Node arg) throws DOMException {
            throw new UnsupportedOperationException("Read-only DOM bridge");
        }

        @NotNull
        @Override
        public Node removeNamedItemNS(String namespaceURI, String localName) throws DOMException {
            throw new UnsupportedOperationException("Read-only DOM bridge");
        }
    };

    private static <T> T readAction(Computable<T> computable) {
        Application app = ApplicationManager.getApplication();
        if (app != null && !app.isReadAccessAllowed()) {
            return app.runReadAction(computable);
        }
        return computable.compute();
    }

    /**
     * Converts the given {@link XmlFile} to a DOM {@link Document}.
     */
    @Nullable
    public static Document convert(@NotNull XmlFile xmlFile) {
        ProgressManager.checkCanceled();
        XmlDocument xmlDocument = readAction(xmlFile::getDocument);
        if (xmlDocument == null) {
            return null;
        }
        return new AndroidDomDocument(xmlDocument, xmlFile);
    }

    /**
     * Returns the {@link TextRange} for a given {@link Node}.
     */
    @NotNull
    public static TextRange getTextRange(@NotNull Node node) {
        if (!(node instanceof AndroidDomNode domNode)) {
            SourcePosition position = PositionXmlParser.getPosition(node);
            if (position != null && position != SourcePosition.UNKNOWN) {
                return new TextRange(position.getStartOffset(), position.getEndOffset());
            }
            return new TextRange(0, 0);
        }
        return domNode.getTextRange();
    }

    /**
     * Trims whitespace from the given node range for text nodes.
     */
    @NotNull
    public static TextRange trim(@NotNull Node node, @NotNull TextRange range) {
        if (node.getNodeType() == Node.TEXT_NODE && node instanceof AndroidDomText textNode) {
            String text = textNode.myElement.getText();
            if (text != null && !text.isEmpty()) {
                int i = 0;
                while (i < text.length() && Character.isWhitespace(text.charAt(i))) {
                    i++;
                }
                int j = text.length();
                while (j > i && Character.isWhitespace(text.charAt(j - 1))) {
                    j--;
                }
                return TextRange.create(range.getStartOffset() + i, range.getStartOffset() + j);
            }
        }
        return range;
    }

    /**
     * Gets the {@link TextRange} for the name of the given {@link Node}.
     */
    @NotNull
    public static TextRange getTextNameRange(@NotNull Node node) {
        if (!(node instanceof AndroidDomNode domNode)) {
            TextRange range = getTextRange(node);
            if (node.getNodeType() == Node.ELEMENT_NODE) {
                String tag = node.getNodeName();
                int start = range.getStartOffset() + 1;
                return new TextRange(start, start + tag.length());
            } else if (node.getNodeType() == Node.ATTRIBUTE_NODE) {
                String name = node.getNodeName();
                int start = range.getStartOffset();
                return new TextRange(start, start + name.length());
            }
            return range;
        }

        XmlElement element = domNode.myElement;

        if (node.getNodeType() == Node.ELEMENT_NODE && element instanceof XmlTag) {
            String tag = node.getNodeName();
            String text = element.getText();
            int index = text.indexOf(tag);
            if (index != -1) {
                TextRange textRange = element.getTextRange();
                int start = textRange.getStartOffset() + index;
                return new TextRange(start, start + tag.length());
            }
        } else if (node.getNodeType() == Node.ATTRIBUTE_NODE && element instanceof XmlAttribute attr) {
            XmlElement nameElement = attr.getNameElement();
            if (nameElement != null) {
                return nameElement.getTextRange();
            }
        }

        return element.getTextRange();
    }

    /**
     * Gets the {@link TextRange} for the value of the given {@link Node}.
     */
    @NotNull
    public static TextRange getTextValueRange(@NotNull Node node) {
        if (!(node instanceof AndroidDomNode domNode)) {
            TextRange range = getTextRange(node);
            if (node.getNodeType() == Node.ATTRIBUTE_NODE) {
                Document ownerDoc = node.getOwnerDocument();
                String contents = null;
                if (ownerDoc != null) {
                    contents = (String) ownerDoc.getUserData(PositionXmlParser.CONTENT_KEY);
                    if (contents == null) {
                        contents = (String) ownerDoc.getUserData("contents");
                    }
                }
                if (contents != null) {
                    int startOffset = range.getStartOffset();
                    int endOffset = range.getEndOffset();
                    int docLen = contents.length();
                    startOffset = Math.clamp(startOffset, 0, docLen);
                    endOffset = Math.clamp(endOffset, startOffset, docLen);
                    int eq = contents.indexOf('=', startOffset);
                    if (eq != -1 && eq < endOffset) {
                        int quoteStart = eq + 1;
                        while (quoteStart < endOffset && Character.isWhitespace(contents.charAt(quoteStart))) {
                            quoteStart++;
                        }
                        if (quoteStart < endOffset) {
                            char quote = contents.charAt(quoteStart);
                            if (quote == '"' || quote == '\'') {
                                int valueStart = quoteStart + 1;
                                int valueEnd = endOffset;
                                if (valueEnd > valueStart && contents.charAt(valueEnd - 1) == quote) {
                                    valueEnd--;
                                } else {
                                    int closing = contents.indexOf(quote, valueStart);
                                    if (closing != -1 && closing <= endOffset) {
                                        valueEnd = closing;
                                    }
                                }
                                return new TextRange(valueStart, valueEnd);
                            }
                        }
                    }
                }
                String val = node.getNodeValue();
                int end = range.getEndOffset() - 1;
                int start = end - (val != null ? val.length() : 0);
                if (start >= range.getStartOffset()) {
                    return new TextRange(start, end);
                }
            }
            return range;
        }

        XmlElement element = domNode.myElement;
        TextRange textRange = element.getTextRange();

        if (node.getNodeType() == Node.ATTRIBUTE_NODE && element instanceof XmlAttribute attr) {
            XmlAttributeValue valueElement = attr.getValueElement();
            if (valueElement != null) {
                return valueElement.getValueTextRange();
            }
        }

        return textRange;
    }

    /**
     * Extracts the underlying {@link XmlElement} if node was produced by this converter.
     */
    @Nullable
    public static XmlElement getPsiElement(@NotNull Node node) {
        if (node instanceof AndroidDomNode domNode) {
            return domNode.myElement;
        }
        return null;
    }

    /**
     * Locates the leaf node at the given offset within the DOM hierarchy.
     */
    @Nullable
    public static Node findNodeAt(@Nullable Node node, int offset) {
        if (node instanceof Document doc) {
            node = doc.getDocumentElement();
            if (node == null) {
                return null;
            }
        }
        if (!(node instanceof AndroidDomNode domNode)) {
            return null;
        }
        return findNodeAt(domNode, offset);
    }

    @Nullable
    public static Node findNodeAt(@NotNull AndroidDomNode element, int offset) {
        TextRange range = element.getTextRange();
        if (!range.containsOffset(offset)) {
            return null;
        }

        AndroidDomNode node = element;
        while (true) {
            ProgressManager.checkCanceled();
            AndroidDomNodeList children = node.getChildNodes();
            int count = children.getLength();
            if (count == 0) {
                return checkAttributesOrNode(node, offset);
            }

            int candidate = -1;
            int low = 0;
            int high = count - 1;
            while (low <= high) {
                int mid = (low + high) >>> 1;
                AndroidDomNode child = children.item(mid);
                TextRange childRange = child != null ? child.getTextRange() : null;
                if (childRange != null && childRange.getStartOffset() <= offset) {
                    candidate = mid;
                    low = mid + 1;
                } else {
                    high = mid - 1;
                }
            }

            if (candidate == -1) {
                return checkAttributesOrNode(node, offset);
            }
            AndroidDomNode candidateChild = children.item(candidate);
            TextRange candidateRange = candidateChild != null ? candidateChild.getTextRange() : null;
            if (candidateRange == null || !candidateRange.containsOffset(offset)) {
                return checkAttributesOrNode(node, offset);
            }
            node = candidateChild;
        }
    }

    private static Node checkAttributesOrNode(AndroidDomNode node, int offset) {
        if (node instanceof AndroidDomElement && node.getAttributes() instanceof AndroidDomNamedNodeMap attributes) {
            for (AndroidDomNode attribute : attributes.getItems()) {
                TextRange attrRange = attribute.getTextRange();
                if (attrRange.containsOffset(offset)) {
                    return attribute;
                }
            }
        }
        return node;
    }

    /**
     * Base class for all DOM nodes backed by XML PSI.
     */
    public static abstract class AndroidDomNode implements Node {
        @Nullable
        protected final Document myOwner;
        @Nullable
        protected final AndroidDomNode myParent;
        @NotNull
        protected final XmlElement myElement;
        @Nullable
        protected AndroidDomNodeList myChildren;
        @Nullable
        protected AndroidDomNode myNext;
        @Nullable
        protected AndroidDomNode myPrevious;
        @Nullable
        protected TextRange myRange;
        @Nullable
        protected Map<String, Object> myUserData;

        protected AndroidDomNode(@Nullable Document owner, @Nullable AndroidDomNode parent, @NotNull XmlElement element) {
            this.myOwner = owner;
            this.myParent = parent;
            this.myElement = element;
        }

        @Nullable
        @Override
        public Node getParentNode() {
            return myParent;
        }

        @NotNull
        @Override
        public AndroidDomNodeList getChildNodes() {
            if (myChildren == null) {
                ProgressManager.checkCanceled();
                PsiElement child = myElement.getFirstChild();
                if (child == null) {
                    myChildren = EMPTY_NODE_LIST;
                    return myChildren;
                }

                var list = new AndroidDomNodeList.Builder();
                TextRange range = getTextRange();
                int offset = range.getStartOffset();
                while (child != null) {
                    ProgressManager.checkCanceled();
                    int length = child.getTextLength();
                    AndroidDomNode node = switch (child) {
                        case XmlTag tag ->
                                new AndroidDomElement(myOwner != null ? myOwner : (Document) this, this, tag);
                        case XmlText text ->
                                new AndroidDomText(myOwner != null ? myOwner : (Document) this, this, text);
                        case XmlComment comment ->
                                new AndroidDomComment(myOwner != null ? myOwner : (Document) this, this, comment);
                        default -> null;
                    };
                    if (node != null) {
                        node.myRange = new TextRange(offset, offset + length);
                        list.add(node, true);
                    }
                    offset += length;
                    child = child.getNextSibling();
                }
                myChildren = list.build();
            }
            return myChildren;
        }

        @Nullable
        @Override
        public Node getFirstChild() {
            AndroidDomNodeList childNodes = getChildNodes();
            return childNodes.getLength() > 0 ? childNodes.item(0) : null;
        }

        @Nullable
        @Override
        public Node getLastChild() {
            AndroidDomNodeList childNodes = getChildNodes();
            return childNodes.getLength() > 0 ? childNodes.item(childNodes.getLength() - 1) : null;
        }

        @Nullable
        @Override
        public Node getPreviousSibling() {
            return myPrevious;
        }

        @Nullable
        @Override
        public Node getNextSibling() {
            return myNext;
        }

        @Nullable
        @Override
        public NamedNodeMap getAttributes() {
            return null;
        }

        @Nullable
        @Override
        public Document getOwnerDocument() {
            return myOwner;
        }

        @NotNull
        @Override
        public Node insertBefore(Node newChild, Node refChild) throws DOMException {
            throw new UnsupportedOperationException("Read-only DOM bridge");
        }

        @NotNull
        @Override
        public Node replaceChild(Node newChild, Node oldChild) throws DOMException {
            throw new UnsupportedOperationException("Read-only DOM bridge");
        }

        @NotNull
        @Override
        public Node removeChild(Node oldChild) throws DOMException {
            throw new UnsupportedOperationException("Read-only DOM bridge");
        }

        @NotNull
        @Override
        public Node appendChild(Node newChild) throws DOMException {
            throw new UnsupportedOperationException("Read-only DOM bridge");
        }

        @Override
        public boolean hasChildNodes() {
            return getChildNodes().getLength() > 0;
        }

        @NotNull
        @Override
        public Node cloneNode(boolean deep) {
            throw new UnsupportedOperationException("Read-only DOM bridge");
        }

        @Override
        public void normalize() {
        }

        @Override
        public boolean isSupported(String feature, String version) {
            return false;
        }

        @Nullable
        @Override
        public String getNamespaceURI() {
            return null;
        }

        @Nullable
        @Override
        public String getPrefix() {
            return null;
        }

        @Override
        public void setPrefix(String prefix) throws DOMException {
            throw new UnsupportedOperationException("Read-only DOM bridge");
        }

        @Nullable
        @Override
        public String getLocalName() {
            return null;
        }

        @Override
        public boolean hasAttributes() {
            return false;
        }

        @Nullable
        @Override
        public String getBaseURI() {
            return null;
        }

        @Override
        public short compareDocumentPosition(Node other) throws DOMException {
            throw new UnsupportedOperationException("Not supported");
        }

        @Override
        public void setTextContent(String textContent) throws DOMException {
            throw new UnsupportedOperationException("Read-only DOM bridge");
        }

        @Override
        public boolean isSameNode(Node other) {
            return this == other;
        }

        @Nullable
        @Override
        public String lookupPrefix(String namespaceURI) {
            XmlTag tag = PsiTreeUtil.getParentOfType(myElement, XmlTag.class, false);
            return tag != null ? tag.getPrefixByNamespace(namespaceURI) : null;
        }

        @Override
        public boolean isDefaultNamespace(String namespaceURI) {
            String defaultUri = lookupNamespaceURI(null);
            return defaultUri != null && defaultUri.equals(namespaceURI);
        }

        @Nullable
        @Override
        public String lookupNamespaceURI(String prefix) {
            XmlTag tag = PsiTreeUtil.getParentOfType(myElement, XmlTag.class, false);
            return tag != null ? tag.getNamespaceByPrefix(prefix) : null;
        }

        @Override
        public boolean isEqualNode(Node arg) {
            return this.equals(arg);
        }

        @Nullable
        @Override
        public Object getFeature(String feature, String version) {
            return null;
        }

        @Nullable
        @Override
        public Object setUserData(String key, Object data, UserDataHandler handler) {
            if (myUserData == null) {
                if (data == null) {
                    return null;
                }
                myUserData = new HashMap<>();
            }
            if (data != null) {
                return myUserData.put(key, data);
            } else {
                return myUserData.remove(key);
            }
        }

        @Nullable
        @Override
        public Object getUserData(String key) {
            if (myUserData != null && myUserData.containsKey(key)) {
                return myUserData.get(key);
            }
            return null;
        }

        @Override
        public void setNodeValue(String nodeValue) throws DOMException {
            throw new UnsupportedOperationException("Read-only DOM bridge");
        }

        @NotNull
        public TextRange getTextRange() {
            TextRange range = myRange;
            if (range == null) {
                myRange = range = myElement.getTextRange();
            }
            return range;
        }

        // From CharacterData
        @NotNull
        public String getData() throws DOMException {
            throw new UnsupportedOperationException("Read-only DOM bridge");
        }

        public void setData(String data) throws DOMException {
            throw new UnsupportedOperationException("Read-only DOM bridge");
        }

        public int getLength() {
            return myElement.getTextLength();
        }

        @NotNull
        public String substringData(int offset, int count) throws DOMException {
            throw new UnsupportedOperationException("Read-only DOM bridge");
        }

        public void appendData(String arg) throws DOMException {
            throw new UnsupportedOperationException("Read-only DOM bridge");
        }

        public void insertData(int offset, String arg) throws DOMException {
            throw new UnsupportedOperationException("Read-only DOM bridge");
        }

        public void deleteData(int offset, int count) throws DOMException {
            throw new UnsupportedOperationException("Read-only DOM bridge");
        }

        public void replaceData(int offset, int count, String arg) throws DOMException {
            throw new UnsupportedOperationException("Read-only DOM bridge");
        }
    }

    /**
     * DOM Document adapter wrapping {@link XmlDocument}.
     */
    public static class AndroidDomDocument extends AndroidDomNode implements Document {
        @NotNull
        private final XmlDocument myPsiDocument;
        @NotNull
        private final XmlFile myFile;
        @Nullable
        private AndroidDomElement myRoot;

        AndroidDomDocument(@NotNull XmlDocument document, @NotNull XmlFile file) {
            super(null, null, document);
            this.myPsiDocument = document;
            this.myFile = file;
        }

        @NotNull
        @Override
        public String getNodeName() {
            return "#document";
        }

        @Nullable
        @Override
        public String getNodeValue() throws DOMException {
            return null;
        }

        @Override
        public short getNodeType() {
            return Node.DOCUMENT_NODE;
        }

        @NotNull
        @Override
        public AndroidDomNodeList getChildNodes() {
            if (myChildren == null) {
                ProgressManager.checkCanceled();
                var list = new AndroidDomNodeList.Builder();
                PsiElement element = myPsiDocument.getFirstChild();
                while (element != null) {
                    ProgressManager.checkCanceled();
                    if (element instanceof XmlTag tag) {
                        if (myRoot != null && myRoot.myTag == tag) {
                            list.add(myRoot, true);
                        } else {
                            AndroidDomElement node = new AndroidDomElement(this, this, tag);
                            if (myRoot == null) {
                                myRoot = node;
                            }
                            list.add(node, true);
                        }
                    } else if (element instanceof XmlComment comment) {
                        AndroidDomNode node = new AndroidDomComment(this, this, comment);
                        list.add(node, true);
                    } else if (element instanceof XmlText text) {
                        AndroidDomNode node = new AndroidDomText(this, this, text);
                        list.add(node, true);
                    }
                    element = element.getNextSibling();
                }
                myChildren = list.build();
            }
            return myChildren;
        }

        @Nullable
        @Override
        public Element getDocumentElement() {
            if (myRoot == null) {
                XmlTag rootTag = readAction(myPsiDocument::getRootTag);
                if (rootTag == null) {
                    return null;
                }
                myRoot = new AndroidDomElement(this, this, rootTag);
            }
            return myRoot;
        }

        @NotNull
        @Override
        public NodeList getElementsByTagName(String tagname) {
            Element root = getDocumentElement();
            if (root != null) {
                var list = new AndroidDomNodeList.Builder();
                if ("*".equals(tagname) || tagname.equals(root.getNodeName())) {
                    list.add((AndroidDomNode) root, false);
                }
                NodeList descendants = root.getElementsByTagName(tagname);
                for (int i = 0; i < descendants.getLength(); i++) {
                    Node item = descendants.item(i);
                    if (item instanceof AndroidDomNode domNode) {
                        list.add(domNode, false);
                    }
                }
                return list.build();
            }
            return EMPTY_NODE_LIST;
        }

        @Nullable
        @Override
        public Object getUserData(String key) {
            Object custom = super.getUserData(key);
            if (custom != null) {
                return custom;
            }
            if (PsiFile.class.getName().equals(key)) {
                return myFile;
            }
            if (File.class.getName().equals(key)) {
                return myFile.getVirtualFile() != null ? VfsUtilCore.virtualToIoFile(myFile.getVirtualFile()) : null;
            }
            if (PositionXmlParser.CONTENT_KEY.equals(key) || "contents".equals(key)) {
                return readAction(myFile::getText);
            }
            return null;
        }

        @Nullable
        @Override
        public String getTextContent() throws DOMException {
            return null;
        }

        @Nullable
        @Override
        public DocumentType getDoctype() {
            return null;
        }

        @NotNull
        @Override
        public DOMImplementation getImplementation() {
            throw new UnsupportedOperationException("Not supported");
        }

        @NotNull
        @Override
        public Element createElement(String tagName) throws DOMException {
            throw new UnsupportedOperationException("Read-only DOM bridge");
        }

        @NotNull
        @Override
        public DocumentFragment createDocumentFragment() {
            throw new UnsupportedOperationException("Read-only DOM bridge");
        }

        @NotNull
        @Override
        public Text createTextNode(String data) {
            throw new UnsupportedOperationException("Read-only DOM bridge");
        }

        @NotNull
        @Override
        public Comment createComment(String data) {
            throw new UnsupportedOperationException("Read-only DOM bridge");
        }

        @NotNull
        @Override
        public CDATASection createCDATASection(String data) throws DOMException {
            throw new UnsupportedOperationException("Read-only DOM bridge");
        }

        @NotNull
        @Override
        public ProcessingInstruction createProcessingInstruction(String target, String data) throws DOMException {
            throw new UnsupportedOperationException("Read-only DOM bridge");
        }

        @NotNull
        @Override
        public Attr createAttribute(String name) throws DOMException {
            throw new UnsupportedOperationException("Read-only DOM bridge");
        }

        @NotNull
        @Override
        public EntityReference createEntityReference(String name) throws DOMException {
            throw new UnsupportedOperationException("Read-only DOM bridge");
        }

        @NotNull
        @Override
        public Node importNode(Node importedNode, boolean deep) throws DOMException {
            throw new UnsupportedOperationException("Read-only DOM bridge");
        }

        @NotNull
        @Override
        public Element createElementNS(String namespaceURI, String qualifiedName) throws DOMException {
            throw new UnsupportedOperationException("Read-only DOM bridge");
        }

        @NotNull
        @Override
        public Attr createAttributeNS(String namespaceURI, String qualifiedName) throws DOMException {
            throw new UnsupportedOperationException("Read-only DOM bridge");
        }

        @NotNull
        @Override
        public NodeList getElementsByTagNameNS(String namespaceURI, String localName) throws DOMException {
            throw new UnsupportedOperationException("Not supported");
        }

        @Nullable
        @Override
        public Element getElementById(String elementId) {
            throw new UnsupportedOperationException("Not supported");
        }

        @Nullable
        @Override
        public String getInputEncoding() {
            return "UTF-8";
        }

        @Nullable
        @Override
        public String getXmlEncoding() {
            return "UTF-8";
        }

        @Override
        public boolean getXmlStandalone() {
            return false;
        }

        @Override
        public void setXmlStandalone(boolean xmlStandalone) throws DOMException {
            throw new UnsupportedOperationException("Read-only DOM bridge");
        }

        @Nullable
        @Override
        public String getXmlVersion() {
            return "1.0";
        }

        @Override
        public void setXmlVersion(String xmlVersion) throws DOMException {
            throw new UnsupportedOperationException("Read-only DOM bridge");
        }

        @Override
        public boolean getStrictErrorChecking() {
            return false;
        }

        @Override
        public void setStrictErrorChecking(boolean strictErrorChecking) {
            throw new UnsupportedOperationException("Read-only DOM bridge");
        }

        @Nullable
        @Override
        public String getDocumentURI() {
            return myFile.getVirtualFile() != null ? myFile.getVirtualFile().getUrl() : null;
        }

        @Override
        public void setDocumentURI(String documentURI) {
            throw new UnsupportedOperationException("Not supported");
        }

        @NotNull
        @Override
        public Node adoptNode(Node source) throws DOMException {
            throw new UnsupportedOperationException("Read-only DOM bridge");
        }

        @NotNull
        @Override
        public DOMConfiguration getDomConfig() {
            throw new UnsupportedOperationException("Not supported");
        }

        @Override
        public void normalizeDocument() {
        }

        @NotNull
        @Override
        public Node renameNode(Node n, String namespaceURI, String qualifiedName) throws DOMException {
            throw new UnsupportedOperationException("Not supported");
        }
    }

    /**
     * DOM Element adapter wrapping {@link XmlTag}.
     */
    public static class AndroidDomElement extends AndroidDomNode implements Element {
        @NotNull
        final XmlTag myTag;
        @Nullable
        private NamedNodeMap myAttributes;

        private static class NodeWithIndex {
            final Node node;
            int nextNodeIndex;

            NodeWithIndex(Node node) {
                this.node = node;
            }
        }

        AndroidDomElement(@NotNull Document owner, @NotNull AndroidDomNode parent, @NotNull XmlTag tag) {
            super(owner, parent, tag);
            this.myTag = tag;
        }

        @NotNull
        @Override
        public String getNodeName() {
            return getTagName();
        }

        @Nullable
        @Override
        public String getNodeValue() throws DOMException {
            return null;
        }

        @Override
        public short getNodeType() {
            return Node.ELEMENT_NODE;
        }

        @Nullable
        @Override
        public String getPrefix() {
            String prefix = readAction(myTag::getNamespacePrefix);
            return prefix.isEmpty() ? null : prefix;
        }

        @Nullable
        @Override
        public String getNamespaceURI() {
            String ns = readAction(myTag::getNamespace);
            return ns.isEmpty() ? null : ns;
        }

        @NotNull
        @Override
        public NamedNodeMap getAttributes() {
            NamedNodeMap attrs = readAction(() -> {
                if (myAttributes == null) {
                    XmlAttribute[] attributes = myTag.getAttributes();
                    myAttributes = attributes.length == 0 ? EMPTY_ATTRIBUTES : new AndroidDomNamedNodeMap(this, attributes);
                }
                return myAttributes;
            });
            return attrs != null ? attrs : EMPTY_ATTRIBUTES;
        }

        @Override
        public boolean hasAttributes() {
            return getAttributes().getLength() > 0;
        }

        @NotNull
        @Override
        public String getTextContent() throws DOMException {
            PsiElement child = myElement.getFirstChild();
            if (child instanceof XmlText && child.getNextSibling() == null) {
                return ((XmlText) child).getValue();
            }

            StringBuilder buffer = new StringBuilder();
            myElement.acceptChildren(new XmlRecursiveElementVisitor() {
                @Override
                public void visitXmlText(@NotNull XmlText text) {
                    buffer.append(text.getValue());
                }
            });
            return buffer.toString();
        }

        @NotNull
        @Override
        public String getTagName() {
            return readAction(myTag::getName);
        }

        @Nullable
        @Override
        public String getLocalName() {
            return readAction(myTag::getLocalName);
        }

        @NotNull
        @Override
        public String getAttribute(@NotNull String name) {
            Node node = getAttributes().getNamedItem(name);
            if (node != null) {
                String val = node.getNodeValue();
                return val != null ? val : "";
            }
            return "";
        }

        @NotNull
        @Override
        public String getAttributeNS(@Nullable String namespace, @NotNull String name) throws DOMException {
            Node node = getAttributes().getNamedItemNS(namespace, name);
            if (node != null) {
                String val = node.getNodeValue();
                return val != null ? val : "";
            }
            return "";
        }

        @Nullable
        @Override
        public Attr getAttributeNode(@NotNull String name) {
            Node node = getAttributes().getNamedItem(name);
            return node instanceof Attr ? (Attr) node : null;
        }

        @Nullable
        @Override
        public Attr getAttributeNodeNS(@Nullable String namespace, @NotNull String name) throws DOMException {
            Node node = getAttributes().getNamedItemNS(namespace, name);
            return node instanceof Attr ? (Attr) node : null;
        }

        @Override
        public boolean hasAttribute(@NotNull String name) {
            return getAttributes().getNamedItem(name) != null;
        }

        @Override
        public boolean hasAttributeNS(@Nullable String namespace, @NotNull String name) throws DOMException {
            return getAttributes().getNamedItemNS(namespace, name) != null;
        }

        @NotNull
        @Override
        public NodeList getElementsByTagName(@NotNull String name) {
            if (getChildNodes().getLength() == 0) {
                return EMPTY_NODE_LIST;
            }

            var matches = new AndroidDomNodeList.Builder();
            List<NodeWithIndex> stack = new ArrayList<>();
            stack.add(new NodeWithIndex(this));

            while (!stack.isEmpty()) {
                ProgressManager.checkCanceled();
                NodeWithIndex top = stack.getLast();
                if (top.nextNodeIndex < top.node.getChildNodes().getLength()) {
                    Node next = top.node.getChildNodes().item(top.nextNodeIndex++);
                    if (next instanceof AndroidDomElement element) {
                        if ("*".equals(name) || name.equals(element.getNodeName())) {
                            matches.add(element, false);
                        }
                        stack.add(new NodeWithIndex(element));
                    }
                } else {
                    stack.removeLast();
                }
            }

            return matches.build();
        }

        @NotNull
        @Override
        public NodeList getElementsByTagNameNS(String namespaceURI, String localName) throws DOMException {
            throw new UnsupportedOperationException("Not supported");
        }

        @NotNull
        @Override
        public Attr setAttributeNode(Attr newAttr) throws DOMException {
            throw new UnsupportedOperationException("Read-only DOM bridge");
        }

        @NotNull
        @Override
        public Attr removeAttributeNode(Attr oldAttr) throws DOMException {
            throw new UnsupportedOperationException("Read-only DOM bridge");
        }

        @Override
        public void setAttribute(String name, String value) throws DOMException {
            throw new UnsupportedOperationException("Read-only DOM bridge");
        }

        @Override
        public void removeAttribute(String name) throws DOMException {
            throw new UnsupportedOperationException("Read-only DOM bridge");
        }

        @Override
        public void setAttributeNS(String namespaceURI, String qualifiedName, String value) throws DOMException {
            throw new UnsupportedOperationException("Read-only DOM bridge");
        }

        @Override
        public void removeAttributeNS(String namespaceURI, String localName) throws DOMException {
            throw new UnsupportedOperationException("Read-only DOM bridge");
        }

        @NotNull
        @Override
        public Attr setAttributeNodeNS(Attr newAttr) throws DOMException {
            throw new UnsupportedOperationException("Read-only DOM bridge");
        }

        @NotNull
        @Override
        public TypeInfo getSchemaTypeInfo() {
            throw new UnsupportedOperationException("Not supported");
        }

        @Override
        public void setIdAttribute(String name, boolean isId) throws DOMException {
            throw new UnsupportedOperationException("Read-only DOM bridge");
        }

        @Override
        public void setIdAttributeNS(String namespaceURI, String localName, boolean isId) throws DOMException {
            throw new UnsupportedOperationException("Read-only DOM bridge");
        }

        @Override
        public void setIdAttributeNode(Attr idAttr, boolean isId) throws DOMException {
            throw new UnsupportedOperationException("Read-only DOM bridge");
        }

        @Override
        public String toString() {
            return "AndroidDomElement(" + myTag.getName() + " at " + myTag.getTextRange() + ")";
        }
    }

    /**
     * DOM Attr adapter wrapping {@link XmlAttribute}.
     */
    public static class AndroidDomAttr extends AndroidDomNode implements Attr {
        @NotNull
        private final AndroidDomElement myOwner;
        @NotNull
        private final XmlAttribute myAttribute;

        AndroidDomAttr(@NotNull Document document, @NotNull AndroidDomElement owner, @NotNull XmlAttribute attribute) {
            super(document, null, attribute);
            this.myOwner = owner;
            this.myAttribute = attribute;
        }

        @NotNull
        @Override
        public String getNodeName() {
            return getName();
        }

        @NotNull
        @Override
        public String getNodeValue() throws DOMException {
            return getValue();
        }

        @Override
        public short getNodeType() {
            return Node.ATTRIBUTE_NODE;
        }

        @NotNull
        @Override
        public String getTextContent() throws DOMException {
            return "";
        }

        @NotNull
        @Override
        public String getName() {
            return readAction(myAttribute::getName);
        }

        @Override
        public boolean getSpecified() {
            return true;
        }

        @NotNull
        @Override
        public String getValue() {
            return readAction(() -> {
                String value = myAttribute.getDisplayValue();
                if (value == null) {
                    value = myAttribute.getValue();
                }
                return value != null ? value : "";
            });
        }

        @NotNull
        @Override
        public String getLocalName() {
            return readAction(myAttribute::getLocalName);
        }

        @Nullable
        @Override
        public String getPrefix() {
            String prefix = readAction(myAttribute::getNamespacePrefix);
            return prefix.isEmpty() ? null : prefix;
        }

        @Nullable
        @Override
        public String getNamespaceURI() {
            String ns = readAction(myAttribute::getNamespace);
            return ns.isEmpty() ? null : ns;
        }

        @Override
        public void setValue(String value) throws DOMException {
            throw new UnsupportedOperationException("Read-only DOM bridge");
        }

        @NotNull
        @Override
        public Element getOwnerElement() {
            return myOwner;
        }

        @NotNull
        @Override
        public TypeInfo getSchemaTypeInfo() {
            throw new UnsupportedOperationException("Not supported");
        }

        @Override
        public boolean isId() {
            return "id".equals(getLocalName());
        }

        @Override
        public String toString() {
            return "AndroidDomAttr(" + getName() + "=" + getValue() + " at " + myElement.getTextRange() + ")";
        }
    }

    /**
     * DOM Text adapter wrapping {@link XmlText}.
     */
    public static class AndroidDomText extends AndroidDomNode implements Text {
        @NotNull
        private final XmlText myText;

        AndroidDomText(@NotNull Document owner, @NotNull AndroidDomNode parent, @NotNull XmlText text) {
            super(owner, parent, text);
            this.myText = text;
        }

        @NotNull
        @Override
        public String getNodeName() {
            return "#text";
        }

        @NotNull
        @Override
        public String getNodeValue() throws DOMException {
            return readAction(myText::getText);
        }

        @Override
        public short getNodeType() {
            return Node.TEXT_NODE;
        }

        @NotNull
        @Override
        public String getTextContent() throws DOMException {
            return readAction(myText::getValue);
        }

        @Override
        @NotNull
        public String getData() throws DOMException {
            return getNodeValue();
        }

        @NotNull
        @Override
        public Text splitText(int offset) throws DOMException {
            throw new UnsupportedOperationException("Read-only DOM bridge");
        }

        @Override
        public boolean isElementContentWhitespace() {
            String s = readAction(myText::getText);
            if (s == null) return true;
            for (int i = 0, n = s.length(); i < n; i++) {
                if (!Character.isWhitespace(s.charAt(i))) {
                    return false;
                }
            }
            return true;
        }

        @NotNull
        @Override
        public String getWholeText() {
            throw new UnsupportedOperationException("Not supported");
        }

        @NotNull
        @Override
        public Text replaceWholeText(String content) throws DOMException {
            throw new UnsupportedOperationException("Read-only DOM bridge");
        }

        @Override
        public String toString() {
            return "AndroidDomText(" + getTextContent() + " at " + myElement.getTextRange() + ")";
        }
    }

    /**
     * DOM Comment adapter wrapping {@link XmlComment}.
     */
    public static class AndroidDomComment extends AndroidDomNode implements Comment {
        @NotNull
        private final XmlComment myComment;

        AndroidDomComment(@NotNull Document owner, @NotNull AndroidDomNode parent, @NotNull XmlComment comment) {
            super(owner, parent, comment);
            this.myComment = comment;
        }

        @NotNull
        @Override
        public String getNodeName() {
            return "#comment";
        }

        @NotNull
        @Override
        public String getNodeValue() throws DOMException {
            return readAction(myComment::getCommentText);
        }

        @Override
        public short getNodeType() {
            return Node.COMMENT_NODE;
        }

        @NotNull
        @Override
        public String getTextContent() throws DOMException {
            return getNodeValue();
        }

        @Override
        @NotNull
        public String getData() throws DOMException {
            return getNodeValue();
        }

        @Override
        public String toString() {
            return "AndroidDomComment(" + getNodeValue() + " at " + myElement.getTextRange() + ")";
        }
    }

    /**
     * NamedNodeMap adapter for attribute collections.
     */
    public static class AndroidDomNamedNodeMap implements NamedNodeMap {
        @NotNull
        protected final Map<String, AndroidDomNode> myMap;
        @NotNull
        protected final Map<String, Map<String, AndroidDomNode>> myNsMap;
        @NotNull
        protected final List<AndroidDomNode> mItems;

        AndroidDomNamedNodeMap(@NotNull AndroidDomElement element, @NotNull XmlAttribute[] attributes) {
            int count = attributes.length;
            int namespaceCount = 0;
            for (XmlAttribute attribute : attributes) {
                if (!attribute.getNamespace().isEmpty()) {
                    namespaceCount++;
                }
            }
            myMap = new HashMap<>(count);
            myNsMap = new HashMap<>(namespaceCount);
            mItems = new ArrayList<>(count);

            for (XmlAttribute attribute : attributes) {
                AndroidDomAttr attr = new AndroidDomAttr(element.myOwner != null ? element.myOwner : (Document) element, element, attribute);
                mItems.add(attr);
                myMap.put(attribute.getName(), attr);
                String namespace = attribute.getNamespace();
                if (!namespace.isEmpty()) {
                    Map<String, AndroidDomNode> map = myNsMap.computeIfAbsent(namespace, k -> new HashMap<>());
                    map.put(attribute.getLocalName(), attr);
                }
            }
        }

        @NotNull
        public List<AndroidDomNode> getItems() {
            return mItems;
        }

        @Nullable
        @Override
        public Node item(int index) {
            if (index < 0 || index >= mItems.size()) {
                return null;
            }
            return mItems.get(index);
        }

        @Override
        public int getLength() {
            return mItems.size();
        }

        @Nullable
        @Override
        public Node getNamedItem(@NotNull String name) {
            return myMap.get(name);
        }

        @Nullable
        @Override
        public Node getNamedItemNS(@Nullable String namespace, @NotNull String localName) throws DOMException {
            if (namespace == null || namespace.isEmpty()) {
                Node node = getNamedItem(localName);
                return node != null && (node.getNamespaceURI() == null || node.getNamespaceURI().isEmpty())
                        ? node : null;
            }
            Map<String, AndroidDomNode> map = myNsMap.get(namespace);
            if (map != null) {
                return map.get(localName);
            }
            return null;
        }

        @NotNull
        @Override
        public Node setNamedItem(Node arg) throws DOMException {
            throw new UnsupportedOperationException("Read-only DOM bridge");
        }

        @NotNull
        @Override
        public Node removeNamedItem(String name) throws DOMException {
            throw new UnsupportedOperationException("Read-only DOM bridge");
        }

        @NotNull
        @Override
        public Node setNamedItemNS(Node arg) throws DOMException {
            throw new UnsupportedOperationException("Read-only DOM bridge");
        }

        @NotNull
        @Override
        public Node removeNamedItemNS(String namespaceURI, String localName) throws DOMException {
            throw new UnsupportedOperationException("Read-only DOM bridge");
        }
    }

    /**
     * NodeList implementation backed by an array of {@link AndroidDomNode}.
     */
    public static final class AndroidDomNodeList implements NodeList {
        @NotNull
        private final AndroidDomNode[] myChildren;

        AndroidDomNodeList(@NotNull AndroidDomNode[] children) {
            this.myChildren = children;
        }

        @Nullable
        @Override
        public AndroidDomNode item(int index) {
            if (index < 0 || index >= myChildren.length) {
                return null;
            }
            return myChildren[index];
        }

        @Override
        public int getLength() {
            return myChildren.length;
        }

        static class Builder {
            private final List<AndroidDomNode> myChildren = new ArrayList<>();

            void add(@NotNull AndroidDomNode node, boolean updateSiblings) {
                if (updateSiblings) {
                    int size = myChildren.size();
                    if (size > 0) {
                        AndroidDomNode last = myChildren.get(size - 1);
                        node.myPrevious = last;
                        last.myNext = node;
                    }
                }
                myChildren.add(node);
            }

            AndroidDomNodeList build() {
                return new AndroidDomNodeList(myChildren.toArray(new AndroidDomNode[0]));
            }
        }
    }

    /**
     * Lazy line and column calculator for XML positions supporting CRLF, emoji, and multi-line values.
     */
    public static class AndroidLintXmlPosition extends Position {
        private final int myOffset;
        @Nullable
        private final Node myNode;
        private int myLine = -1;
        private int myColumn = -1;
        private boolean myInitialized;

        public AndroidLintXmlPosition(@Nullable Node node, int offset) {
            this.myNode = node;
            this.myOffset = offset;
        }

        @Override
        public int getOffset() {
            return myOffset;
        }

        @Override
        public int getLine() {
            ensureLineInitialized();
            return myLine;
        }

        @Override
        public int getColumn() {
            ensureLineInitialized();
            return myColumn;
        }

        private void ensureLineInitialized() {
            if (myInitialized) {
                return;
            }
            myInitialized = true;
            initializeLineColumn();
        }

        private void initializeLineColumn() {
            if (myNode != null) {
                XmlElement element = AndroidDomPsiConverter.getPsiElement(myNode);
                if (element != null) {
                    PsiFile file = element.getContainingFile();
                    if (file != null && file.isValid()) {
                        String contents = file.getText();
                        initializeFromText(contents);
                        return;
                    }
                }
                Document document = myNode.getOwnerDocument();
                if (document != null) {
                    String text = (String) document.getUserData(PositionXmlParser.CONTENT_KEY);
                    if (text == null) {
                        text = (String) document.getUserData("contents");
                    }
                    if (text != null) {
                        initializeFromText(text);
                        return;
                    }
                    File file = (File) document.getUserData(File.class.getName());
                    if (file != null) {
                        try {
                            String contents = Files.readString(file.toPath());
                            initializeFromText(contents);
                            return;
                        } catch (Exception ignored) {
                        }
                    }
                }
            }
            myLine = 0;
            myColumn = myOffset;
        }

        public void initializeFromText(@NotNull String contents) {
            int offset = myOffset;
            myLine = 0;
            offset = Math.min(offset, contents.length());
            int lineOffset = 0;
            char prev = 0;
            for (int currentOffset = 0; currentOffset < offset; currentOffset++) {
                char c = contents.charAt(currentOffset);
                if (c == '\n') {
                    lineOffset = currentOffset + 1;
                    if (prev != '\r') {
                        myLine++;
                    }
                } else if (c == '\r') {
                    myLine++;
                    lineOffset = currentOffset + 1;
                }
                prev = c;
            }
            myColumn = offset - lineOffset;
        }
    }
}
