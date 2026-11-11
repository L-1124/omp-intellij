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

import com.android.ide.common.blame.SourcePosition
import com.android.tools.lint.detector.api.Position
import com.android.utils.PositionXmlParser
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.util.Computable
import com.intellij.openapi.util.TextRange
import com.intellij.openapi.vfs.VfsUtilCore
import com.intellij.psi.PsiElement
import com.intellij.psi.PsiFile
import com.intellij.psi.XmlRecursiveElementVisitor
import com.intellij.psi.util.PsiTreeUtil
import com.intellij.psi.xml.XmlAttribute
import com.intellij.psi.xml.XmlComment
import com.intellij.psi.xml.XmlDocument
import com.intellij.psi.xml.XmlElement
import com.intellij.psi.xml.XmlFile
import com.intellij.psi.xml.XmlTag
import com.intellij.psi.xml.XmlText
import org.w3c.dom.Attr
import org.w3c.dom.CDATASection
import org.w3c.dom.Comment
import org.w3c.dom.DOMConfiguration
import org.w3c.dom.DOMException
import org.w3c.dom.DOMImplementation
import org.w3c.dom.Document
import org.w3c.dom.DocumentFragment
import org.w3c.dom.DocumentType
import org.w3c.dom.Element
import org.w3c.dom.EntityReference
import org.w3c.dom.NamedNodeMap
import org.w3c.dom.Node
import org.w3c.dom.NodeList
import org.w3c.dom.ProcessingInstruction
import org.w3c.dom.Text
import org.w3c.dom.TypeInfo
import org.w3c.dom.UserDataHandler
import java.io.File
import java.nio.file.Files
import java.util.ArrayList
import java.util.HashMap

/**
 * Converter which takes a PSI hierarchy for an XML file or document, and
 * creates a read-only DOM representation suitable for Android Lint detectors.
 */
