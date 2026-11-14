package org.jetbrains.android.testing

import com.android.AndroidXConstants
import com.android.SdkConstants
import com.android.resources.ResourceFolderType
import com.android.resources.ResourceType
import com.android.utils.SdkUtils
import com.intellij.lang.java.JavaLanguage
import com.intellij.navigation.NavigationItem
import com.intellij.openapi.application.readAction
import com.intellij.openapi.module.Module
import com.intellij.openapi.module.ModuleManager
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.roots.LibraryOrderEntry
import com.intellij.openapi.roots.ModuleRootManager
import com.intellij.openapi.roots.OrderRootType
import com.intellij.openapi.util.io.FileUtil
import com.intellij.openapi.vfs.*
import com.intellij.openapi.vfs.impl.jar.CoreJarFileSystem
import com.intellij.psi.*
import com.intellij.psi.search.searches.ReferencesSearch
import com.intellij.psi.util.InheritanceUtil
import com.intellij.psi.util.PsiTreeUtil
import com.intellij.psi.xml.XmlFile
import com.intellij.testIntegration.TestFinderHelper
import com.intellij.util.Processor
import com.jetbrains.ls.api.core.LSAnalysisContext
import com.jetbrains.ls.api.core.LSServer
import com.jetbrains.ls.api.core.util.findVirtualFile
import com.jetbrains.ls.api.core.util.getLspLocationForDefinition
import com.jetbrains.ls.api.core.util.uri
import com.jetbrains.ls.api.features.language.LSLanguage
import com.jetbrains.ls.api.features.relatedTests.LSRelatedTestsProvider
import com.jetbrains.ls.api.features.relatedTests.RelatedTestsParams
import com.jetbrains.ls.api.features.relatedTests.RelatedTestsResult
import com.jetbrains.lsp.implementation.LspHandlerContext
import com.jetbrains.lsp.protocol.*
import org.jetbrains.android.AndroidExtension
import org.jetbrains.android.context.AndroidContext
import org.jetbrains.android.context.AndroidFileRole
import org.jetbrains.android.context.AndroidQueryException
import org.jetbrains.android.navigation.ManifestTarget
import org.jetbrains.android.resource.AndroidSources
import org.jetbrains.android.resource.ResourceResolver
import org.jetbrains.android.xml.AndroidXml
import org.jetbrains.kotlin.asJava.toLightClass
import org.jetbrains.kotlin.idea.KotlinLanguage
import org.jetbrains.kotlin.psi.KtCallExpression
import org.jetbrains.kotlin.psi.KtClass
import org.jetbrains.kotlin.psi.KtNameReferenceExpression
import org.jetbrains.kotlin.psi.psiUtil.containingClass
import java.nio.file.Files
import java.nio.file.InvalidPathException
import java.nio.file.Path

class AndroidXmlRelatedTestsProvider : LSRelatedTestsProvider {

    override val supportedLanguages: Set<LSLanguage>
        get() = setOf(AndroidExtension.XML)

