package org.jetbrains.android.navigation

import com.intellij.openapi.module.Module
import com.intellij.openapi.util.TextRange
import com.intellij.psi.PsiClass
import com.intellij.psi.PsiElement
import com.intellij.psi.xml.XmlAttribute
import com.intellij.psi.xml.XmlAttributeValue

/**
 * Resolved target of an AndroidManifest component or instrumentation class attribute.
 */
@JvmRecord
data class ManifestClassTarget(
    val targetClass: PsiClass?,
    val targetElement: PsiElement?,
    val sourceAttribute: XmlAttribute?,
    val sourceAttributeValue: XmlAttributeValue?,
    val sourceValueRange: TextRange?,
    val fqcn: String?,
    val isAmbiguous: Boolean,
    val module: Module?,
    val isClassAttribute: Boolean,
    val failureReason: String?
) {
    companion object {
        @JvmStatic
        fun notClassAttribute(): ManifestClassTarget {
            return ManifestClassTarget(null, null, null, null, null, null, false, null, false, null)
        }
    }
}
