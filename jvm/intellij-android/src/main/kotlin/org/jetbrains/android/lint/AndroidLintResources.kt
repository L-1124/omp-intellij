package org.jetbrains.android.lint

import com.android.ide.common.rendering.api.ArrayResourceValueImpl
import com.android.ide.common.rendering.api.AttrResourceValueImpl
import com.android.ide.common.rendering.api.AttributeFormat
import com.android.ide.common.rendering.api.PluralsResourceValueImpl
import com.android.ide.common.rendering.api.ResourceNamespace
import com.android.ide.common.rendering.api.ResourceValue
import com.android.ide.common.rendering.api.ResourceValueImpl
import com.android.ide.common.rendering.api.StyleItemResourceValueImpl
import com.android.ide.common.rendering.api.StyleResourceValueImpl
import com.android.ide.common.rendering.api.StyleableResourceValueImpl
import com.android.ide.common.resources.AbstractResourceRepository
import com.android.ide.common.resources.ResourceItem
import com.android.ide.common.resources.ResourceRepository
import com.android.ide.common.resources.ResourceVisitor
import com.android.ide.common.resources.SingleNamespaceResourceRepository
import com.android.ide.common.resources.ValueXmlHelper
import com.android.ide.common.resources.configuration.FolderConfiguration
import com.android.ide.common.util.PathString
import com.android.resources.ResourceFolderType
import com.android.resources.ResourceType
import com.android.resources.ResourceUrl
import com.android.tools.lint.client.api.ResourceRepositoryScope
import com.android.tools.lint.detector.api.Scope
import com.android.tools.lint.model.LintModelAndroidLibrary
import com.google.common.collect.ArrayListMultimap
import com.google.common.collect.ImmutableListMultimap
import com.google.common.collect.ListMultimap
import com.intellij.openapi.module.Module
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.roots.LibraryOrderEntry
import com.intellij.openapi.roots.ModuleOrderEntry
import com.intellij.openapi.roots.ModuleRootManager
import com.intellij.openapi.roots.OrderRootType
import com.intellij.openapi.vfs.VfsUtilCore
import com.intellij.psi.xml.XmlFile
import com.intellij.psi.xml.XmlTag
import org.jetbrains.android.context.AndroidContext
import org.jetbrains.android.context.AndroidQueryException
import org.jetbrains.android.resource.AndroidSources
import org.jetbrains.android.xml.AndroidXml
import java.io.IOException
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.util.ArrayDeque
import java.util.Collections
import java.util.EnumSet
import java.util.Queue
import java.util.concurrent.CancellationException
import java.util.regex.Pattern

class AndroidLintResources private constructor() {

    class Inputs(
        resourceRoots: List<Path>? = null,
        manifests: List<Path>? = null,
        @get:JvmName("mergedManifest")
        val mergedManifest: Path? = null,
        @get:JvmName("manifestMergeReport")
        val manifestMergeReport: Path? = null,
        @get:JvmName("fingerprint")
        val fingerprint: String? = null,
        @get:JvmName("complete")
        val complete: Boolean = false,
    ) {
        @get:JvmName("resourceRoots")
        val resourceRoots: List<Path> = resourceRoots?.let { java.util.List.copyOf(it) } ?: java.util.List.of()

        @get:JvmName("manifests")
        val manifests: List<Path> = manifests?.let { java.util.List.copyOf(it) } ?: java.util.List.of()


        override fun equals(other: Any?): Boolean {
            if (this === other) return true
            if (other !is Inputs) return false
            return resourceRoots == other.resourceRoots &&
                    manifests == other.manifests &&
                    mergedManifest == other.mergedManifest &&
                    manifestMergeReport == other.manifestMergeReport &&
                    fingerprint == other.fingerprint &&
                    complete == other.complete
        }

        override fun hashCode(): Int {
            var result = resourceRoots.hashCode()
            result = 31 * result + manifests.hashCode()
            result = 31 * result + (mergedManifest?.hashCode() ?: 0)
            result = 31 * result + (manifestMergeReport?.hashCode() ?: 0)
            result = 31 * result + (fingerprint?.hashCode() ?: 0)
            result = 31 * result + complete.hashCode()
            return result
        }

        override fun toString(): String {
            return "Inputs(resourceRoots=$resourceRoots, manifests=$manifests, mergedManifest=$mergedManifest, manifestMergeReport=$manifestMergeReport, fingerprint=$fingerprint, complete=$complete)"
        }
    }

    private data class CacheKey(
        val projectRoot: Path?,
        val moduleRoot: Path?,
        val variant: String?,
        val scope: ResourceRepositoryScope,
        val fingerprint: String?,
        val currentPath: Path?,
        val currentDocStamp: Long,
    )

    private data class CachedRepository(
        val repository: LintResourceRepository,
        val trackedDirectories: List<Path>,
        val trackedFiles: List<Path>,
    )