class AndroidDomPsiConverter private constructor() {
    companion object {
        private val EMPTY_NODE_LIST = AndroidDomNodeList(emptyArray())

        private val EMPTY_ATTRIBUTES: NamedNodeMap = object : NamedNodeMap {
            override fun getLength(): Int = 0
            override fun getNamedItem(name: String?): Node? = null
            override fun getNamedItemNS(namespaceURI: String?, localName: String?): Node? = null
            override fun setNamedItem(arg: Node?): Node = throw UnsupportedOperationException("Read-only DOM bridge")
            override fun removeNamedItem(name: String?): Node =
                throw UnsupportedOperationException("Read-only DOM bridge")

            override fun item(index: Int): Node? = null
            override fun setNamedItemNS(arg: Node?): Node = throw UnsupportedOperationException("Read-only DOM bridge")
            override fun removeNamedItemNS(namespaceURI: String?, localName: String?): Node =
                throw UnsupportedOperationException("Read-only DOM bridge")
        }

        private fun <T> readAction(computable: () -> T): T {
            val app = ApplicationManager.getApplication()
            return if (app != null && !app.isReadAccessAllowed) {
                app.runReadAction(Computable { computable() })
            } else {
                computable()
            }
        }

        /**
         * Converts the given [XmlFile] to a DOM [Document].
         */
        @JvmStatic
        fun convert(xmlFile: XmlFile?): Document? {
            if (xmlFile == null) return null
            ProgressManager.checkCanceled()
            val xmlDocument = readAction { xmlFile.document } ?: return null
            return AndroidDomDocument(xmlDocument, xmlFile)
        }

        /**
         * Returns the [TextRange] for a given [Node].
         */
        @JvmStatic
        fun getTextRange(node: Node): TextRange {
            if (node !is AndroidDomNode) {
                val position = PositionXmlParser.getPosition(node)
                if (position != null && position != SourcePosition.UNKNOWN) {
                    return TextRange(position.startOffset, position.endOffset)
                }
                return TextRange(0, 0)
            }
            return node.getTextRange()
        }

        /**
         * Trims whitespace from the given node range for text nodes.
         */
        @JvmStatic
        fun trim(node: Node, range: TextRange): TextRange {
            if (node.nodeType == Node.TEXT_NODE && node is AndroidDomText) {
                val text = node.myElement.text
                if (!text.isNullOrEmpty()) {
                    var i = 0
                    while (i < text.length && Character.isWhitespace(text[i])) {
                        i++
                    }
                    var j = text.length
                    while (j > i && Character.isWhitespace(text[j - 1])) {
                        j--
                    }
                    return TextRange.create(range.startOffset + i, range.startOffset + j)
                }
            }
            return range
        }

        /**
         * Gets the [TextRange] for the name of the given [Node].
         */
        @JvmStatic
        fun getTextNameRange(node: Node): TextRange {
            if (node !is AndroidDomNode) {
                val range = getTextRange(node)
                if (node.nodeType == Node.ELEMENT_NODE) {
                    val tag = node.nodeName
                    val start = range.startOffset + 1
                    return TextRange(start, start + (tag?.length ?: 0))
                } else if (node.nodeType == Node.ATTRIBUTE_NODE) {
                    val name = node.nodeName
                    val start = range.startOffset
                    return TextRange(start, start + (name?.length ?: 0))
                }
                return range
            }

            val element = node.myElement

            if (node.nodeType == Node.ELEMENT_NODE && element is XmlTag) {
                val tag = node.nodeName
                val text = element.text
                if (tag != null && text != null) {
                    val index = text.indexOf(tag)
                    if (index != -1) {
                        val textRange = element.textRange
                        val start = textRange.startOffset + index
                        return TextRange(start, start + tag.length)
                    }
                }
            } else if (node.nodeType == Node.ATTRIBUTE_NODE && element is XmlAttribute) {
                val nameElement = element.nameElement
                if (nameElement != null) {
                    return nameElement.textRange
                }
            }

            return element.textRange
        }

        /**
         * Gets the [TextRange] for the value of the given [Node].
         */
        @JvmStatic
        fun getTextValueRange(node: Node): TextRange {
            if (node !is AndroidDomNode) {
                val range = getTextRange(node)
                if (node.nodeType == Node.ATTRIBUTE_NODE) {
                    val ownerDoc = node.ownerDocument
                    var contents = ownerDoc?.getUserData(PositionXmlParser.CONTENT_KEY) as? String
                    if (contents == null && ownerDoc != null) {
                        contents = ownerDoc.getUserData("contents") as? String
                    }
                    if (contents != null) {
                        var startOffset = range.startOffset
                        var endOffset = range.endOffset
                        val docLen = contents.length
                        startOffset = startOffset.coerceIn(0, docLen)
                        endOffset = endOffset.coerceIn(startOffset, docLen)
                        val eq = contents.indexOf('=', startOffset)
                        if (eq != -1 && eq < endOffset) {
                            var quoteStart = eq + 1
                            while (quoteStart < endOffset && Character.isWhitespace(contents[quoteStart])) {
                                quoteStart++
                            }
                            if (quoteStart < endOffset) {
                                val quote = contents[quoteStart]
                                if (quote == '"' || quote == '\'') {
                                    val valueStart = quoteStart + 1
                                    var valueEnd = endOffset
                                    if (valueEnd > valueStart && contents[valueEnd - 1] == quote) {
                                        valueEnd--
                                    } else {
                                        val closing = contents.indexOf(quote, valueStart)
                                        if (closing != -1 && closing <= endOffset) {
                                            valueEnd = closing
                                        }
                                    }
                                    return TextRange(valueStart, valueEnd)
                                }
                            }
                        }
                    }
                    val value = node.nodeValue
                    val end = range.endOffset - 1
                    val start = end - (value?.length ?: 0)
                    if (start >= range.startOffset) {
                        return TextRange(start, end)
                    }
                }
                return range
            }

            val element = node.myElement
            val textRange = element.textRange

            if (node.nodeType == Node.ATTRIBUTE_NODE && element is XmlAttribute) {
                val valueElement = element.valueElement
                if (valueElement != null) {
                    return valueElement.valueTextRange
                }
            }

            return textRange
        }

        /**
         * Extracts the underlying [XmlElement] if node was produced by this converter.
         */
        @JvmStatic
        fun getPsiElement(node: Node): XmlElement? {
            if (node is AndroidDomNode) {
                return node.myElement
            }
            return null
        }

        /**
         * Locates the leaf node at the given offset within the DOM hierarchy.
         */
        @JvmStatic
        fun findNodeAt(node: Node?, offset: Int): Node? {
            var current = node ?: return null
            if (current is Document) {
                current = current.documentElement ?: return null
            }
            if (current !is AndroidDomNode) {
                return null
            }
            return findNodeAt(current, offset)
        }

        @JvmStatic
        fun findNodeAt(element: AndroidDomNode, offset: Int): Node? {
            val range = element.getTextRange()
            if (!range.containsOffset(offset)) {
                return null
            }

            var node: AndroidDomNode = element
            while (true) {
                ProgressManager.checkCanceled()
                val children = node.getChildNodes()
                val count = children.length
                if (count == 0) {
                    return checkAttributesOrNode(node, offset)
                }

                var candidate = -1
                var low = 0
                var high = count - 1
                while (low <= high) {
                    val mid = (low + high) ushr 1
                    val child = children.item(mid)
                    val childRange = child?.getTextRange()
                    if (childRange != null && childRange.startOffset <= offset) {
                        candidate = mid
                        low = mid + 1
                    } else {
                        high = mid - 1
                    }
                }

                if (candidate == -1) {
                    return checkAttributesOrNode(node, offset)
                }
                val candidateChild = children.item(candidate)
                val candidateRange = candidateChild?.getTextRange()
                if (candidateRange == null || !candidateRange.containsOffset(offset)) {
                    return checkAttributesOrNode(node, offset)
                }
                node = candidateChild
            }
        }

        private fun checkAttributesOrNode(node: AndroidDomNode, offset: Int): Node {
            if (node is AndroidDomElement) {
                val attributes = node.attributes
                if (attributes is AndroidDomNamedNodeMap) {
                    for (attribute in attributes.items) {
                        val attrRange = attribute.getTextRange()
                        if (attrRange.containsOffset(offset)) {
                            return attribute
                        }
                    }
                }
            }
            return node
        }
    }

