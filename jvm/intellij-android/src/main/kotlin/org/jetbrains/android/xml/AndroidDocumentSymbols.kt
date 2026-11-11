package org.jetbrains.android.xml

import com.intellij.openapi.editor.Document
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.util.TextRange
import com.intellij.psi.PsiDocumentManager
import com.intellij.psi.PsiElement
import com.intellij.psi.PsiFile
import com.intellij.psi.xml.XmlAttribute
import com.intellij.psi.xml.XmlFile
import com.intellij.psi.xml.XmlTag
import com.jetbrains.ls.api.core.LSServer
import com.jetbrains.ls.api.core.features.LSDocumentSymbolCustomizer
import com.jetbrains.ls.api.core.features.mapDeclaration
import com.jetbrains.ls.api.features.symbols.LSDocumentSymbolProvider
import com.jetbrains.ls.api.features.language.LSLanguage
import com.jetbrains.lsp.implementation.LspHandlerContext
import com.jetbrains.lsp.protocol.DocumentSymbol
import com.jetbrains.lsp.protocol.DocumentSymbolParams
import com.jetbrains.lsp.protocol.Position
import com.jetbrains.lsp.protocol.Range
import com.jetbrains.lsp.protocol.SymbolKind
import kotlinx.coroutines.flow.Flow
import org.jetbrains.android.context.AndroidContext
import org.jetbrains.android.context.AndroidRequests

class AndroidDocumentSymbols(language: LSLanguage) : LSDocumentSymbolProvider {

    override val supportedLanguages: Set<LSLanguage> = setOf(language)

    context(server: LSServer, handlerContext: LspHandlerContext)
    override fun getDocumentSymbols(params: DocumentSymbolParams): Flow<DocumentSymbol> {
        return AndroidRequests.query(server, params.textDocument, Position(0, 0)) { _, file, _ ->
            val customizer = Customizer()
            val result = ArrayList<DocumentSymbol>()
            for (root in customizer.getRootDeclarations(file)) {
                ProgressManager.checkCanceled()
                val symbol = mapDeclaration(root, customizer, false)
                if (symbol != null) result.add(symbol)
            }
            result
        }
    }

    private class Customizer : LSDocumentSymbolCustomizer<PsiElement> {
        override fun getRootDeclarations(file: PsiFile): List<PsiElement> {
            ProgressManager.checkCanceled()
            val xml = file as? XmlFile ?: return emptyList()
            val root = xml.rootTag ?: return emptyList()
            if (!AndroidContext.isSupportedXml(xml)) return emptyList()
            if (root.name == "manifest") return listOf(root)
            if (root.name != "resources") return emptyList()
            return resourceChildren(root, false)
        }

        override fun getNestedDeclarations(element: PsiElement): List<PsiElement> {
            ProgressManager.checkCanceled()
            val tag = element as XmlTag
            if (tag.name == "manifest") {
                val result = ArrayList<PsiElement>()
                for (child in tag.subTags) {
                    ProgressManager.checkCanceled()
                    if (child.name == "application" || (child.name == "instrumentation" && named(child, true))) {
                        result.add(child)
                    }
                }
                return result
            }
            if (tag.name == "application") {
                val result = ArrayList<PsiElement>()
                for (child in tag.subTags) {
                    ProgressManager.checkCanceled()
                    if (COMPONENTS.contains(child.name) && named(child, true)) {
                        result.add(child)
                    }
                }
                return result
            }
            if (tag.name == "style" || tag.name == "declare-styleable") {
                return resourceChildren(tag, true)
            }
            return emptyList()
        }

        private fun resourceChildren(parent: XmlTag, nested: Boolean): List<PsiElement> {
            val result = ArrayList<PsiElement>()
            for (child in parent.subTags) {
                ProgressManager.checkCanceled()
                if (!named(child, false)) continue
                if (nested) {
                    if ((parent.name == "style" && child.name == "item") || (parent.name == "declare-styleable" && child.name == "attr")) {
                        result.add(child)
                    }
                } else if (resourceKind(child) != null) {
                    result.add(child)
                }
            }
            return result
        }