    private data class CachedFramework(
        val repository: LintResourceRepository,
        val trackedDirectories: List<Path>,
        val trackedFiles: List<Path>,
    )

    class LintResourceItem(
        private val name: String,
        private val type: ResourceType,
        private val namespace: ResourceNamespace,
        private val libraryName: String?,
        configuration: FolderConfiguration?,
        private val resourceValue: ResourceValue?,
        private val source: PathString?,
        private val fileBased: Boolean,
        @get:JvmName("isPublic")
        val isPublic: Boolean,
    ) : ResourceItem {
        private val configuration: FolderConfiguration = configuration ?: FolderConfiguration.createDefault()

        override fun getName(): String = name
        override fun getType(): ResourceType = type
        override fun getNamespace(): ResourceNamespace = namespace
        override fun getLibraryName(): String? = libraryName
        override fun getConfiguration(): FolderConfiguration = configuration
        override fun getResourceValue(): ResourceValue? = resourceValue
        override fun getSource(): PathString? = source
        override fun getOriginalSource(): PathString? = source
        override fun isFileBased(): Boolean = fileBased

        override fun toString(): String = "LintResourceItem($namespace:$type/$name)"
    }

    class LintResourceRepository(
        defaultNamespace: ResourceNamespace?,
        private val packageName: String?,
    ) : AbstractResourceRepository(), SingleNamespaceResourceRepository {
        private val defaultNamespace: ResourceNamespace = defaultNamespace ?: ResourceNamespace.RES_AUTO
        private val storage: MutableMap<ResourceNamespace, MutableMap<ResourceType, ListMultimap<String, ResourceItem>>> =
            LinkedHashMap()
        private val namespaces: MutableSet<ResourceNamespace> = LinkedHashSet()
        private var frameworkFallback: ResourceRepository? = null

        init {
            namespaces.add(this.defaultNamespace)
            namespaces.add(ResourceNamespace.RES_AUTO)
        }

        fun setFrameworkFallback(fallback: ResourceRepository?) {
            this.frameworkFallback = fallback
        }

        @Synchronized
        fun add(item: ResourceItem) {
            val ns = item.namespace
            namespaces.add(ns)
            addItemToNamespace(ns, item)
            if (ns != ResourceNamespace.RES_AUTO && ns != ResourceNamespace.ANDROID) {
                addItemToNamespace(ResourceNamespace.RES_AUTO, item)
            }
        }

        private fun addItemToNamespace(ns: ResourceNamespace, item: ResourceItem) {
            val forNs = storage.computeIfAbsent(ns) { LinkedHashMap() }
            val forType = forNs.computeIfAbsent(item.type) { ArrayListMultimap.create() }

            val existing = forType.get(item.name)
            var overridden = false
            for (ex in existing) {
                if (ex.configuration == item.configuration) {
                    overridden = true
                    break
                }
            }
            if (!overridden) {
                forType.put(item.name, item)
            }
        }

        override fun getResourcesInternal(
            namespace: ResourceNamespace,
            resourceType: ResourceType,
        ): ListMultimap<String, ResourceItem> {
            var forNs = storage[namespace]
            if (forNs == null && namespace == ResourceNamespace.RES_AUTO) {
                forNs = storage[defaultNamespace]
            } else if (forNs == null && namespace == defaultNamespace) {
                forNs = storage[ResourceNamespace.RES_AUTO]
            }
            if (forNs == null) {
                if (namespace == ResourceNamespace.ANDROID && frameworkFallback != null) {
                    return frameworkFallback!!.getResources(namespace, resourceType)
                }
                return ImmutableListMultimap.of()
            }
            val map = forNs[resourceType]
            return map ?: ImmutableListMultimap.of()
        }

        override fun hasResources(
            namespace: ResourceNamespace,
            resourceType: ResourceType,
            resourceName: String,
        ): Boolean {
            val has = super.hasResources(namespace, resourceType, resourceName)
            if (!has && namespace == ResourceNamespace.ANDROID && frameworkFallback != null) {
                return frameworkFallback!!.hasResources(namespace, resourceType, resourceName)
            }
            return has
        }

        override fun hasResources(
            namespace: ResourceNamespace,
            resourceType: ResourceType,
        ): Boolean {
            val has = super.hasResources(namespace, resourceType)
            if (!has && namespace == ResourceNamespace.ANDROID && frameworkFallback != null) {
                return frameworkFallback!!.hasResources(namespace, resourceType)
            }
            return has
        }

        override fun accept(visitor: ResourceVisitor): ResourceVisitor.VisitResult {
            for (forNs in storage.values) {
                for (multimap in forNs.values) {
                    for (item in multimap.values()) {
                        if (visitor.visit(item) == ResourceVisitor.VisitResult.ABORT) {
                            return ResourceVisitor.VisitResult.ABORT
                        }
                    }
                }
            }
            return ResourceVisitor.VisitResult.CONTINUE
        }

        override fun getNamespace(): ResourceNamespace = defaultNamespace

        override fun getPackageName(): String? = packageName

        override fun getNamespaces(): Set<ResourceNamespace> = Collections.unmodifiableSet(namespaces)

        override fun getPublicResources(
            namespace: ResourceNamespace,
            type: ResourceType,
        ): Collection<ResourceItem> {
            val all = getResources(namespace, type).values().toList()
            val pub = ArrayList<ResourceItem>()
            for (item in all) {
                if (item is LintResourceItem && item.isPublic) {
                    pub.add(item)
                }
            }
            return pub
        }

        override fun getLeafResourceRepositories(): Collection<SingleNamespaceResourceRepository> {
            return Collections.singletonList(this)
        }
    }

