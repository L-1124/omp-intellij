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
import com.android.tools.lint.client.api.LintClient;
import com.android.tools.lint.client.api.XmlParser;
import com.android.tools.lint.detector.api.DefaultPosition;
import com.android.tools.lint.detector.api.Location;
import com.android.tools.lint.detector.api.Position;
import com.android.tools.lint.detector.api.XmlContext;
import com.android.utils.Pair;
import com.android.utils.PositionXmlParser;
import com.intellij.openapi.progress.ProgressManager;
import com.intellij.openapi.util.TextRange;
import com.intellij.psi.PsiFile;
import com.intellij.psi.xml.XmlFile;
import org.jetbrains.android.context.AndroidQueryException;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;
import org.w3c.dom.Attr;
import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.Node;
import org.xml.sax.SAXException;

import javax.xml.parsers.ParserConfigurationException;
import java.io.File;
import java.io.IOException;
import java.util.concurrent.CancellationException;

public class AndroidLintXmlParser extends XmlParser {
    private final LintClient client;
    private boolean parsingFailed;

    public AndroidLintXmlParser(LintClient client) {
        this.client = client;
    }

    private void markFailed() {
        this.parsingFailed = true;
        if (client instanceof AndroidLintClient lintClient) {
            lintClient.xmlParsingFailed();
        }
    }

    public boolean hasParsingFailed() {
        return parsingFailed;
    }

    @Nullable
    public Document parsePsi(@Nullable XmlFile xmlFile) {
        if (xmlFile == null) {
            return null;
        }
        return AndroidDomPsiConverter.convert(xmlFile);
    }

    @Nullable
    public static Document createDocument(@Nullable XmlFile xmlFile) {
        if (xmlFile == null) {
            return null;
        }
        return AndroidDomPsiConverter.convert(xmlFile);
    }

    @Override
    @Nullable
    public Document parseXml(File file) {
        if (file == null) {
            return null;
        }
        ProgressManager.checkCanceled();
        if (client instanceof AndroidLintClient lintClient) {
            try {
                PsiFile psi = lintClient.xmlSource(file);
                if (psi instanceof XmlFile xmlFile) {
                    Document doc = AndroidDomPsiConverter.convert(xmlFile);
                    if (doc != null) {
                        return doc;
                    } else {
                        markFailed();
                        return null;
                    }
                }
            } catch (CancellationException | Error | AndroidQueryException e) {
                throw e;
            } catch (Exception t) {
                if (client != null) {
                    client.log(t, "Failed converting PSI parse tree to DOM for %1$s", file.getPath());
                }
                markFailed();
                return null;
            }
        }
        CharSequence xml = client != null ? client.readFile(file) : null;
        if (xml == null || xml.isEmpty()) {
            return null;
        }
        return parseXml(xml, file);
    }

    @Override
    @Nullable
    public Document parseXml(CharSequence xml, File file) {
        if (xml == null && file == null) {
            return null;
        }
        ProgressManager.checkCanceled();
        if (file != null && client instanceof AndroidLintClient lintClient) {
            try {
                PsiFile psi = lintClient.xmlSource(file);
                if (psi instanceof XmlFile xmlFile) {
                    Document doc = AndroidDomPsiConverter.convert(xmlFile);
                    if (doc != null) {
                        return doc;
                    } else {
                        markFailed();
                        return null;
                    }
                }
            } catch (CancellationException | Error | AndroidQueryException e) {
                throw e;
            } catch (Exception t) {
                if (client != null) {
                    client.log(t, "Failed converting PSI parse tree to DOM for %1$s", file.getPath());
                }
                markFailed();
                return null;
            }
        }
        if (xml == null && client != null && file != null) {
            xml = client.readFile(file);
        }
        if (xml == null) {
            return null;
        }
        try {
            Document document = PositionXmlParser.parse(xml.toString());
            if (document != null && file != null) {
                document.setUserData(File.class.getName(), file, null);
                document.setUserData(PositionXmlParser.CONTENT_KEY, xml.toString(), null);
                document.setUserData("contents", xml.toString(), null);
            }
            return document;
        } catch (CancellationException | Error | AndroidQueryException e) {
            throw e;
        } catch (IOException | SAXException | ParserConfigurationException e) {
            if (file != null && !file.getName().equals("lint.xml") && !file.getName().endsWith("lint.xml")) {
                if (client != null) {
                    client.log(e, "PositionXmlParser failed parsing %1$s", file.getPath());
                }
                markFailed();
            }
            return null;
        }
    }

