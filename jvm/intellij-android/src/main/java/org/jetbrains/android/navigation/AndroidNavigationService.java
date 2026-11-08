package org.jetbrains.android.navigation;

import com.intellij.find.findUsages.FindUsagesHandler;
import com.intellij.find.findUsages.FindUsagesManager;
import com.intellij.find.findUsages.FindUsagesOptions;
import com.intellij.openapi.editor.Document;
import com.intellij.openapi.progress.ProgressManager;
import com.intellij.openapi.project.Project;
import com.intellij.psi.PsiDocumentManager;
import com.intellij.psi.PsiElement;
import com.intellij.psi.PsiFile;
import com.intellij.psi.xml.XmlFile;
import com.jetbrains.ls.api.core.features.LSDefinitionLocation;
import com.jetbrains.ls.api.core.util.PositionKt;
import com.jetbrains.lsp.protocol.Location;
import org.jetbrains.android.context.AndroidContext;
import org.jetbrains.android.context.AndroidFileInfo;
import org.jetbrains.android.context.AndroidFileRole;
import org.jetbrains.android.context.AndroidQueryException;
import org.jetbrains.android.resource.ResourceReference;
import org.jetbrains.android.resource.ResourceResolver;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;

public final class AndroidNavigationService {
    private static final AndroidNavigationService INSTANCE = new AndroidNavigationService();

    private AndroidNavigationService() {
    }

    public static AndroidNavigationService getInstance() {
        return INSTANCE;
    }

    public List<Location> getReferences(Project project, PsiFile file, int offset, boolean includeDeclaration) {
        ManifestClassTarget target = checkedTarget(project, file, offset);
        if (target == null) return List.of();
        PsiElement element = target.targetElement();
        FindUsagesHandler handler = new FindUsagesManager(project).getFindUsagesHandler(element, true);
        if (handler == null) throw AndroidQueryException.modelUnavailable("Native class usage handler unavailable");
        var result = new LinkedHashSet<Location>();
        if (includeDeclaration) {
            Location declaration = PositionKt.getLspLocationForDefinition(element);
            if (declaration == null) throw AndroidQueryException.targetUnresolved(target.fqcn());
            result.add(declaration);
        }
        FindUsagesOptions options = handler.getFindUsagesOptions();
        options.isSearchForTextOccurrences = false;
        handler.processElementUsages(element, usage -> {
            ProgressManager.checkCanceled();
            PsiElement reference = usage.getElement();
            if (reference != null && !(reference.getContainingFile() instanceof XmlFile)) {
                Location location = PositionKt.getLspLocationForDefinition(reference);
                if (location != null) synchronized (result) {
                    result.add(location);
                }
            }
            return true;
        }, options);
        ProgressManager.checkCanceled();
        Document document = PsiDocumentManager.getInstance(project).getDocument(file);
        if (document == null) throw AndroidQueryException.modelUnavailable("Current XML document unavailable");
        Location current = PositionKt.toLspLocation(target.sourceValueRange(), file.getVirtualFile(), document);
        if (current == null) throw AndroidQueryException.modelUnavailable("Current XML location unavailable");
        result.add(current);
        return new ArrayList<>(result);
    }

    public List<LSDefinitionLocation> getDefinitions(Project project, PsiFile file, int offset) {
        ManifestClassTarget target = checkedTarget(project, file, offset);
        if (target != null) {
            Location location = PositionKt.getLspLocationForDefinition(target.targetElement());
            if (location == null) throw AndroidQueryException.targetUnresolved(target.fqcn());
            Document document = PsiDocumentManager.getInstance(project).getDocument(file);
            return List.of(new LSDefinitionLocation(location, PositionKt.toLspRange(target.sourceValueRange(), document)));
        }
        AndroidFileInfo info = AndroidContext.identify(file);
        if (!info.isAndroidFile()) return List.of();
        ResourceReference reference = info.role() == AndroidFileRole.KOTLIN_OR_JAVA
                ? ResourceResolver.findRReferenceAt(project, file, offset) : ResourceResolver.findResourceReferenceAt(file, offset);
        if (reference == null || reference.isFramework()) return List.of();
        return ResourceResolver.resolve(project, info.module(), reference);
    }

    private static ManifestClassTarget checkedTarget(Project project, PsiFile file, int offset) {
        ProgressManager.checkCanceled();
        ManifestClassTarget target = ManifestTarget.resolve(project, file, offset);
        if (target == null || !target.isClassAttribute()) return null;
        if (target.failureReason() != null)
            throw new AndroidQueryException(target.failureReason() + ": " + target.fqcn());
        return target;
    }
}