    context(server: LSServer, handlerContext: LspHandlerContext)
    override suspend fun getRelatedTests(params: RelatedTestsParams): RelatedTestsResult {
        val openVersions = AndroidSources.Scope.openVersions(server)
        val pending = server.withAnalysisContext {
            readAction {
                ProgressManager.checkCanceled()
                val project = contextOf<LSAnalysisContext>().project
                val virtualFile = params.textDocument.findVirtualFile()
                if (virtualFile == null) {
                    return@readAction VerifiedQueryResult(emptyResult(), null)
                }
                val psiFile = virtualFile.findPsiFile(project)
                if (psiFile == null) {
                    return@readAction VerifiedQueryResult(emptyResult(), null)
                }
                val document = virtualFile.findDocument()
                    ?: PsiDocumentManager.getInstance(project).getDocument(psiFile)
                if (document == null) {
                    return@readAction VerifiedQueryResult(emptyResult(), null)
                }
                val line = params.position.line
                if (line !in 0 until document.lineCount) {
                    return@readAction VerifiedQueryResult(emptyResult(), null)
                }
                val character = params.position.character
                val lineLength = document.getLineEndOffset(line) - document.getLineStartOffset(line)
                if (character !in 0..lineLength) {
                    return@readAction VerifiedQueryResult(emptyResult(), null)
                }
                val offset = document.getLineStartOffset(line) + character
                val stamp = document.modificationStamp
                val contents = document.immutableCharSequence
                val observedDocs = LinkedHashMap<VirtualFile, ObservedDocument>()
                try {
                    AndroidSources.Scope(server, virtualFile, openVersions).use { sources ->
                        val result = findRelatedTests(project, psiFile, offset, observedDocs)
                        ProgressManager.checkCanceled()
                        if (stamp != document.modificationStamp) {
                            throw AndroidQueryException("content_modified", -32801)
                        }
                        verifyObservedDocuments(project, observedDocs)
                        sources.verify()
                        VerifiedQueryResult(
                            result = result,
                            verify = { verifyProject ->
                                ProgressManager.checkCanceled()
                                sources.verify()
                                val latestVf = params.textDocument.findVirtualFile()
                                val latestDoc = latestVf?.findDocument()
                                    ?: latestVf?.findPsiFile(verifyProject)?.let {
                                        PsiDocumentManager.getInstance(verifyProject).getDocument(it)
                                    }
                                if (latestDoc == null ||
                                    latestDoc.modificationStamp != stamp ||
                                    java.lang.CharSequence.compare(contents, latestDoc.immutableCharSequence) != 0
                                ) {
                                    throw AndroidQueryException("content_modified", -32801)
                                }
                                verifyObservedDocumentsByUri(verifyProject, observedDocs.values)
                            }
                        )
                    }
                } catch (error: AndroidQueryException) {
                    error.throwAsLspError()
                }
            }
        }
        val verify = pending.verify
        if (verify != null) {
            server.withAnalysisContext {
                readAction {
                    val verifyProject = contextOf<LSAnalysisContext>().project
                    try {
                        verify(verifyProject)
                    } catch (error: AndroidQueryException) {
                        error.throwAsLspError()
                    }
                }
            }
        }
        return pending.result
    }

    internal data class ObservedDocument(
        val uri: URI,
        val stamp: Long,
        val contents: CharSequence
    )

    private data class VerifiedQueryResult(
        val result: RelatedTestsResult,
        val verify: ((Project) -> Unit)?
    )