    @Override
    @Nullable
    public Document parseXml(XmlContext context) {
        if (context == null) {
            return null;
        }
        return parseXml(context.getContents(), context.file);
    }

    private Pair<File, ? extends Node> findManifestSource(Node node) {
        if (client != null && node != null && client.isMergeManifestNode(node)) {
            return client.findManifestSourceNode(node);
        }
        return null;
    }

    private static File resolveFile(File file, Node node) {
        if (file == null && node != null && node.getOwnerDocument() != null) {
            Object data = node.getOwnerDocument().getUserData(File.class.getName());
            if (data instanceof File f) {
                return f;
            }
        }
        return file;
    }

    @NotNull
    @Override
    public Location getLocation(File file, Node node) {
        File targetFile = resolveFile(file, node);
        if (targetFile == null) return Location.NONE;
        if (node == null) {
            return Location.create(targetFile);
        }
        Pair<File, ? extends Node> merged = findManifestSource(node);
        if (merged == null && client != null && client.isMergeManifestNode(node)) return Location.NONE;
        if (merged != null) {
            targetFile = merged.getFirst() != null ? merged.getFirst() : targetFile;
            node = merged.getSecond();
        }
        if (!(node instanceof AndroidDomPsiConverter.AndroidDomNode)) {
            SourcePosition pos = PositionXmlParser.getPosition(node);
            if (pos == null || pos.equals(SourcePosition.UNKNOWN)) {
                return Location.create(targetFile).withSource(node);
            }
            return Location.create(targetFile, pos).withSource(node);
        }
        TextRange textRange = AndroidDomPsiConverter.getTextRange(node);
        if (node.getNodeType() == Node.TEXT_NODE) {
            textRange = AndroidDomPsiConverter.trim(node, textRange);
        }
        Position start = new AndroidDomPsiConverter.AndroidLintXmlPosition(node, textRange.getStartOffset());
        Position end = new AndroidDomPsiConverter.AndroidLintXmlPosition(node, textRange.getEndOffset());
        return Location.create(targetFile, start, end).withSource(node);
    }

    @NotNull
    @Override
    public Location getLocation(XmlContext context, Node node) {
        return getLocation(context != null ? context.file : null, node);
    }

    @NotNull
    @Override
    public Location getLocation(LintClient client, File file, Node node) {
        return getLocation(file, node);
    }

    @NotNull
    @Override
    public Location getLocation(XmlContext context, Node node, int startDelta, int endDelta) {
        File targetFile = resolveFile(context != null ? context.file : null, node);
        if (targetFile == null) return Location.NONE;
        if (node == null) {
            return Location.create(targetFile);
        }
        Pair<File, ? extends Node> merged = findManifestSource(node);
        if (merged == null && client != null && client.isMergeManifestNode(node)) return Location.NONE;
        if (merged != null) {
            targetFile = merged.getFirst() != null ? merged.getFirst() : targetFile;
            node = merged.getSecond();
        }
        if (!(node instanceof AndroidDomPsiConverter.AndroidDomNode)) {
            SourcePosition pos = PositionXmlParser.getPosition(node, startDelta, endDelta);
            if (pos == null || pos.equals(SourcePosition.UNKNOWN)) {
                return Location.create(targetFile).withSource(node);
            }
            return Location.create(targetFile, pos).withSource(node);
        }
        TextRange textRange = AndroidDomPsiConverter.getTextRange(node);
        Position start = new AndroidDomPsiConverter.AndroidLintXmlPosition(node, textRange.getStartOffset() + startDelta);
        Position end = new AndroidDomPsiConverter.AndroidLintXmlPosition(node, textRange.getStartOffset() + endDelta);
        return Location.create(targetFile, start, end).withSource(node);
    }