    /**
     * Base class for all DOM nodes backed by XML PSI.
     */
    abstract class AndroidDomNode protected constructor(
        @JvmField internal val myOwner: Document?,
        @JvmField internal val myParent: AndroidDomNode?,
        @JvmField internal val myElement: XmlElement
    ) : Node {
        @JvmField
        internal var myChildren: AndroidDomNodeList? = null

        @JvmField
        internal var myNext: AndroidDomNode? = null

        @JvmField
        internal var myPrevious: AndroidDomNode? = null

        @JvmField
        internal var myRange: TextRange? = null

        @JvmField
        protected var myUserData: MutableMap<String, Any?>? = null

        override fun getParentNode(): Node? = myParent

        override fun getChildNodes(): AndroidDomNodeList {
            var children = myChildren
            if (children == null) {
                ProgressManager.checkCanceled()
                var child = myElement.firstChild
                if (child == null) {
                    myChildren = EMPTY_NODE_LIST
                    return EMPTY_NODE_LIST
                }

                val list = AndroidDomNodeList.Builder()
                val range = getTextRange()
                var offset = range.startOffset
                val ownerDoc = myOwner ?: (this as Document)
                while (child != null) {
                    ProgressManager.checkCanceled()
                    val length = child.textLength
                    val node: AndroidDomNode? = when (child) {
                        is XmlTag -> AndroidDomElement(ownerDoc, this, child)
                        is XmlText -> AndroidDomText(ownerDoc, this, child)
                        is XmlComment -> AndroidDomComment(ownerDoc, this, child)
                        else -> null
                    }
                    if (node != null) {
                        node.myRange = TextRange(offset, offset + length)
                        list.add(node, true)
                    }
                    offset += length
                    child = child.nextSibling
                }
                children = list.build()
                myChildren = children
            }
            return children
        }

        override fun getFirstChild(): Node? {
            val childNodes = childNodes
            return if (childNodes.length > 0) childNodes.item(0) else null
        }

        override fun getLastChild(): Node? {
            val childNodes = childNodes
            return if (childNodes.length > 0) childNodes.item(childNodes.length - 1) else null
        }

        override fun getPreviousSibling(): Node? = myPrevious

        override fun getNextSibling(): Node? = myNext

        override fun getAttributes(): NamedNodeMap? = null

        override fun getOwnerDocument(): Document? = myOwner

        override fun insertBefore(newChild: Node?, refChild: Node?): Node =
            throw UnsupportedOperationException("Read-only DOM bridge")

        override fun replaceChild(newChild: Node?, oldChild: Node?): Node =
            throw UnsupportedOperationException("Read-only DOM bridge")

        override fun removeChild(oldChild: Node?): Node =
            throw UnsupportedOperationException("Read-only DOM bridge")

        override fun appendChild(newChild: Node?): Node =
            throw UnsupportedOperationException("Read-only DOM bridge")

        override fun hasChildNodes(): Boolean = childNodes.length > 0

        override fun cloneNode(deep: Boolean): Node =
            throw UnsupportedOperationException("Read-only DOM bridge")

        override fun normalize() {}

        override fun isSupported(feature: String?, version: String?): Boolean = false

        override fun getNamespaceURI(): String? = null

        override fun getPrefix(): String? = null

        override fun setPrefix(prefix: String?) {
            throw UnsupportedOperationException("Read-only DOM bridge")
        }

        override fun getLocalName(): String? = null

        override fun hasAttributes(): Boolean = false

        override fun getBaseURI(): String? = null

        override fun compareDocumentPosition(other: Node?): Short =
            throw UnsupportedOperationException("Not supported")

        override fun setTextContent(textContent: String?) {
            throw UnsupportedOperationException("Read-only DOM bridge")
        }

        override fun isSameNode(other: Node?): Boolean = this === other

        override fun lookupPrefix(namespaceURI: String?): String? {
            val tag = PsiTreeUtil.getParentOfType(myElement, XmlTag::class.java, false)
            return tag?.getPrefixByNamespace(namespaceURI ?: "")
        }

        override fun isDefaultNamespace(namespaceURI: String?): Boolean {
            val defaultUri = lookupNamespaceURI(null)
            return defaultUri != null && defaultUri == namespaceURI
        }

        override fun lookupNamespaceURI(prefix: String?): String? {
            val tag = PsiTreeUtil.getParentOfType(myElement, XmlTag::class.java, false)
            return tag?.getNamespaceByPrefix(prefix ?: "")
        }

        override fun isEqualNode(arg: Node?): Boolean = this == arg

        override fun getFeature(feature: String?, version: String?): Any? = null

        override fun setUserData(key: String?, data: Any?, handler: UserDataHandler?): Any? {
            if (key == null) return null
            var map = myUserData
            if (map == null) {
                if (data == null) {
                    return null
                }
                map = HashMap()
                myUserData = map
            }
            return if (data != null) {
                map.put(key, data)
            } else {
                map.remove(key)
            }
        }

        override fun getUserData(key: String?): Any? {
            if (key == null) return null
            val map = myUserData
            return if (map != null && map.containsKey(key)) {
                map[key]
            } else {
                null
            }
        }

        override fun setNodeValue(nodeValue: String?) {
            throw UnsupportedOperationException("Read-only DOM bridge")
        }

        fun getTextRange(): TextRange {
            var range = myRange
            if (range == null) {
                range = myElement.textRange
                myRange = range
            }
            return range
        }

        // From CharacterData
        open fun getData(): String = throw UnsupportedOperationException("Read-only DOM bridge")

        open fun setData(data: String?) {
            throw UnsupportedOperationException("Read-only DOM bridge")
        }

        open fun getLength(): Int = myElement.textLength

        open fun substringData(offset: Int, count: Int): String =
            throw UnsupportedOperationException("Read-only DOM bridge")

        open fun appendData(arg: String?) {
            throw UnsupportedOperationException("Read-only DOM bridge")
        }

        open fun insertData(offset: Int, arg: String?) {
            throw UnsupportedOperationException("Read-only DOM bridge")
        }

        open fun deleteData(offset: Int, count: Int) {
            throw UnsupportedOperationException("Read-only DOM bridge")
        }

        open fun replaceData(offset: Int, count: Int, arg: String?) {
            throw UnsupportedOperationException("Read-only DOM bridge")
        }
    }

