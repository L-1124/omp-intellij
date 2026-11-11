package org.jetbrains.android.resource

import com.intellij.ide.highlighter.XmlFileType
import com.intellij.openapi.fileTypes.PlainTextFileType
import com.intellij.openapi.fileTypes.PlainTextLanguage
import com.intellij.openapi.module.Module
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.text.StringUtil
import com.intellij.openapi.vfs.VfsUtilCore
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.openapi.vfs.VirtualFileManager
import com.intellij.psi.PsiFile
import com.intellij.psi.PsiManager
import com.intellij.psi.SingleRootFileViewProvider
import com.intellij.psi.xml.XmlFile
import com.intellij.testFramework.LightVirtualFile
import com.jetbrains.ls.api.core.LSServer
import com.jetbrains.ls.api.core.util.uri
import com.jetbrains.lsp.protocol.URI
import org.codehaus.groovy.ast.ModuleNode
import org.codehaus.groovy.control.SourceUnit
import org.jetbrains.android.context.AndroidQueryException
import org.jetbrains.kotlin.psi.KtPsiFactory
import java.io.IOException
import java.nio.file.Files
import java.nio.file.NoSuchFileException
import java.nio.file.Path
import java.nio.file.attribute.BasicFileAttributes
import java.nio.file.attribute.FileTime
import java.util.Objects

object AndroidSources {
    private val CURRENT = ThreadLocal<Scope>()

    @JvmStatic
    fun observeCompiledArchive(path: Path) {
        if (CURRENT.get() != null) track(path)
    }

    class Scope @JvmOverloads constructor(
        internal val server: LSServer?,
        file: VirtualFile?,
        openVersions: Map<String, Int?> = openVersions(server)
    ) : AutoCloseable {
        internal val initialOpenVersions: MutableMap<String, Int?> = HashMap()
        internal val versions: MutableMap<String, Int?> = HashMap()
        internal val stamps: MutableMap<Path, Stamp?> = HashMap()
        internal val directories: MutableMap<Path, DirectorySnapshot?> = HashMap()
        internal val files: MutableMap<Path, PsiFile?> = HashMap()
        internal val texts: MutableMap<Path, String?> = HashMap()
        internal var savedModelInputs: Boolean = false

        @JvmField
        val layouts: MutableMap<Module, AndroidLayout?> = HashMap()
        internal val groovyAsts: MutableMap<Path, ModuleNode?> = HashMap()

        init {
            if (CURRENT.get() != null) throw IllegalStateException("Nested Android source scope")
            initialOpenVersions.putAll(openVersions)
            CURRENT.set(this)
            observe(file)
        }

        fun useSavedModelInputs() {
            savedModelInputs = true
        }

        fun verify() {
            ProgressManager.checkCanceled()
            for ((key, value) in versions) {
                if (!Objects.equals(value, version(server, key))) {
                    throw AndroidQueryException("content_modified", -32801)
                }
            }
            for ((key, value) in stamps) {
                if (!Objects.equals(value, stamp(key))) {
                    throw AndroidQueryException("content_modified", -32801)
                }
            }
            for ((key, value) in directories) {
                if (!Objects.equals(value, directorySnapshot(key))) {
                    throw AndroidQueryException("content_modified", -32801)
                }
            }
        }

        override fun close() {
            CURRENT.remove()
        }

        companion object {
            @JvmStatic
            fun openVersions(server: LSServer?): Map<String, Int?> {
                val versions = HashMap<String, Int?>()
                if (server != null) {
                    for (uri in server.documents.openDocuments()) {
                        versions[uri.uri] = version(server, uri.uri)
                    }
                }
                return versions
            }
        }
    }

    @JvmStatic
    fun scope(): Scope {
        return CURRENT.get() ?: throw IllegalStateException("Android model reads require a request scope")
    }

    @JvmStatic
    internal fun track(path: Path) {
        val normalized = path.toAbsolutePath().normalize()
        val scope = scope()
        if (!scope.stamps.containsKey(normalized)) {
            scope.stamps[normalized] = stamp(normalized)
        }
    }

    @JvmStatic
    fun trackDirectory(directory: Path?) {
        if (directory == null) return
        val scope = CURRENT.get() ?: return
        val dir = directory.toAbsolutePath().normalize()
        if (!scope.directories.containsKey(dir)) {
            scope.directories[dir] = directorySnapshot(dir)
        }
    }