    @NotNull
    @Override
    public Location getNameLocation(LintClient client, File file, Node node) {
        File targetFile = resolveFile(file, node);
        if (targetFile == null) return Location.NONE;
        if (node == null) {
            return Location.create(targetFile);
        }
        Pair<File, ? extends Node> merged = findManifestSource(node);
        if (merged == null && this.client != null && this.client.isMergeManifestNode(node)) return Location.NONE;
        if (merged != null) {
            targetFile = merged.getFirst() != null ? merged.getFirst() : targetFile;
            node = merged.getSecond();
        }
        if (!(node instanceof AndroidDomPsiConverter.AndroidDomNode)) {
            Location location = getLocation(targetFile, node);
            Position start = location.getStart();
            if (start != null) {
                int delta = (node instanceof Element) ? 1 : 0;
                String name = node.getNodeName();
                int length = name != null ? name.length() : 0;
                int startOffset = start.getOffset() + delta;
                int startColumn = start.getColumn() + delta;
                return Location.create(
                        targetFile,
                        new DefaultPosition(start.getLine(), startColumn, startOffset),
                        new DefaultPosition(start.getLine(), startColumn + length, startOffset + length)
                ).withSource(node);
            }
            return location;
        }
        TextRange textRange = AndroidDomPsiConverter.getTextNameRange(node);
        Position start = new AndroidDomPsiConverter.AndroidLintXmlPosition(node, textRange.getStartOffset());
        Position end = new AndroidDomPsiConverter.AndroidLintXmlPosition(node, textRange.getEndOffset());
        return Location.create(targetFile, start, end).withSource(node);
    }

    @NotNull
    @Override
    public Location getNameLocation(XmlContext context, Node node) {
        return getNameLocation(this.client, context != null ? context.file : null, node);
    }

    @NotNull
    @Override
    public Location getValueLocation(LintClient client, File file, Attr node) {
        File targetFile = resolveFile(file, node);
        if (targetFile == null) return Location.NONE;
        if (node == null) {
            return Location.create(targetFile);
        }
        Pair<File, ? extends Node> merged = findManifestSource(node);
        if (merged == null && this.client != null && this.client.isMergeManifestNode(node)) return Location.NONE;
        if (merged != null) {
            targetFile = merged.getFirst() != null ? merged.getFirst() : targetFile;
            if (merged.getSecond() instanceof Attr attr) {
                node = attr;
            }
        }
        if (!(node instanceof AndroidDomPsiConverter.AndroidDomNode)) {
            Location location = getLocation(targetFile, node);
            Position start = location.getStart();
            if (start != null) {
                Document ownerDoc = node.getOwnerDocument();
                String contents = ownerDoc != null ? (String) ownerDoc.getUserData(PositionXmlParser.CONTENT_KEY) : null;
                if (contents == null && ownerDoc != null) {
                    contents = (String) ownerDoc.getUserData("contents");
                }
                if (contents != null) {
                    int valueStartOffset = start.getOffset();
                    int docLen = contents.length();
                    while (valueStartOffset < docLen) {
                        char c = contents.charAt(valueStartOffset++);
                        if (c == '"' || c == '\'') {
                            break;
                        }
                    }
                    if (valueStartOffset > 0 && valueStartOffset <= docLen) {
                        char quote = contents.charAt(valueStartOffset - 1);
                        int valueEndOffset = valueStartOffset;
                        while (valueEndOffset < docLen && contents.charAt(valueEndOffset) != quote) {
                            valueEndOffset++;
                        }
                        Position valStart = new AndroidDomPsiConverter.AndroidLintXmlPosition(node, valueStartOffset);
                        Position valEnd = new AndroidDomPsiConverter.AndroidLintXmlPosition(node, valueEndOffset);
                        return Location.create(targetFile, valStart, valEnd).withSource(node);
                    }
                }
            }
            return location;
        }
        TextRange textRange = AndroidDomPsiConverter.getTextValueRange(node);
        Position start = new AndroidDomPsiConverter.AndroidLintXmlPosition(node, textRange.getStartOffset());
        Position end = new AndroidDomPsiConverter.AndroidLintXmlPosition(node, textRange.getEndOffset());
        return Location.create(targetFile, start, end).withSource(node);
    }