    /**
     * DOM Document adapter wrapping [XmlDocument].
     */
    open class AndroidDomDocument(
        @JvmField internal val myPsiDocument: XmlDocument,
        @JvmField internal val myFile: XmlFile
    ) : AndroidDomNode(null, null, myPsiDocument), Document {
        private var myRoot: AndroidDomElement? = null

        override fun getNodeName(): String = "#document"

        override fun getNodeValue(): String? = null

        override fun getNodeType(): Short = Node.DOCUMENT_NODE

        override fun getChildNodes(): AndroidDomNodeList {
            var children = myChildren
            if (children == null) {
                ProgressManager.checkCanceled()
                val list = AndroidDomNodeList.Builder()
                var element = myPsiDocument.firstChild
                while (element != null) {
                    ProgressManager.checkCanceled()
                    when (element) {
                        is XmlTag -> {
                            val root = myRoot
                            if (root != null && root.myTag === element) {
                                list.add(root, true)
                            } else {
                                val node = AndroidDomElement(this, this, element)
                                if (myRoot == null) {
                                    myRoot = node
                                }
                                list.add(node, true)
                            }
                        }

                        is XmlComment -> {
                            val node = AndroidDomComment(this, this, element)
                            list.add(node, true)
                        }

                        is XmlText -> {
                            val node = AndroidDomText(this, this, element)
                            list.add(node, true)
                        }
                    }
                    element = element.nextSibling
                }
                children = list.build()
                myChildren = children
            }
            return children
        }

        override fun getDocumentElement(): Element? {
            if (myRoot == null) {
                val rootTag = readAction { myPsiDocument.rootTag } ?: return null
                myRoot = AndroidDomElement(this, this, rootTag)
            }
            return myRoot
        }

        override fun getElementsByTagName(tagname: String?): NodeList {
            val root = documentElement
            if (root != null) {
                val list = AndroidDomNodeList.Builder()
                if ("*" == tagname || tagname == root.nodeName) {
                    list.add(root as AndroidDomNode, false)
                }
                val descendants = root.getElementsByTagName(tagname)
                val len = descendants.length
                for (i in 0 until len) {
                    val item = descendants.item(i)
                    if (item is AndroidDomNode) {
                        list.add(item, false)
                    }
                }
                return list.build()
            }
            return EMPTY_NODE_LIST
        }

        override fun getUserData(key: String?): Any? {
            val custom = super.getUserData(key)
            if (custom != null) {
                return custom
            }
            if (PsiFile::class.java.name == key) {
                return myFile
            }
            if (File::class.java.name == key) {
                val vf = myFile.virtualFile
                return if (vf != null) VfsUtilCore.virtualToIoFile(vf) else null
            }
            if (PositionXmlParser.CONTENT_KEY == key || "contents" == key) {
                return readAction { myFile.text }
            }
            return null
        }

        override fun getTextContent(): String? = null

        override fun getDoctype(): DocumentType? = null

        override fun getImplementation(): DOMImplementation =
            throw UnsupportedOperationException("Not supported")

        override fun createElement(tagName: String?): Element =
            throw UnsupportedOperationException("Read-only DOM bridge")

        override fun createDocumentFragment(): DocumentFragment =
            throw UnsupportedOperationException("Read-only DOM bridge")

        override fun createTextNode(data: String?): Text =
            throw UnsupportedOperationException("Read-only DOM bridge")

        override fun createComment(data: String?): Comment =
            throw UnsupportedOperationException("Read-only DOM bridge")

        override fun createCDATASection(data: String?): CDATASection =
            throw UnsupportedOperationException("Read-only DOM bridge")

        override fun createProcessingInstruction(target: String?, data: String?): ProcessingInstruction =
            throw UnsupportedOperationException("Read-only DOM bridge")

        override fun createAttribute(name: String?): Attr =
            throw UnsupportedOperationException("Read-only DOM bridge")

        override fun createEntityReference(name: String?): EntityReference =
            throw UnsupportedOperationException("Read-only DOM bridge")

        override fun importNode(importedNode: Node?, deep: Boolean): Node =
            throw UnsupportedOperationException("Read-only DOM bridge")

        override fun createElementNS(namespaceURI: String?, qualifiedName: String?): Element =
            throw UnsupportedOperationException("Read-only DOM bridge")

        override fun createAttributeNS(namespaceURI: String?, qualifiedName: String?): Attr =
            throw UnsupportedOperationException("Read-only DOM bridge")

        override fun getElementsByTagNameNS(namespaceURI: String?, localName: String?): NodeList =
            throw UnsupportedOperationException("Not supported")

        override fun getElementById(elementId: String?): Element? =
            throw UnsupportedOperationException("Not supported")

        override fun getInputEncoding(): String? = "UTF-8"

        override fun getXmlEncoding(): String? = "UTF-8"

        override fun getXmlStandalone(): Boolean = false

        override fun setXmlStandalone(xmlStandalone: Boolean) {
            throw UnsupportedOperationException("Read-only DOM bridge")
        }

        override fun getXmlVersion(): String? = "1.0"

        override fun setXmlVersion(xmlVersion: String?) {
            throw UnsupportedOperationException("Read-only DOM bridge")
        }

        override fun getStrictErrorChecking(): Boolean = false

        override fun setStrictErrorChecking(strictErrorChecking: Boolean) {
            throw UnsupportedOperationException("Read-only DOM bridge")
        }

        override fun getDocumentURI(): String? = myFile.virtualFile?.url

        override fun setDocumentURI(documentURI: String?) {
            throw UnsupportedOperationException("Not supported")
        }

        override fun adoptNode(source: Node?): Node =
            throw UnsupportedOperationException("Read-only DOM bridge")

        override fun getDomConfig(): DOMConfiguration =
            throw UnsupportedOperationException("Not supported")

        override fun normalizeDocument() {}

        override fun renameNode(n: Node?, namespaceURI: String?, qualifiedName: String?): Node =
            throw UnsupportedOperationException("Not supported")
    }

