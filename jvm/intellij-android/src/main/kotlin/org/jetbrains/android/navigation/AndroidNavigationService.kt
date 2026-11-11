package org.jetbrains.android.navigation

import com.intellij.find.findUsages.FindUsagesManager
import com.intellij.openapi.editor.Document
import com.intellij.openapi.module.Module
import com.intellij.openapi.module.ModuleManager
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.roots.LibraryOrderEntry
import com.intellij.openapi.roots.ModuleRootManager
import com.intellij.openapi.roots.OrderRootType
import com.intellij.openapi.util.TextRange
import com.intellij.openapi.vfs.VfsUtilCore
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.psi.JavaPsiFacade
import com.intellij.psi.PsiClass
import com.intellij.psi.PsiDocumentManager
import com.intellij.psi.PsiElement
import com.intellij.psi.PsiField
import com.intellij.psi.PsiFile
import com.intellij.psi.search.GlobalSearchScope
import com.intellij.psi.search.searches.ReferencesSearch
import com.intellij.psi.util.PsiTreeUtil
import com.intellij.psi.xml.XmlFile
import com.intellij.psi.xml.XmlTag
import com.jetbrains.ls.api.core.features.LSDefinitionLocation
import com.jetbrains.ls.api.core.util.getLspLocationForDefinition
import com.jetbrains.ls.api.core.util.toLspLocation
import com.jetbrains.ls.api.core.util.toLspRange
import com.jetbrains.lsp.protocol.Location
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.jetbrains.android.context.AndroidContext
import org.jetbrains.android.context.AndroidFileInfo
import org.jetbrains.android.context.AndroidFileRole
import org.jetbrains.android.context.AndroidQueryException
import org.jetbrains.android.resource.AndroidSources
import org.jetbrains.android.resource.ResourceResolver
import org.jetbrains.android.xml.AndroidXml
import java.nio.file.Files
import java.nio.file.Path

class AndroidNavigationService private constructor() {

    fun getReferences(project: Project, file: PsiFile, offset: Int, includeDeclaration: Boolean): List<Location> {
        val target = checkedTarget(project, file, offset)
        if (target != null) {
            return getManifestReferences(project, file, target, includeDeclaration)
        }

        val resTarget = resolveResourceDeclaration(project, file, offset)
        if (resTarget != null) {
            return findResourceFieldReferences(
                project,
                resTarget.module,
                resTarget.namespace,
                resTarget.variant,
                resTarget.type,
                resTarget.name,
                null,
                includeDeclaration,
                resTarget.declarationLocation,
                null
            )
        }

        return emptyList()
    }

    private fun getManifestReferences(
        project: Project,
        file: PsiFile,
        target: ManifestClassTarget,
        includeDeclaration: Boolean
    ): List<Location> {
        val element = target.targetElement
            ?: throw AndroidQueryException.modelUnavailable("Native class usage handler unavailable")
        val handler = FindUsagesManager(project).getFindUsagesHandler(element, true)
            ?: throw AndroidQueryException.modelUnavailable("Native class usage handler unavailable")
        val result = LinkedHashSet<Location>()
        if (includeDeclaration) {
            val declaration = element.getLspLocationForDefinition()
                ?: throw AndroidQueryException.targetUnresolved(target.fqcn ?: "")
            result.add(declaration)
        }
        val options = handler.findUsagesOptions
        options.isSearchForTextOccurrences = false
        handler.processElementUsages(element, { usage ->
            ProgressManager.checkCanceled()
            val reference = usage.element
            if (reference != null && reference.containingFile !is XmlFile) {
                val location = reference.getLspLocationForDefinition()
                if (location != null) {
                    synchronized(result) {
                        result.add(location)
                    }
                }
            }
            true
        }, options)
        ProgressManager.checkCanceled()
        val document = PsiDocumentManager.getInstance(project).getDocument(file)
            ?: throw AndroidQueryException.modelUnavailable("Current XML document unavailable")
        val range = target.sourceValueRange
            ?: throw AndroidQueryException.modelUnavailable("Current XML location unavailable")
        val vFile = file.virtualFile
            ?: throw AndroidQueryException.modelUnavailable("Current XML location unavailable")
        val current = range.toLspLocation(vFile, document)
        result.add(current)
        return ArrayList(result)
    }