    private class TrackingCollector {
        val directories: MutableList<Path> = ArrayList()
        val files: MutableList<Path> = ArrayList()
        val seenDirs: MutableSet<Path> = LinkedHashSet()
        val seenFiles: MutableSet<Path> = LinkedHashSet()

        fun trackDirectory(dir: Path?) {
            if (dir != null && seenDirs.add(dir.toAbsolutePath().normalize())) {
                directories.add(dir.toAbsolutePath().normalize())
                AndroidSources.trackDirectory(dir)
            }
        }

        fun trackFile(file: Path?) {
            if (file != null && seenFiles.add(file.toAbsolutePath().normalize())) {
                files.add(file.toAbsolutePath().normalize())
                AndroidSources.observeCompiledArchive(file)
            }
        }
    }

    companion object {
        private val R_TXT_LINE = Pattern.compile("^([a-z\\[\\]]+)\\s+([a-zA-Z0-9_]+)\\s+([a-zA-Z0-9_]+)\\s+(.+)$")
        private const val MAX_CACHE_SIZE = 64

        private val REPO_CACHE: MutableMap<CacheKey, CachedRepository> = Collections.synchronizedMap(
            object : LinkedHashMap<CacheKey, CachedRepository>(64, 0.75f, true) {
                override fun removeEldestEntry(eldest: MutableMap.MutableEntry<CacheKey, CachedRepository>?): Boolean {
                    return size > MAX_CACHE_SIZE
                }
            }
        )

        private val FRAMEWORK_CACHE: MutableMap<String, CachedFramework> = Collections.synchronizedMap(
            object : LinkedHashMap<String, CachedFramework>(16, 0.75f, true) {
                override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, CachedFramework>?): Boolean {
                    return size > 16
                }
            }
        )

        @JvmStatic
        fun scope(model: AndroidLintModel?, path: Path?): Scope? {
            if (model == null || path == null) return null
            val normPath = path.toAbsolutePath().normalize()
            if (!normPath.toString().endsWith(".xml")) return null

            // 1. Check confirmed manifests ONLY (no arbitrary .idea or build manifests)
            val xmlInputs = model.xmlInputs
            if (xmlInputs != null) {
                for (manifest in xmlInputs.manifests) {
                    if (normPath == manifest.toAbsolutePath().normalize()) {
                        return Scope.MANIFEST
                    }
                }
            }

            // 2. Check resource files: must be direct child of resource subfolder (<resRoot>/<folder>/<file.xml>)
            val parent = normPath.parent
            if (parent != null && parent.parent != null) {
                val grandParent = parent.parent?.toAbsolutePath()?.normalize()
                if (xmlInputs != null && grandParent != null) {
                    for (root in xmlInputs.resourceRoots) {
                        if (grandParent == root.toAbsolutePath().normalize()) {
                            val folder = folderType(normPath)
                            if (folder != null) {
                                return Scope.RESOURCE_FILE
                            }
                        }
                    }
                }
            }
            return null
        }

        @JvmStatic
        fun folderType(path: Path?): ResourceFolderType? {
            if (path == null) return null
            val parent = path.parent ?: return null
            val folderName = parent.fileName.toString()
            return ResourceFolderType.getFolderType(folderName)
        }

        @JvmStatic
        fun getRepository(model: AndroidLintModel, scope: ResourceRepositoryScope): ResourceRepository {
            return getRepository(model, scope, null, null)
        }