        override fun getName(element: PsiElement): String? {
            val tag = element as XmlTag
            val attribute = nameAttribute(tag)
            if (attribute != null && !attribute.value.isNullOrBlank()) {
                return AndroidXml.value(attribute)
            }
            return tag.name
        }

        override fun getKind(element: PsiElement): SymbolKind? {
            val tag = element as XmlTag
            return when (tag.name) {
                "manifest" -> SymbolKind.Namespace
                "application" -> SymbolKind.Module
                "activity", "service", "provider", "receiver", "instrumentation" -> SymbolKind.Class
                "activity-alias" -> SymbolKind.Interface
                else -> {
                    val parentTag = tag.parentTag
                    if (parentTag != null && parentTag.name == "style") SymbolKind.Property else resourceKind(tag)
                }
            }
        }

        override fun getDetail(element: PsiElement): String? {
            val tag = element as XmlTag
            return if (tag.name == "item") tag.getAttributeValue("type") else tag.name
        }

        override fun isDeprecated(element: PsiElement): Boolean = false

        override fun getRanges(element: PsiElement): LSDocumentSymbolCustomizer.ElementRanges? {
            val tag = element as XmlTag
            val document = PsiDocumentManager.getInstance(tag.project).getDocument(tag.containingFile)
                ?: error("Current XML document unavailable")
            val selection: TextRange
            val attribute = nameAttribute(tag)
            val valueElement = attribute?.valueElement
            if (attribute != null && valueElement != null && !attribute.value.isNullOrBlank()) {
                selection = valueElement.valueTextRange
            } else {
                var name = tag.firstChild
                while (name != null && name.text != tag.name) {
                    name = name.nextSibling
                }
                if (name == null) return null
                selection = name.textRange
            }
            if (!tag.textRange.contains(selection) || tag.textRange.endOffset > document.textLength) {
                return null
            }
            return LSDocumentSymbolCustomizer.ElementRanges(range(document, tag.textRange), range(document, selection))
        }

        private fun nameAttribute(tag: XmlTag): XmlAttribute? {
            if (tag.name == "manifest") return tag.getAttribute("package")
            if (tag.name == "application" || tag.name == "instrumentation" || COMPONENTS.contains(tag.name)) {
                return AndroidXml.androidName(tag)
            }
            return tag.getAttribute("name")
        }
    }

    companion object {
        private val COMPONENTS = setOf("activity", "service", "provider", "receiver", "activity-alias")

        private fun named(tag: XmlTag, android: Boolean): Boolean {
            val attribute = if (android) AndroidXml.androidName(tag) else tag.getAttribute("name")
            val valueElement = attribute?.valueElement
            val value = attribute?.value
            if (attribute == null || valueElement == null || value.isNullOrBlank()) {
                return false
            }
            val text = valueElement.text
            return text.length >= 2 && (text[0] == '\'' || text[0] == '"') && text[0] == text[text.length - 1]
        }

        private fun resourceKind(tag: XmlTag): SymbolKind? {
            val type = if (tag.name == "item") tag.getAttributeValue("type") else tag.name
            if (type == null) return null
            return when (type) {
                "string" -> SymbolKind.String
                "color", "dimen" -> SymbolKind.Constant
                "bool" -> SymbolKind.Boolean
                "integer" -> SymbolKind.Number
                "array", "string-array", "integer-array", "plurals" -> SymbolKind.Array
                "style" -> SymbolKind.Class
                "declare-styleable" -> SymbolKind.Interface
                "attr" -> SymbolKind.Property
                "id" -> SymbolKind.Variable
                else -> null
            }
        }

        private fun range(document: Document, range: TextRange): Range {
            return Range(position(document, range.startOffset), position(document, range.endOffset))
        }

        private fun position(document: Document, offset: Int): Position {
            val line = document.getLineNumber(offset)
            return Position(line, offset - document.getLineStartOffset(line))
        }
    }
}
