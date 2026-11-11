package org.jetbrains.android.navigation

import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.TextRange
import com.intellij.psi.JavaPsiFacade
import com.intellij.psi.PsiClass
import com.intellij.psi.PsiCompiledElement
import com.intellij.psi.PsiElement
import com.intellij.psi.PsiErrorElement
import com.intellij.psi.PsiFile
import com.intellij.psi.util.PsiTreeUtil
import com.intellij.psi.xml.XmlAttribute
import com.intellij.psi.xml.XmlAttributeValue
import com.intellij.psi.xml.XmlFile
import com.intellij.psi.xml.XmlTag
import org.jetbrains.android.context.AndroidContext
import org.jetbrains.android.context.AndroidFileInfo
import org.jetbrains.android.context.AndroidFileRole
import org.jetbrains.android.context.AndroidQueryException
import org.jetbrains.android.xml.AndroidXml

object ManifestTarget {
    private val COMPONENTS = setOf("activity", "service", "provider", "receiver", "activity-alias")

    @JvmStatic
    fun resolve(project: Project, file: PsiFile, offset: Int): ManifestClassTarget? {
        ProgressManager.checkCanceled()
        val xml = file as? XmlFile ?: return null
        val info = AndroidContext.identify(xml)
        if (info.role != AndroidFileRole.MANIFEST) return null
        val value = PsiTreeUtil.getParentOfType(xml.findElementAt(offset), XmlAttributeValue::class.java, false)
        val attribute = value?.parent as? XmlAttribute ?: return null
        val range = value.valueTextRange
        if (!range.contains(offset) || !supported(attribute, xml.rootTag)) {
            return ManifestClassTarget.notClassAttribute()
        }
        if (PsiTreeUtil.findChildOfType(attribute, PsiErrorElement::class.java) != null) {
            return ManifestClassTarget.notClassAttribute()
        }
        val text = value.text
        if (text.length < 2 || (text[0] != '\'' && text[0] != '"') || text[0] != text[text.length - 1]) {
            return ManifestClassTarget.notClassAttribute()
        }
        val raw = AndroidXml.value(attribute)
        if (raw == null || raw.isBlank() || raw.contains("\${") || raw.startsWith("@")) {
            return ManifestClassTarget.notClassAttribute()
        }
        val root = xml.rootTag
        var base = root?.getAttribute("package")?.let { AndroidXml.value(it) }
        if (base.isNullOrBlank()) base = info.namespace
        val names = classNames(raw, base)
        if (names.isEmpty()) {
            return failure(info, attribute, value, range, raw, AndroidQueryException.REASON_MODEL_UNAVAILABLE)
        }
        val module = info.module
            ?: return failure(info, attribute, value, range, raw, AndroidQueryException.REASON_MODEL_UNAVAILABLE)
        val scope = module.getModuleWithDependenciesAndLibrariesScope(false)
        val facade = JavaPsiFacade.getInstance(project)
        for (name in names) {
            val candidates = LinkedHashMap<PsiElement, PsiClass>()
            for (candidate in facade.findClasses(name, scope)) {
                ProgressManager.checkCanceled()
                val navElement = candidate.navigationElement
                if (navElement != null) {
                    candidates.putIfAbsent(navElement, candidate)
                }
            }
            if (candidates.size > 1) {
                return failure(info, attribute, value, range, name, AndroidQueryException.REASON_AMBIGUOUS_TARGET)
            }
            if (candidates.isEmpty()) continue
            val entry = candidates.entries.iterator().next()
            if (entry.key is PsiCompiledElement) {
                return failure(info, attribute, value, range, name, AndroidQueryException.REASON_TARGET_UNRESOLVED)
            }
            return ManifestClassTarget(entry.value, entry.key, attribute, value, range, name, false, module, true, null)
        }
        return failure(info, attribute, value, range, raw, AndroidQueryException.REASON_TARGET_UNRESOLVED)
    }

    private fun failure(
        info: AndroidFileInfo,
        attribute: XmlAttribute,
        value: XmlAttributeValue,
        range: TextRange,
        name: String,
        reason: String
    ): ManifestClassTarget {
        return ManifestClassTarget(
            null,
            null,
            attribute,
            value,
            range,
            name,
            reason == AndroidQueryException.REASON_AMBIGUOUS_TARGET,
            info.module,
            true,
            reason
        )
    }

    private fun classNames(raw: String, base: String?): List<String> {
        val name = raw.replace('$', '.')
        if (name.startsWith(".")) {
            return if (base.isNullOrBlank()) emptyList() else listOf(base + name)
        }
        if (base.isNullOrBlank()) {
            return if (name.indexOf('.') < 0) emptyList() else listOf(name)
        }
        return listOf("$base.$name", name)
    }

    private fun supported(attribute: XmlAttribute, root: XmlTag?): Boolean {
        if (AndroidContext.ANDROID_NS != attribute.namespace || root == null) return false
        val tag = attribute.parent
        val name = tag.name
        if (name == "application" || name == "instrumentation") {
            return tag.parentTag == root && attribute.localName == "name"
        }
        if (!COMPONENTS.contains(name)) return false
        val application = tag.parentTag
        if (application == null || application.name != "application" || application.parentTag != root) {
            return false
        }
        val expected = if (name == "activity-alias") "targetActivity" else "name"
        return attribute.localName == expected
    }
}
