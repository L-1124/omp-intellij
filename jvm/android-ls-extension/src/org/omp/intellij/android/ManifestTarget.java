package org.omp.intellij.android;

import com.intellij.openapi.progress.ProgressManager;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.util.TextRange;
import com.intellij.psi.JavaPsiFacade;
import com.intellij.psi.PsiClass;
import com.intellij.psi.PsiCompiledElement;
import com.intellij.psi.PsiElement;
import com.intellij.psi.PsiErrorElement;
import com.intellij.psi.PsiFile;
import com.intellij.psi.search.GlobalSearchScope;
import com.intellij.psi.util.PsiTreeUtil;
import com.intellij.psi.xml.XmlAttribute;
import com.intellij.psi.xml.XmlAttributeValue;
import com.intellij.psi.xml.XmlFile;
import com.intellij.psi.xml.XmlTag;

import java.util.LinkedHashMap;
import java.util.Set;

public final class ManifestTarget {
    private static final Set<String> COMPONENTS = Set.of("activity", "service", "provider", "receiver", "activity-alias");

    private ManifestTarget() {
    }

    public static ManifestClassTarget resolve(Project project, PsiFile file, int offset) {
        ProgressManager.checkCanceled();
        if (!(file instanceof XmlFile xml)) return null;
        AndroidFileInfo info = AndroidContext.identify(xml);
        if (info.role() != AndroidFileRole.MANIFEST) return null;
        XmlAttributeValue value = PsiTreeUtil.getParentOfType(xml.findElementAt(offset), XmlAttributeValue.class, false);
        if (value == null || !(value.getParent() instanceof XmlAttribute attribute)) return null;
        TextRange range = value.getValueTextRange();
        if (!range.contains(offset) || !supported(attribute, xml.getRootTag()))
            return ManifestClassTarget.notClassAttribute();
        if (PsiTreeUtil.findChildOfType(attribute, PsiErrorElement.class) != null)
            return ManifestClassTarget.notClassAttribute();
        String text = value.getText();
        if (text.length() < 2 || (text.charAt(0) != '\'' && text.charAt(0) != '"') || text.charAt(0) != text.charAt(text.length() - 1))
            return ManifestClassTarget.notClassAttribute();
        String raw = AndroidXml.value(attribute);
        if (raw.isBlank() || raw.contains("${") || raw.startsWith("@")) return ManifestClassTarget.notClassAttribute();
        XmlTag root = xml.getRootTag();
        String base = root == null ? null : AndroidXml.value(root.getAttribute("package"));
        if (base == null || base.isBlank()) base = info.namespace();
        java.util.List<String> names = classNames(raw, base);
        if (names.isEmpty())
            return failure(info, attribute, value, range, raw, AndroidQueryException.REASON_MODEL_UNAVAILABLE);
        if (info.module() == null)
            return failure(info, attribute, value, range, raw, AndroidQueryException.REASON_MODEL_UNAVAILABLE);
        GlobalSearchScope scope = info.module().getModuleWithDependenciesAndLibrariesScope(false);
        JavaPsiFacade facade = JavaPsiFacade.getInstance(project);
        for (String name : names) {
            var candidates = new LinkedHashMap<PsiElement, PsiClass>();
            for (PsiClass candidate : facade.findClasses(name, scope)) {
                ProgressManager.checkCanceled();
                candidates.putIfAbsent(candidate.getNavigationElement(), candidate);
            }
            if (candidates.size() > 1)
                return failure(info, attribute, value, range, name, AndroidQueryException.REASON_AMBIGUOUS_TARGET);
            if (candidates.isEmpty()) continue;
            var entry = candidates.entrySet().iterator().next();
            if (entry.getKey() instanceof PsiCompiledElement)
                return failure(info, attribute, value, range, name, AndroidQueryException.REASON_TARGET_UNRESOLVED);
            return new ManifestClassTarget(entry.getValue(), entry.getKey(), attribute, value, range, name, false, info.module(), true, null);
        }
        return failure(info, attribute, value, range, raw, AndroidQueryException.REASON_TARGET_UNRESOLVED);
    }

    private static ManifestClassTarget failure(AndroidFileInfo info, XmlAttribute attribute, XmlAttributeValue value, TextRange range, String name, String reason) {
        return new ManifestClassTarget(null, null, attribute, value, range, name, reason.equals(AndroidQueryException.REASON_AMBIGUOUS_TARGET), info.module(), true, reason);
    }

    private static java.util.List<String> classNames(String raw, String base) {
        String name = raw.replace('$', '.');
        if (name.startsWith("."))
            return base == null || base.isBlank() ? java.util.List.of() : java.util.List.of(base + name);
        if (base == null || base.isBlank())
            return name.indexOf('.') < 0 ? java.util.List.of() : java.util.List.of(name);
        return java.util.List.of(base + "." + name, name);
    }

    private static boolean supported(XmlAttribute attribute, XmlTag root) {
        if (!AndroidContext.ANDROID_NS.equals(attribute.getNamespace()) || root == null) return false;
        XmlTag tag = attribute.getParent();
        String name = tag.getName();
        if (name.equals("application") || name.equals("instrumentation"))
            return tag.getParentTag() == root && attribute.getLocalName().equals("name");
        if (!COMPONENTS.contains(name)) return false;
        XmlTag application = tag.getParentTag();
        if (application == null || !application.getName().equals("application") || application.getParentTag() != root)
            return false;
        return attribute.getLocalName().equals(name.equals("activity-alias") ? "targetActivity" : "name");
    }
}
