package org.omp.intellij.android;

import com.intellij.openapi.editor.Document;
import com.intellij.openapi.progress.ProgressManager;
import com.intellij.openapi.util.TextRange;
import com.intellij.psi.PsiDocumentManager;
import com.intellij.psi.PsiElement;
import com.intellij.psi.PsiFile;
import com.intellij.psi.xml.XmlAttribute;
import com.intellij.psi.xml.XmlAttributeValue;
import com.intellij.psi.xml.XmlFile;
import com.intellij.psi.xml.XmlTag;
import com.jetbrains.ls.api.core.features.LSDocumentSymbolCustomizer;
import com.jetbrains.ls.api.features.impl.common.symbols.LSDocumentSymbolProviderPsiBase;
import com.jetbrains.ls.api.features.language.LSLanguage;
import com.jetbrains.lsp.protocol.Position;
import com.jetbrains.lsp.protocol.Range;
import com.jetbrains.lsp.protocol.SymbolKind;

import java.util.ArrayList;
import java.util.List;
import java.util.Set;

public final class AndroidDocumentSymbols extends LSDocumentSymbolProviderPsiBase {
    private static final Set<String> COMPONENTS = Set.of("activity", "service", "provider", "receiver", "activity-alias");

    public AndroidDocumentSymbols(LSLanguage language) {
        super(language);
    }

    @Override
    public LSDocumentSymbolCustomizer<PsiElement> createCustomizer() {
        return new Customizer();
    }

    @Override
    public kotlinx.coroutines.flow.Flow<com.jetbrains.lsp.protocol.DocumentSymbol> getDocumentSymbols(
            com.jetbrains.ls.api.core.LSServer server, com.jetbrains.lsp.implementation.LspHandlerContext context,
            com.jetbrains.lsp.protocol.DocumentSymbolParams params) {
        return AndroidRequests.query(server, params.getTextDocument(), new Position(0, 0), (project, file, offset) -> {
            var customizer = createCustomizer();
            List<com.jetbrains.lsp.protocol.DocumentSymbol> result = new ArrayList<>();
            for (PsiElement root : customizer.getRootDeclarations(file)) {
                ProgressManager.checkCanceled();
                var symbol = com.jetbrains.ls.api.core.features.LSDocumentSymbolsKt.mapDeclaration(root, customizer, false);
                if (symbol != null) result.add(symbol);
            }
            return result;
        });
    }

    private static final class Customizer implements LSDocumentSymbolCustomizer<PsiElement> {
        @Override
        public List<PsiElement> getRootDeclarations(PsiFile file) {
            ProgressManager.checkCanceled();
            if (!(file instanceof XmlFile xml) || xml.getRootTag() == null) return List.of();
            if (!AndroidContext.isSupportedXml(xml)) return List.of();
            XmlTag root = xml.getRootTag();
            if (root.getName().equals("manifest")) return List.of(root);
            if (!root.getName().equals("resources")) return List.of();
            return resourceChildren(root, false);
        }

        @Override
        public List<PsiElement> getNestedDeclarations(PsiElement element) {
            ProgressManager.checkCanceled();
            XmlTag tag = (XmlTag) element;
            if (tag.getName().equals("manifest")) {
                List<PsiElement> result = new ArrayList<>();
                for (XmlTag child : tag.getSubTags()) {
                    ProgressManager.checkCanceled();
                    if (child.getName().equals("application") || child.getName().equals("instrumentation") && named(child, true))
                        result.add(child);
                }
                return result;
            }
            if (tag.getName().equals("application")) {
                List<PsiElement> result = new ArrayList<>();
                for (XmlTag child : tag.getSubTags()) {
                    ProgressManager.checkCanceled();
                    if (COMPONENTS.contains(child.getName()) && named(child, true)) result.add(child);
                }
                return result;
            }
            if (tag.getName().equals("style") || tag.getName().equals("declare-styleable"))
                return resourceChildren(tag, true);
            return List.of();
        }

        private List<PsiElement> resourceChildren(XmlTag parent, boolean nested) {
            List<PsiElement> result = new ArrayList<>();
            for (XmlTag child : parent.getSubTags()) {
                ProgressManager.checkCanceled();
                if (!named(child, false)) continue;
                if (nested) {
                    if (parent.getName().equals("style") && child.getName().equals("item") || parent.getName().equals("declare-styleable") && child.getName().equals("attr"))
                        result.add(child);
                } else if (resourceKind(child) != null) result.add(child);
            }
            return result;
        }