        @JvmStatic
        fun getRepository(
            model: AndroidLintModel?,
            scope: ResourceRepositoryScope,
            currentPath: Path? = null,
            currentXml: XmlFile? = null,
        ): ResourceRepository {
            if (model == null) {
                throw AndroidQueryException.modelUnavailable("Model is null; resource repository unavailable")
            }

            if (scope == ResourceRepositoryScope.ANDROID) {
                return getFrameworkRepository(model)
            }

            val inputs = model.xmlInputs
                ?: throw AndroidQueryException.modelUnavailable("Resource inputs are null for ${model.moduleRoot}")
            if (!inputs.complete) {
                throw AndroidQueryException.modelUnavailable("Resource inputs are incomplete or unconfirmed for ${model.moduleRoot}")
            }

            val normCurrentPath = currentPath?.toAbsolutePath()?.normalize()
            val currentDocStamp = currentXml?.modificationStamp ?: 0L
            val key = CacheKey(
                projectRoot = model.projectRoot,
                moduleRoot = model.moduleRoot,
                variant = model.variant,
                scope = scope,
                fingerprint = inputs.fingerprint,
                currentPath = normCurrentPath,
                currentDocStamp = currentDocStamp,
            )
            val cached = REPO_CACHE[key]
            if (cached != null) {
                for (dir in cached.trackedDirectories) {
                    AndroidSources.trackDirectory(dir)
                }
                for (file in cached.trackedFiles) {
                    AndroidSources.observeCompiledArchive(file)
                }
                return cached.repository
            }

            val tracker = TrackingCollector()
            val repository = buildRepository(model, scope, normCurrentPath, currentXml, tracker)
            REPO_CACHE[key] = CachedRepository(repository, tracker.directories, tracker.files)
            return repository
        }

        private fun getFrameworkRepository(model: AndroidLintModel): ResourceRepository {
            val sdkHome = model.sdkHome
            val compileTarget = model.compileTarget
            if (sdkHome == null || compileTarget == null) {
                throw AndroidQueryException.modelUnavailable("SDK home or compileTarget missing for ANDROID scope repository")
            }
            val frameworkRes = sdkHome.resolve("platforms").resolve(compileTarget).resolve("data/res")
            if (!Files.isDirectory(frameworkRes)) {
                throw AndroidQueryException.modelUnavailable("SDK framework resource directory missing: $frameworkRes")
            }

            val cacheKey = "$compileTarget:$frameworkRes"
            val cached = FRAMEWORK_CACHE[cacheKey]
            if (cached != null) {
                for (dir in cached.trackedDirectories) {
                    AndroidSources.trackDirectory(dir)
                }
                for (file in cached.trackedFiles) {
                    AndroidSources.observeCompiledArchive(file)
                }
                return cached.repository
            }

            val tracker = TrackingCollector()
            val repo = LintResourceRepository(ResourceNamespace.ANDROID, "android")
            val project = model.module?.project ?: model.androidModule?.project
            parseResourceDirectory(
                project,
                frameworkRes,
                ResourceNamespace.ANDROID,
                "android",
                repo,
                tracker,
                true,
                null,
                null,
                null
            )
            FRAMEWORK_CACHE[cacheKey] = CachedFramework(repo, tracker.directories, tracker.files)
            return repo
        }

