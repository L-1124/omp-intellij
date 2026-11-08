package org.jetbrains.android.xml;

import com.intellij.psi.xml.XmlAttribute;
import org.jetbrains.android.context.AndroidContext;

public final class AndroidXml {
    private AndroidXml() {
    }

    static XmlAttribute androidName(com.intellij.psi.xml.XmlTag tag) {
        for (XmlAttribute attribute : tag.getAttributes()) {
            if (attribute.getLocalName().equals("name") && AndroidContext.ANDROID_NS.equals(attribute.getNamespace()))
                return attribute;
        }
        return null;
    }

    public static String value(XmlAttribute attribute) {
        if (attribute == null || attribute.getValueElement() == null) return null;
        for (var child = attribute.getValueElement().getFirstChild(); child != null; child = child.getNextSibling()) {
            // General entities can resolve external DTDs; structural queries never resolve them.
            if (child instanceof com.intellij.psi.xml.XmlEntityRef) return attribute.getValue();
        }
        return attribute.getDisplayValue();
    }
}