    fun findResourceFieldReferences(
        project: Project,
        ownerModule: Module?,
        namespace: String?,
        variant: String?,
        type: String,
        name: String,
        candidateClassOrigins: List<Path>?,
        includeDeclaration: Boolean,
        declarationLocation: Location?,
        participatingClassOriginsOut: MutableList<Path>?
    ): List<Location> {
        ProgressManager.checkCanceled()
        if (ownerModule == null) {
            throw AndroidQueryException.modelUnavailable("Owner module unavailable")
        }
        val moduleRootVf = AndroidContext.findModuleRoot(ownerModule)
            ?: throw AndroidQueryException.modelUnavailable("Module root unavailable for ${ownerModule.name}")
        val moduleRoot = Path.of(moduleRootVf.path).toAbsolutePath().normalize()

        if (variant == null) {
            throw AndroidQueryException.ambiguousVariant("Variant ambiguous for ${ownerModule.name}")
        }
        if (namespace.isNullOrBlank()) {
            throw AndroidQueryException.targetUnresolved("Namespace unresolved for ${ownerModule.name}")
        }

        // Verify AGP build snapshot provenance
        ResourceResolver.verifyProvenance(project, moduleRoot, variant, namespace, type, name)

        // Verify class origins
        val verifiedJars = ArrayList(ResourceResolver.findVerifiedRClassOrigins(moduleRoot, variant))
        val intermediatesDir = moduleRoot.resolve("build/intermediates")
        for (entry in ModuleRootManager.getInstance(ownerModule).orderEntries) {
            if (entry is LibraryOrderEntry && entry.library != null) {
                for (url in entry.library!!.getUrls(OrderRootType.CLASSES)) {
                    var cleanPath = VfsUtilCore.urlToPath(url)
                    val sep = cleanPath.indexOf("!/")
                    if (sep >= 0) cleanPath = cleanPath.substring(0, sep)
                    try {
                        val p = Path.of(cleanPath).toAbsolutePath().normalize()
                        if (p.startsWith(intermediatesDir) && p.toString().replace('\\', '/')
                                .contains("/$variant/") && Files.isRegularFile(p)
                        ) {
                            if (!verifiedJars.contains(p)) verifiedJars.add(p)
                        }
                    } catch (_: Exception) {
                    }
                }
            }
        }
        if (verifiedJars.isEmpty()) {
            throw AndroidQueryException.missingSnapshot("Compiled R jar not found for variant $variant")
        }

        val allowedOrigins = LinkedHashSet<Path>()
        if (!candidateClassOrigins.isNullOrEmpty()) {
            for (candidate in candidateClassOrigins) {
                if (!Files.isRegularFile(candidate) || !candidate.startsWith(intermediatesDir)
                    || !candidate.toString().replace('\\', '/').contains("/$variant/")
                ) {
                    throw AndroidQueryException.ambiguousTarget("Class origin does not belong to owner module and variant: $candidate")
                }
                if (!verifiedJars.contains(candidate)) {
                    throw AndroidQueryException.missingSnapshot("Class origin is not a verified build artifact for variant $variant: $candidate")
                }
                allowedOrigins.add(candidate)
            }
        } else {
            allowedOrigins.addAll(verifiedJars)
        }

        // Locate R class in owner module scope
        val facade = JavaPsiFacade.getInstance(project)
        val depLibScope = ownerModule.getModuleWithDependenciesAndLibrariesScope(false)
        val rClasses = facade.findClasses("$namespace.R", depLibScope)
        if (rClasses.isEmpty()) {
            throw AndroidQueryException.classNotFound("$namespace.R")
        }

        val verifiedRClasses = ArrayList<PsiClass>()
        for (rClass in rClasses) {
            ProgressManager.checkCanceled()
            val containing = rClass.containingFile
            val vFile = containing?.virtualFile ?: continue
            var path = vFile.path
            val sep = path.indexOf("!/")
            if (sep >= 0) path = path.substring(0, sep)
            val archive = Path.of(path).toAbsolutePath().normalize()
            if (allowedOrigins.contains(archive)) {
                verifiedRClasses.add(rClass)
                if (participatingClassOriginsOut != null && !participatingClassOriginsOut.contains(archive)) {
                    participatingClassOriginsOut.add(archive)
                }
            }
        }
        // AGP application R archives also contain dependency namespaces. Search only compiled copies
        // in imported consumers; an unrelated module with the same namespace remains excluded.
        for (consumer in ModuleManager.getInstance(project).modules) {
            if (consumer == ownerModule || !consumer.moduleWithDependenciesScope.isSearchInModuleContent(ownerModule)) continue
            val consumerRoot = AndroidContext.findModuleRoot(consumer)
            val consumerVariant =
                if (consumerRoot != null) AndroidContext.resolveVariant(consumer, consumerRoot) else null
            if (consumerRoot == null || consumerVariant == null) continue
            if (namespace == AndroidContext.resolveNamespace(project, consumer)) continue
            for (dependency in ModuleManager.getInstance(project).modules) {
                if (!consumer.moduleWithDependenciesScope.isSearchInModuleContent(dependency)) continue
                if (namespace != AndroidContext.resolveNamespace(project, dependency)) continue
                val dependencyRoot = AndroidContext.findModuleRoot(dependency)
                if (dependencyRoot != null && Path.of(dependencyRoot.path).toAbsolutePath().normalize() != moduleRoot) {
                    throw AndroidQueryException.ambiguousTarget("Consumer has multiple resource owners for $namespace")
                }
            }
            val copies =
                HashSet(ResourceResolver.findVerifiedRClassOrigins(Path.of(consumerRoot.path), consumerVariant))
            for (copy in facade.findClasses(
                "$namespace.R",
                consumer.getModuleWithDependenciesAndLibrariesScope(false)
            )) {
                val containing = copy.containingFile
                val path = containing?.virtualFile?.path ?: ""
                val separator = path.indexOf("!/")
                if (separator < 0) continue
                val archive = Path.of(path.substring(0, separator)).toAbsolutePath().normalize()
                if (!copies.contains(archive)) continue
                if (!verifiedRClasses.contains(copy)) verifiedRClasses.add(copy)
                if (participatingClassOriginsOut != null && !participatingClassOriginsOut.contains(archive)) {
                    participatingClassOriginsOut.add(archive)
                }
            }
        }
        if (verifiedRClasses.isEmpty()) {
            throw AndroidQueryException.classNotFound("Verified R class not found for $namespace.R")
        }

        val rTypeName = if (type == "string-array" || type == "integer-array") "array" else type
        val rFieldName = name.replace('.', '_').replace(':', '_')
        val fields = ArrayList<PsiField>()
        for (rClass in verifiedRClasses) {
            ProgressManager.checkCanceled()
            val inner = rClass.findInnerClassByName(rTypeName, false)
                ?: throw AndroidQueryException.fieldNotFound("Inner R class not found for R.$rTypeName")
            val field = inner.findFieldByName(rFieldName, false)
                ?: throw AndroidQueryException.fieldNotFound("R field not found for R.$rTypeName.$rFieldName")
            fields.add(field)
        }

        // Search scope: intersection of ownerModule.getModuleWithDependentsScope() and projectScope
        val projectScope = GlobalSearchScope.projectScope(project)
        val dependentsScope = ownerModule.moduleWithDependentsScope
        val searchScope = dependentsScope.intersectWith(projectScope)

        val codeReferences = LinkedHashSet<Location>()
        val docStamps = LinkedHashMap<Document, Long>()
        for (field in fields) {
            ProgressManager.checkCanceled()
            // Proven ownership and the imported consumer graph define visibility, including omitted library R roots.
            ReferencesSearch.search(field, searchScope, true).forEach { reference ->
                ProgressManager.checkCanceled()
                val element = reference.element ?: return@forEach
                val containing = element.containingFile
                if (containing == null || containing is XmlFile) return@forEach
                val vFile = containing.virtualFile
                if (vFile == null || !vFile.isValid) return@forEach
                AndroidSources.observe(vFile)
                val doc = containing.fileDocument ?: return@forEach
                synchronized(docStamps) {
                    docStamps.putIfAbsent(doc, doc.modificationStamp)
                }

                val start = element.textRange.startOffset + reference.rangeInElement.startOffset
                val end = element.textRange.startOffset + reference.rangeInElement.endOffset
                if (start < 0 || end > doc.textLength || start > end) return@forEach

                val loc = TextRange(start, end).toLspLocation(vFile, doc)
                if (loc != null) {
                    synchronized(codeReferences) {
                        codeReferences.add(loc)
                    }
                }
            }
        }

        ProgressManager.checkCanceled()
        for ((doc, stamp) in docStamps) {
            if (doc.modificationStamp != stamp) {
                throw AndroidQueryException("content_modified", -32801)
            }
        }

        val result = ArrayList<Location>()
        if (includeDeclaration && declarationLocation != null) {
            result.add(declarationLocation)
        }
        result.addAll(codeReferences)
        return result
    }