        private fun buildRepository(
            model: AndroidLintModel,
            scope: ResourceRepositoryScope,
            currentPath: Path?,
            currentXml: XmlFile?,
            tracker: TrackingCollector,
        ): LintResourceRepository {
            val project = model.module?.project ?: model.androidModule?.project
            val pkg = model.namespace
            val primaryNs = if (pkg != null) ResourceNamespace.fromPackageName(pkg) else ResourceNamespace.RES_AUTO
            val repo = LintResourceRepository(primaryNs, pkg)

            // 1. Own resources in variant precedence order
            val ownRoots = model.xmlInputs?.resourceRoots ?: emptyList()
            for (root in ownRoots) {
                ProgressManager.checkCanceled()
                parseResourceDirectory(
                    project,
                    root,
                    primaryNs,
                    null,
                    repo,
                    tracker,
                    false,
                    null,
                    currentPath,
                    currentXml
                )
            }

            // 2. Local dependent project modules (recursive transitive traversal)
            if (scope == ResourceRepositoryScope.LOCAL_DEPENDENCIES || scope == ResourceRepositoryScope.ALL_DEPENDENCIES) {
                val visited = LinkedHashSet<Module>()
                val queue: Queue<Module> = ArrayDeque()
                model.androidModule?.let {
                    queue.add(it)
                    visited.add(it)
                }
                model.module?.let {
                    visited.add(it)
                }

                while (!queue.isEmpty()) {
                    val current = queue.poll()
                    for (entry in ModuleRootManager.getInstance(current).orderEntries) {
                        ProgressManager.checkCanceled()
                        if (entry !is ModuleOrderEntry) continue
                        val depModule = entry.module
                        if (depModule == null || depModule.isDisposed || !visited.add(depModule)) continue
                        queue.add(depModule)

                        val depRootVf = AndroidContext.findModuleRoot(depModule)
                            ?: throw AndroidQueryException.modelUnavailable("Dependency module root not found: ${depModule.name}")
                        val depModel = AndroidLintModelResolver.resolve(project, depRootVf, depModule)
                            ?: throw AndroidQueryException.modelUnavailable("Model unavailable for dependency module: ${depModule.name}")
                        val depInputs = depModel.xmlInputs
                            ?: throw AndroidQueryException.modelUnavailable("Model unavailable for dependency module: ${depModule.name}")
                        if (!depInputs.complete) {
                            throw AndroidQueryException.modelUnavailable("Model incomplete for dependency module: ${depModule.name}")
                        }

                        val depPkg = depModel.namespace
                        val depNs =
                            if (depPkg != null) ResourceNamespace.fromPackageName(depPkg) else ResourceNamespace.RES_AUTO
                        for (depResRoot in depInputs.resourceRoots) {
                            ProgressManager.checkCanceled()
                            parseResourceDirectory(
                                project,
                                depResRoot,
                                depNs,
                                depModule.name,
                                repo,
                                tracker,
                                false,
                                null,
                                currentPath,
                                currentXml
                            )
                        }
                    }
                }
            }

            // 3. AAR Library dependencies
            if (scope == ResourceRepositoryScope.ALL_DEPENDENCIES) {
                if (model.sdkHome != null && model.compileTarget != null) {
                    try {
                        repo.setFrameworkFallback(getFrameworkRepository(model))
                    } catch (e: CancellationException) {
                        throw e
                    } catch (_: Exception) {
                    }
                }

                val variant = model.lintModelVariant
                val deps = variant?.artifact?.dependencies
                if (deps != null) {
                    for (lib in deps.getAll()) {
                        ProgressManager.checkCanceled()
                        if (lib is LintModelAndroidLibrary) {
                            val resFolder = lib.resFolder
                            val symbolFile = lib.symbolFile
                            val publicRes = lib.publicResources
                            val libName = lib.resolvedCoordinates.toString()
                            val libNs = ResourceNamespace.RES_AUTO

                            val publicNames = parsePublicFile(publicRes?.toPath(), tracker)

                            if (resFolder != null && resFolder.isDirectory) {
                                parseResourceDirectory(
                                    project,
                                    resFolder.toPath(),
                                    libNs,
                                    libName,
                                    repo,
                                    tracker,
                                    false,
                                    publicNames,
                                    currentPath,
                                    currentXml
                                )
                            } else if (symbolFile != null && symbolFile.isFile) {
                                parseRTxt(symbolFile.toPath(), libNs, libName, repo, tracker, publicNames)
                            }
                        }
                    }
                } else if (model.androidModule != null) {
                    for (entry in ModuleRootManager.getInstance(model.androidModule).orderEntries) {
                        ProgressManager.checkCanceled()
                        if (entry !is LibraryOrderEntry) continue
                        val library = entry.library ?: continue
                        for (url in library.getUrls(OrderRootType.CLASSES)) {
                            var pathStr = VfsUtilCore.urlToPath(url)
                            val sep = pathStr.indexOf("!/")
                            if (sep >= 0) pathStr = pathStr.substring(0, sep)
                            try {
                                val classesJar = Path.of(pathStr).toAbsolutePath().normalize()
                                val parent = classesJar.parent ?: continue
                                var resDir = parent.resolve("res")
                                var rTxt = parent.resolve("R.txt")
                                var pubTxt = parent.resolve("public.txt")
                                if (!Files.isDirectory(resDir) && parent.parent != null) {
                                    resDir = parent.parent.resolve("res")
                                    rTxt = parent.parent.resolve("R.txt")
                                    pubTxt = parent.parent.resolve("public.txt")
                                }
                                val libName = entry.libraryName
                                val publicNames = parsePublicFile(pubTxt, tracker)
                                if (Files.isDirectory(resDir)) {
                                    parseResourceDirectory(
                                        project,
                                        resDir,
                                        ResourceNamespace.RES_AUTO,
                                        libName,
                                        repo,
                                        tracker,
                                        false,
                                        publicNames,
                                        currentPath,
                                        currentXml
                                    )
                                } else if (Files.isRegularFile(rTxt)) {
                                    parseRTxt(rTxt, ResourceNamespace.RES_AUTO, libName, repo, tracker, publicNames)
                                }
                            } catch (e: CancellationException) {
                                throw e
                            } catch (_: Exception) {
                            }
                        }
                    }
                }
            }

            return repo
        }

        private fun parsePublicFile(publicFile: Path?, tracker: TrackingCollector): Set<String>? {
            if (publicFile == null || !Files.isRegularFile(publicFile)) return null
            tracker.trackFile(publicFile)
            val publicNames = HashSet<String>()
            try {
                Files.newBufferedReader(publicFile, StandardCharsets.UTF_8).use { reader ->
                    var line: String?
                    while (reader.readLine().also { line = it } != null) {
                        val trimmed = line!!.trim()
                        if (trimmed.isEmpty() || trimmed.startsWith("#")) continue
                        val parts = trimmed.split("\\s+".toRegex())
                        if (parts.size >= 2) {
                            publicNames.add("${parts[0]}:${parts[1]}")
                        }
                    }
                }
            } catch (_: IOException) {
            }
            return publicNames
        }