    /**
     * DOM Element adapter wrapping [XmlTag].
     */
    open class AndroidDomElement(
        owner: Document,
        parent: AndroidDomNode,
        @JvmField internal val myTag: XmlTag
    ) : AndroidDomNode(owner, parent, myTag), Element {
        private var myAttributes: NamedNodeMap? = null

        private class NodeWithIndex(
            val node: Node,
            var nextNodeIndex: Int = 0
        )

        override fun getNodeName(): String = tagName

        override fun getNodeValue(): String? = null

        override fun getNodeType(): Short = Node.ELEMENT_NODE

        override fun getPrefix(): String? {
            val prefix = readAction { myTag.namespacePrefix }
            return if (prefix.isEmpty()) null else prefix
        }

        override fun getNamespaceURI(): String? {
            val ns = readAction { myTag.namespace }
            return if (ns.isEmpty()) null else ns
        }

        override fun getAttributes(): NamedNodeMap {
            val attrs = readAction {
                if (myAttributes == null) {
                    val attributes = myTag.attributes
                    myAttributes = if (attributes.isEmpty()) {
                        EMPTY_ATTRIBUTES
                    } else {
                        AndroidDomNamedNodeMap(this, attributes)
                    }
                }
                myAttributes
            }
            return attrs ?: EMPTY_ATTRIBUTES
        }

        override fun hasAttributes(): Boolean = attributes.length > 0

        override fun getTextContent(): String {
            val child = myElement.firstChild
            if (child is XmlText && child.nextSibling == null) {
                return child.value
            }

            val buffer = StringBuilder()
            myElement.acceptChildren(object : XmlRecursiveElementVisitor() {
                override fun visitXmlText(text: XmlText) {
                    buffer.append(text.value)
                }
            })
            return buffer.toString()
        }

        override fun getTagName(): String = readAction { myTag.name }

        override fun getLocalName(): String = readAction { myTag.localName }

        override fun getAttribute(name: String?): String {
            if (name == null) return ""
            val node = attributes.getNamedItem(name)
            if (node != null) {
                val value = node.nodeValue
                return value ?: ""
            }
            return ""
        }

        override fun getAttributeNS(namespaceURI: String?, localName: String?): String {
            if (localName == null) return ""
            val node = attributes.getNamedItemNS(namespaceURI, localName)
            if (node != null) {
                val value = node.nodeValue
                return value ?: ""
            }
            return ""
        }

        override fun getAttributeNode(name: String?): Attr? {
            if (name == null) return null
            val node = attributes.getNamedItem(name)
            return if (node is Attr) node else null
        }

        override fun getAttributeNodeNS(namespaceURI: String?, localName: String?): Attr? {
            if (localName == null) return null
            val node = attributes.getNamedItemNS(namespaceURI, localName)
            return if (node is Attr) node else null
        }

        override fun hasAttribute(name: String?): Boolean {
            if (name == null) return false
            return attributes.getNamedItem(name) != null
        }

        override fun hasAttributeNS(namespaceURI: String?, localName: String?): Boolean {
            if (localName == null) return false
            return attributes.getNamedItemNS(namespaceURI, localName) != null
        }

        override fun getElementsByTagName(name: String?): NodeList {
            if (name == null || childNodes.length == 0) {
                return EMPTY_NODE_LIST
            }

            val matches = AndroidDomNodeList.Builder()
            val stack = ArrayList<NodeWithIndex>()
            stack.add(NodeWithIndex(this))

            while (stack.isNotEmpty()) {
                ProgressManager.checkCanceled()
                val top = stack[stack.size - 1]
                val childNodes = top.node.childNodes
                if (top.nextNodeIndex < childNodes.length) {
                    val next = childNodes.item(top.nextNodeIndex++)
                    if (next is AndroidDomElement) {
                        if ("*" == name || name == next.nodeName) {
                            matches.add(next, false)
                        }
                        stack.add(NodeWithIndex(next))
                    }
                } else {
                    stack.removeAt(stack.size - 1)
                }
            }

            return matches.build()
        }

        override fun getElementsByTagNameNS(namespaceURI: String?, localName: String?): NodeList =
            throw UnsupportedOperationException("Not supported")

        override fun setAttributeNode(newAttr: Attr?): Attr =
            throw UnsupportedOperationException("Read-only DOM bridge")

        override fun removeAttributeNode(oldAttr: Attr?): Attr =
            throw UnsupportedOperationException("Read-only DOM bridge")

        override fun setAttribute(name: String?, value: String?) {
            throw UnsupportedOperationException("Read-only DOM bridge")
        }

        override fun removeAttribute(name: String?) {
            throw UnsupportedOperationException("Read-only DOM bridge")
        }

        override fun setAttributeNS(namespaceURI: String?, qualifiedName: String?, value: String?) {
            throw UnsupportedOperationException("Read-only DOM bridge")
        }

        override fun removeAttributeNS(namespaceURI: String?, localName: String?) {
            throw UnsupportedOperationException("Read-only DOM bridge")
        }

        override fun setAttributeNodeNS(newAttr: Attr?): Attr =
            throw UnsupportedOperationException("Read-only DOM bridge")

        override fun getSchemaTypeInfo(): TypeInfo =
            throw UnsupportedOperationException("Not supported")

        override fun setIdAttribute(name: String?, isId: Boolean) {
            throw UnsupportedOperationException("Read-only DOM bridge")
        }

        override fun setIdAttributeNS(namespaceURI: String?, localName: String?, isId: Boolean) {
            throw UnsupportedOperationException("Read-only DOM bridge")
        }

        override fun setIdAttributeNode(idAttr: Attr?, isId: Boolean) {
            throw UnsupportedOperationException("Read-only DOM bridge")
        }

        override fun toString(): String =
            "AndroidDomElement(${myTag.name} at ${myTag.textRange})"
    }