    fun findResourceFieldReferencesCommand(
        project: Project,
        moduleName: String,
        namespace: String,
        type: String,
        name: String,
        candidateClassOrigins: List<Path>?
    ): JsonObject {
        val ownerModule = requireModule(project, moduleName, namespace)
        val moduleRootVf = AndroidContext.findModuleRoot(ownerModule)
            ?: throw AndroidQueryException.modelUnavailable("Module root not found for $moduleName")
        val variant = AndroidContext.resolveVariant(ownerModule, moduleRootVf)
            ?: throw AndroidQueryException.ambiguousVariant("Variant ambiguous for $moduleName")

        val participatingOrigins = ArrayList<Path>()
        val references = findResourceFieldReferences(
            project, ownerModule, namespace, variant, type, name,
            candidateClassOrigins, false, null, participatingOrigins
        )

        val response = LinkedHashMap<String, JsonElement>()
        response["protocolVersion"] = JsonPrimitive(1)
        response["fieldResolved"] = JsonPrimitive(true)

        val refElements = ArrayList<JsonElement>()
        for (loc in references) {
            refElements.add(Json.Default.encodeToJsonElement(Location.serializer(), loc))
        }
        response["references"] = JsonArray(refElements)

        val originObj = LinkedHashMap<String, JsonElement>()
        originObj["moduleName"] = JsonPrimitive(ownerModule.name)
        originObj["namespace"] = JsonPrimitive(namespace)
        val originUris = ArrayList<JsonElement>()
        for (p in participatingOrigins) {
            originUris.add(JsonPrimitive(p.toUri().toString()))
        }
        originObj["classOrigins"] = JsonArray(originUris)
        response["origin"] = JsonObject(originObj)

        return JsonObject(response)
    }

