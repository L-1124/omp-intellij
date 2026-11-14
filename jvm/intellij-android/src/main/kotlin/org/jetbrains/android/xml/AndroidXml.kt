package org.jetbrains.android.xml

import com.android.SdkConstants
import com.android.xml.AndroidManifest
import com.intellij.psi.xml.XmlAttribute
import com.intellij.psi.xml.XmlEntityRef
import com.intellij.psi.xml.XmlTag

object AndroidXml {
    @JvmStatic
    fun androidName(tag: XmlTag): XmlAttribute? {
        for (attribute in tag.attributes) {
            if (attribute.localName == AndroidManifest.ATTRIBUTE_NAME && SdkConstants.ANDROID_URI == attribute.namespace) {
                return attribute
            }
        }
        return null
    }

    @JvmStatic
    fun value(attribute: XmlAttribute?): String? {
        val valueElement = attribute?.valueElement ?: return null
        var child = valueElement.firstChild
        while (child != null) {
            // General entities can resolve external DTDs; structural queries never resolve them.
            if (child is XmlEntityRef) return attribute.value
            child = child.nextSibling
        }
        return attribute.displayValue
    }
}
