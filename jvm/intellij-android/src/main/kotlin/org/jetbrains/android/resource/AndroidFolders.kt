package org.jetbrains.android.resource

import com.android.SdkConstants
import com.android.ide.common.resources.configuration.FolderConfiguration
import com.android.resources.FolderTypeRelationship
import com.android.resources.ResourceFolderType
import com.android.resources.ResourceType
import com.intellij.psi.xml.XmlTag

object AndroidFolders {

    @JvmStatic
    fun isValues(name: String): Boolean =
        ResourceFolderType.getFolderType(name) == ResourceFolderType.VALUES &&
            FolderConfiguration.getConfigForFolder(name) != null

    @JvmStatic
    fun isResourceFolder(name: String): Boolean =
        ResourceFolderType.getFolderType(name) != null &&
            FolderConfiguration.getConfigForFolder(name) != null

    @JvmStatic
    fun folderNames(type: String): List<String> {
        val resType = ResourceType.fromClassName(type) ?: ResourceType.fromXmlTagName(type) ?: return emptyList()
        val result = ArrayList<String>()
        val nonValues = FolderTypeRelationship.getNonValuesRelatedFolder(resType)
        if (nonValues != null) {
            result.add(nonValues.getName())
        }
        if (FolderTypeRelationship.match(resType, ResourceFolderType.VALUES)) {
            result.add(ResourceFolderType.VALUES.getName())
        }
        return result
    }

    @JvmStatic
    fun valueResourceType(tag: XmlTag): String? {
        val tagName = tag.name
        if (tagName == SdkConstants.TAG_RESOURCES ||
            tagName == "declare-styleable" ||
            tagName == "eat-comment" ||
            tagName == "skip" ||
            tagName == "public" ||
            tagName == "overlayable" ||
            tagName == "bag"
        ) {
            return null
        }
        val resType = ResourceType.fromXmlTag(tag, { it.name }, { t, attr -> t.getAttributeValue(attr) })
        return resType?.getName()
    }
}