    /**
     * DOM Attr adapter wrapping [XmlAttribute].
     */
    open class AndroidDomAttr(
        document: Document,
        @JvmField internal val myOwnerElement: AndroidDomElement,
        @JvmField internal val myAttribute: XmlAttribute
    ) : AndroidDomNode(document, null, myAttribute), Attr {

        override fun getNodeName(): String = name

        override fun getNodeValue(): String = value

        override fun getNodeType(): Short = Node.ATTRIBUTE_NODE

        override fun getTextContent(): String = ""

        override fun getName(): String = readAction { myAttribute.name }

        override fun getSpecified(): Boolean = true

        override fun getValue(): String = readAction {
            val displayVal = myAttribute.displayValue
            displayVal ?: myAttribute.value ?: ""
        }

        override fun getLocalName(): String = readAction { myAttribute.localName }

        override fun getPrefix(): String? {
            val prefix = readAction { myAttribute.namespacePrefix }
            return if (prefix.isEmpty()) null else prefix
        }

        override fun getNamespaceURI(): String? {
            val ns = readAction { myAttribute.namespace }
            return if (ns.isEmpty()) null else ns
        }

        override fun setValue(value: String?) {
            throw UnsupportedOperationException("Read-only DOM bridge")
        }

        override fun getOwnerElement(): Element = myOwnerElement

        override fun getSchemaTypeInfo(): TypeInfo =
            throw UnsupportedOperationException("Not supported")

        override fun isId(): Boolean = "id" == localName

        override fun toString(): String =
            "AndroidDomAttr(${name}=${value} at ${myElement.textRange})"
    }