    private fun requireModule(project: Project, moduleName: String, namespace: String?): Module {
        val module = ModuleManager.getInstance(project).findModuleByName(moduleName)
        if (module == null || !AndroidContext.isAndroidModule(module)) {
            throw AndroidQueryException.modelUnavailable("Android module not found: $moduleName")
        }
        verifyModuleNamespace(project, module, namespace)
        return module
    }

    private fun verifyModuleNamespace(project: Project, module: Module, namespace: String?) {
        if (!namespace.isNullOrBlank()) {
            val resolvedNs = AndroidContext.resolveNamespace(project, module)
            if (namespace != resolvedNs) {
                throw AndroidQueryException.targetUnresolved(
                    "Namespace mismatch for module ${module.name}: expected $namespace but got $resolvedNs"
                )
            }
        }
    }

    fun getDefinitions(project: Project, file: PsiFile, offset: Int): List<LSDefinitionLocation> {
        val target = checkedTarget(project, file, offset)
        if (target != null) {
            val element = target.targetElement
            val location = element?.getLspLocationForDefinition()
            if (location == null) throw AndroidQueryException.targetUnresolved(target.fqcn ?: "")
            val document = PsiDocumentManager.getInstance(project).getDocument(file)
            val origin = if (document != null && target.sourceValueRange != null) {
                target.sourceValueRange.toLspRange(document)
            } else null
            return listOf(LSDefinitionLocation(location, origin))
        }
        val info = AndroidContext.identify(file)
        if (!info.isAndroidFile) return emptyList()
        val reference = if (info.role == AndroidFileRole.KOTLIN_OR_JAVA) {
            ResourceResolver.findRReferenceAt(project, file, offset)
        } else {
            ResourceResolver.findResourceReferenceAt(file, offset)
        }
        if (reference == null || reference.isFramework) return emptyList()
        return ResourceResolver.resolve(project, info.module, reference)
    }

