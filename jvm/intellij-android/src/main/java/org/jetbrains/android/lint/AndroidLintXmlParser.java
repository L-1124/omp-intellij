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
import org.w3c.dom.Attr;
import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.Node;
import org.xml.sax.SAXException;

import javax.xml.parsers.ParserConfigurationException;
import java.io.File;
import java.io.IOException;

public class AndroidLintXmlParser extends XmlParser {
    private final LintClient client;

    public AndroidLintXmlParser(LintClient client) {
        this.client = client;
    }

    @Override
    public Document parseXml(File file) {
        if (file == null) {
            return null;
        }
        CharSequence xml = client != null ? client.readFile(file) : null;
        if (xml == null || xml.length() == 0) {
            return null;
        }
        return parseXml(xml, file);
    }

    @Override
    public Document parseXml(CharSequence xml, File file) {
        if (xml == null) {
            return null;
        }
        try {
            Document document = PositionXmlParser.parse(xml.toString());
            if (document != null && file != null) {
                document.setUserData(File.class.getName(), file, null);
                document.setUserData("contents", xml.toString(), null);
            }
            return document;
        } catch (IOException | SAXException | ParserConfigurationException e) {
            return null;
        }
    }

    @Override
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

    @Override
    public Location getLocation(File file, Node node) {
        if (node == null) {
            return file != null ? Location.create(file) : Location.NONE;
        }
        Pair<File, ? extends Node> merged = findManifestSource(node);
        if (merged != null) {
            file = merged.getFirst();
            node = merged.getSecond();
        }
        SourcePosition pos = PositionXmlParser.getPosition(node);
        if (pos == null || pos.equals(SourcePosition.UNKNOWN)) {
            return (file != null ? Location.create(file) : Location.NONE).withSource(node);
        }
        return Location.create(file, pos).withSource(node);
    }

    @Override
    public Location getLocation(XmlContext context, Node node) {
        return getLocation(context != null ? context.file : null, node);
    }

    @Override
    public Location getLocation(LintClient client, File file, Node node) {
        return getLocation(file, node);
    }

    @Override
    public Location getLocation(XmlContext context, Node node, int start, int end) {
        File file = context != null ? context.file : null;
        if (node == null) {
            return file != null ? Location.create(file) : Location.NONE;
        }
        Pair<File, ? extends Node> merged = findManifestSource(node);
        if (merged != null) {
            file = merged.getFirst();
            node = merged.getSecond();
        }
        SourcePosition pos = PositionXmlParser.getPosition(node, start, end);
        if (pos == null || pos.equals(SourcePosition.UNKNOWN)) {
            return (file != null ? Location.create(file) : Location.NONE).withSource(node);
        }
        return Location.create(file, pos).withSource(node);
    }

    @Override
    public Location getNameLocation(LintClient client, File file, Node node) {
        Location location = getLocation(file, node);
        Position start = location.getStart();
        Position end = location.getEnd();
        if (start != null && end != null && node != null) {
            int delta = (node instanceof Element) ? 1 : 0;
            String name = node.getNodeName();
            int length = name != null ? name.length() : 0;
            int startOffset = start.getOffset() + delta;
            int startColumn = start.getColumn() + delta;
            return Location.create(
                    location.getFile(),
                    new DefaultPosition(start.getLine(), startColumn, startOffset),
                    new DefaultPosition(start.getLine(), startColumn + length, startOffset + length)
            ).withSource(node);
        }
        return location;
    }

    @Override
    public Location getNameLocation(XmlContext context, Node node) {
        return getNameLocation(this.client, context != null ? context.file : null, node);
    }

    @Override
    public Location getValueLocation(LintClient client, File file, Attr node) {
        Location location = getLocation(file, node);
        Position start = location.getStart();
        Position end = location.getEnd();
        if (start != null && end != null && node != null) {
            Document ownerDoc = node.getOwnerDocument();
            String contents = ownerDoc != null ? (String) ownerDoc.getUserData("contents") : null;
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
                    int lineStart = contents.lastIndexOf('\n', valueStartOffset) + 1;
                    int line = start.getLine();
                    int startCol = valueStartOffset - lineStart;
                    int endCol = valueEndOffset - lineStart;
                    return Location.create(
                            location.getFile(),
                            new DefaultPosition(line, startCol, valueStartOffset),
                            new DefaultPosition(line, endCol, valueEndOffset)
                    ).withSource(node);
                }
            }
        }
        return location;
    }

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
        if (merged != null) {
            node = merged.getSecond();
        }
        SourcePosition pos = PositionXmlParser.getPosition(node);
        return pos != null ? pos.getStartOffset() : -1;
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
        if (merged != null) {
            node = merged.getSecond();
        }
        SourcePosition pos = PositionXmlParser.getPosition(node);
        return pos != null ? pos.getEndOffset() : -1;
    }

    @Override
    public int getNodeEndOffset(XmlContext context, Node node) {
        return getNodeEndOffset(this.client, context != null ? context.file : null, node);
    }

    @Override
    public Node findNodeAt(XmlContext context, int offset) {
        if (context == null || context.document == null) {
            return null;
        }
        return PositionXmlParser.findNodeAt(context.document, offset);
    }

    @Override
    public Node findNodeAt(Node node, int offset) {
        if (node == null) {
            return null;
        }
        return PositionXmlParser.findNodeAt(node, offset);
    }

    @Override
    public Location.Handle createLocationHandle(XmlContext context, Node node) {
        int start = getNodeStartOffset(context, node);
        int end = getNodeEndOffset(context, node);
        if (start < 0) {
            start = 0;
        }
        if (end < start) {
            end = start;
        }
        return new Location.DefaultLocationHandle(context, start, end);
    }
}