    /**
     * DOM Text adapter wrapping [XmlText].
     */
    open class AndroidDomText(
        owner: Document,
        parent: AndroidDomNode,
        @JvmField internal val myText: XmlText
    ) : AndroidDomNode(owner, parent, myText), Text {

        override fun getNodeName(): String = "#text"

        override fun getNodeValue(): String = readAction { myText.text }

        override fun getNodeType(): Short = Node.TEXT_NODE

        override fun getTextContent(): String = readAction { myText.value }

        override fun getData(): String = nodeValue

        override fun setData(data: String?) {
            super.setData(data)
        }

        override fun getLength(): Int = super.getLength()

        override fun substringData(offset: Int, count: Int): String =
            super.substringData(offset, count)

        override fun appendData(arg: String?) {
            super.appendData(arg)
        }

        override fun insertData(offset: Int, arg: String?) {
            super.insertData(offset, arg)
        }

        override fun deleteData(offset: Int, count: Int) {
            super.deleteData(offset, count)
        }

        override fun replaceData(offset: Int, count: Int, arg: String?) {
            super.replaceData(offset, count, arg)
        }

        override fun splitText(offset: Int): Text =
            throw UnsupportedOperationException("Read-only DOM bridge")

        override fun isElementContentWhitespace(): Boolean {
            val s = readAction { myText.text } ?: return true
            for (i in 0 until s.length) {
                if (!Character.isWhitespace(s[i])) {
                    return false
                }
            }
            return true
        }

        override fun getWholeText(): String =
            throw UnsupportedOperationException("Not supported")

        override fun replaceWholeText(content: String?): Text =
            throw UnsupportedOperationException("Read-only DOM bridge")

        override fun toString(): String =
            "AndroidDomText(${textContent} at ${myElement.textRange})"
    }

    /**
     * DOM Comment adapter wrapping [XmlComment].
     */
    open class AndroidDomComment(
        owner: Document,
        parent: AndroidDomNode,
        @JvmField internal val myComment: XmlComment
    ) : AndroidDomNode(owner, parent, myComment), Comment {

        override fun getNodeName(): String = "#comment"

        override fun getNodeValue(): String = readAction { myComment.commentText }

        override fun getNodeType(): Short = Node.COMMENT_NODE

        override fun getTextContent(): String = nodeValue

        override fun getData(): String = nodeValue

        override fun setData(data: String?) {
            super.setData(data)
        }

        override fun getLength(): Int = super.getLength()

        override fun substringData(offset: Int, count: Int): String =
            super.substringData(offset, count)

        override fun appendData(arg: String?) {
            super.appendData(arg)
        }

        override fun insertData(offset: Int, arg: String?) {
            super.insertData(offset, arg)
        }

        override fun deleteData(offset: Int, count: Int) {
            super.deleteData(offset, count)
        }

        override fun replaceData(offset: Int, count: Int, arg: String?) {
            super.replaceData(offset, count, arg)
        }

        override fun toString(): String =
            "AndroidDomComment(${nodeValue} at ${myElement.textRange})"
    }

