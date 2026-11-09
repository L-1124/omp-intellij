package org.jetbrains.android.navigation;

import com.intellij.openapi.module.Module;
import com.intellij.openapi.module.ModuleManager;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.vfs.VirtualFile;
import com.intellij.psi.ResolveScopeEnlarger;
import com.intellij.psi.search.GlobalSearchScope;
import com.intellij.psi.search.SearchScope;
import org.jetbrains.android.context.AndroidContext;
import org.jetbrains.android.resource.ResourceResolver;

import java.nio.file.Path;
import java.util.HashSet;
import java.util.Set;

public final class AndroidResourceResolveScope extends ResolveScopeEnlarger {
    @Override
    public SearchScope getAdditionalResolveScope(VirtualFile file, Project project) {
        Module owner = AndroidContext.findModule(project, file);
        if (owner == null) return null;
        Set<Path> archives = new HashSet<>();
        var dependencies = owner.getModuleWithDependenciesScope();
        for (Module module : ModuleManager.getInstance(project).getModules()) {
            if (!dependencies.isSearchInModuleContent(module)) continue;
            var root = AndroidContext.findModuleRoot(module);
            String variant = AndroidContext.resolveVariant(module, root);
            if (variant != null) archives.addAll(ResourceResolver.findVerifiedRClassOrigins(Path.of(root.getPath()), variant));
        }
        if (archives.isEmpty()) return null;
        return new GlobalSearchScope(project) {
            @Override
            public boolean contains(VirtualFile candidate) {
                String path = candidate.getPath();
                int separator = path.indexOf("!/");
                return separator >= 0 && archives.contains(Path.of(path.substring(0, separator)).toAbsolutePath().normalize());
            }

            @Override
            public boolean isSearchInModuleContent(Module module) {
                return dependencies.isSearchInModuleContent(module);
            }

            @Override
            public boolean isSearchInLibraries() {
                return true;
            }
        };
    }
}
