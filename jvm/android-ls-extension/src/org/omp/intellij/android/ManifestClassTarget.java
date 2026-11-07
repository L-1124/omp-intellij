package org.omp.intellij.android;

import com.intellij.openapi.module.Module;
import com.intellij.openapi.util.TextRange;
import com.intellij.psi.PsiClass;
import com.intellij.psi.PsiElement;
import com.intellij.psi.xml.XmlAttribute;
import com.intellij.psi.xml.XmlAttributeValue;

/**
 * Resolved target of an AndroidManifest component or instrumentation class attribute.
 *
 * @param targetClass          Resolved Java/Kotlin PsiClass, or null if unresolved
 * @param targetElement        Navigation PsiElement (e.g. KtClass or PsiClass declaration), or null
 * @param sourceAttribute      The XmlAttribute in AndroidManifest.xml
 * @param sourceAttributeValue The XmlAttributeValue holding the class name
 * @param sourceValueRange     Exact text range of the attribute value (excluding delimiters)
 * @param fqcn                 Normalized fully qualified class name, or null if cannot be constructed
 * @param isAmbiguous          True if resolution found multiple conflicting declarations
 * @param module               Module containing the AndroidManifest
 * @param isClassAttribute     True if the cursor is on a valid component/instrumentation class attribute
 * @param failureReason        Specific error reason if identified as a class attribute but failed (e.g. model_unavailable)
 */
public record ManifestClassTarget(
        PsiClass targetClass,
        PsiElement targetElement,
        XmlAttribute sourceAttribute,
        XmlAttributeValue sourceAttributeValue,
        TextRange sourceValueRange,
        String fqcn,
        boolean isAmbiguous,
        Module module,
        boolean isClassAttribute,
        String failureReason
) {
    public static ManifestClassTarget notClassAttribute() {
        return new ManifestClassTarget(null, null, null, null, null, null, false, null, false, null);
    }
}