    private fun checkedTarget(project: Project, file: PsiFile, offset: Int): ManifestClassTarget? {
        ProgressManager.checkCanceled()
        val target = ManifestTarget.resolve(project, file, offset)
        if (target == null || !target.isClassAttribute) return null
        if (target.failureReason != null) {
            throw AndroidQueryException("${target.failureReason}: ${target.fqcn}")
        }
        return target
    }

    companion object {
        private val INSTANCE = AndroidNavigationService()

        @JvmStatic
        fun getInstance(): AndroidNavigationService = INSTANCE

        @JvmStatic
        fun resolveResourceDeclaration(project: Project, file: PsiFile, offset: Int): ResourceDeclarationTarget? {
            ProgressManager.checkCanceled()
            val xml = file as? XmlFile ?: return null
            val info = AndroidContext.identify(xml)
            if (!info.isAndroidFile) return null
            val module = info.module ?: return null
            val namespace = info.namespace ?: return null
            val variant = info.variant ?: return null

            if (info.role == AndroidFileRole.VALUES_XML) {
                val element = xml.findElementAt(offset)
                val tag = PsiTreeUtil.getParentOfType(element, XmlTag::class.java, false) ?: return null
                val parent = tag.parentTag ?: return null
                if ("resources" != parent.name) return null
                val tagName = tag.name
                // Attribute and declare-styleable resources have distinct search paths;
                // keep native behavior per section 7.4.
                if ("declare-styleable" == tagName || "attr" == tagName) return null
                val nameAttr = tag.getAttribute("name")
                val valueElement = nameAttr?.valueElement ?: return null
                val rawName = AndroidXml.value(nameAttr)
                if (rawName.isNullOrBlank()) return null
                val type: String
                if ("item" == tagName) {
                    val rawType = AndroidXml.value(tag.getAttribute("type"))
                    if (rawType.isNullOrBlank()) return null
                    type = rawType
                } else if ("string-array" == tagName || "integer-array" == tagName) {
                    type = "array"
                } else {
                    type = tagName
                }
                if ("attr" == type || "declare-styleable" == type || "styleable" == type) {
                    return null
                }
                val nameRange = valueElement.valueTextRange
                val attrRange = nameAttr.textRange
                val tagStart = tag.textOffset
                val tagHeaderEnd = Math.min(tagStart + tagName.length + 1, xml.textLength)
                val tagRange = TextRange(tagStart, tagHeaderEnd)
                if (!nameRange.contains(offset) && !attrRange.contains(offset) && !tagRange.contains(offset)) {
                    return null
                }
                val document = PsiDocumentManager.getInstance(project).getDocument(xml) ?: return null
                val declLoc = nameRange.toLspLocation(xml.virtualFile, document)
                return ResourceDeclarationTarget(module, namespace, variant, type, rawName, declLoc)
            }

            if (info.role == AndroidFileRole.RESOURCE_XML) {
                val vFile = xml.virtualFile
                val parent = vFile?.parent ?: return null
                val folder = parent.name
                val type = folder.split("-", limit = 2)[0]
                val fileName = xml.name
                val dot = fileName.indexOf('.')
                val rawName = if (dot >= 0) fileName.substring(0, dot) else fileName
                val rootTag = xml.rootTag ?: return null
                var nameToken = rootTag.firstChild
                while (nameToken != null && nameToken.text != rootTag.name) {
                    nameToken = nameToken.nextSibling
                }
                val tagStart = rootTag.textOffset
                val tokenRange = nameToken?.textRange
                    ?: TextRange(tagStart + 1, tagStart + 1 + rootTag.name.length)
                val rootHeaderRange = TextRange(tagStart, tokenRange.endOffset)
                if (!rootHeaderRange.contains(offset)) {
                    // Do not treat arbitrary elements inside file resources as resource declarations
                    return null
                }
                val document = PsiDocumentManager.getInstance(project).getDocument(xml) ?: return null
                val declLoc = tokenRange.toLspLocation(xml.virtualFile, document)
                return ResourceDeclarationTarget(module, namespace, variant, type, rawName, declLoc)
            }

            return null
        }
    }
}
