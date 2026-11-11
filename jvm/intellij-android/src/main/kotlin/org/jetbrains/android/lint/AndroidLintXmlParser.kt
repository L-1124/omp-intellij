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
import com.android.tools.lint.client.api.LintClient
import com.android.tools.lint.client.api.XmlParser
import com.android.tools.lint.detector.api.DefaultPosition
import com.android.tools.lint.detector.api.Location
import com.android.tools.lint.detector.api.Position
import com.android.tools.lint.detector.api.XmlContext
import com.android.utils.Pair
import com.android.utils.PositionXmlParser
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.util.TextRange
import com.intellij.psi.PsiFile
import com.intellij.psi.xml.XmlFile
import org.jetbrains.android.context.AndroidQueryException
import org.w3c.dom.Attr
import org.w3c.dom.Document
import org.w3c.dom.Element
import org.w3c.dom.Node
import org.xml.sax.SAXException
import java.io.File
import java.io.IOException
import java.util.concurrent.CancellationException
import javax.xml.parsers.ParserConfigurationException

open class AndroidLintXmlParser(
    private val client: LintClient?
) : XmlParser() {
    private var parsingFailed: Boolean = false

    private fun markFailed() {
        this.parsingFailed = true
        if (client is AndroidLintClient) {
            client.xmlParsingFailed()
        }
    }

    open fun hasParsingFailed(): Boolean = parsingFailed

    open fun parsePsi(xmlFile: XmlFile?): Document? {
        if (xmlFile == null) {
            return null
        }
        return AndroidDomPsiConverter.convert(xmlFile)
    }

    companion object {
        @JvmStatic
        fun createDocument(xmlFile: XmlFile?): Document? {
            if (xmlFile == null) {
                return null
            }
            return AndroidDomPsiConverter.convert(xmlFile)
        }

        @JvmStatic
        internal fun resolveFile(file: File?, node: Node?): File? {
            if (file == null && node != null && node.ownerDocument != null) {
                val data = node.ownerDocument.getUserData(File::class.java.name)
                if (data is File) {
                    return data
                }
            }
            return file
        }
    }

    override fun parseXml(file: File): Document? {
        ProgressManager.checkCanceled()
        if (client is AndroidLintClient) {
            try {
                val psi = client.xmlSource(file)
                if (psi is XmlFile) {
                    val doc = AndroidDomPsiConverter.convert(psi)
                    if (doc != null) {
                        return doc
                    } else {
                        markFailed()
                        return null
                    }
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Error) {
                throw e
            } catch (e: AndroidQueryException) {
                throw e
            } catch (t: Exception) {
                client.log(t, "Failed converting PSI parse tree to DOM for %1\$s", file.path)
                markFailed()
                return null
            }
        }
        val xml = client?.readFile(file)
        if (xml.isNullOrEmpty()) {
            return null
        }
        return parseXml(xml, file)
    }

    override fun parseXml(xml: CharSequence, file: File): Document? {
        ProgressManager.checkCanceled()
        if (client is AndroidLintClient) {
            try {
                val psi = client.xmlSource(file)
                if (psi is XmlFile) {
                    val doc = AndroidDomPsiConverter.convert(psi)
                    if (doc != null) {
                        return doc
                    } else {
                        markFailed()
                        return null
                    }
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Error) {
                throw e
            } catch (e: AndroidQueryException) {
                throw e
            } catch (t: Exception) {
                client.log(t, "Failed converting PSI parse tree to DOM for %1\$s", file.path)
                markFailed()
                return null
            }
        }
        try {
            val document = PositionXmlParser.parse(xml.toString())
            if (document != null) {
                document.setUserData(File::class.java.name, file, null)
                document.setUserData(PositionXmlParser.CONTENT_KEY, xml.toString(), null)
                document.setUserData("contents", xml.toString(), null)
            }
            return document
        } catch (e: CancellationException) {
            throw e
        } catch (e: Error) {
            throw e
        } catch (e: AndroidQueryException) {
            throw e
        } catch (e: IOException) {
            handleXmlParseException(e, file)
            return null
        } catch (e: SAXException) {
            handleXmlParseException(e, file)
            return null
        } catch (e: ParserConfigurationException) {
            handleXmlParseException(e, file)
            return null
        }
    }

    private fun handleXmlParseException(e: Exception, file: File?) {
        if (file != null && file.name != "lint.xml" && !file.name.endsWith("lint.xml")) {
            client?.log(e, "PositionXmlParser failed parsing %1\$s", file.path)
            markFailed()
        }
    }

    override fun parseXml(context: XmlContext): Document? {
        val contents = context.getContents()
        val file = context.file
        if (contents == null && file == null) {
            return null
        }
        if (contents != null && file != null) {
            return parseXml(contents, file)
        }
        if (file != null) {
            return parseXml(file)
        }
        return null
    }

    private fun findManifestSource(node: Node?): Pair<File, out Node>? {
        if (client != null && node != null && client.isMergeManifestNode(node)) {
            return client.findManifestSourceNode(node)
        }
        return null
    }

    override fun getLocation(file: File, node: Node): Location {
        var targetFile = resolveFile(file, node) ?: return Location.NONE
        var targetNode: Node = node
        val merged = findManifestSource(targetNode)
        if (merged == null && client != null && client.isMergeManifestNode(targetNode)) return Location.NONE
        if (merged != null) {
            targetFile = merged.first ?: targetFile
            targetNode = merged.second
        }
        if (targetNode !is AndroidDomPsiConverter.AndroidDomNode) {
            val pos = PositionXmlParser.getPosition(targetNode)
            if (pos == null || pos == SourcePosition.UNKNOWN) {
                return Location.create(targetFile).withSource(targetNode)
            }
            return Location.create(targetFile, pos).withSource(targetNode)
        }
        var textRange = AndroidDomPsiConverter.getTextRange(targetNode)
        if (targetNode.nodeType == Node.TEXT_NODE) {
            textRange = AndroidDomPsiConverter.trim(targetNode, textRange)
        }
        val start = AndroidDomPsiConverter.AndroidLintXmlPosition(targetNode, textRange.startOffset)
        val end = AndroidDomPsiConverter.AndroidLintXmlPosition(targetNode, textRange.endOffset)
        return Location.create(targetFile, start, end).withSource(targetNode)
    }

    override fun getLocation(context: XmlContext, node: Node): Location {
        val file = context.file ?: return Location.NONE
        return getLocation(file, node)
    }

    override fun getLocation(client: LintClient, file: File, node: Node): Location {
        return getLocation(file, node)
    }

    override fun getLocation(context: XmlContext, node: Node, startDelta: Int, endDelta: Int): Location {
        var targetFile = resolveFile(context.file, node) ?: return Location.NONE
        var targetNode: Node = node
        val merged = findManifestSource(targetNode)
        if (merged == null && client != null && client.isMergeManifestNode(targetNode)) return Location.NONE
        if (merged != null) {
            targetFile = merged.first ?: targetFile
            targetNode = merged.second
        }
        if (targetNode !is AndroidDomPsiConverter.AndroidDomNode) {
            val pos = PositionXmlParser.getPosition(targetNode, startDelta, endDelta)
            if (pos == null || pos == SourcePosition.UNKNOWN) {
                return Location.create(targetFile).withSource(targetNode)
            }
            return Location.create(targetFile, pos).withSource(targetNode)
        }
        val textRange = AndroidDomPsiConverter.getTextRange(targetNode)
        val start = AndroidDomPsiConverter.AndroidLintXmlPosition(targetNode, textRange.startOffset + startDelta)
        val end = AndroidDomPsiConverter.AndroidLintXmlPosition(targetNode, textRange.startOffset + endDelta)
        return Location.create(targetFile, start, end).withSource(targetNode)
    }

    override fun getNameLocation(client: LintClient, file: File, node: Node): Location {
        var targetFile = resolveFile(file, node) ?: return Location.NONE
        var targetNode: Node = node
        val merged = findManifestSource(targetNode)
        if (merged == null && this.client != null && this.client.isMergeManifestNode(targetNode)) return Location.NONE
        if (merged != null) {
            targetFile = merged.first ?: targetFile
            targetNode = merged.second
        }
        if (targetNode !is AndroidDomPsiConverter.AndroidDomNode) {
            val location = getLocation(targetFile, targetNode)
            val start = location.start
            if (start != null) {
                val delta = if (targetNode is Element) 1 else 0
                val name = targetNode.nodeName
                val length = name?.length ?: 0
                val startOffset = start.offset + delta
                val startColumn = start.column + delta
                return Location.create(
                    targetFile,
                    DefaultPosition(start.line, startColumn, startOffset),
                    DefaultPosition(start.line, startColumn + length, startOffset + length)
                ).withSource(targetNode)
            }
            return location
        }
        val textRange = AndroidDomPsiConverter.getTextNameRange(targetNode)
        val start = AndroidDomPsiConverter.AndroidLintXmlPosition(targetNode, textRange.startOffset)
        val end = AndroidDomPsiConverter.AndroidLintXmlPosition(targetNode, textRange.endOffset)
        return Location.create(targetFile, start, end).withSource(targetNode)
    }

    override fun getNameLocation(context: XmlContext, node: Node): Location {
        val file = context.file ?: return Location.NONE
        val lintClient = this.client ?: context.client
        return getNameLocation(lintClient, file, node)
    }

    override fun getValueLocation(client: LintClient, file: File, node: Attr): Location {
        var targetFile = resolveFile(file, node) ?: return Location.NONE
        var targetNode: Attr = node
        val merged = findManifestSource(targetNode)
        if (merged == null && this.client != null && this.client.isMergeManifestNode(targetNode)) return Location.NONE
        if (merged != null) {
            targetFile = merged.first ?: targetFile
            val second = merged.second
            if (second is Attr) {
                targetNode = second
            }
        }
        if (targetNode !is AndroidDomPsiConverter.AndroidDomNode) {
            val location = getLocation(targetFile, targetNode)
            val start = location.start
            if (start != null) {
                val ownerDoc = targetNode.ownerDocument
                var contents = ownerDoc?.getUserData(PositionXmlParser.CONTENT_KEY) as? String
                if (contents == null && ownerDoc != null) {
                    contents = ownerDoc.getUserData("contents") as? String
                }
                if (contents != null) {
                    var valueStartOffset = start.offset
                    val docLen = contents.length
                    while (valueStartOffset < docLen) {
                        val c = contents[valueStartOffset++]
                        if (c == '"' || c == '\'') {
                            break
                        }
                    }
                    if (valueStartOffset in 1..docLen) {
                        val quote = contents[valueStartOffset - 1]
                        var valueEndOffset = valueStartOffset
                        while (valueEndOffset < docLen && contents[valueEndOffset] != quote) {
                            valueEndOffset++
                        }
                        val valStart = AndroidDomPsiConverter.AndroidLintXmlPosition(targetNode, valueStartOffset)
                        val valEnd = AndroidDomPsiConverter.AndroidLintXmlPosition(targetNode, valueEndOffset)
                        return Location.create(targetFile, valStart, valEnd).withSource(targetNode)
                    }
                }
            }
            return location
        }
        val textRange = AndroidDomPsiConverter.getTextValueRange(targetNode)
        val start = AndroidDomPsiConverter.AndroidLintXmlPosition(targetNode, textRange.startOffset)
        val end = AndroidDomPsiConverter.AndroidLintXmlPosition(targetNode, textRange.endOffset)
        return Location.create(targetFile, start, end).withSource(targetNode)
    }

    override fun getValueLocation(context: XmlContext, node: Attr): Location {
        val file = context.file ?: return Location.NONE
        val lintClient = this.client ?: context.client
        return getValueLocation(lintClient, file, node)
    }

    override fun getNodeStartOffset(client: LintClient, file: File, node: Node): Int {
        var targetNode: Node = node
        val merged = findManifestSource(targetNode)
        if (merged == null && this.client != null && this.client.isMergeManifestNode(targetNode)) return -1
        if (merged != null) {
            targetNode = merged.second
        }
        if (targetNode is AndroidDomPsiConverter.AndroidDomNode) {
            return targetNode.getTextRange().startOffset
        }
        val pos = PositionXmlParser.getPosition(targetNode)
        return if (pos != null && pos != SourcePosition.UNKNOWN) pos.startOffset else -1
    }

    override fun getNodeStartOffset(context: XmlContext, node: Node): Int {
        val file = context.file ?: return -1
        val lintClient = this.client ?: context.client
        return getNodeStartOffset(lintClient, file, node)
    }

    override fun getNodeEndOffset(client: LintClient, file: File, node: Node): Int {
        var targetNode: Node = node
        val merged = findManifestSource(targetNode)
        if (merged == null && this.client != null && this.client.isMergeManifestNode(targetNode)) return -1
        if (merged != null) {
            targetNode = merged.second
        }
        if (targetNode is AndroidDomPsiConverter.AndroidDomNode) {
            return targetNode.getTextRange().endOffset
        }
        val pos = PositionXmlParser.getPosition(targetNode)
        return if (pos != null && pos != SourcePosition.UNKNOWN) pos.endOffset else -1
    }

    override fun getNodeEndOffset(context: XmlContext, node: Node): Int {
        val file = context.file ?: return -1
        val lintClient = this.client ?: context.client
        return getNodeEndOffset(lintClient, file, node)
    }

    override fun findNodeAt(context: XmlContext, offset: Int): Node? {
        val document = context.document ?: return null
        return findNodeAt(document, offset)
    }

    override fun findNodeAt(node: Node, offset: Int): Node? {
        if (node is AndroidDomPsiConverter.AndroidDomNode) {
            return AndroidDomPsiConverter.findNodeAt(node, offset)
        }
        return PositionXmlParser.findNodeAt(node, offset)
    }

    override fun createLocationHandle(context: XmlContext, node: Node): Location.Handle {
        val file = context.file
        return AndroidLocationHandle(this, file, node)
    }

    open class AndroidLocationHandle(
        private val parser: AndroidLintXmlParser?,
        private val file: File?,
        private val node: Node?
    ) : Location.Handle {
        override var clientData: Any? = null

        override fun resolve(): Location {
            val targetFile = resolveFile(file, node) ?: return Location.NONE
            if (node == null) {
                return Location.create(targetFile)
            }
            if (parser != null) {
                return parser.getLocation(targetFile, node)
            }
            if (node !is AndroidDomPsiConverter.AndroidDomNode) {
                val pos = PositionXmlParser.getPosition(node)
                if (pos == null || pos == SourcePosition.UNKNOWN) {
                    return Location.create(targetFile).withSource(node)
                }
                return Location.create(targetFile, pos).withSource(node)
            }
            val textRange = AndroidDomPsiConverter.getTextRange(node)
            val start = AndroidDomPsiConverter.AndroidLintXmlPosition(node, textRange.startOffset)
            val end = AndroidDomPsiConverter.AndroidLintXmlPosition(node, textRange.endOffset)
            return Location.create(targetFile, start, end).withSource(node)
        }

    }
}