        private fun parseResourceDirectory(
            project: Project?,
            resDir: Path,
            namespace: ResourceNamespace,
            libraryName: String?,
            repo: LintResourceRepository,
            tracker: TrackingCollector,
            isFramework: Boolean,
            publicNames: Set<String>?,
            currentPath: Path?,
            currentXml: XmlFile?,
        ) {
            tracker.trackDirectory(resDir)
            val subfolders = LinkedHashSet<Path>()
            if (Files.isDirectory(resDir)) {
                try {
                    Files.list(resDir).use { stream ->
                        stream.filter(Files::isDirectory).forEach { subfolders.add(it) }
                    }
                } catch (_: IOException) {
                }
            }
            if (currentPath != null && currentPath.parent != null && currentPath.parent.parent != null
                && currentPath.parent.parent == resDir
            ) {
                subfolders.add(currentPath.parent)
            }

            val sortedSubfolders = subfolders.sorted()
            for (subfolder in sortedSubfolders) {
                ProgressManager.checkCanceled()
                tracker.trackDirectory(subfolder)
                val folderName = subfolder.fileName.toString()
                val folderType = ResourceFolderType.getFolderType(folderName) ?: continue
                var config = FolderConfiguration.getConfigForFolder(folderName)
                if (config == null) config = FolderConfiguration.createDefault()

                val files = LinkedHashSet<Path>()
                if (Files.isDirectory(subfolder)) {
                    try {
                        Files.list(subfolder).use { fileStream ->
                            fileStream.filter(Files::isRegularFile).forEach { files.add(it) }
                        }
                    } catch (_: IOException) {
                    }
                }
                if (currentPath != null && currentPath.parent != null && currentPath.parent == subfolder) {
                    files.add(currentPath)
                }

                val sortedFiles = files.sorted()
                for (file in sortedFiles) {
                    ProgressManager.checkCanceled()
                    tracker.trackFile(file)
                    val xmlFile: XmlFile? = if (file == currentPath && currentXml != null) {
                        currentXml
                    } else if (file.toString().endsWith(".xml")) {
                        if (project != null) AndroidSources.diskXml(project, file) else null
                    } else {
                        null
                    }

                    if (folderType == ResourceFolderType.VALUES) {
                        if (xmlFile != null) {
                            parseValuesXml(
                                file,
                                xmlFile,
                                namespace,
                                libraryName,
                                config,
                                repo,
                                isFramework,
                                publicNames
                            )
                        }
                    } else {
                        parseFileResource(file, xmlFile, folderType, namespace, libraryName, config, repo, publicNames)
                    }
                }
            }
        }

        private fun parseFileResource(
            file: Path,
            xmlFile: XmlFile?,
            folderType: ResourceFolderType,
            namespace: ResourceNamespace,
            libraryName: String?,
            config: FolderConfiguration,
            repo: LintResourceRepository,
            publicNames: Set<String>?,
        ) {
            val fileName = file.fileName.toString()
            val dot = fileName.indexOf('.')
            val resName = if (dot > 0) fileName.substring(0, dot) else fileName
            val type = folderType.resourceType ?: return

            val isPub = publicNames == null || publicNames.contains("${type.getName()}:$resName")
            val pathString = PathString(file)
            val value = ResourceValueImpl(namespace, type, resName, file.toString(), libraryName)
            val item = LintResourceItem(resName, type, namespace, libraryName, config, value, pathString, true, isPub)
            repo.add(item)

            if (xmlFile != null && xmlFile.rootTag != null) {
                collectIdsFromTag(xmlFile.rootTag!!, namespace, libraryName, config, pathString, repo, publicNames)
            }
        }

        private fun collectIdsFromTag(
            tag: XmlTag,
            namespace: ResourceNamespace,
            libraryName: String?,
            config: FolderConfiguration,
            pathString: PathString,
            repo: LintResourceRepository,
            publicNames: Set<String>?,
        ) {
            ProgressManager.checkCanceled()
            for (attr in tag.attributes) {
                val value = AndroidXml.value(attr)
                if (value != null) {
                    val url = ResourceUrl.parse(value)
                    if (url != null && url.isCreate && url.type == ResourceType.ID && !url.isFramework && url.namespace == null && url.hasValidName()) {
                        val idName = url.name
                        val isPub = publicNames == null || publicNames.contains("id:$idName")
                        val idVal = ResourceValueImpl(namespace, ResourceType.ID, idName, value, libraryName)
                        val idItem = LintResourceItem(
                            idName,
                            ResourceType.ID,
                            namespace,
                            libraryName,
                            config,
                            idVal,
                            pathString,
                            false,
                            isPub
                        )
                        repo.add(idItem)
                    }
                }
            }
            for (child in tag.subTags) {
                collectIdsFromTag(child, namespace, libraryName, config, pathString, repo, publicNames)
            }
        }

