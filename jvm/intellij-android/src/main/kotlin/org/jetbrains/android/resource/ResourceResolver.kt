package org.jetbrains.android.resource

import com.android.resources.ResourceType
import com.android.resources.ResourceUrl
import com.google.gson.JsonArray
import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.intellij.openapi.editor.Document
import com.intellij.openapi.module.Module
import com.intellij.openapi.module.ModuleManager
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.TextRange
import com.intellij.openapi.util.text.StringUtil
import com.intellij.openapi.vfs.VfsUtilCore
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.openapi.vfs.VirtualFileManager
import com.intellij.psi.PsiClass
import com.intellij.psi.PsiDocumentManager
import com.intellij.psi.PsiElement
import com.intellij.psi.PsiField
import com.intellij.psi.PsiFile
import com.intellij.psi.PsiReference
import com.intellij.psi.util.PsiTreeUtil
import com.intellij.psi.xml.XmlAttribute
import com.intellij.psi.xml.XmlAttributeValue
import com.intellij.psi.xml.XmlFile
import com.intellij.psi.xml.XmlTag
import com.jetbrains.ls.api.core.features.LSDefinitionLocation
import com.jetbrains.ls.api.core.util.toLspRange
import com.jetbrains.lsp.protocol.Location
import com.jetbrains.lsp.protocol.Position
import com.jetbrains.lsp.protocol.Range
import org.jetbrains.android.context.AndroidContext
import org.jetbrains.android.context.AndroidQueryException
import org.jetbrains.android.xml.AndroidXml
import java.io.IOException
import java.nio.file.Files
import java.nio.file.InvalidPathException
import java.nio.file.NoSuchFileException
import java.nio.file.Path
import java.nio.file.attribute.FileTime
import java.util.ArrayDeque
import java.util.ArrayList
import java.util.Comparator
import java.util.LinkedHashMap
import java.util.LinkedHashSet

object ResourceResolver {

    @JvmStatic
    fun findResourceReferenceAt(file: PsiFile?, offset: Int): ResourceReference? {
        if (file !is XmlFile) return null
        val value = PsiTreeUtil.getParentOfType(file.findElementAt(offset), XmlAttributeValue::class.java, false)
        if (value == null || !value.valueTextRange.contains(offset)) return null
        val parent = value.parent
        val text = if (parent is XmlAttribute) AndroidXml.value(parent) else null
        if (text == null || text.length < 2 || (text[0] != '@' && text[0] != '?')) return null
        val url = ResourceUrl.parse(text)
        if (url == null || url.type == null || !url.hasValidName()) return null
        var document: Document? = file.fileDocument
        if (document == null) document = PsiDocumentManager.getInstance(file.project).getDocument(file)
        if (document == null) return null
        return ResourceReference(
            url.type.getName(),
            url.name,
            url.namespace,
            url.isFramework,
            value.valueTextRange.toLspRange(document),
            null
        )
    }

    @JvmStatic
    fun findRReferenceAt(project: Project, file: PsiFile?, offset: Int): ResourceReference? {
        if (file == null) return null
        val element = file.findElementAt(offset)
        var document: Document? = file.fileDocument
        if (document == null) document = PsiDocumentManager.getInstance(project).getDocument(file)
        if (document == null) return null
        val fields = LinkedHashSet<PsiField>()
        var referenceRange: TextRange? = null
        var current: PsiElement? = element
        while (current != null && current !== file) {
            ProgressManager.checkCanceled()
            for (reference in current.references) {
                if (!reference.rangeInElement.shiftRight(current.textOffset).contains(offset)) continue
                val target = reference.resolve()
                if (target is PsiField) {
                    val type = target.containingClass
                    val owner = type?.containingClass
                    if (owner != null && "R" == owner.name) {
                        fields.add(target)
                        referenceRange = reference.rangeInElement.shiftRight(current.textOffset)
                    }
                }
            }
            if (fields.isNotEmpty()) break
            current = current.parent
        }
        if (fields.size != 1 || referenceRange == null) return null
        val field = fields.iterator().next()
        val type = field.containingClass ?: return null
        val ownerClass = type.containingClass ?: return null
        val owner = ownerClass.qualifiedName
        if (owner == null || !owner.endsWith(".R")) return null
        val namespace = owner.substring(0, owner.length - 2)
        val origin = field.containingFile?.virtualFile
        var path = origin?.path
        if (path != null && path.contains("!/")) {
            path = path.substring(0, path.indexOf("!/"))
        }
        val originRange = referenceRange.toLspRange(document)
        val classOrigin = if (path == null) null else Path.of(path).toAbsolutePath().normalize()
        return ResourceReference(
            type.name ?: "",
            field.name,
            namespace,
            namespace == "android",
            originRange,
            classOrigin
        )
    }

