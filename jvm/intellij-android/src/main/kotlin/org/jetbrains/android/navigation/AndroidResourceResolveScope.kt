package org.jetbrains.android.navigation

import com.intellij.openapi.module.Module
import com.intellij.openapi.module.ModuleManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.psi.ResolveScopeEnlarger
import com.intellij.psi.search.GlobalSearchScope
import com.intellij.psi.search.SearchScope
import org.jetbrains.android.context.AndroidContext
import org.jetbrains.android.resource.ResourceResolver
import java.nio.file.Path

class AndroidResourceResolveScope : ResolveScopeEnlarger() {
    override fun getAdditionalResolveScope(file: VirtualFile, project: Project): SearchScope? {
        val owner = AndroidContext.findModule(project, file) ?: return null
        val archives = HashSet<Path>()
        val dependencies = owner.getModuleWithDependenciesScope()
        for (module in ModuleManager.getInstance(project).modules) {
            if (!dependencies.isSearchInModuleContent(module)) continue
            val root = AndroidContext.findModuleRoot(module)
            val variant = AndroidContext.resolveVariant(module, root)
            if (variant != null && root != null) {
                archives.addAll(ResourceResolver.findVerifiedRClassOrigins(Path.of(root.path), variant))
            }
        }
        if (archives.isEmpty()) return null
        return object : GlobalSearchScope(project) {
            override fun contains(candidate: VirtualFile): Boolean {
                val path = candidate.path
                val separator = path.indexOf("!/")
                return separator >= 0 && archives.contains(
                    Path.of(path.substring(0, separator)).toAbsolutePath().normalize()
                )
            }

            override fun isSearchInModuleContent(module: Module): Boolean {
                return dependencies.isSearchInModuleContent(module)
            }

            override fun isSearchInLibraries(): Boolean = true
        }
    }
}