    /**
     * NamedNodeMap adapter for attribute collections.
     */
    open class AndroidDomNamedNodeMap(
        element: AndroidDomElement,
        attributes: Array<XmlAttribute>
    ) : NamedNodeMap {
        @JvmField
        protected val myMap: MutableMap<String, AndroidDomNode>

        @JvmField
        protected val myNsMap: MutableMap<String, MutableMap<String, AndroidDomNode>>

        @JvmField
        protected val mItems: MutableList<AndroidDomNode>

        init {
            val count = attributes.size
            var namespaceCount = 0
            for (attribute in attributes) {
                if (attribute.namespace.isNotEmpty()) {
                    namespaceCount++
                }
            }
            myMap = HashMap(count)
            myNsMap = HashMap(namespaceCount)
            mItems = ArrayList(count)

            val ownerDoc = element.myOwner ?: (element as Document)
            for (attribute in attributes) {
                val attr = AndroidDomAttr(ownerDoc, element, attribute)
                mItems.add(attr)
                myMap[attribute.name] = attr
                val namespace = attribute.namespace
                if (namespace.isNotEmpty()) {
                    val map = myNsMap.computeIfAbsent(namespace) { HashMap() }
                    map[attribute.localName] = attr
                }
            }
        }

        val items: List<AndroidDomNode> get() = mItems

        override fun item(index: Int): Node? {
            if (index < 0 || index >= mItems.size) {
                return null
            }
            return mItems[index]
        }

        override fun getLength(): Int = mItems.size

        override fun getNamedItem(name: String?): Node? {
            if (name == null) return null
            return myMap[name]
        }

        override fun getNamedItemNS(namespaceURI: String?, localName: String?): Node? {
            if (localName == null) return null
            if (namespaceURI.isNullOrEmpty()) {
                val node = getNamedItem(localName)
                return if (node != null && node.namespaceURI.isNullOrEmpty()) node else null
            }
            val map = myNsMap[namespaceURI]
            return map?.get(localName)
        }

        override fun setNamedItem(arg: Node?): Node =
            throw UnsupportedOperationException("Read-only DOM bridge")

        override fun removeNamedItem(name: String?): Node =
            throw UnsupportedOperationException("Read-only DOM bridge")

        override fun setNamedItemNS(arg: Node?): Node =
            throw UnsupportedOperationException("Read-only DOM bridge")

        override fun removeNamedItemNS(namespaceURI: String?, localName: String?): Node =
            throw UnsupportedOperationException("Read-only DOM bridge")
    }

    /**
     * NodeList implementation backed by an array of [AndroidDomNode].
     */
    class AndroidDomNodeList internal constructor(
        private val myChildren: Array<AndroidDomNode>
    ) : NodeList {
        override fun item(index: Int): AndroidDomNode? {
            if (index < 0 || index >= myChildren.size) {
                return null
            }
            return myChildren[index]
        }

        override fun getLength(): Int = myChildren.size

        internal class Builder {
            private val myChildren = ArrayList<AndroidDomNode>()

            fun add(node: AndroidDomNode, updateSiblings: Boolean) {
                if (updateSiblings) {
                    val size = myChildren.size
                    if (size > 0) {
                        val last = myChildren[size - 1]
                        node.myPrevious = last
                        last.myNext = node
                    }
                }
                myChildren.add(node)
            }

            fun build(): AndroidDomNodeList {
                return AndroidDomNodeList(myChildren.toTypedArray())
            }
        }
    }

    /**
     * Lazy line and column calculator for XML positions supporting CRLF, emoji, and multi-line values.
     */
    open class AndroidLintXmlPosition(
        private val myNode: Node?,
        private val myOffset: Int
    ) : Position() {
        private var myLine = -1
        private var myColumn = -1
        private var myInitialized = false

        override val offset: Int
            get() = myOffset

        override val line: Int
            get() {
                ensureLineInitialized()
                return myLine
            }

        override val column: Int
            get() {
                ensureLineInitialized()
                return myColumn
            }

        private fun ensureLineInitialized() {
            if (myInitialized) {
                return
            }
            myInitialized = true
            initializeLineColumn()
        }

        private fun initializeLineColumn() {
            if (myNode != null) {
                val element = getPsiElement(myNode)
                if (element != null) {
                    val file = element.containingFile
                    if (file != null && file.isValid) {
                        val contents = file.text
                        if (contents != null) {
                            initializeFromText(contents)
                            return
                        }
                    }
                }
                val document = myNode.ownerDocument
                if (document != null) {
                    var text = document.getUserData(PositionXmlParser.CONTENT_KEY) as? String
                    if (text == null) {
                        text = document.getUserData("contents") as? String
                    }
                    if (text != null) {
                        initializeFromText(text)
                        return
                    }
                    val file = document.getUserData(File::class.java.name) as? File
                    if (file != null) {
                        try {
                            val contents = Files.readString(file.toPath())
                            initializeFromText(contents)
                            return
                        } catch (_: Exception) {
                        }
                    }
                }
            }
            myLine = 0
            myColumn = myOffset
        }

        fun initializeFromText(contents: String) {
            var offset = myOffset
            myLine = 0
            offset = Math.min(offset, contents.length)
            var lineOffset = 0
            var prev: Char = 0.toChar()
            for (currentOffset in 0 until offset) {
                val c = contents[currentOffset]
                if (c == '\n') {
                    lineOffset = currentOffset + 1
                    if (prev != '\r') {
                        myLine++
                    }
                } else if (c == '\r') {
                    myLine++
                    lineOffset = currentOffset + 1
                }
                prev = c
            }
            myColumn = offset - lineOffset
        }
    }
}
