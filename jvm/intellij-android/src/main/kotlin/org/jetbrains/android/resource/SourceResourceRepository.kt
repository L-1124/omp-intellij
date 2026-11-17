@file:Suppress("UnstableApiUsage")

package org.jetbrains.android.resource

import com.android.ide.common.rendering.api.ResourceNamespace
import com.android.ide.common.resources.ResourceMergerItem
import com.android.ide.common.resources.ResourceSet
import com.android.resources.ResourceType
import com.android.utils.ILogger
import com.intellij.openapi.module.Module
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.roots.LibraryOrderEntry
import com.intellij.openapi.roots.ModuleRootManager
import com.intellij.openapi.roots.OrderRootType
import com.intellij.openapi.vfs.VfsUtilCore
import com.intellij.openapi.vfs.VirtualFile
import org.jetbrains.android.context.AndroidContext
import java.nio.file.Files
import java.nio.file.InvalidPathException
import java.nio.file.Path
import java.util.LinkedHashMap
import java.util.LinkedHashSet

/**
 * Resource declarations read from source directories through the Android SDK resource model.
 *
 * The build-output route (merger.xml, blame maps, generated R jars) describes one build snapshot and
 * breaks whenever AGP changes its intermediate layout. Source directories are the input the model is
 * designed for, so the same parsers the IDE uses produce the declarations without depending on any
 * build output: unsaved editors, qualified variants and library resources stay available.
 */
class SourceResourceRepository private constructor(
    private val sets: List<ResourceSet>,
) {

    /** Declarations of [type]/[name] in this repository, ordered by source set then qualifier. */
    fun declarations(type: String, name: String): List<Declaration> {
        ProgressManager.checkCanceled()
        val result = ArrayList<Declaration>()
        for (set in sets) {
            ProgressManager.checkCanceled()
            // Keys embed the qualifier (string-es/app_name), so match on the item itself.
            for (item in set.dataMap.values()) {
                if (item.type.getName() != type || item.name != name) continue
                result.add(Declaration(item, set.configName))
            }
        }
        return result
    }

    /** True when any source set contributes a name of [type]; used to separate "absent" from "unreadable". */
    fun has(type: String, name: String): Boolean {
        ProgressManager.checkCanceled()
        for (set in sets) {
            for (item in set.dataMap.values()) {
                if (item.type.getName() == type && item.name == name) return true
            }
        }
        return false
    }

    class Declaration(
        val item: ResourceMergerItem,
        val sourceSet: String,
    ) {
        val path: Path?
            get() = try {
                item.source.toPath()
            } catch (_: Exception) {
                null
            }

        val qualifier: String
            get() = item.configuration.qualifierString
    }

    companion object {
        private val NO_LOG = object : ILogger {
            override fun error(t: Throwable?, format: String?, vararg args: Any?) {}
            override fun warning(format: String?, vararg args: Any?) {}
            override fun info(format: String?, vararg args: Any?) {}
            override fun verbose(format: String?, vararg args: Any?) {}
        }

        private val R_CLASS_DIRECTORIES = setOf(
            "compile_and_runtime_r_class_jar",
            "compile_r_class_jar",
            "compile_and_runtime_not_namespaced_r_class_jar"
        )

        /**
         * Loads every resource source set of [module], plus the exploded resources of its imported
         * Android libraries. Libraries are named by package so equal names in different libraries
         * stay distinguishable.
         */
        fun load(project: Project, module: Module, namespace: String): SourceResourceRepository {
            ProgressManager.checkCanceled()
            val sets = ArrayList<ResourceSet>()
            val resourceNamespace = ResourceNamespace.fromPackageName(namespace)

            for (root in AndroidContext.findResourceRoots(project, module)) {
                ProgressManager.checkCanceled()
                val directory = Path.of(root.path).toAbsolutePath().normalize()
                val sourceSet = sourceSetName(module, directory)
                val set = ResourceSet(sourceSet, resourceNamespace, null, false, null)
                set.addSource(directory.toFile())
                sets.add(set)
            }

            for (library in importedLibraries(module)) {
                ProgressManager.checkCanceled()
                val set = ResourceSet(
                    library.name, ResourceNamespace.fromPackageName(library.namespace),
                    library.namespace, true, null
                )
                set.addSource(library.resources.toFile())
                sets.add(set)
            }

            for (set in sets) {
                ProgressManager.checkCanceled()
                try {
                    set.loadFromFiles(NO_LOG)
                } catch (_: Exception) {
                    // A malformed source set must not hide the ones that parsed.
                }
            }
            return SourceResourceRepository(sets)
        }

        private fun sourceSetName(module: Module, resources: Path): String {
            val src = resources.parent ?: return module.name
            return if (src.fileName?.toString() == "src") module.name else src.fileName.toString()
        }

        private class Library(val name: String, val namespace: String, val resources: Path)

        /**
         * Exploded AAR directories among the module's library roots.
         *
         * A library is recognised by an adjacent res directory and AndroidManifest.xml, which is the
         * layout AGP writes when it unpacks a dependency for compilation.
         */
        private fun importedLibraries(module: Module): List<Library> {
            val result = LinkedHashMap<Path, Library>()
            for (entry in ModuleRootManager.getInstance(module).orderEntries) {
                val library = (entry as? LibraryOrderEntry)?.library ?: continue
                for (type in listOf(OrderRootType.CLASSES, OrderRootType.SOURCES)) {
                    for (url in library.getUrls(type)) {
                        ProgressManager.checkCanceled()
                        var value = VfsUtilCore.urlToPath(url)
                        val separator = value.indexOf("!/")
                        if (separator >= 0) value = value.substring(0, separator)
                        val path = try {
                            Path.of(value).toAbsolutePath().normalize()
                        } catch (_: InvalidPathException) {
                            continue
                        }
                        val directory = if (Files.isDirectory(path)) path else path.parent ?: continue
                        var current: Path? = directory
                        while (current != null && !current.parent.equals(current)) {
                            val resources = current.resolve("res")
                            val manifest = current.resolve("AndroidManifest.xml")
                            if (Files.isDirectory(resources) && Files.isRegularFile(manifest)) {
                                val namespace = manifestNamespace(manifest) ?: break
                                result.putIfAbsent(
                                    current,
                                    Library(current.fileName.toString(), namespace, resources)
                                )
                                break
                            }
                            if (current.resolve("build").let { Files.isDirectory(it) }) break
                            current = current.parent
                        }
                    }
                }
            }
            return result.values.toList()
        }

        /** Reads the package attribute; AAR manifests carry the resource namespace there. */
        private fun manifestNamespace(manifest: Path): String? {
            return try {
                val text = Files.readString(manifest)
                val match = Regex("package=\"([^\"]+)\"").find(text) ?: return null
                match.groupValues[1].takeIf { it.isNotEmpty() }
            } catch (_: Exception) {
                null
            }
        }
    }
}