    @JvmStatic
    internal fun modifiedAfter(path: Path, time: FileTime): Boolean {
        val normalized = path.toAbsolutePath().normalize()
        track(normalized)
        val stamp = scope().stamps[normalized]
        return stamp != null && stamp.modified.compareTo(time) > 0
    }

    internal data class Stamp(
        val size: Long,
        val modified: FileTime,
        val key: Any?
    )

    internal data class DirectoryEntry(
        val name: String,
        val isDirectory: Boolean,
        val stamp: Stamp?
    )

    internal data class DirectorySnapshot(
        val entries: List<DirectoryEntry>
    )

    private fun directorySnapshot(dir: Path): DirectorySnapshot? {
        try {
            if (!Files.isDirectory(dir)) return null
            Files.list(dir).use { stream ->
                val entries = stream.map { p ->
                    val name = p.fileName.toString()
                    val isDir = Files.isDirectory(p)
                    val st = stamp(p)
                    DirectoryEntry(name, isDir, st)
                }.sorted(compareBy { it.name }).toList()
                return DirectorySnapshot(entries)
            }
        } catch (e: IOException) {
            return null
        }
    }

    private fun stamp(path: Path): Stamp? {
        return try {
            val value = Files.readAttributes(path, BasicFileAttributes::class.java)
            Stamp(value.size(), value.lastModifiedTime(), value.fileKey())
        } catch (missing: NoSuchFileException) {
            null
        } catch (error: IOException) {
            throw AndroidQueryException.modelUnavailable("Cannot stat source: $path")
        }
    }

    @JvmStatic
    fun text(path: Path): String? {
        val normalized = path.toAbsolutePath().normalize()
        val scope = CURRENT.get() ?: throw IllegalStateException("Android source reads require a request scope")
        if (scope.texts.containsKey(normalized)) return scope.texts[normalized]
        ProgressManager.checkCanceled()
        val before = stamp(normalized)
        scope.stamps[normalized] = before
        if (before == null) {
            scope.texts[normalized] = null
            return null
        }
        return try {
            val text = Files.readString(normalized)
            if (!Objects.equals(before, stamp(normalized))) {
                throw AndroidQueryException("content_modified", -32801)
            }
            scope.texts[normalized] = text
            text
        } catch (error: IOException) {
            throw AndroidQueryException.modelUnavailable("Cannot read source: $normalized")
        }
    }

    @JvmStatic
    fun current(project: Project, path: Path): PsiFile? {
        track(path)
        val url = VfsUtilCore.pathToUrl(path.toAbsolutePath().normalize().toString())
        val file = VirtualFileManager.getInstance().findFileByUrl(url)
        observe(file)
        return if (file == null) null else PsiManager.getInstance(project).findFile(file)
    }

    @JvmStatic
    fun open(file: VirtualFile?): Scope {
        return Scope(null, file)
    }

    @JvmStatic
    fun observe(file: VirtualFile?) {
        val scope = CURRENT.get()
        if (file == null || scope == null) return
        if (scope.server != null) {
            val uri = file.uri.uri
            if (!scope.versions.containsKey(uri)) {
                scope.versions[uri] = scope.initialOpenVersions[uri]
            }
        }
    }

    @JvmStatic
    fun version(server: LSServer?, uri: String?): Int? {
        if (server == null || uri == null) return null
        return server.documents.getVersion(URI(uri))
    }

    @JvmStatic
    fun gradleScript(project: Project, root: VirtualFile): PsiFile? {
        val ktsPath = Path.of(root.path, "build.gradle.kts").toAbsolutePath().normalize()
        val scope = scope()
        if (!scope.savedModelInputs) {
            val current = current(project, ktsPath)
            if (current != null) return current
        }
        if (scope.files.containsKey(ktsPath)) return scope.files[ktsPath]
        // ILS omits Gradle scripts from its source snapshot until didOpen.
        val ktsText = text(ktsPath)
        if (ktsText != null) {
            val file = KtPsiFactory(project, false).createFile("build.gradle.kts", ktsText)
            scope.files[ktsPath] = file
            return file
        }

        // Fallback to Groovy build.gradle
        val groovyPath = Path.of(root.path, "build.gradle").toAbsolutePath().normalize()
        if (!scope.savedModelInputs) {
            val current = current(project, groovyPath)
            if (current != null) return current
        }
        if (scope.files.containsKey(groovyPath)) return scope.files[groovyPath]
        val groovyText = text(groovyPath)
        if (groovyText != null) {
            val vFile = virtualFile(groovyPath, PlainTextFileType.INSTANCE, groovyText)
            val provider = SingleRootFileViewProvider(
                PsiManager.getInstance(project),
                vFile,
                false,
                PlainTextFileType.INSTANCE
            )
            val file = provider.getPsi(PlainTextLanguage.INSTANCE)
            scope.files[groovyPath] = file
            return file
        }
        return null
    }

