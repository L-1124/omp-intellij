package org.jetbrains.android.navigation;

import com.intellij.openapi.module.ModuleManager;
import com.intellij.openapi.progress.ProgressManager;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.vfs.JarFileSystem;
import com.intellij.openapi.util.io.FileUtil;
import com.intellij.openapi.vfs.VirtualFileManager;
import com.intellij.openapi.vfs.impl.jar.CoreJarFileSystem;
import com.intellij.openapi.util.Disposer;
import com.intellij.psi.PsiClass;
import com.intellij.psi.PsiClassOwner;
import com.intellij.psi.PsiElementFinder;
import com.intellij.psi.PsiManager;
import com.intellij.psi.PsiPackage;
import com.intellij.psi.ClassFileViewProvider;
import com.intellij.psi.impl.compiled.ClsFileImpl;
import com.intellij.psi.stubs.StubTree;
import com.intellij.openapi.vfs.VirtualFile;
import org.jetbrains.android.context.AndroidQueryException;
import java.io.IOException;
import java.util.concurrent.ConcurrentHashMap;
import java.util.Map;
import com.intellij.psi.search.GlobalSearchScope;
import com.jetbrains.analyzer.api.AnalyzerContextKind;
import com.jetbrains.analyzer.bootstrap.AnalyzerContainerBuilder;
import com.jetbrains.ls.api.features.WorkspaceComponentEntry;
import com.jetbrains.ls.snapshot.api.impl.core.LSConfigurationData;
import com.jetbrains.ls.snapshot.api.impl.core.WorkspaceComponent;
import kotlin.Unit;
import kotlin.coroutines.Continuation;
import org.jetbrains.android.context.AndroidContext;
import org.jetbrains.android.resource.ResourceResolver;

import java.nio.file.Path;
import java.util.LinkedHashSet;

public final class AndroidCompiledResourceClassFinder extends PsiElementFinder {
    private final Project project;
    private final CoreJarFileSystem archives = new CoreJarFileSystem();
    private final Map<VirtualFile, PsiClass[]> compiledClasses = new ConcurrentHashMap<>();

    public AndroidCompiledResourceClassFinder(Project project) {
        this.project = project;
        Disposer.register(project, archives::clearHandlersCache);
    }

    @Override
    public PsiClass findClass(String qualifiedName, GlobalSearchScope scope) {
        PsiClass[] classes = findClasses(qualifiedName, scope);
        return classes.length == 0 ? null : classes[0];
    }

    @Override
    public PsiClass[] getClasses(PsiPackage psiPackage, GlobalSearchScope scope) {
        String name = psiPackage.getQualifiedName();
        return name.isEmpty() ? PsiClass.EMPTY_ARRAY : findClasses(name + ".R", scope);
    }

    @Override
    public PsiClass[] findClasses(String qualifiedName, GlobalSearchScope scope) {
        if (!qualifiedName.endsWith(".R")) return PsiClass.EMPTY_ARRAY;
        var result = new LinkedHashSet<PsiClass>();
        for (var module : ModuleManager.getInstance(project).getModules()) {
            ProgressManager.checkCanceled();
            if (!scope.isSearchInModuleContent(module)) continue;
            var root = AndroidContext.findModuleRoot(module);
            String variant = AndroidContext.resolveVariant(module, root);
            if (variant == null) continue;
            for (var origin : ResourceResolver.findVerifiedRClassOrigins(Path.of(root.getPath()), variant)) {
                org.jetbrains.android.resource.AndroidSources.observeCompiledArchive(origin);
                String url = JarFileSystem.PROTOCOL_PREFIX + FileUtil.toSystemIndependentName(origin.toString())
                        + JarFileSystem.JAR_SEPARATOR + qualifiedName.replace('.', '/') + ".class";
                var file = VirtualFileManager.getInstance().findFileByUrl(url);
                if (file == null) file = archives.findFileByPath(url.substring(JarFileSystem.PROTOCOL_PREFIX.length()));
                if (file == null || file instanceof com.jetbrains.analyzer.filesystem.AnalyzerVirtualFile && scope.contains(file)) continue;
                PsiClass[] classes;
                if (file.getFileSystem() == archives) {
                    classes = compiledClasses.computeIfAbsent(file, this::readCompiledClasses);
                } else {
                    var psi = PsiManager.getInstance(project).findFile(file);
                    classes = psi instanceof PsiClassOwner owner ? owner.getClasses() : PsiClass.EMPTY_ARRAY;
                }
                for (PsiClass psiClass : classes) {
                    if (qualifiedName.equals(psiClass.getQualifiedName())) result.add(psiClass);
                }
            }
        }
        return result.toArray(PsiClass.EMPTY_ARRAY);
    }

    private PsiClass[] readCompiledClasses(VirtualFile file) {
        try {
            // The headless indexed stub loader requires AnalyzerVirtualFile; parse the actual class bytes with the platform builder.
            var stub = ClsFileImpl.buildFileStub(file, file.contentsToByteArray());
            if (stub == null) return PsiClass.EMPTY_ARRAY;
            var provider = new ClassFileViewProvider(PsiManager.getInstance(project), file, false);
            var tree = new StubTree(stub);
            var compiled = new ClsFileImpl(provider) {
                @Override
                public StubTree getStubTree() {
                    return tree;
                }
            };
            ((com.intellij.psi.impl.java.stubs.impl.PsiJavaFileStubImpl) stub).setPsi(compiled);
            provider.forceCachedPsi(compiled);
            return compiled.getClasses();
        } catch (IOException | com.intellij.util.cls.ClsFormatException error) {
            throw AndroidQueryException.modelUnavailable("Cannot parse compiled resource class: " + file.getPath());
        }
    }

    public static final class Entry implements WorkspaceComponentEntry, WorkspaceComponent<Object> {
        @Override
        public WorkspaceComponent<?> component() {
            return this;
        }

        @Override
        public Object init(LSConfigurationData data) {
            return this;
        }

        @Override
        public Object registerInApplicationContainer(AnalyzerContainerBuilder builder,
                com.intellij.openapi.application.Application application, Object state,
                AnalyzerContextKind kind, Continuation<? super Unit> continuation) {
            builder.extension("com.intellij.resolveScopeEnlarger", new AndroidResourceResolveScope());
            return Unit.INSTANCE;
        }

        @Override
        public Object registerInProjectContainer(AnalyzerContainerBuilder builder, Project project,
                Object state, AnalyzerContextKind kind, Continuation<? super Unit> continuation) {
            builder.extension("com.intellij.java.elementFinder", new AndroidCompiledResourceClassFinder(project));
            return Unit.INSTANCE;
        }
    }
}
