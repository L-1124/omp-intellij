package org.jetbrains.android.context

import com.intellij.openapi.externalSystem.util.ExternalSystemApiUtil
import com.intellij.openapi.module.Module
import com.intellij.openapi.module.ModuleManager
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.roots.LibraryOrderEntry
import com.intellij.openapi.roots.ModuleRootManager
import com.intellij.openapi.roots.OrderRootType
import com.intellij.openapi.roots.ProjectFileIndex
import com.intellij.openapi.vfs.VfsUtilCore
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.openapi.vfs.VirtualFileManager
import com.intellij.psi.PsiFile
import com.intellij.psi.xml.XmlFile
import org.jetbrains.android.resource.AndroidFolders
import org.jetbrains.android.resource.AndroidLayout
import org.jetbrains.android.resource.AndroidSources
import java.nio.file.Files
import java.nio.file.InvalidPathException
import java.nio.file.Path
import java.util.regex.Pattern

object AndroidContext {
    const val ANDROID_NS = "http://schemas.android.com/apk/res/android"
    private val RESOURCE_TYPES = setOf(
        "anim",
        "animator",
        "color",
        "drawable",
        "font",
        "interpolator",
        "layout",
        "menu",
        "mipmap",
        "navigation",
        "raw",
        "transition",
        "xml"
    )
    private val PACKAGE = Pattern.compile("[A-Za-z_][A-Za-z0-9_]*(?:\\.[A-Za-z_][A-Za-z0-9_]*)*")

    @JvmStatic
    fun identify(file: PsiFile?): AndroidFileInfo {
        ProgressManager.checkCanceled()
        if (file == null || file.virtualFile == null || !file.isValid) return AndroidFileInfo.nonAndroid()
        val module = findModule(file.project, file.virtualFile)
        if (module != null && isAndroidModule(module)) {
            val direct = identify(file, module)
            if (direct.isAndroidFile) return direct
        }
        // Explicit custom roots can lie outside all imported content roots.
        var selected: AndroidFileInfo? = null
        for (candidate in ModuleManager.getInstance(file.project).modules) {
            if (!isAndroidModule(candidate)) continue
            val info = identify(file, candidate)
            if (!info.isAndroidFile) continue
            val previous = selected
            if (previous != null) {
                if (previous.moduleRoot == info.moduleRoot) {
                    if (previous.variant == null && info.variant != null) selected = info
                    else if (previous.variant != null && info.variant != null && previous.variant != info.variant)
                        return AndroidFileInfo.nonAndroid()
                    continue
                }
                return AndroidFileInfo.nonAndroid()
            }
            selected = info
        }
        return selected ?: AndroidFileInfo.nonAndroid()
    }

    private fun identify(file: PsiFile, module: Module): AndroidFileInfo {
        val root = findModuleRoot(module) ?: return AndroidFileInfo.nonAndroid()
        val layout = layout(module)
        val path = Path.of(file.virtualFile.path).toAbsolutePath().normalize()
        var role = AndroidFileRole.NOT_ANDROID
        val rootTag = (file as? XmlFile)?.rootTag
        if (file is XmlFile && rootTag != null) {
            val name = rootTag.name
            if (name == "manifest" && layout.manifests.contains(path)) role = AndroidFileRole.MANIFEST
            else if (path.parent?.parent != null && layout.resources.contains(path.parent.parent)) {
                val folder = path.parent.fileName.toString()
                if (name == "resources" && AndroidFolders.isValues(folder)) role = AndroidFileRole.VALUES_XML
                else if (RESOURCE_TYPES.contains(folder.substringBefore('-'))) role = AndroidFileRole.RESOURCE_XML
            }
        } else if (file.name.endsWith(".java") || file.name.endsWith(".kt")) {
            if (module == ProjectFileIndex.getInstance(file.project).getModuleForFile(file.virtualFile))
                role = AndroidFileRole.KOTLIN_OR_JAVA
        }
        if (role == AndroidFileRole.NOT_ANDROID) return AndroidFileInfo.nonAndroid()
        return AndroidFileInfo(
            role,
            module,
            root,
            resolveVariant(module, root),
            resolveNamespace(file.project, module),
            true
        )
    }

    @JvmStatic
    fun isSupportedXml(file: XmlFile?): Boolean {
        val role = identify(file).role
        return role == AndroidFileRole.MANIFEST || role == AndroidFileRole.VALUES_XML
    }

