package org.jetbrains.android.navigation;

import com.intellij.navigation.DirectNavigationProvider;
import com.intellij.openapi.module.Module;
import com.intellij.openapi.module.ModuleManager;
import com.intellij.openapi.progress.ProgressManager;
import com.intellij.openapi.util.TextRange;
import com.intellij.psi.PsiClass;
import com.intellij.psi.PsiElement;
import com.intellij.psi.PsiField;
import com.intellij.psi.PsiFile;
import com.intellij.psi.impl.FakePsiElement;
import com.jetbrains.ls.api.core.util.PositionKt;
import org.jetbrains.android.context.AndroidContext;
import org.jetbrains.android.context.AndroidQueryException;
import org.jetbrains.android.resource.AndroidSources;
import org.jetbrains.android.resource.ResourceReference;
import org.jetbrains.android.resource.AndroidLocations;
import org.jetbrains.android.resource.ResourceResolver;

import com.intellij.openapi.application.Application;
import com.jetbrains.analyzer.api.AnalyzerContextKind;
import com.jetbrains.analyzer.bootstrap.AnalyzerContainerBuilder;
import com.jetbrains.ls.api.features.WorkspaceComponentEntry;
import com.jetbrains.ls.snapshot.api.impl.core.LSConfigurationData;
import com.jetbrains.ls.snapshot.api.impl.core.WorkspaceComponent;
import kotlin.Unit;
import kotlin.coroutines.Continuation;
import java.nio.file.Path;

public final class AndroidResourceNavigation implements DirectNavigationProvider {
    public static final AndroidResourceNavigation INSTANCE = new AndroidResourceNavigation();

    public AndroidResourceNavigation() {
    }
    @Override
    public PsiElement getNavigationElement(PsiElement element) {
        if (!(element instanceof PsiField field)) return null;
        PsiClass type = field.getContainingClass();
        PsiClass owner = type == null ? null : type.getContainingClass();
        String qualified = owner == null ? null : owner.getQualifiedName();
        if (qualified == null || !qualified.endsWith(".R") || qualified.equals("android.R")) return null;
        var file = field.getContainingFile().getVirtualFile();
        if (file == null || !file.getPath().contains("!/")) return null;
        Path origin = Path.of(file.getPath().substring(0, file.getPath().indexOf("!/"))).toAbsolutePath().normalize();
        try (var sources = AndroidSources.open(element.getContainingFile().getVirtualFile())) {
            for (Module module : ModuleManager.getInstance(element.getProject()).getModules()) {
                ProgressManager.checkCanceled();
                if (!AndroidContext.isAndroidModule(module)) continue;
                var root = AndroidContext.findModuleRoot(module);
                if (root == null || !origin.startsWith(Path.of(root.getPath()).toAbsolutePath().normalize())) continue;
                var reference = new ResourceReference(type.getName(), field.getName(), qualified.substring(0, qualified.length() - 2), false, null, origin);
                var definitions = ResourceResolver.resolveAll(element.getProject(), module, reference);
                if (definitions.isEmpty()) continue;
                var location = definitions.get(0).getLocation();
                Path path = AndroidLocations.path(location);
                PsiFile xml = AndroidSources.navigationFile(element.getProject(), path);
                if (xml == null) continue;
                var document = xml.getFileDocument();
                int start = PositionKt.offsetByPosition(document, location.getRange().getStart());
                int end = PositionKt.offsetByPosition(document, location.getRange().getEnd());
                sources.verify();
                return new Declaration(xml, new TextRange(start, end));
            }
            return null;
        } catch (AndroidQueryException error) {
            if (error.getErrorCode() == -32801)
                return AndroidResourceNavigation.<RuntimeException, PsiElement>raise(new com.jetbrains.lsp.implementation.LspResponseErrorException(error.getMessage(), -32801, null, error));
            return null;
        }
    }

    @SuppressWarnings("unchecked")
    private static <E extends Throwable, T> T raise(Throwable error) throws E {
        throw (E) error;
    }

    private static final class Declaration extends FakePsiElement {
        private final PsiFile file;
        private final TextRange range;

        Declaration(PsiFile file, TextRange range) {
            this.file = file;
            this.range = range;
        }

        @Override
        public PsiElement getParent() {
            return file;
        }

        @Override
        public PsiFile getContainingFile() {
            return file;
        }

        @Override
        public TextRange getTextRange() {
            return range;
        }

        @Override
        public int getTextOffset() {
            return range.getStartOffset();
        }

        @Override
        public PsiElement getNavigationElement() {
            return this;
        }

        @Override
        public String getText() {
            return file.getText().substring(range.getStartOffset(), range.getEndOffset());
        }
    }

    public static final class Component implements WorkspaceComponent<Object> {
        public static final Component INSTANCE = new Component();

        private Component() {
        }

        @Override
        public Object init(LSConfigurationData data) {
            return this;
        }

        @Override
        public Object registerInApplicationContainer(
                AnalyzerContainerBuilder builder,
                Application application,
                Object state,
                AnalyzerContextKind kind,
                Continuation<? super Unit> continuation) {
            builder.extension("com.intellij.lang.directNavigationProvider", AndroidResourceNavigation.INSTANCE);
            return Unit.INSTANCE;
        }

    }

    public static final class Entry implements WorkspaceComponentEntry {
        @Override
        public WorkspaceComponent<?> component() {
            return Component.INSTANCE;
        }
    }
}