    @JvmStatic
    fun resolve(project: Project, module: Module?, reference: ResourceReference?): List<LSDefinitionLocation> {
        val all = resolveAll(project, module, reference)
        if (reference != null && reference.classOrigin != null && reference.originRange != null) {
            // When queried from Kotlin or Java, the platform's LSCommonDefinitionProvider
            // resolves the R field and navigates to the first source via AndroidResourceNavigation
            // (DirectNavigationProvider). Emitting only supplementary qualifiers prevents duplicate
            // reporting of the first source in ILS 271's union stream.
            return if (all.size <= 1) emptyList() else all.subList(1, all.size)
        }
        return all
    }

    @JvmStatic
    fun resolveAll(project: Project, module: Module?, reference: ResourceReference?): List<LSDefinitionLocation> {
        if (module == null || reference == null || reference.isFramework) return emptyList()
        val owners = mutableListOf<Module>()
        owners.add(module)
        for (candidate in ModuleManager.getInstance(project).modules) {
            if (candidate !== module && module.moduleWithDependenciesScope.isSearchInModuleContent(candidate)) {
                owners.add(candidate)
            }
        }
        val locations = LinkedHashSet<Location>()
        for (owner in owners) {
            ProgressManager.checkCanceled()
            val root = AndroidContext.findModuleRoot(owner) ?: continue
            val path = Path.of(root.path).toAbsolutePath().normalize()
            if (reference.classOrigin != null && !reference.classOrigin!!.startsWith(path)) continue
            val namespace = AndroidContext.resolveNamespace(project, owner)
            if (reference.namespace != null && reference.namespace != namespace) continue
            val variant = AndroidContext.resolveVariant(owner, root)
            if (namespace == null || variant == null) continue
            try {
                locations.addAll(Provenance(project, path, variant, namespace).resolve(reference.type, reference.name))
            } catch (_: InvalidProvenance) {
                // Optional definition enhancement leaves the original provider's target intact.
            } catch (_: InvalidPathException) {
                // Optional definition enhancement leaves the original provider's target intact.
            } catch (error: AndroidQueryException) {
                if (error.errorCode == -32801) throw error
            }
        }
        val result = ArrayList<LSDefinitionLocation>(locations.size)
        for (location in locations) {
            result.add(LSDefinitionLocation(location, reference.originRange))
        }
        return result
    }

    @JvmStatic
    fun key(type: String, name: String): String {
        var effectiveType = type
        if (effectiveType == "string-array" || effectiveType == "integer-array") effectiveType = "array"
        return effectiveType + '\u0000' + name.replace('.', '_').replace(':', '_')
    }

    @JvmStatic
    fun verifyProvenance(
        project: Project,
        module: Path,
        variant: String,
        namespace: String,
        type: String,
        name: String
    ) {
        val provenance = Provenance(project, module, variant, namespace)
        if (!Files.isRegularFile(provenance.merger)) {
            throw AndroidQueryException.missingSnapshot("Build snapshot merger.xml not found for variant $variant")
        }
        try {
            provenance.load()
            val wanted = key(type, name)
            provenance.validate(wanted, type, name)
        } catch (e: InvalidProvenance) {
            val detail = if (e.message != null) " (${e.message})" else ""
            throw AndroidQueryException.staleSnapshot("Resource declaration is missing from snapshot or modified without rebuilding: $type/$name$detail")
        }
    }