        private fun parseValuesXml(
            file: Path,
            xmlFile: XmlFile?,
            namespace: ResourceNamespace,
            libraryName: String?,
            config: FolderConfiguration,
            repo: LintResourceRepository,
            isFramework: Boolean,
            publicNames: Set<String>?,
        ) {
            if (xmlFile == null) return
            val root = xmlFile.rootTag ?: return
            if (root.name != "resources") return

            val pathString = PathString(file)
            val fileDeclaredPublic = HashSet<String>()
            for (tag in root.subTags) {
                if ("public" == tag.name) {
                    val pType = tag.getAttributeValue("type")
                    val pName = tag.getAttributeValue("name")
                    if (pType != null && pName != null) {
                        fileDeclaredPublic.add("$pType:$pName")
                    }
                }
            }

            for (tag in root.subTags) {
                ProgressManager.checkCanceled()
                val tagName = tag.name
                if ("public" == tagName) continue
                val name = tag.getAttributeValue("name")
                if (name.isNullOrEmpty()) continue

                val type: ResourceType? = when (tagName) {
                    "string" -> ResourceType.STRING
                    "color" -> ResourceType.COLOR
                    "dimen" -> ResourceType.DIMEN
                    "bool" -> ResourceType.BOOL
                    "integer" -> ResourceType.INTEGER
                    "style" -> ResourceType.STYLE
                    "attr" -> ResourceType.ATTR
                    "declare-styleable" -> ResourceType.STYLEABLE
                    "plurals" -> ResourceType.PLURALS
                    "array", "string-array", "integer-array" -> ResourceType.ARRAY
                    "item" -> {
                        val typeAttr = tag.getAttributeValue("type")
                        if (typeAttr != null) ResourceType.fromXmlTagName(typeAttr) else null
                    }

                    else -> ResourceType.fromXmlTagName(tagName)
                }

                if (type == null) continue

                val isPub: Boolean = if (isFramework) {
                    fileDeclaredPublic.contains("${type.getName()}:$name") || (publicNames != null && publicNames.contains(
                        "${type.getName()}:$name"
                    ))
                } else if (publicNames != null) {
                    publicNames.contains("${type.getName()}:$name") || fileDeclaredPublic.contains("${type.getName()}:$name")
                } else {
                    fileDeclaredPublic.isEmpty() || fileDeclaredPublic.contains("${type.getName()}:$name")
                }

                val resValue: ResourceValue = when (type) {
                    ResourceType.STYLE -> {
                        val parentStyle = tag.getAttributeValue("parent")
                        val style = StyleResourceValueImpl(namespace, name, parentStyle, libraryName)
                        for (itemTag in tag.subTags) {
                            if ("item" == itemTag.name) {
                                val itemName = itemTag.getAttributeValue("name")
                                val itemVal = parseRawText(itemTag)
                                if (itemName != null) {
                                    var attrNs = namespace
                                    var attrName = itemName
                                    if (itemName.startsWith("android:")) {
                                        attrNs = ResourceNamespace.ANDROID
                                        attrName = itemName.substring(8)
                                    }
                                    style.addItem(StyleItemResourceValueImpl(attrNs, attrName, itemVal, libraryName))
                                    if (attrNs != ResourceNamespace.RES_AUTO && attrNs != ResourceNamespace.ANDROID) {
                                        style.addItem(
                                            StyleItemResourceValueImpl(
                                                ResourceNamespace.RES_AUTO,
                                                attrName,
                                                itemVal,
                                                libraryName
                                            )
                                        )
                                    }
                                }
                            }
                        }
                        style
                    }

                    ResourceType.ATTR -> {
                        parseAttrTag(tag, namespace, name, libraryName)
                    }

                    ResourceType.STYLEABLE -> {
                        val styleable = StyleableResourceValueImpl(namespace, name, null, libraryName)
                        for (attrTag in tag.subTags) {
                            if ("attr" == attrTag.name) {
                                val attrName = attrTag.getAttributeValue("name")
                                if (!attrName.isNullOrEmpty()) {
                                    var attrNs = namespace
                                    var simpleAttrName = attrName
                                    if (attrName.startsWith("android:")) {
                                        attrNs = ResourceNamespace.ANDROID
                                        simpleAttrName = attrName.substring(8)
                                    }
                                    val childAttr = parseAttrTag(attrTag, attrNs, simpleAttrName, libraryName)
                                    styleable.addValue(childAttr)
                                    if (attrNs != ResourceNamespace.ANDROID && hasAttrDefinition(attrTag)) {
                                        val isChildPub =
                                            publicNames == null || publicNames.contains("attr:$simpleAttrName") || fileDeclaredPublic.contains(
                                                "attr:$simpleAttrName"
                                            )
                                        repo.add(
                                            LintResourceItem(
                                                simpleAttrName,
                                                ResourceType.ATTR,
                                                attrNs,
                                                libraryName,
                                                config,
                                                childAttr,
                                                pathString,
                                                false,
                                                isChildPub
                                            )
                                        )
                                    }
                                }
                            }
                        }
                        styleable
                    }

                    ResourceType.ARRAY -> {
                        val arr = ArrayResourceValueImpl(namespace, name, libraryName)
                        for (elem in tag.subTags) {
                            arr.addElement(parseRawText(elem))
                        }
                        arr
                    }

                    ResourceType.PLURALS -> {
                        val plurals = PluralsResourceValueImpl(namespace, name, null, libraryName)
                        for (item in tag.subTags) {
                            val quantity = item.getAttributeValue("quantity")
                            if (quantity != null) {
                                plurals.addPlural(quantity, parseRawText(item))
                            }
                        }
                        plurals
                    }

                    else -> {
                        val textVal = parseRawText(tag)
                        ResourceValueImpl(namespace, type, name, textVal, libraryName)
                    }
                }

                val item =
                    LintResourceItem(name, type, namespace, libraryName, config, resValue, pathString, false, isPub)
                repo.add(item)
            }
        }