    companion object {
        private val R_CLASS_DIRECTORIES = setOf(
            "compile_and_runtime_r_class_jar",
            "compile_r_class_jar",
            "compile_and_runtime_not_namespaced_r_class_jar",
            "compile_app_classes_jar"
        )

        private val CONTEXT_BASE_CLASSES = listOf(
            "android.app.Activity",
            "android.app.Fragment",
            AndroidXConstants.CLASS_V4_FRAGMENT.oldName(),
            AndroidXConstants.CLASS_V4_FRAGMENT.newName(),
            "android.widget.Adapter"
        )

        internal fun emptyResult(): RelatedTestsResult =
            RelatedTestsResult(isTest = false, targets = emptyList(), sourceName = null)

        internal fun findRelatedTests(
            project: Project,
            file: PsiFile,
            offset: Int,
            observedDocs: MutableMap<VirtualFile, ObservedDocument> = LinkedHashMap()
        ): RelatedTestsResult {
            ProgressManager.checkCanceled()
            val xml = file as? XmlFile
            if (xml == null) {
                return emptyResult()
            }
            val info = AndroidContext.identify(xml)
            if (!info.isAndroidFile) {
                return emptyResult()
            }
            if (info.role == AndroidFileRole.MANIFEST) {
                val target = ManifestTarget.resolve(project, xml, offset) ?: return emptyResult()
                if (!target.isClassAttribute) return emptyResult()
                if (target.failureReason != null) {
                    if (target.failureReason == AndroidQueryException.REASON_MODEL_UNAVAILABLE) {
                        throw AndroidQueryException.modelUnavailable("Model unavailable for ${target.fqcn ?: xml.name}")
                    }
                    return emptyResult()
                }
                val candidate = target.targetElement ?: return emptyResult()
                observeSourceElement(candidate, observedDocs)
                return collectRelatedTestsResult(xml, listOf(candidate), observedDocs)
            }

            if (info.role != AndroidFileRole.RESOURCE_XML) {
                return emptyResult()
            }

            val folderName = xml.containingDirectory?.name
                ?: xml.virtualFile?.parent?.name
                ?: return emptyResult()
            val resourceType = when (ResourceFolderType.getFolderType(folderName)) {
                ResourceFolderType.LAYOUT -> ResourceType.LAYOUT
                ResourceFolderType.MENU -> ResourceType.MENU
                else -> return emptyResult()
            }
            val resourceName = SdkUtils.fileNameToResourceName(xml.name)
            if (resourceName.isBlank()) return emptyResult()

            val module = info.module
                ?: throw AndroidQueryException.modelUnavailable("Owner module unavailable")
            val moduleRootVf = info.moduleRoot
                ?: throw AndroidQueryException.modelUnavailable("Module root unavailable for ${module.name}")
            val moduleRoot = Path.of(moduleRootVf.path).toAbsolutePath().normalize()
            val namespace = info.namespace
            if (namespace.isNullOrBlank()) {
                throw AndroidQueryException.modelUnavailable("Namespace unresolved for ${module.name}")
            }
            val variant = info.variant ?: resolveSingleCompiledVariant(project, module, moduleRoot)
            if (variant == null) {
                return emptyResult()
            }

            val verifiedJars = ResourceResolver.findVerifiedRClassOrigins(moduleRoot, variant)
            for (origin in verifiedJars) {
                AndroidSources.observeCompiledArchive(origin)
            }
            if (verifiedJars.isEmpty()) {
                return emptyResult()
            }

            val fields = findVerifiedOwnerRFields(
                project = project,
                ownerModule = module,
                verifiedJars = verifiedJars,
                namespace = namespace,
                type = resourceType.getName(),
                name = resourceName
            )
            if (fields.isEmpty()) {
                return emptyResult()
            }

            ResourceResolver.verifyProvenance(
                project,
                moduleRoot,
                variant,
                namespace,
                resourceType.getName(),
                resourceName
            )

            val declared = resolveContextClass(project, module, namespace, xml)
            if (declared != null) {
                observeSourceElement(declared, observedDocs)
                return collectRelatedTestsResult(xml, listOf(declared), observedDocs)
            }

            val candidates = collectFallbackReferences(module, fields, observedDocs)
            if (candidates.isEmpty()) {
                return emptyResult()
            }
            return collectRelatedTestsResult(xml, candidates, observedDocs)
        }

        internal fun findVerifiedOwnerRFields(
            project: Project,
            ownerModule: Module,
            verifiedJars: List<Path>,
            namespace: String,
            type: String,
            name: String
        ): List<PsiField> {
            val verifiedJarSet = verifiedJars.toHashSet()
            val facade = JavaPsiFacade.getInstance(project)
            val depLibScope = ownerModule.getModuleWithDependenciesAndLibrariesScope(false)
            val rClasses = facade.findClasses("$namespace.R", depLibScope)
            val verifiedRClasses = ArrayList<PsiClass>()
            for (rClass in rClasses) {
                ProgressManager.checkCanceled()
                val vFile = rClass.containingFile?.virtualFile ?: continue
                var path = vFile.path
                val sep = path.indexOf("!/")
                if (sep >= 0) path = path.substring(0, sep)
                val archive = try {
                    Path.of(path).toAbsolutePath().normalize()
                } catch (_: InvalidPathException) {
                    continue
                }
                if (verifiedJarSet.contains(archive)) {
                    verifiedRClasses.add(rClass)
                }
            }
            if (verifiedRClasses.isEmpty()) {
                loadVerifiedRClassesFromOrigins(project, verifiedJars, "$namespace.R", verifiedRClasses)
            }
            if (verifiedRClasses.isEmpty()) return emptyList()
            val rTypeName = if (type == "string-array" || type == "integer-array") "array" else type
            val rFieldName = name.replace('.', '_').replace(':', '_')
            val fields = ArrayList<PsiField>()
            for (rClass in verifiedRClasses) {
                ProgressManager.checkCanceled()
                val inner = rClass.findInnerClassByName(rTypeName, false) ?: continue
                val field = inner.findFieldByName(rFieldName, false) ?: continue
                fields.add(field)
            }
            return fields
        }

        private fun loadVerifiedRClassesFromOrigins(
            project: Project,
            verifiedJars: List<Path>,
            qualifiedName: String,
            out: MutableList<PsiClass>
        ) {
            val entryPath = qualifiedName.replace('.', '/') + ".class"
            val archives = CoreJarFileSystem()
            try {
                for (origin in verifiedJars) {
                    ProgressManager.checkCanceled()
                    val url = JarFileSystem.PROTOCOL_PREFIX + FileUtil.toSystemIndependentName(origin.toString()) +
                            JarFileSystem.JAR_SEPARATOR + entryPath
                    var file = VirtualFileManager.getInstance().findFileByUrl(url)
                    if (file == null) {
                        file = archives.findFileByPath(url.substring(JarFileSystem.PROTOCOL_PREFIX.length))
                    }
                    if (file == null) continue
                    val classes = if (file.fileSystem is CoreJarFileSystem) {
                        org.jetbrains.android.navigation.AndroidCompiledResourceClassFinder.readCompiledClasses(
                            project,
                            file
                        )
                    } else {
                        val psi = PsiManager.getInstance(project).findFile(file)
                        if (psi is PsiClassOwner) psi.classes else PsiClass.EMPTY_ARRAY
                    }
                    for (psiClass in classes) {
                        if (qualifiedName == psiClass.qualifiedName) {
                            out.add(psiClass)
                        }
                    }
                }
            } finally {
                archives.clearHandlersCache()
            }
        }


        internal fun resolveContextClass(
            project: Project,
            module: Module,
            namespace: String,
            xml: XmlFile
        ): PsiElement? {
            val root = xml.rootTag
            if (root == null) {
                return null
            }
            val contextAttr = root.getAttribute("context", SdkConstants.TOOLS_URI)
            if (contextAttr == null) {
                return null
            }
            if (PsiTreeUtil.findChildOfType(contextAttr, PsiErrorElement::class.java) != null) return null
            val value = contextAttr.valueElement ?: return null
            val text = value.text
            if (text.length < 2 || (text[0] != '\'' && text[0] != '"') || text[0] != text[text.length - 1]) {
                return null
            }
            val raw = AndroidXml.value(contextAttr)?.trim()
            if (raw.isNullOrBlank() || raw.contains("$" + "{") || raw.startsWith("@")) {
                return null
            }
            val names = ManifestTarget.classNames(raw, namespace)
            if (names.isEmpty()) return null
            val scope = module.getModuleWithDependenciesAndLibrariesScope(false)
            val facade = JavaPsiFacade.getInstance(project)
            for (name in names) {
                val candidates = LinkedHashMap<PsiElement, PsiClass>()
                for (candidate in facade.findClasses(name, scope)) {
                    ProgressManager.checkCanceled()
                    val navElement = candidate.navigationElement
                    if (navElement !is PsiCompiledElement) {
                        candidates.putIfAbsent(navElement, candidate)
                    }
                }
                if (candidates.size > 1) {
                    return null
                }
                if (candidates.isEmpty()) continue
                return candidates.keys.first()
            }
            return null
        }

        internal fun collectFallbackReferences(
            module: Module,
            fields: List<PsiField>,
            observedDocs: MutableMap<VirtualFile, ObservedDocument>
        ): List<PsiElement> {
            val searchScope = module.getModuleScope(false)
            val result = LinkedHashSet<PsiElement>()
            for (field in fields) {
                val query = ReferencesSearch.search(field, searchScope)
                query.forEach(Processor { reference ->
                    ProgressManager.checkCanceled()
                    val element = reference.element
                    observeSourceElement(element, observedDocs)
                    val candidate: PsiElement? = when (element.language) {
                        KotlinLanguage.INSTANCE -> checkKotlinReference(element)
                        JavaLanguage.INSTANCE -> checkJavaReference(element)
                        else -> null
                    }
                    if (candidate != null) {
                        observeSourceElement(candidate, observedDocs)
                        result.add(candidate)
                    }
                    true
                })
            }
            return ArrayList(result)
        }

        internal fun checkJavaReference(element: PsiElement): PsiClass? {
            val referenceExpression = element as? PsiReferenceExpression ?: return null
            val methodCall =
                PsiTreeUtil.getParentOfType(referenceExpression, PsiMethodCallExpression::class.java, true)
                    ?: return null
            val methodName = methodCall.methodExpression.referenceName
            if (methodName != "setContentView" && methodName != "inflate") return null
            val relatedClass = PsiTreeUtil.getParentOfType(methodCall, PsiClass::class.java, true)
                ?: return null
            return if (isContextHostClass(relatedClass)) relatedClass else null
        }

        internal fun checkKotlinReference(element: PsiElement): KtClass? {
            val callExpression = PsiTreeUtil.getParentOfType(element, KtCallExpression::class.java, true)
                ?: return null
            val calleeExpression = callExpression.calleeExpression as? KtNameReferenceExpression ?: return null
            val methodName = calleeExpression.getReferencedName()
            if (methodName != "setContentView" && methodName != "inflate") return null
            val relatedClass = callExpression.containingClass() ?: return null

            @Suppress("DEPRECATION")
            val lightClass = relatedClass.toLightClass() ?: return null
            return if (isContextHostClass(lightClass)) relatedClass else null
        }

        internal fun isContextHostClass(psiClass: PsiClass): Boolean {
            return CONTEXT_BASE_CLASSES.any { InheritanceUtil.isInheritor(psiClass, it) }
        }

        internal fun collectRelatedTestsResult(
            xml: XmlFile,
            candidates: List<PsiElement>,
            observedDocs: MutableMap<VirtualFile, ObservedDocument>
        ): RelatedTestsResult {
            val sourceTargets = LinkedHashSet<PsiElement>()
            for (candidate in candidates) {
                ProgressManager.checkCanceled()
                val navElement = candidate.navigationElement
                observeSourceElement(navElement, observedDocs)
                sourceTargets.add(navElement)
            }
            if (sourceTargets.isEmpty()) {
                return emptyResult()
            }
            val locations = LinkedHashSet<Location>()
            for (sourceTarget in sourceTargets) {
                ProgressManager.checkCanceled()
                val found = TestFinderHelper.findTestsForClass(sourceTarget)
                for (testElement in found) {
                    ProgressManager.checkCanceled()
                    observeSourceElement(testElement, observedDocs)
                    val location = toRelatedLocation(testElement) ?: continue
                    locations.add(location)
                }
            }
            val sourceName = if (sourceTargets.size == 1) {
                (sourceTargets.first() as? NavigationItem)?.name
            } else {
                sourceTargets.mapNotNull { (it as? NavigationItem)?.name }.distinct().singleOrNull() ?: xml.name
            }
            return RelatedTestsResult(
                isTest = false,
                targets = ArrayList(locations),
                sourceName = sourceName
            )
        }

        internal fun toRelatedLocation(element: PsiElement): Location? {
            if (element is PsiFile) {
                val vFile = element.virtualFile ?: return null
                return Location(DocumentUri(vFile.uri), Range(Position(0, 0), Position(0, 0)))
            }
            return element.getLspLocationForDefinition()
        }

        internal fun observeSourceElement(
            element: PsiElement,
            observedDocs: MutableMap<VirtualFile, ObservedDocument>
        ) {
            val containingFile = element.containingFile ?: return
            val vFile = containingFile.virtualFile ?: return
            if (!vFile.isValid) return
            AndroidSources.observe(vFile)
            if (vFile.isInLocalFileSystem) {
                try {
                    AndroidSources.track(Path.of(vFile.path))
                } catch (_: InvalidPathException) {
                }
            }
            if (!observedDocs.containsKey(vFile)) {
                val doc = vFile.findDocument()
                    ?: PsiDocumentManager.getInstance(element.project).getDocument(containingFile)
                if (doc != null) {
                    observedDocs[vFile] = ObservedDocument(vFile.uri, doc.modificationStamp, doc.immutableCharSequence)
                }
            }
        }

        internal fun verifyObservedDocuments(
            project: Project,
            observedDocs: Map<VirtualFile, ObservedDocument>
        ) {
            for ((vFile, expected) in observedDocs) {
                ProgressManager.checkCanceled()
                if (!vFile.isValid) {
                    throw AndroidQueryException("content_modified", -32801)
                }
                val latestDoc = vFile.findDocument()
                    ?: PsiManager.getInstance(project).findFile(vFile)?.let {
                        PsiDocumentManager.getInstance(project).getDocument(it)
                    }
                if (latestDoc == null ||
                    latestDoc.modificationStamp != expected.stamp ||
                    java.lang.CharSequence.compare(expected.contents, latestDoc.immutableCharSequence) != 0
                ) {
                    throw AndroidQueryException("content_modified", -32801)
                }
            }
        }

        private fun verifyObservedDocumentsByUri(
            project: Project,
            observedDocs: Collection<ObservedDocument>
        ) {
            for ((uri, expectedStamp, expectedContents) in observedDocs) {
                ProgressManager.checkCanceled()
                val latestVf = TextDocumentIdentifier(DocumentUri(uri)).findVirtualFile()
                if (latestVf == null || !latestVf.isValid) {
                    throw AndroidQueryException("content_modified", -32801)
                }
                val latestDoc = latestVf.findDocument()
                    ?: latestVf.findPsiFile(project)?.let {
                        PsiDocumentManager.getInstance(project).getDocument(it)
                    }
                if (latestDoc == null ||
                    latestDoc.modificationStamp != expectedStamp ||
                    java.lang.CharSequence.compare(expectedContents, latestDoc.immutableCharSequence) != 0
                ) {
                    throw AndroidQueryException("content_modified", -32801)
                }
            }
        }

        private fun resolveSingleCompiledVariant(project: Project, module: Module, root: Path): String? {
            val variants = LinkedHashSet<String>()
            val directory = root.resolve("build/intermediates")
            collectOrderEntryAndNameVariants(module, root, directory, variants)
            if (variants.isEmpty()) {
                for (candidate in ModuleManager.getInstance(project).modules) {
                    if (candidate == module || candidate.isDisposed) continue
                    val candRoot = AndroidContext.findModuleRoot(candidate) ?: continue
                    if (Path.of(candRoot.path).toAbsolutePath().normalize() != root) continue
                    val resolved = AndroidContext.resolveVariant(candidate, candRoot)
                    if (resolved != null) {
                        variants.add(resolved)
                    } else {
                        collectOrderEntryAndNameVariants(candidate, root, directory, variants)
                    }
                }
            }
            if (variants.isEmpty() && Files.isDirectory(directory)) {
                for (dirName in R_CLASS_DIRECTORIES) {
                    val rDir = directory.resolve(dirName)
                    if (!Files.isDirectory(rDir)) continue
                    try {
                        Files.list(rDir).use { stream ->
                            stream.forEach { child ->
                                if (Files.isDirectory(child) &&
                                    ResourceResolver.findVerifiedRClassOrigins(root, child.fileName.toString())
                                        .isNotEmpty()
                                ) {
                                    variants.add(child.fileName.toString())
                                }
                            }
                        }
                    } catch (_: Exception) {
                    }
                }
            }
            if (variants.size > 1) {
                throw AndroidQueryException.ambiguousVariant("Variant ambiguous for ${module.name}")
            }
            return variants.singleOrNull()
        }

        private fun collectOrderEntryAndNameVariants(
            module: Module,
            root: Path,
            directory: Path,
            variants: MutableSet<String>
        ) {
            for (entry in ModuleRootManager.getInstance(module).orderEntries) {
                val library = (entry as? LibraryOrderEntry)?.library ?: continue
                for (url in library.getUrls(OrderRootType.CLASSES)) {
                    val value = VfsUtilCore.urlToPath(url)
                    val separator = value.indexOf("!/")
                    val path = try {
                        Path.of(if (separator < 0) value else value.substring(0, separator)).toAbsolutePath()
                            .normalize()
                    } catch (_: InvalidPathException) {
                        continue
                    }
                    if (!path.startsWith(directory)) continue
                    val relative = directory.relativize(path)
                    if (relative.nameCount >= 3 && relative.getName(0).toString() in R_CLASS_DIRECTORIES) {
                        variants.add(relative.getName(1).toString())
                    }
                }
            }
            val moduleName = module.name
            val separator = moduleName.lastIndexOf('.')
            if (separator >= 0 && separator + 1 < moduleName.length) {
                val candidate = moduleName.substring(separator + 1)
                val sourceUrl = VfsUtilCore.pathToUrl(root.resolve("src").resolve(candidate).toString())
                for (contentUrl in ModuleRootManager.getInstance(module).contentRootUrls) {
                    if (contentUrl == sourceUrl) variants.add(candidate)
                }
            }
        }
    }
}