    @JvmStatic
    fun findVerifiedRClassOrigins(module: Path, variant: String): List<Path> {
        val cap = variant[0].uppercaseChar().toString() + variant.substring(1)
        val processTask = "process${cap}Resources"
        val generateTask = "generate${cap}RFile"
        val bundleTask = "bundle${cap}ClassesToCompileJar"
        val candidates = listOf(
            module.resolve("build/intermediates/compile_and_runtime_r_class_jar").resolve(variant).resolve(processTask)
                .resolve("R.jar"),
            module.resolve("build/intermediates/compile_r_class_jar").resolve(variant).resolve(processTask)
                .resolve("R.jar"),
            module.resolve("build/intermediates/compile_r_class_jar").resolve(variant).resolve(generateTask)
                .resolve("R.jar"),
            module.resolve("build/intermediates/compile_and_runtime_not_namespaced_r_class_jar").resolve(variant)
                .resolve(processTask).resolve("R.jar"),
            module.resolve("build/intermediates/compile_app_classes_jar").resolve(variant).resolve(bundleTask)
                .resolve("classes.jar")
        )
        val found = mutableListOf<Path>()
        for (p in candidates) {
            if (Files.isRegularFile(p)) {
                found.add(p.toAbsolutePath().normalize())
            }
        }
        return found
    }

    private fun declaration(tag: XmlTag): String? {
        val parent = tag.parentTag
        if (parent == null || !(parent.name == "resources" || (tag.name == "attr" && parent.name == "declare-styleable"))) {
            return null
        }
        val name = AndroidXml.value(tag.getAttribute("name"))
        val type = if (tag.name == "item") AndroidXml.value(tag.getAttribute("type")) else tag.name
        return if (name == null || type == null) null else key(type, name)
    }

    private fun declarations(file: XmlFile?): Map<String, MutableList<TextRange>> {
        val result = LinkedHashMap<String, MutableList<TextRange>>()
        if (file == null || file.rootTag == null) return result
        collect(file.rootTag!!, result)
        return result
    }

    private fun collect(tag: XmlTag, result: MutableMap<String, MutableList<TextRange>>) {
        ProgressManager.checkCanceled()
        val identity = declaration(tag)
        val nameAttr = tag.getAttribute("name")
        if (identity != null && nameAttr != null && nameAttr.valueElement != null) {
            result.computeIfAbsent(identity) { ArrayList() }.add(nameAttr.valueElement!!.valueTextRange)
        }
        for (attribute in tag.attributes) {
            val value = AndroidXml.value(attribute)
            if (value != null && attribute.valueElement != null) {
                val url = ResourceUrl.parse(value)
                if (url != null && url.isCreate && url.type == ResourceType.ID && !url.isFramework && url.namespace == null && url.hasValidName()) {
                    result.computeIfAbsent(key("id", url.name)) { ArrayList() }
                        .add(attribute.valueElement!!.valueTextRange)
                }
            }
        }
        for (child in tag.subTags) {
            collect(child, result)
        }
    }

    private fun children(path: Path): List<Path> {
        ProgressManager.checkCanceled()
        AndroidSources.track(path)
        return try {
            Files.list(path).use { stream ->
                stream.sorted().toList()
            }
        } catch (_: NoSuchFileException) {
            emptyList()
        } catch (_: IOException) {
            throw InvalidProvenance()
        }
    }

    private class InvalidProvenance : RuntimeException {
        constructor(message: String?) : super(message)
        constructor() : super()
    }