    @NotNull
    @Override
    public Location getValueLocation(XmlContext context, Attr node) {
        return getValueLocation(this.client, context != null ? context.file : null, node);
    }

    @Override
    public int getNodeStartOffset(LintClient client, File file, Node node) {
        if (node == null) {
            return -1;
        }
        Pair<File, ? extends Node> merged = findManifestSource(node);
        if (merged == null && this.client != null && this.client.isMergeManifestNode(node)) return -1;
        if (merged != null) {
            node = merged.getSecond();
        }
        if (node instanceof AndroidDomPsiConverter.AndroidDomNode domNode) {
            return domNode.getTextRange().getStartOffset();
        }
        SourcePosition pos = PositionXmlParser.getPosition(node);
        return pos != null && !pos.equals(SourcePosition.UNKNOWN) ? pos.getStartOffset() : -1;
    }

    @Override
    public int getNodeStartOffset(XmlContext context, Node node) {
        return getNodeStartOffset(this.client, context != null ? context.file : null, node);
    }

    @Override
    public int getNodeEndOffset(LintClient client, File file, Node node) {
        if (node == null) {
            return -1;
        }
        Pair<File, ? extends Node> merged = findManifestSource(node);
        if (merged == null && this.client != null && this.client.isMergeManifestNode(node)) return -1;
        if (merged != null) {
            node = merged.getSecond();
        }
        if (node instanceof AndroidDomPsiConverter.AndroidDomNode domNode) {
            return domNode.getTextRange().getEndOffset();
        }
        SourcePosition pos = PositionXmlParser.getPosition(node);
        return pos != null && !pos.equals(SourcePosition.UNKNOWN) ? pos.getEndOffset() : -1;
    }

    @Override
    public int getNodeEndOffset(XmlContext context, Node node) {
        return getNodeEndOffset(this.client, context != null ? context.file : null, node);
    }

    @Nullable
    @Override
    public Node findNodeAt(XmlContext context, int offset) {
        if (context == null || context.document == null) {
            return null;
        }
        return findNodeAt(context.document, offset);
    }

    @Nullable
    @Override
    public Node findNodeAt(Node node, int offset) {
        if (node == null) {
            return null;
        }
        if (node instanceof AndroidDomPsiConverter.AndroidDomNode) {
            return AndroidDomPsiConverter.findNodeAt(node, offset);
        }
        return PositionXmlParser.findNodeAt(node, offset);
    }

    @NotNull
    @Override
    public Location.Handle createLocationHandle(XmlContext context, Node node) {
        File file = context != null ? context.file : null;
        return new AndroidLocationHandle(this, file, node);
    }

    public static class AndroidLocationHandle implements Location.Handle {
        private final AndroidLintXmlParser parser;
        private final File file;
        private final Node node;
        private Object clientData;

        public AndroidLocationHandle(AndroidLintXmlParser parser, File file, Node node) {
            this.parser = parser;
            this.file = file;
            this.node = node;
        }

        @NotNull
        @Override
        public Location resolve() {
            File targetFile = resolveFile(file, node);
            if (targetFile == null) return Location.NONE;
            if (node == null) {
                return Location.create(targetFile);
            }
            if (parser != null) {
                return parser.getLocation(targetFile, node);
            }
            if (!(node instanceof AndroidDomPsiConverter.AndroidDomNode)) {
                SourcePosition pos = PositionXmlParser.getPosition(node);
                if (pos == null || pos.equals(SourcePosition.UNKNOWN)) {
                    return Location.create(targetFile).withSource(node);
                }
                return Location.create(targetFile, pos).withSource(node);
            }
            TextRange textRange = AndroidDomPsiConverter.getTextRange(node);
            Position start = new AndroidDomPsiConverter.AndroidLintXmlPosition(node, textRange.getStartOffset());
            Position end = new AndroidDomPsiConverter.AndroidLintXmlPosition(node, textRange.getEndOffset());
            return Location.create(targetFile, start, end).withSource(node);
        }

        @Override
        public void setClientData(@Nullable Object clientData) {
            this.clientData = clientData;
        }

        @Nullable
        @Override
        public Object getClientData() {
            return clientData;
        }
    }
}