        @Override
        public String getName(PsiElement element) {
            XmlTag tag = (XmlTag) element;
            XmlAttribute attribute = nameAttribute(tag);
            if (attribute != null && attribute.getValue() != null && !attribute.getValue().isBlank())
                return AndroidXml.value(attribute);
            return tag.getName();
        }

        @Override
        public SymbolKind getKind(PsiElement element) {
            XmlTag tag = (XmlTag) element;
            return switch (tag.getName()) {
                case "manifest" -> SymbolKind.Namespace;
                case "application" -> SymbolKind.Module;
                case "activity", "service", "provider", "receiver", "instrumentation" -> SymbolKind.Class;
                case "activity-alias" -> SymbolKind.Interface;
                default ->
                        tag.getParentTag() != null && tag.getParentTag().getName().equals("style") ? SymbolKind.Property : resourceKind(tag);
            };
        }

        @Override
        public String getDetail(PsiElement element) {
            XmlTag tag = (XmlTag) element;
            return tag.getName().equals("item") ? tag.getAttributeValue("type") : tag.getName();
        }

        @Override
        public boolean isDeprecated(PsiElement element) {
            return false;
        }

        @Override
        public ElementRanges getRanges(PsiElement element) {
            XmlTag tag = (XmlTag) element;
            Document document = PsiDocumentManager.getInstance(tag.getProject()).getDocument(tag.getContainingFile());
            if (document == null) throw new IllegalStateException("Current XML document unavailable");
            TextRange selection;
            XmlAttribute attribute = nameAttribute(tag);
            if (attribute != null && attribute.getValueElement() != null && attribute.getValue() != null && !attribute.getValue().isBlank()) {
                XmlAttributeValue value = attribute.getValueElement();
                selection = value.getValueTextRange();
            } else {
                PsiElement name = tag.getFirstChild();
                while (name != null && !name.getText().equals(tag.getName())) name = name.getNextSibling();
                if (name == null) return null;
                selection = name.getTextRange();
            }
            if (!tag.getTextRange().contains(selection) || tag.getTextRange().getEndOffset() > document.getTextLength())
                return null;
            return new ElementRanges(range(document, tag.getTextRange()), range(document, selection));
        }

        private XmlAttribute nameAttribute(XmlTag tag) {
            if (tag.getName().equals("manifest")) return tag.getAttribute("package");
            if (tag.getName().equals("application") || tag.getName().equals("instrumentation") || COMPONENTS.contains(tag.getName()))
                return AndroidXml.androidName(tag);
            return tag.getAttribute("name");
        }
    }

    private static boolean named(XmlTag tag, boolean android) {
        XmlAttribute attribute = android ? AndroidXml.androidName(tag) : tag.getAttribute("name");
        if (attribute == null || attribute.getValueElement() == null || attribute.getValue() == null || attribute.getValue().isBlank())
            return false;
        String text = attribute.getValueElement().getText();
        return text.length() >= 2 && (text.charAt(0) == '\'' || text.charAt(0) == '"') && text.charAt(0) == text.charAt(text.length() - 1);
    }

    private static SymbolKind resourceKind(XmlTag tag) {
        String type = tag.getName().equals("item") ? tag.getAttributeValue("type") : tag.getName();
        if (type == null) return null;
        return switch (type) {
            case "string" -> SymbolKind.String;
            case "color", "dimen" -> SymbolKind.Constant;
            case "bool" -> SymbolKind.Boolean;
            case "integer" -> SymbolKind.Number;
            case "array", "string-array", "integer-array", "plurals" -> SymbolKind.Array;
            case "style" -> SymbolKind.Class;
            case "declare-styleable" -> SymbolKind.Interface;
            case "attr" -> SymbolKind.Property;
            case "id" -> SymbolKind.Variable;
            default -> null;
        };
    }

    private static Range range(Document document, TextRange range) {
        return new Range(position(document, range.getStartOffset()), position(document, range.getEndOffset()));
    }

    private static Position position(Document document, int offset) {
        int line = document.getLineNumber(offset);
        return new Position(line, offset - document.getLineStartOffset(line));
    }
}