        private fun parseRawText(tag: XmlTag?): String? {
            val value = tag?.value ?: return null
            if (value.hasCDATA()) {
                val sb = StringBuilder()
                for (text in value.textElements) {
                    sb.append(text.value)
                }
                return sb.toString().trim()
            }
            val raw = value.text ?: return null
            return ValueXmlHelper.unescapeResourceString(raw, true, true)
        }

        private fun parseAttrTag(
            tag: XmlTag,
            namespace: ResourceNamespace,
            name: String,
            libraryName: String?,
        ): AttrResourceValueImpl {
            val attr = AttrResourceValueImpl(namespace, name, libraryName)
            val formats = EnumSet.noneOf(AttributeFormat::class.java)
            val formatString = tag.getAttributeValue("format")
            if (formatString != null) {
                formats.addAll(AttributeFormat.parse(formatString))
            }

            for (child in tag.subTags) {
                val childName = child.name
                when (childName) {
                    "enum" -> formats.add(AttributeFormat.ENUM)
                    "flag" -> formats.add(AttributeFormat.FLAGS)
                    else -> continue
                }
                val valName = child.getAttributeValue("name")
                if (!valName.isNullOrEmpty()) {
                    var desc = child.getAttributeValue("description")
                    if (desc == null) desc = child.getAttributeValue("_description")
                    var numericValue: Int? = null
                    val valueStr = child.getAttributeValue("value")
                    if (valueStr != null) {
                        try {
                            numericValue = java.lang.Long.decode(valueStr.trim()).toInt()
                        } catch (_: NumberFormatException) {
                        }
                    }
                    attr.addValue(valName, numericValue, desc)
                }
            }
            attr.setFormats(formats)

            var description = tag.getAttributeValue("description")
            if (description == null) description = tag.getAttributeValue("_description")
            if (description != null) {
                attr.setDescription(description)
            }
            val groupName = tag.getAttributeValue("_groupName")
            if (groupName != null) {
                attr.setGroupName(groupName)
            }
            return attr
        }

        private fun hasAttrDefinition(tag: XmlTag): Boolean {
            if (tag.getAttributeValue("format") != null) return true
            for (child in tag.subTags) {
                val name = child.name
                if ("enum" == name || "flag" == name) return true
            }
            return false
        }

        private fun parseRTxt(
            rTxtFile: Path,
            namespace: ResourceNamespace,
            libraryName: String?,
            repo: LintResourceRepository,
            tracker: TrackingCollector,
            publicNames: Set<String>?,
        ) {
            if (!Files.isRegularFile(rTxtFile)) return
            tracker.trackFile(rTxtFile)
            try {
                Files.newBufferedReader(rTxtFile, StandardCharsets.UTF_8).use { reader ->
                    var line: String?
                    while (reader.readLine().also { line = it } != null) {
                        val matcher = R_TXT_LINE.matcher(line!!.trim())
                        if (matcher.matches()) {
                            val typeStr = matcher.group(2)
                            val name = matcher.group(3)
                            val type = ResourceType.fromXmlTagName(typeStr)
                            if (type != null) {
                                val isPub = publicNames == null || publicNames.contains("${type.getName()}:$name")
                                // R.txt does not contain actual string values; value is set to null
                                val valImpl = ResourceValueImpl(namespace, type, name, null, libraryName)
                                val item = LintResourceItem(
                                    name,
                                    type,
                                    namespace,
                                    libraryName,
                                    FolderConfiguration.createDefault(),
                                    valImpl,
                                    PathString(rTxtFile),
                                    false,
                                    isPub
                                )
                                repo.add(item)
                            }
                        }
                    }
                }
            } catch (_: IOException) {
            }
        }
    }
}