    private class Provenance(
        private val project: Project,
        private val module: Path,
        private val variant: String,
        private val namespace: String
    ) {
        private val task: String
        private val incremental: Path
        val merger: Path
        private val merged: Path
        private val blame: Path
        private var mergedAt: FileTime? = null
        private val roots = LinkedHashSet<Path>()
        private val membership = LinkedHashMap<Path, MutableSet<String>>()
        private val sourceIds = LinkedHashMap<String, Path>()

        init {
            val cap = variant[0].uppercaseChar().toString() + variant.substring(1)
            val mergeTask = "merge${cap}Resources"
            val packageTask = "package${cap}Resources"
            val mTask = module.resolve("build/intermediates/incremental").resolve(variant).resolve(mergeTask)
            val pTask = module.resolve("build/intermediates/incremental").resolve(packageTask)
            val pTaskVar = module.resolve("build/intermediates/incremental").resolve(variant).resolve(packageTask)
            val producers = LinkedHashSet<String>()
            for (origin in findVerifiedRClassOrigins(module, variant)) {
                val producer = origin.parent.fileName.toString()
                if (producer == "generate${cap}RFile") {
                    producers.add(packageTask)
                } else if (producer == "process${cap}Resources") {
                    producers.add(mergeTask)
                }
            }
            if (producers.size > 1) {
                throw AndroidQueryException(
                    "ambiguous_target: Conflicting compiled resource producers for $module",
                    -32803
                )
            }
            val isLibrary = producers.contains(packageTask)
            if (isLibrary) {
                task = packageTask
                incremental = if (Files.isRegularFile(pTaskVar.resolve("merger.xml"))) pTaskVar else pTask
            } else {
                task = mergeTask
                incremental = mTask
            }
            merger = incremental.resolve("merger.xml")
            merged = incremental.resolve("merged.dir")
            val b1 = module.resolve("build/intermediates/merged_res_blame_folder").resolve(variant).resolve(task)
                .resolve("out")
            val b2 = module.resolve("build/intermediates/merged_res_blame_folder").resolve(task).resolve("out")
            blame = if (Files.isDirectory(b1)) b1 else b2
        }

        fun load() {
            val file = AndroidSources.xml(project, merger)
            val tag = file?.rootTag
            if (tag == null || tag.name != "merger" || "3" != tag.getAttributeValue("version")) {
                throw InvalidProvenance()
            }
            for (dataset in tag.subTags) {
                ProgressManager.checkCanceled()
                if (dataset.name != "dataSet") continue
                for (source in dataset.subTags) {
                    if (source.name != "source" || source.getAttributeValue("path") == null) continue
                    val root = Path.of(source.getAttributeValue("path")!!).toAbsolutePath().normalize()
                    roots.add(root)
                    for (item in source.subTags) {
                        ProgressManager.checkCanceled()
                        if (item.name != "file" || item.getAttributeValue("path") == null) continue
                        val path = Path.of(item.getAttributeValue("path")!!).toAbsolutePath().normalize()
                        if (!path.startsWith(root)) throw InvalidProvenance()
                        val keys = membership.computeIfAbsent(path) { LinkedHashSet() }
                        var name = AndroidXml.value(item.getAttribute("name"))
                        var type = AndroidXml.value(item.getAttribute("type"))
                        if (name != null && type != null) keys.add(key(type, name))
                        for (child in item.subTags) {
                            name = AndroidXml.value(child.getAttribute("name"))
                            type =
                                if (child.name == "item") AndroidXml.value(child.getAttribute("type")) else child.name
                            if (name != null && type != null) keys.add(key(type, name))
                            if (child.name == "declare-styleable") {
                                for (attr in child.subTags) {
                                    val attribute = AndroidXml.value(attr.getAttribute("name"))
                                    if (attr.name == "attr" && attribute != null) {
                                        keys.add(key("attr", attribute))
                                    }
                                }
                            }
                        }
                    }
                }
            }
            val paths = LinkedHashSet<Path>(roots)
            paths.add(output())
            paths.add(merged)
            paths.add(incremental.resolve("stripped.dir"))
            val pngs = module.resolve("build/generated/res/pngs").resolve(variant)
            if (Files.isDirectory(pngs)) paths.add(pngs)
            val sorted =
                paths.stream().sorted(Comparator.comparing { path -> path.toString().replace('\\', '/') }).toList()
            val moduleName = module.fileName.toString()
            val prefix = namespace + (if (namespace.endsWith(moduleName)) "" else ".$moduleName")
            for (index in 0 until sorted.size) {
                val path = sorted[index]
                sourceIds[(prefix + "-" + path.parent.fileName + "-" + index).replace(' ', '_')] = path
            }
            try {
                mergedAt = Files.getLastModifiedTime(merger)
                for (source in listOf(
                    module.resolve("build.gradle.kts"),
                    module.resolve("build.gradle"),
                    module.parent.resolve("settings.gradle.kts"),
                    module.parent.resolve("settings.gradle"),
                    module.parent.resolve("gradle/libs.versions.toml")
                )) {
                    if (Files.exists(source) && Files.getLastModifiedTime(source).compareTo(mergedAt) > 0) {
                        throw InvalidProvenance()
                    }
                    val current = AndroidSources.current(project, source)
                    val disk = AndroidSources.text(source)
                    if (current != null && current.text != (if (disk == null) null else StringUtil.convertLineSeparators(
                            disk
                        ))
                    ) {
                        throw InvalidProvenance()
                    }
                }
            } catch (_: IOException) {
                throw InvalidProvenance()
            }
        }

        private fun output(): Path {
            return module.resolve("build/intermediates/merged_res").resolve(variant).resolve(task)
        }

        private fun decode(value: String): Path {
            val separator = value.indexOf(":/")
            if (separator >= 0 && !(separator == 1 && value[0].isLetter())) {
                val root = sourceIds[value.substring(0, separator)] ?: throw InvalidProvenance()
                val path = root.resolve(value.substring(separator + 2)).normalize()
                if (!path.startsWith(root)) throw InvalidProvenance()
                return path
            }
            return Path.of(value).toAbsolutePath().normalize()
        }

        private fun fileMatches(path: Path, type: String, name: String): Boolean {
            if (path.parent == null || path.parent.fileName == null) return false
            val folder = path.parent.fileName.toString()
            var filename = path.fileName.toString()
            val extension = filename.lastIndexOf('.')
            if (extension >= 0) filename = filename.substring(0, extension)
            if (filename.endsWith(".9")) filename = filename.substring(0, filename.length - 2)
            return (folder == type || folder.startsWith("$type-")) && filename == name
        }

        fun validate(wanted: String, type: String, name: String) {
            val actual = LinkedHashSet<Path>()
            for (root in roots) {
                val folders = LinkedHashSet<Path>(children(root))
                val virtualRoot = VirtualFileManager.getInstance().findFileByUrl(VfsUtilCore.pathToUrl(root.toString()))
                if (virtualRoot != null) {
                    for (child in virtualRoot.children) {
                        if (child.isDirectory) folders.add(Path.of(child.path))
                    }
                }
                for (folder in folders) {
                    val folderName = folder.fileName.toString()
                    val values = folderName == "values" || folderName.startsWith("values-")
                    val typed = folderName == type || folderName.startsWith("$type-")
                    if (!values && !typed && type != "id") continue
                    val files = LinkedHashSet<Path>(children(folder))
                    if (virtualRoot != null) {
                        val virtualFolder = virtualRoot.findChild(folderName)
                        if (virtualFolder != null) {
                            for (child in virtualFolder.children) {
                                if (!child.isDirectory) files.add(Path.of(child.path).toAbsolutePath().normalize())
                            }
                        }
                    }
                    for (path in files) {
                        ProgressManager.checkCanceled()
                        val built = membership.getOrDefault(path, emptySet()).contains(wanted)
                        AndroidSources.track(path)
                        val regular = Files.isRegularFile(path)
                        if (built && !regular) throw InvalidProvenance()
                        val time = mergedAt ?: throw InvalidProvenance()
                        if (regular && path.toString().endsWith(".xml") && AndroidSources.modifiedAfter(path, time)) {
                            val current = AndroidSources.current(project, path)
                            if (current != null && path.toString().endsWith(".xml") &&
                                current.text != StringUtil.convertLineSeparators(AndroidSources.text(path) ?: "")
                            ) {
                                throw InvalidProvenance()
                            }
                        }
                        if (values || type == "id") {
                            if (!path.toString().endsWith(".xml")) continue
                            val exists = declarations(AndroidSources.xml(project, path)).containsKey(wanted)
                            if (exists != built) throw InvalidProvenance()
                            if (exists) actual.add(path)
                        } else if (typed && fileMatches(path, type, name)) {
                            if (!built) throw InvalidProvenance()
                            actual.add(path)
                        }
                    }
                }
            }
            for (entry in membership.entries) {
                if (entry.value.contains(wanted) && !actual.contains(entry.key)) {
                    throw InvalidProvenance()
                }
            }
        }

        fun resolve(type: String, name: String): List<Location> {
            load()
            val wanted = key(type, name)
            validate(wanted, type, name)
            val result = LinkedHashSet<Location>()
            for (folder in children(merged)) {
                val qualifier = folder.fileName.toString()
                if (qualifier != "values" && !qualifier.startsWith("values-")) continue
                val output = folder.resolve(if (qualifier == "values") "values.xml" else "$qualifier.xml")
                val xml = AndroidSources.xml(project, output)
                if (xml == null || xml.rootTag == null) continue
                for (tag in xml.rootTag!!.subTags) {
                    if (wanted != declaration(tag)) continue
                    val blameFile = blame.resolve("multi-v2").resolve("$qualifier.json")
                    var json = json(blameFile)
                    if (json == null && qualifier.startsWith("values-")) {
                        json =
                            json(blame.resolve("multi-v2").resolve(qualifier.replace("values-", "values-b+") + ".json"))
                    }
                    if (json == null) throw InvalidProvenance("Blame map missing for qualifier $qualifier")
                    var mapped = false
                    for (log in array(objectOf(json).get("logs"))) {
                        ProgressManager.checkCanceled()
                        val obj = objectOf(log)
                        if (decode(string(obj, "outputFile")) != output) continue
                        for (item in array(obj.get("map"))) {
                            val map = objectOf(item)
                            // AGP omits "to" when every target coordinate equals "from".
                            val to = objectOf(if (map.has("to")) map.get("to") else map.get("from"))
                            var starts = numbers(to, "startOffsets")
                            var ends = numbers(to, "endOffsets")
                            if (ends.isEmpty()) ends = starts
                            var matches = false
                            val limit = Math.min(starts.size, ends.size)
                            for (index in 0 until limit) {
                                if (starts[index] <= tag.textOffset && ends[index] >= tag.textOffset) {
                                    matches = true
                                }
                            }
                            if (starts.isEmpty()) {
                                var document: Document? = xml.fileDocument
                                if (document == null) document =
                                    PsiDocumentManager.getInstance(project).getDocument(xml)
                                if (document != null) {
                                    val line = document.getLineNumber(tag.textOffset)
                                    for (startLine in numbers(to, "startLines")) {
                                        if (startLine == line) matches = true
                                    }
                                }
                            }
                            if (matches) {
                                addValue(decode(string(map, "source")), wanted, result)
                                mapped = true
                            }
                        }
                    }
                    if (!mapped) throw InvalidProvenance("Unmapped resource in blame: $wanted in $output")
                }
            }
            val single = json(blame.resolve("single").resolve("$task.json"))
            if (single != null) {
                for (item in array(single)) {
                    ProgressManager.checkCanceled()
                    val entry = objectOf(item)
                    val source = decode(string(entry, "source"))
                    if (!fileMatches(source, type, name)) continue
                    if (!decode(string(entry, "merged")).startsWith(output()) || !membership.getOrDefault(
                            source,
                            emptySet()
                        ).contains(wanted) || !Files.isRegularFile(source)
                    ) {
                        throw InvalidProvenance()
                    }
                    result.add(AndroidLocations.at(source, Range(Position(0, 0), Position(0, 0))))
                }
            }
            return ArrayList(result)
        }

        private fun addValue(path: Path, wanted: String, result: MutableSet<Location>) {
            if (!membership.getOrDefault(path, emptySet()).contains(wanted)) {
                throw InvalidProvenance("Resource missing in snapshot membership: $path")
            }
            val file =
                AndroidSources.xml(project, path) ?: throw InvalidProvenance("Source XML cannot be opened: $path")
            val ranges = declarations(file)[wanted]
            if (ranges == null || ranges.isEmpty()) {
                throw InvalidProvenance("Declaration range missing for $wanted in $path")
            }
            var document: Document? = file.fileDocument
            if (document == null) document = PsiDocumentManager.getInstance(project).getDocument(file)
            if (document == null) throw InvalidProvenance("Document unavailable for $path")
            for (range in ranges) {
                result.add(AndroidLocations.at(path, range.toLspRange(document)))
            }
        }

        private fun json(path: Path): JsonElement? {
            val text = AndroidSources.text(path) ?: return null
            return try {
                JsonParser.parseString(text)
            } catch (_: com.google.gson.JsonParseException) {
                throw InvalidProvenance()
            }
        }

        private fun objectOf(value: JsonElement?): JsonObject {
            if (value == null || !value.isJsonObject) throw InvalidProvenance()
            return value.asJsonObject
        }

        private fun array(value: JsonElement?): JsonArray {
            if (value == null || !value.isJsonArray) throw InvalidProvenance()
            return value.asJsonArray
        }

        private fun string(obj: JsonObject, name: String): String {
            val value = obj.get(name)
            if (value == null || !value.isJsonPrimitive || !value.asJsonPrimitive.isString) {
                throw InvalidProvenance()
            }
            return value.asString
        }

        private fun numbers(obj: JsonObject, name: String): IntArray {
            if (!obj.has(name)) return IntArray(0)
            val value = string(obj, name)
            if (value.isEmpty()) return IntArray(0)
            return try {
                val parts = value.split(",")
                val numbers = IntArray(parts.size)
                for (index in parts.indices) {
                    numbers[index] = parts[index].toInt()
                }
                numbers
            } catch (_: NumberFormatException) {
                throw InvalidProvenance()
            }
        }
    }
}