    @JvmStatic
    fun groovyAst(project: Project, root: VirtualFile): ModuleNode? {
        val path = Path.of(root.path, "build.gradle").toAbsolutePath().normalize()
        val scope = scope()
        if (scope.groovyAsts.containsKey(path)) return scope.groovyAsts[path]
        var text: String? = null
        if (!scope.savedModelInputs) {
            val current = current(project, path)
            if (current != null) text = current.text
        }
        if (text == null) text = text(path)
        if (text.isNullOrBlank()) {
            scope.groovyAsts[path] = null
            return null
        }
        return try {
            val unit = SourceUnit.create("build.gradle", text)
            unit.parse()
            unit.completePhase()
            unit.convert()
            val ast = unit.ast
            scope.groovyAsts[path] = ast
            ast
        } catch (t: Throwable) {
            scope.groovyAsts[path] = null
            null
        }
    }

    @JvmStatic
    fun xml(project: Project, path: Path): XmlFile? {
        val normalized = path.toAbsolutePath().normalize()
        val current = current(project, normalized)
        if (current != null) return current as? XmlFile
        val scope = CURRENT.get() ?: return null
        if (scope.files.containsKey(normalized)) return scope.files[normalized] as? XmlFile
        val text = text(normalized)
        var file: XmlFile? = null
        if (text != null) {
            val virtualFile = virtualFile(normalized, XmlFileType.INSTANCE, StringUtil.convertLineSeparators(text))
            SingleRootFileViewProvider.doNotCheckFileSizeLimit(virtualFile)
            val provider =
                SingleRootFileViewProvider(PsiManager.getInstance(project), virtualFile, false, XmlFileType.INSTANCE)
            file = provider.getPsi(com.intellij.lang.xml.XMLLanguage.INSTANCE) as? XmlFile
                ?: throw AndroidQueryException.modelUnavailable("Native XML parser unavailable")
        }
        scope.files[normalized] = file
        return file
    }

    @JvmStatic
    fun diskXml(project: Project, path: Path): XmlFile? {
        val normalized = path.toAbsolutePath().normalize()
        track(normalized)
        val text = text(normalized) ?: return null
        val virtualFile = virtualFile(normalized, XmlFileType.INSTANCE, StringUtil.convertLineSeparators(text))
        SingleRootFileViewProvider.doNotCheckFileSizeLimit(virtualFile)
        val provider =
            SingleRootFileViewProvider(PsiManager.getInstance(project), virtualFile, false, XmlFileType.INSTANCE)
        val file = provider.getPsi(com.intellij.lang.xml.XMLLanguage.INSTANCE) as? XmlFile
            ?: throw AndroidQueryException.modelUnavailable("Native XML parser unavailable")
        return file
    }

    @JvmStatic
    fun navigationFile(project: Project, path: Path): PsiFile? {
        if (path.toString().endsWith(".xml")) return xml(project, path)
        track(path)
        val current = current(project, path)
        if (current != null) return current
        val file = virtualFile(path, PlainTextFileType.INSTANCE, "")
        val provider =
            SingleRootFileViewProvider(PsiManager.getInstance(project), file, false, PlainTextFileType.INSTANCE)
        return provider.getPsi(PlainTextLanguage.INSTANCE)
    }

    private fun virtualFile(
        source: Path,
        type: com.intellij.openapi.fileTypes.FileType,
        text: String
    ): LightVirtualFile {
        return object : LightVirtualFile(source.fileName.toString(), type, text) {
            override fun getPath(): String {
                return source.toString().replace('\\', '/')
            }

            override fun getUrl(): String {
                return VfsUtilCore.pathToUrl(path)
            }
        }
    }
}