    @JvmStatic
    fun isAndroidModule(module: Module?): Boolean =
        module != null && !module.isDisposed && findModuleRoot(module) != null && layout(module).android

    @JvmStatic
    fun findModule(project: Project, file: VirtualFile): Module? =
        ProjectFileIndex.getInstance(project).getModuleForFile(file)

    @JvmStatic
    fun findModuleRoot(module: Module?): VirtualFile? {
        if (module == null || module.isDisposed) return null
        val candidates = LinkedHashSet<Path>()
        for (content in ModuleRootManager.getInstance(module).contentRoots) {
            var current: Path? = Path.of(content.path).toAbsolutePath().normalize()
            while (current != null) {
                if (Files.isRegularFile(current.resolve("build.gradle.kts")) || Files.isRegularFile(current.resolve("build.gradle"))) {
                    candidates.add(current)
                    break
                }
                current = current.parent
            }
        }
        if (candidates.isEmpty()) {
            ExternalSystemApiUtil.getExternalProjectPath(module)?.let {
                candidates.add(Path.of(it).toAbsolutePath().normalize())
            }
        }
        if (candidates.size != 1) return null
        return VirtualFileManager.getInstance().findFileByUrl(VfsUtilCore.pathToUrl(candidates.first().toString()))
    }

    @JvmStatic
    fun resolveVariant(module: Module?, root: VirtualFile?): String? {
        if (module == null || root == null) return null
        val variants = LinkedHashSet<String>()
        val directory = Path.of(root.path).toAbsolutePath().normalize().resolve("build/intermediates")
        for (entry in ModuleRootManager.getInstance(module).orderEntries) {
            val library = (entry as? LibraryOrderEntry)?.library ?: continue
            for (url in library.getUrls(OrderRootType.CLASSES)) {
                val value = VfsUtilCore.urlToPath(url)
                val separator = value.indexOf("!/")
                val path = try {
                    Path.of(if (separator < 0) value else value.substring(0, separator)).toAbsolutePath().normalize()
                } catch (_: InvalidPathException) {
                    continue
                }
                if (!path.startsWith(directory)) continue
                val relative = directory.relativize(path)
                if (relative.nameCount >= 3 && relative.getName(0).toString() in R_CLASS_DIRECTORIES)
                    variants.add(relative.getName(1).toString())
            }
        }
        // Require both importer variant naming and its source-set URL, not leftover artifacts.
        val moduleName = module.name
        val separator = moduleName.lastIndexOf('.')
        if (separator >= 0 && separator + 1 < moduleName.length) {
            val candidate = moduleName.substring(separator + 1)
            val sourceUrl = VfsUtilCore.pathToUrl(Path.of(root.path).resolve("src").resolve(candidate).toString())
            for (contentUrl in ModuleRootManager.getInstance(module).contentRootUrls) {
                if (contentUrl == sourceUrl) variants.add(candidate)
            }
        }
        return variants.singleOrNull()
    }

    private val R_CLASS_DIRECTORIES = setOf(
        "compile_and_runtime_r_class_jar",
        "compile_r_class_jar",
        "compile_and_runtime_not_namespaced_r_class_jar"
    )

    @JvmStatic
    fun resolveNamespace(project: Project, module: Module?): String? {
        if (module == null || findModuleRoot(module) == null) return null
        return layout(module).namespace?.takeIf { PACKAGE.matcher(it).matches() }
    }

    @JvmStatic
    fun findResourceRoots(project: Project, module: Module?): List<VirtualFile> {
        if (!isAndroidModule(module)) return emptyList()
        val roots = ArrayList<VirtualFile>()
        for (path in layout(module!!).resources) {
            VirtualFileManager.getInstance().findFileByUrl(VfsUtilCore.pathToUrl(path.toString()))?.let(roots::add)
        }
        return roots
    }

    private fun layout(module: Module): AndroidLayout = AndroidSources.scope().layouts.computeIfAbsent(module) {
        val root = findModuleRoot(module)!!
        val sources = LinkedHashSet<String>()
        val sourceRoot = Path.of(root.path).toAbsolutePath().normalize().resolve("src")
        for (url in ModuleRootManager.getInstance(module).sourceRootUrls) {
            val path = Path.of(VfsUtilCore.urlToPath(url)).toAbsolutePath().normalize()
            if (path.startsWith(sourceRoot) && path.nameCount > sourceRoot.nameCount)
                sources.add(sourceRoot.relativize(path).getName(0).toString())
        }
        AndroidLayout(module.project, root, resolveVariant(module, root), sources)
    }!!
}
