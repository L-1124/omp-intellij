package org.jetbrains.android.lint

import com.android.tools.lint.client.api.BlameFile
import com.android.tools.lint.client.api.LintClient
import com.android.tools.lint.detector.api.Location
import com.android.utils.Pair
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.project.Project
import org.jetbrains.android.resource.AndroidSources
import org.w3c.dom.Document
import org.w3c.dom.Node
import java.io.File
import java.io.IOException
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.util.IdentityHashMap
import java.util.concurrent.CancellationException
import java.util.regex.Pattern

class AndroidLintManifest(
    val model: AndroidLintModel?,
    val ideaProject: Project?,
    val client: LintClient?,
) {
    private val reportFileCache: MutableMap<Any, BlameFile> = HashMap()
    private val sourceNodeCache: MutableMap<Node, Pair<File, out Node>> = IdentityHashMap()

    @Volatile
    private var resolvedMergedDocument: Document? = null

    @Volatile
    private var cachedManifestDocument: Document? = null

    fun getMergedManifest(
        lintProject: com.android.tools.lint.detector.api.Project? = null,
        targetFile: File? = null,
        targetDom: Document? = null,
    ): Document? {
        ProgressManager.checkCanceled()

        cachedManifestDocument?.let { return it }

        if (isValidBuiltSnapshot(targetFile, targetDom)) {
            val mergedFile = getMergedManifestFile()
            val reportFile = getManifestMergeReportFile()
            if (mergedFile != null && reportFile != null) {
                val parser = client?.xmlParser
                var mergedDoc: Document? = null
                if (client != null) {
                    try {
                        mergedDoc = client.getXmlDocument(mergedFile, null)
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        LOG.debug("Failed reading merged manifest via client", e)
                    }
                }
                if (mergedDoc == null && parser != null) {
                    try {
                        mergedDoc = parser.parseXml(mergedFile)
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        LOG.debug("Failed parsing merged manifest via parser", e)
                    }
                }
                if (mergedDoc != null) {
                    resolveMergeManifestSources(mergedDoc, reportFile)
                    mergedDoc.setUserData(File::class.java.name, mergedFile, null)
                    this.resolvedMergedDocument = mergedDoc
                    this.cachedManifestDocument = mergedDoc
                    return mergedDoc
                }
            }
        }

        // Clean / unbuilt / open changed sources: provide verified source-local target DOM without pretending merged
        this.resolvedMergedDocument = null
        if (targetDom != null) {
            targetDom.setUserData(LintClient.MERGED_MANIFEST, null, null)
            if (targetFile != null) {
                targetDom.setUserData(File::class.java.name, targetFile, null)
            }
            this.cachedManifestDocument = targetDom
            return targetDom
        }

        val fallbackFile = targetFile ?: getPrimaryManifestFile()
        if (fallbackFile != null) {
            val parser = client?.xmlParser
            var sourceDoc: Document? = null
            if (client != null) {
                try {
                    sourceDoc = client.getXmlDocument(fallbackFile, null)
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    LOG.debug("Failed reading source manifest via client", e)
                }
            }
            if (sourceDoc == null && parser != null) {
                try {
                    sourceDoc = parser.parseXml(fallbackFile)
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    LOG.debug("Failed parsing source manifest via parser", e)
                }
            }
            if (sourceDoc != null) {
                sourceDoc.setUserData(LintClient.MERGED_MANIFEST, null, null)
                sourceDoc.setUserData(File::class.java.name, fallbackFile, null)
                this.cachedManifestDocument = sourceDoc
                return sourceDoc
            }
        }

        return null
    }

    fun resolveMergeManifestSources(mergedManifest: Document?, reportFile: Any?) {
        ProgressManager.checkCanceled()
        if (mergedManifest == null || reportFile == null) return
        val normalizedReport = if (reportFile is Path) {
            reportFile.toFile()
        } else {
            reportFile
        }
        mergedManifest.setUserData(LintClient.MERGED_MANIFEST, normalizedReport, null)
    }

    fun findManifestSourceNode(mergedNode: Node?): Pair<File, out Node>? {
        ProgressManager.checkCanceled()
        if (mergedNode == null) return null
        val doc = if (mergedNode is Document) mergedNode else mergedNode.ownerDocument ?: return null

        if (!isMergeManifestNode(mergedNode)) {
            val fileObj = doc.getUserData(File::class.java.name)
            if (fileObj is File) {
                return Pair.of(fileObj, mergedNode)
            } else if (fileObj is Path) {
                return Pair.of(fileObj.toFile(), mergedNode)
            }
            val primary = getPrimaryManifestFile()
            if (primary != null) {
                return Pair.of(primary, mergedNode)
            }
            return null
        }

        val cached = sourceNodeCache[mergedNode]
        if (cached != null) {
            return if (cached === NOT_FOUND) null else cached
        }

        var report = doc.getUserData(LintClient.MERGED_MANIFEST)
        if (report == null && doc === resolvedMergedDocument) {
            report = getManifestMergeReportFile()
        }
        if (report == null) {
            sourceNodeCache[mergedNode] = NOT_FOUND
            return null
        }

        var blameFile = reportFileCache[report]
        if (blameFile == null) {
            try {
                blameFile = when (report) {
                    is File -> BlameFile.parse(report)
                    is Path -> BlameFile.parse(report.toFile())
                    is List<*> -> {
                        @Suppress("UNCHECKED_CAST")
                        BlameFile.parse(report as List<String>)
                    }

                    is String -> BlameFile.parse(listOf(*report.split("\n".toRegex()).toTypedArray()))
                    else -> BlameFile.NONE
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                LOG.debug("Failed parsing manifest blame file", e)
                blameFile = BlameFile.NONE
            }
            reportFileCache[report] = blameFile
        }

        var source: Pair<File, out Node>? = null
        if (blameFile != null && blameFile !== BlameFile.NONE && client != null) {
            try {
                source = blameFile.findSourceNode(client, mergedNode)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                LOG.debug("Failed resolving source node via blame", e)
            }
        }

        sourceNodeCache[mergedNode] = source ?: NOT_FOUND
        return source
    }

    fun findManifestSourceLocation(mergedNode: Node?): Location? {
        ProgressManager.checkCanceled()
        if (mergedNode == null) return null
        val source = findManifestSourceNode(mergedNode)
        if (source != null && source.first != null && source.second != null) {
            val parser = client?.xmlParser
            if (parser != null) {
                return parser.getLocation(source.first, source.second)
            }
        }
        return null
    }

    fun isMergeManifestNode(node: Node?): Boolean {
        if (node == null) return false
        val doc = if (node is Document) node else node.ownerDocument ?: return false
        if (resolvedMergedDocument != null && doc === resolvedMergedDocument) return true
        return doc.getUserData(LintClient.MERGED_MANIFEST) != null
    }

    fun isValidBuiltSnapshot(): Boolean {
        return isValidBuiltSnapshot(null, null)
    }

    fun isValidBuiltSnapshot(targetFile: File?, targetDom: Document?): Boolean {
        ProgressManager.checkCanceled()
        if (model == null) return false
        val variant = model.variant
        if (variant.isNullOrBlank()) return false

        // Disallow when SDK premise is missing: incomplete model cannot validate built state
        if (model.minSdkPremiseMissing) {
            return false
        }

        val mergedFile = getMergedManifestFile()
        if (mergedFile == null || !Files.isRegularFile(mergedFile.toPath())) {
            return false
        }
        val mergedPath = mergedFile.toPath().toAbsolutePath().normalize()
        if (!pathMatchesVariant(mergedPath, variant)) {
            return false
        }
        AndroidSources.observeCompiledArchive(mergedPath)

        val reportFile = getManifestMergeReportFile()
        if (reportFile == null || !Files.isRegularFile(reportFile.toPath())) {
            return false
        }
        val reportPath = reportFile.toPath().toAbsolutePath().normalize()
        if (!pathMatchesVariant(reportPath, variant)) {
            return false
        }
        if (!isAgpDecisionLog(reportPath)) {
            return false
        }
        AndroidSources.observeCompiledArchive(reportPath)

        val mergedTime: Long
        try {
            mergedTime = Files.getLastModifiedTime(mergedPath).toMillis()
        } catch (_: IOException) {
            return false
        }

        // Verify build script freshness: changes in build.gradle(.kts) invalidate built manifest
        val moduleRoot = model.moduleRoot
        if (moduleRoot != null) {
            for (scriptName in listOf("build.gradle.kts", "build.gradle")) {
                val script = moduleRoot.resolve(scriptName)
                if (Files.isRegularFile(script)) {
                    AndroidSources.observeCompiledArchive(script)
                    try {
                        if (Files.getLastModifiedTime(script).toMillis() > mergedTime) {
                            return false
                        }
                    } catch (_: IOException) {
                        return false
                    }
                }
            }
        }

        try {
            if (UNRESOLVED_PLACEHOLDER.matcher(Files.readString(mergedPath)).find()) return false
        } catch (_: IOException) {
            return false
        }

        val sourceManifests = getSourceManifestFiles()
        if (sourceManifests.isEmpty()) {
            return false
        }

        for (src in sourceManifests) {
            val srcPath = src.toPath().toAbsolutePath().normalize()
            AndroidSources.observeCompiledArchive(srcPath)

            if (!Files.isRegularFile(srcPath)) {
                return false
            }

            try {
                val srcTime = Files.getLastModifiedTime(srcPath).toMillis()
                if (srcTime > mergedTime) {
                    return false
                }
            } catch (_: IOException) {
                return false
            }

            if (targetFile != null && targetFile.toPath().toAbsolutePath().normalize() == srcPath) {
                if (client != null) {
                    val editorText = client.readFile(targetFile)
                    if (editorText != null) {
                        try {
                            val diskText = Files.readString(srcPath)
                            if (normalizeLf(editorText) != normalizeLf(diskText)) {
                                return false
                            }
                        } catch (_: IOException) {
                            return false
                        }
                    }
                }
            }
        }

        return true
    }

    fun getSourceManifestFiles(): List<File> {
        ProgressManager.checkCanceled()
        val results = LinkedHashSet<File>()
        val seen = LinkedHashSet<Path>()

        if (model != null) {
            val modelFiles = model.manifestFiles()
            for (f in modelFiles) {
                if (seen.add(f.toPath().toAbsolutePath().normalize())) {
                    results.add(f)
                }
            }

            val variant = model.lintModelVariant
            if (variant != null) {
                for (provider in variant.sourceProviders) {
                    for (f in provider.manifestFiles) {
                        if (seen.add(f.toPath().toAbsolutePath().normalize())) {
                            results.add(f)
                        }
                    }
                }
            }

            if (results.isEmpty() && model.moduleRoot != null) {
                val std = model.moduleRoot.resolve("src/main/AndroidManifest.xml")
                AndroidSources.observeCompiledArchive(std)
                if (Files.isRegularFile(std) && seen.add(std.toAbsolutePath().normalize())) {
                    results.add(std.toFile())
                }
            }
        }

        return results.toList()
    }

    fun getPrimaryManifestFile(): File? {
        val files = getSourceManifestFiles()
        return if (files.isEmpty()) null else files[0]
    }

    fun getMergedManifestFile(): File? {
        if (model == null) return null
        val fromModel = model.mergedManifest()
        if (fromModel != null && Files.isRegularFile(fromModel.toPath())) {
            return fromModel
        }
        val variant = model.lintModelVariant
        if (variant != null) {
            val f = variant.mergedManifest
            if (f != null && Files.isRegularFile(f.toPath())) return f
        }
        val root = model.moduleRoot
        val v = model.variant
        for (p in mergedManifestCandidates(root, v)) {
            AndroidSources.observeCompiledArchive(p)
            if (Files.isRegularFile(p)) return p.toFile()
        }
        return null
    }

    fun getManifestMergeReportFile(): File? {
        if (model == null) return null
        val fromModel = model.manifestMergeReport()
        if (fromModel != null && Files.isRegularFile(fromModel.toPath())) {
            return fromModel
        }
        val variant = model.lintModelVariant
        if (variant != null) {
            val f = variant.manifestMergeReport
            if (f != null && Files.isRegularFile(f.toPath())) return f
        }
        val root = model.moduleRoot
        val v = model.variant
        for (p in mergerReportCandidates(root, v)) {
            AndroidSources.observeCompiledArchive(p)
            if (Files.isRegularFile(p)) return p.toFile()
        }
        return null
    }

    companion object {
        private val LOG = Logger.getInstance(AndroidLintManifest::class.java)
        private val NOT_FOUND = Pair.of<File, Node>(null, null)
        private val UNRESOLVED_PLACEHOLDER = Pattern.compile("\\$\\{[a-zA-Z0-9_.]+}")

        @JvmStatic
        fun mergedManifestCandidates(root: Path?, variant: String?): List<Path> {
            if (root == null || variant.isNullOrBlank()) return emptyList()
            val cap = variant[0].uppercaseChar().toString() + variant.substring(1)
            return listOf(
                root.resolve("build/intermediates/merged_manifests/$variant/process${cap}Manifest/AndroidManifest.xml"),
                root.resolve("build/intermediates/merged_manifest/$variant/process${cap}MainManifest/AndroidManifest.xml"),
                root.resolve("build/intermediates/merged_manifests/$variant/AndroidManifest.xml"),
                root.resolve("build/intermediates/merged_manifest/$variant/AndroidManifest.xml")
            )
        }

        @JvmStatic
        fun mergerReportCandidates(root: Path?, variant: String?): List<Path> {
            if (root == null || variant.isNullOrBlank()) return emptyList()
            val cap = variant[0].uppercaseChar().toString() + variant.substring(1)
            return listOf(
                root.resolve("build/outputs/logs/manifest-merger-$variant-report.txt"),
                root.resolve("build/intermediates/manifest_merge_blame_file/$variant/process${cap}MainManifest/manifest-merger-blame-$variant-report.txt")
            )
        }

        private fun pathMatchesVariant(path: Path, variant: String): Boolean {
            val pathStr = path.toString().replace('\\', '/').lowercase()
            val vLower = variant.lowercase()
            return pathStr.contains("/$vLower/")
                    || pathStr.contains("-$vLower-")
                    || pathStr.contains("process${vLower}manifest")
                    || pathStr.contains("process${vLower}mainmanifest")
        }

        private fun isAgpDecisionLog(reportPath: Path): Boolean {
            try {
                Files.newBufferedReader(reportPath, StandardCharsets.UTF_8).use { reader ->
                    var line: String?
                    var linesRead = 0
                    while (reader.readLine().also { line = it } != null && linesRead < 20) {
                        linesRead++
                        val trimmed = line!!.trim()
                        if (trimmed.startsWith("-- Merging decision tree log ---")) {
                            return true
                        }
                        if (trimmed.startsWith("ADDED from ") || trimmed.startsWith("MERGED from ") || trimmed.startsWith(
                                "INJECTED from "
                            )
                        ) {
                            return true
                        }
                    }
                }
            } catch (_: IOException) {
            }
            return false
        }

        private fun normalizeLf(text: CharSequence?): String {
            if (text == null) return ""
            return text.toString().replace("\r\n", "\n").replace('\r', '\n')
        }
    }
}
