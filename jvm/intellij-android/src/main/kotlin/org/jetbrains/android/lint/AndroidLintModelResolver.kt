package org.jetbrains.android.lint

import com.android.tools.lint.model.LintModelAndroidLibrary
import com.android.tools.lint.model.LintModelLibrary
import com.android.tools.lint.model.LintModelModule
import com.android.tools.lint.model.LintModelModuleType
import com.android.tools.lint.model.LintModelSerialization
import com.android.tools.lint.model.LintModelVariant
import com.android.tools.lint.model.PathVariables
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.module.Module
import com.intellij.openapi.module.ModuleManager
import com.intellij.openapi.progress.ProcessCanceledException
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.roots.LibraryOrderEntry
import com.intellij.openapi.roots.ModuleOrderEntry
import com.intellij.openapi.roots.ModuleRootManager
import com.intellij.openapi.roots.OrderEntry
import com.intellij.openapi.roots.OrderRootType
import com.intellij.openapi.vfs.VfsUtilCore
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.psi.PsiElement
import com.intellij.psi.PsiFile
import com.intellij.psi.util.PsiTreeUtil
import com.intellij.psi.xml.XmlFile
import org.codehaus.groovy.ast.ModuleNode
import org.codehaus.groovy.ast.expr.ArgumentListExpression
import org.codehaus.groovy.ast.expr.BinaryExpression
import org.codehaus.groovy.ast.expr.ClosureExpression
import org.codehaus.groovy.ast.expr.ConstantExpression
import org.codehaus.groovy.ast.expr.Expression
import org.codehaus.groovy.ast.expr.MapEntryExpression
import org.codehaus.groovy.ast.expr.MethodCallExpression
import org.codehaus.groovy.ast.expr.NamedArgumentListExpression
import org.codehaus.groovy.ast.expr.TupleExpression
import org.codehaus.groovy.ast.stmt.BlockStatement
import org.codehaus.groovy.ast.stmt.ExpressionStatement
import org.codehaus.groovy.ast.stmt.Statement
import org.codehaus.groovy.control.SourceUnit
import org.jetbrains.android.context.AndroidContext
import org.jetbrains.android.context.AndroidQueryException
import org.jetbrains.android.resource.AndroidLayout
import org.jetbrains.android.resource.AndroidSources
import org.jetbrains.kotlin.psi.KtAnonymousInitializer
import org.jetbrains.kotlin.psi.KtBinaryExpression
import org.jetbrains.kotlin.psi.KtBlockExpression
import org.jetbrains.kotlin.psi.KtCallExpression
import org.jetbrains.kotlin.psi.KtConstantExpression
import org.jetbrains.kotlin.psi.KtEscapeStringTemplateEntry
import org.jetbrains.kotlin.psi.KtExpression
import org.jetbrains.kotlin.psi.KtFile
import org.jetbrains.kotlin.psi.KtLambdaExpression
import org.jetbrains.kotlin.psi.KtScript
import org.jetbrains.kotlin.psi.KtScriptInitializer
import org.jetbrains.kotlin.psi.KtStringTemplateExpression
import java.io.File
import java.io.IOException
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.security.MessageDigest
import java.security.NoSuchAlgorithmException
import java.util.ArrayDeque
import java.util.ArrayList
import java.util.HashSet
import java.util.LinkedHashSet
import java.util.Properties
import java.util.Queue
import java.util.concurrent.CancellationException
import java.util.regex.Pattern

object AndroidLintModelResolver {
    private val LOG = Logger.getInstance(AndroidLintModelResolver::class.java)

    @JvmRecord
    data class CleanAstResult(
        val minSdk: Int?,
        val targetSdk: Int?,
        val compileSdk: Int?,
        val compileTarget: String?,
        val namespace: String?,
        val isLibrary: Boolean?,
        val minSdkPremiseMissing: Boolean,
        val minSdkUnsafe: Boolean,
        val targetSdkUnsafe: Boolean,
        val compileSdkUnsafe: Boolean
    )

    @JvmStatic
    @JvmOverloads
    fun resolve(project: Project?, mainFile: VirtualFile?, importedModule: Module? = null): AndroidLintModel? {
        if (project == null || project.isDisposed || mainFile == null) return null
        ProgressManager.checkCanceled()

        var module = importedModule ?: AndroidContext.findModule(project, mainFile)
        if (module == null) {
            val pathStr = mainFile.path
            var filePath: Path? = null
            try {
                filePath = Path.of(pathStr).toAbsolutePath().normalize()
            } catch (_: Exception) {
            }
            if (filePath != null) {
                var best: Module? = null
                var bestLen = -1
                for (candidate in ModuleManager.getInstance(project).modules) {
                    if (candidate.isDisposed) continue
                    val rootVf = AndroidContext.findModuleRoot(candidate)
                    if (rootVf != null) {
                        try {
                            val rootPath = Path.of(rootVf.path).toAbsolutePath().normalize()
                            if (filePath.startsWith(rootPath)) {
                                val len = rootPath.nameCount
                                if (len > bestLen) {
                                    bestLen = len
                                    best = candidate
                                }
                            }
                        } catch (_: Exception) {
                        }
                    }
                    for (contentRoot in ModuleRootManager.getInstance(candidate).contentRoots) {
                        try {
                            val rootPath = Path.of(contentRoot.path).toAbsolutePath().normalize()
                            if (filePath.startsWith(rootPath)) {
                                val len = rootPath.nameCount
                                if (len > bestLen) {
                                    bestLen = len
                                    best = candidate
                                }
                            }
                        } catch (_: Exception) {
                        }
                    }
                }
                module = best
            }
        }
        if (module == null || module.isDisposed) return null

        val isXml = mainFile.name.endsWith(".xml")
        var androidModule: Module? = null
        if (isXml) {
            var mainPathCandidate: Path? = null
            try {
                mainPathCandidate = Path.of(mainFile.path).toAbsolutePath().normalize()
            } catch (_: Exception) {
            }
            val mainPath = mainPathCandidate
            if (mainPath != null) {
                val rawModuleRootVf = AndroidContext.findModuleRoot(module)
                if (rawModuleRootVf != null) {
                    val rawModuleRoot = Path.of(rawModuleRootVf.path).toAbsolutePath().normalize()
                    val parent = mainPath.parent
                    val grandParent = parent?.parent
                    val normGrandParent = grandParent?.toAbsolutePath()?.normalize()

                    val matchingModules = ArrayList<Module>()
                    for (candidate in ModuleManager.getInstance(project).modules) {
                        if (candidate.isDisposed) continue
                        val candRootVf = AndroidContext.findModuleRoot(candidate) ?: continue
                        val candRoot = Path.of(candRootVf.path).toAbsolutePath().normalize()
                        if (rawModuleRoot != candRoot) continue

                        val layout = getLayout(candidate) ?: continue

                        val matchesManifest = layout.manifests.any { m ->
                            m.toAbsolutePath().normalize() == mainPath
                        }
                        var matchesResource = false
                        if (normGrandParent != null) {
                            matchesResource = layout.resources.any { r ->
                                r.toAbsolutePath().normalize() == normGrandParent
                            }
                        }

                        if (matchesManifest || matchesResource) {
                            matchingModules.add(candidate)
                        }
                    }

                    if (matchingModules.size == 1) {
                        androidModule = matchingModules[0]
                    } else if (matchingModules.size > 1) {
                        val withRClasspath = ArrayList<Module>()
                        for (m in matchingModules) {
                            if (hasRClasspath(m, rawModuleRoot)) {
                                withRClasspath.add(m)
                            }
                        }
                        if (withRClasspath.size == 1) {
                            androidModule = withRClasspath[0]
                        } else {
                            val pool = if (withRClasspath.isNotEmpty()) withRClasspath else matchingModules
                            val withVariant = ArrayList<Module>()
                            for (m in pool) {
                                val mRoot = AndroidContext.findModuleRoot(m)
                                if (mRoot != null && AndroidContext.resolveVariant(m, mRoot) != null) {
                                    withVariant.add(m)
                                }
                            }
                            if (withVariant.size == 1) {
                                androidModule = withVariant[0]
                            } else {
                                val androidPool = pool.filter { isAndroidModule(it) }
                                if (androidPool.size == 1) {
                                    androidModule = androidPool[0]
                                } else {
                                    val mainSources = androidPool.filter { it.name.endsWith(".main") }
                                    if (mainSources.size == 1) {
                                        androidModule = mainSources[0]
                                    } else {
                                        throw AndroidQueryException.modelUnavailable(
                                            "Ambiguous Android XML source-set owner: $mainPath"
                                        )
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        if (androidModule == null) {
            if (isAndroidModule(module)) {
                androidModule = module
            } else if (isXml) {
                val layout = getLayout(module)
                if (layout != null && (layout.android || layout.manifests.isNotEmpty() || layout.resources.isNotEmpty())) {
                    androidModule = module
                } else {
                    return null
                }
            } else {
                val candidates = ArrayList<Module>()
                for (candidate in ModuleManager.getInstance(project).modules) {
                    if (candidate == module || candidate.isDisposed) continue
                    if (!isAndroidModule(candidate)) continue
                    if (candidate.getModuleWithDependenciesScope().isSearchInModuleContent(module)) {
                        candidates.add(candidate)
                    }
                }
                if (candidates.isEmpty()) return null

                candidates.sortWith { a, b ->
                    val aApp = isAppModule(project, a)
                    val bApp = isAppModule(project, b)
                    if (aApp != bApp) {
                        if (aApp) -1 else 1
                    } else {
                        a.name.compareTo(b.name)
                    }
                }
                androidModule = candidates[0]
            }
        }
        if (isXml) module = androidModule

        val moduleRootVf = AndroidContext.findModuleRoot(androidModule) ?: return null
        val moduleRoot = Path.of(moduleRootVf.path).toAbsolutePath().normalize()
        val basePath = project.basePath
        val projectRoot = if (basePath != null) Path.of(basePath).toAbsolutePath().normalize() else moduleRoot

        var sdkHome: Path? = null
        var compileSdk: Int? = null
        var compileTarget: String? = null
        val ruleJars = ArrayList<Path>()
        val ruleJarFingerprints = ArrayList<String>()
        val seenRuleJars = HashSet<Path>()

        for (entry in ModuleRootManager.getInstance(androidModule).orderEntries) {
            ProgressManager.checkCanceled()
            if (entry !is LibraryOrderEntry || entry.library == null) continue
            val lib = entry.library ?: continue
            for (url in lib.getUrls(OrderRootType.CLASSES)) {
                var pathStr = VfsUtilCore.urlToPath(url)
                val sep = pathStr.indexOf("!/")
                if (sep >= 0) pathStr = pathStr.substring(0, sep)
                val path: Path
                try {
                    path = Path.of(pathStr).toAbsolutePath().normalize()
                } catch (_: Exception) {
                    continue
                }

                if (path.fileName != null && path.fileName.toString() == "android.jar") {
                    val platformDir = path.parent
                    if (platformDir != null) {
                        val platformsDir = platformDir.parent
                        if (platformsDir != null && platformsDir.fileName != null && platformsDir.fileName.toString() == "platforms") {
                            sdkHome = platformsDir.parent
                        }
                        val sourceProps = platformDir.resolve("source.properties")
                        AndroidSources.observeCompiledArchive(sourceProps)
                        if (Files.isRegularFile(sourceProps)) {
                            try {
                                Files.newInputStream(sourceProps).use { inStream ->
                                    val props = Properties()
                                    props.load(inStream)
                                    val apiLevelStr = props.getProperty("AndroidVersion.ApiLevel")
                                    if (apiLevelStr != null) {
                                        val m = Pattern.compile("^(\\d+)").matcher(apiLevelStr.trim())
                                        if (m.find()) {
                                            compileSdk = m.group(1).toInt()
                                        }
                                    }
                                }
                            } catch (_: IOException) {
                            }
                        }
                        val platformName = platformDir.fileName.toString()
                        if (platformName.startsWith("android-")) {
                            compileTarget = platformName
                            if (compileSdk == null) {
                                val m = Pattern.compile("^android-(\\d+)").matcher(platformName)
                                if (m.find()) compileSdk = m.group(1).toInt()
                            }
                        }
                    }
                }

                if (path.fileName != null && path.fileName.toString() == "classes.jar") {
                    val parent = path.parent
                    if (parent != null && parent.fileName != null && parent.fileName.toString() == "jars") {
                        val lintJar = parent.resolve("lint.jar")
                        AndroidSources.observeCompiledArchive(lintJar)
                        if (Files.isRegularFile(lintJar) && seenRuleJars.add(lintJar)) {
                            ruleJars.add(lintJar)
                            try {
                                val size = Files.size(lintJar)
                                val mtime = Files.getLastModifiedTime(lintJar).toMillis()
                                ruleJarFingerprints.add("$lintJar:$size:$mtime")
                            } catch (_: IOException) {
                            }
                        }
                    }
                }
            }
        }

        var variant = AndroidContext.resolveVariant(androidModule, moduleRootVf)

        var lintModelModule: LintModelModule? = null
        var lintModelVariant: LintModelVariant? = null
        var minSdk: Int? = null
        var targetSdk: Int? = null
        var namespace: String? = null
        var isLibrary = false
        var minSdkPremiseMissing = false

        val lintReportBase = moduleRoot.resolve("build/intermediates/lint_report_lint_model")
        val incrementalBase = moduleRoot.resolve("build/intermediates/incremental")
        AndroidSources.observeCompiledArchive(lintReportBase)
        AndroidSources.observeCompiledArchive(incrementalBase)

        val candidateDirs = ArrayList<Path>()
        if (variant != null) {
            val capVariant = variant.replaceFirstChar { if (it.isLowerCase()) it.titlecase() else it.toString() }
            candidateDirs.add(lintReportBase.resolve(variant).resolve("generate${capVariant}LintReportModel"))
            candidateDirs.add(incrementalBase.resolve("lintAnalyze$capVariant"))
        } else if (Files.isDirectory(lintReportBase)) {
            val varDirs = ArrayList<Path>()
            try {
                Files.list(lintReportBase).use { stream ->
                    for (p in stream.toList()) {
                        if (Files.isDirectory(p)) varDirs.add(p)
                    }
                }
            } catch (_: IOException) {
            }
            if (varDirs.size == 1) {
                val singleVar = varDirs[0].fileName.toString()
                val capSingleVar =
                    singleVar.replaceFirstChar { if (it.isLowerCase()) it.titlecase() else it.toString() }
                candidateDirs.add(varDirs[0].resolve("generate${capSingleVar}LintReportModel"))
            }
        }

        var foundModelDir: Path? = null
        val candidateXmls = ArrayList<Path>()
        for (cDir in candidateDirs) {
            AndroidSources.observeCompiledArchive(cDir)
            val moduleXml = cDir.resolve("module.xml")
            candidateXmls.add(moduleXml)
            AndroidSources.observeCompiledArchive(moduleXml)
            if (variant != null) {
                val variantXml = cDir.resolve("$variant.xml")
                val depsXml = cDir.resolve("$variant-main-dependencies.xml")
                val libsXml = cDir.resolve("$variant-main-libraries.xml")
                candidateXmls.add(variantXml)
                candidateXmls.add(depsXml)
                candidateXmls.add(libsXml)
                AndroidSources.observeCompiledArchive(variantXml)
                AndroidSources.observeCompiledArchive(depsXml)
                AndroidSources.observeCompiledArchive(libsXml)
            }
            if (foundModelDir == null && Files.isRegularFile(moduleXml)) {
                foundModelDir = cDir
            }
        }

        val modelXmlFiles = ArrayList<Path>()
        if (foundModelDir != null) {
            try {
                Files.list(foundModelDir).use { stream ->
                    for (f in stream.toList()) {
                        if (f.fileName.toString().endsWith(".xml")) {
                            modelXmlFiles.add(f)
                            AndroidSources.observeCompiledArchive(f)
                        }
                    }
                }
            } catch (_: IOException) {
            }

            var loadedModule: LintModelModule? = null
            var loadedVariant: LintModelVariant? = null
            var loadedMinSdk: Int? = null
            var loadedTargetSdk: Int? = null
            var loadedNamespace: String? = null
            var loadedIsLibrary: Boolean? = null
            var loadedCompileTarget: String? = null
            var loadedCompileSdk: Int? = null
            val loadedRuleJars = ArrayList<Path>()
            val loadedRuleJarFingerprints = ArrayList<String>()

            try {
                loadedModule = LintModelSerialization.readModule(foundModelDir.toFile(), null, true, PathVariables())
                    ?: throw IOException("Null module read from $foundModelDir")

                if (variant != null) {
                    loadedVariant = loadedModule.findVariant(variant)
                        ?: throw IllegalStateException("Variant $variant not found in model at $foundModelDir")
                } else if (loadedModule.variants.size == 1) {
                    loadedVariant = loadedModule.variants[0]
                } else {
                    throw IllegalStateException("Variant is unknown and model at $foundModelDir has ${loadedModule.variants.size} variants")
                }

                val loadedVariantName = loadedVariant.name
                if (loadedVariant.minSdkVersion != null) {
                    loadedMinSdk = loadedVariant.minSdkVersion?.apiLevel
                }
                if (loadedVariant.targetSdkVersion != null) {
                    loadedTargetSdk = loadedVariant.targetSdkVersion?.apiLevel
                }
                loadedNamespace = loadedVariant.`package`
                if (loadedNamespace == null) loadedNamespace = loadedModule.namespace
                loadedIsLibrary = loadedModule.type == LintModelModuleType.LIBRARY
                loadedCompileTarget = loadedModule.compileTarget
                if (loadedCompileTarget != null) {
                    val m = Pattern.compile("(\\d+)").matcher(loadedCompileTarget)
                    if (m.find()) loadedCompileSdk = m.group(1).toInt()
                }

                val mainArtifact = loadedVariant.mainArtifact
                if (mainArtifact?.dependencies != null) {
                    for (lib in mainArtifact.dependencies.getAll()) {
                        val lintJarFile = lib.lintJar
                        if (lintJarFile != null) {
                            val p = lintJarFile.toPath().toAbsolutePath().normalize()
                            AndroidSources.observeCompiledArchive(p)
                            if (Files.isRegularFile(p)) {
                                loadedRuleJars.add(p)
                                loadedRuleJarFingerprints.add(
                                    "$p:${Files.size(p)}:${
                                        Files.getLastModifiedTime(p).toMillis()
                                    }"
                                )
                            }
                        }
                    }
                }
                for (jarFile in loadedModule.lintRuleJars) {
                    if (jarFile != null) {
                        val p = jarFile.toPath().toAbsolutePath().normalize()
                        AndroidSources.observeCompiledArchive(p)
                        if (Files.isRegularFile(p)) {
                            loadedRuleJars.add(p)
                            loadedRuleJarFingerprints.add(
                                "$p:${Files.size(p)}:${
                                    Files.getLastModifiedTime(p).toMillis()
                                }"
                            )
                        }
                    }
                }

                lintModelModule = loadedModule
                lintModelVariant = loadedVariant
                variant = loadedVariantName
                minSdk = loadedMinSdk
                targetSdk = loadedTargetSdk
                namespace = loadedNamespace
                isLibrary = loadedIsLibrary ?: false
                if (compileTarget == null) compileTarget = loadedCompileTarget
                if (compileSdk == null) compileSdk = loadedCompileSdk
                for (p in loadedRuleJars) {
                    if (seenRuleJars.add(p)) ruleJars.add(p)
                }
                ruleJarFingerprints.addAll(loadedRuleJarFingerprints)
                minSdkPremiseMissing = (minSdk == null)
            } catch (t: Throwable) {
                if (t is ProcessCanceledException || t is CancellationException) {
                    throw t
                }
                LOG.debug("Failed to load official lint model from $foundModelDir, falling back to clean AST", t)
                lintModelModule = null
                lintModelVariant = null
                minSdk = null
                targetSdk = null
                namespace = null
                isLibrary = false
                minSdkPremiseMissing = false
            }
        }

        var ast: CleanAstResult? = null
        if (lintModelModule == null) {
            val script = AndroidSources.gradleScript(project, moduleRootVf)
            if (script is KtFile) {
                ast = parseCleanAst(script)
            } else {
                val groovy = AndroidSources.groovyAst(project, moduleRootVf)
                if (groovy != null) {
                    ast = parseCleanAst(groovy)
                }
            }
            if (ast != null) {
                if (compileSdk == null && ast.compileSdk != null) {
                    compileSdk = ast.compileSdk
                    if (compileTarget == null) compileTarget = ast.compileTarget
                } else if (compileTarget == null && ast.compileTarget != null) {
                    compileTarget = ast.compileTarget
                }
                if (ast.minSdk != null) {
                    minSdk = ast.minSdk
                    minSdkPremiseMissing = false
                } else if (ast.minSdkUnsafe) {
                    minSdk = null
                    minSdkPremiseMissing = true
                }
                if (targetSdk == null && !ast.targetSdkUnsafe) targetSdk = ast.targetSdk
                if (namespace == null) namespace = ast.namespace
                if (ast.isLibrary != null) isLibrary = ast.isLibrary
            }

            val allowManifestFallback = (ast == null || !ast.minSdkUnsafe)
            val allowTargetManifestFallback = (ast == null || !ast.targetSdkUnsafe)
            val confirmedManifests = ArrayList<Path>()
            val layout = getLayout(androidModule)
            if (layout != null) {
                for (mf in layout.manifests) {
                    val norm = mf.toAbsolutePath().normalize()
                    AndroidSources.observeCompiledArchive(norm)
                    if (Files.isRegularFile(norm) && !confirmedManifests.contains(norm)) {
                        confirmedManifests.add(norm)
                    }
                }
            }
            if (variant != null) {
                val varMf = moduleRoot.resolve("src").resolve(variant).resolve("AndroidManifest.xml").normalize()
                if ((layout == null || layout.manifests.contains(varMf))
                    && Files.isRegularFile(varMf) && !confirmedManifests.contains(varMf)
                ) {
                    confirmedManifests.add(varMf)
                }
            }
            val mainMf = moduleRoot.resolve("src/main/AndroidManifest.xml").normalize()
            if ((layout == null || layout.manifests.contains(mainMf))
                && Files.isRegularFile(mainMf) && !confirmedManifests.contains(mainMf)
            ) {
                confirmedManifests.add(mainMf)
            }

            for (manifestPath in confirmedManifests) {
                if ((minSdk == null && allowManifestFallback) || (targetSdk == null && allowTargetManifestFallback) || namespace == null) {
                    val xmlFile: XmlFile? =
                        if (isXml && manifestPath == mainFile.toNioPath().toAbsolutePath().normalize()) {
                            AndroidSources.xml(project, manifestPath)
                        } else {
                            AndroidSources.diskXml(project, manifestPath)
                        }
                    val rootTag = xmlFile?.rootTag
                    if (rootTag != null) {
                        val usesSdk = rootTag.findFirstSubTag("uses-sdk")
                        if (usesSdk != null) {
                            if (minSdk == null && allowManifestFallback) {
                                var minAttr = usesSdk.getAttributeValue("minSdkVersion", AndroidContext.ANDROID_NS)
                                if (minAttr == null) minAttr = usesSdk.getAttributeValue("android:minSdkVersion")
                                if (minAttr != null && minAttr.matches(Regex("^\\d+$"))) {
                                    try {
                                        minSdk = minAttr.toInt()
                                        minSdkPremiseMissing = false
                                    } catch (_: NumberFormatException) {
                                        minSdk = null
                                        minSdkPremiseMissing = true
                                    }
                                }
                            }
                            if (targetSdk == null && allowTargetManifestFallback) {
                                var targetAttr =
                                    usesSdk.getAttributeValue("targetSdkVersion", AndroidContext.ANDROID_NS)
                                if (targetAttr == null) targetAttr =
                                    usesSdk.getAttributeValue("android:targetSdkVersion")
                                if (targetAttr != null && targetAttr.matches(Regex("^\\d+$"))) {
                                    try {
                                        targetSdk = targetAttr.toInt()
                                    } catch (_: NumberFormatException) {
                                        targetSdk = null
                                    }
                                }
                            }
                        }
                        if (namespace == null) {
                            val pkg = rootTag.getAttributeValue("package")
                            if (!pkg.isNullOrBlank()) namespace = pkg
                        }
                    }
                }
            }

            if (namespace == null) {
                namespace = AndroidContext.resolveNamespace(project, androidModule)
            }
            if (minSdk == null) {
                minSdkPremiseMissing = true
            }
        }

        if (compileTarget == null && compileSdk != null) {
            compileTarget = "android-$compileSdk"
        }

        val configFiles = AndroidLintClient.configurationFiles(projectRoot, moduleRoot)
        val lintXmlFingerprint = computeLintXmlFingerprint(configFiles)

        val trackedXmls = ArrayList<Path>(candidateXmls)
        for (f in modelXmlFiles) {
            if (!trackedXmls.contains(f)) trackedXmls.add(f)
        }

        val fingerprint = computeModelFingerprint(
            module.name,
            androidModule.name,
            moduleRoot.toString(),
            projectRoot.toString(),
            variant,
            compileSdk,
            compileTarget,
            minSdk,
            targetSdk,
            namespace,
            isLibrary,
            minSdkPremiseMissing,
            lintModelModule != null,
            trackedXmls
        )

        val xmlInputs = resolveXmlInputs(
            project,
            androidModule,
            moduleRoot,
            variant,
            lintModelVariant,
            minSdk,
            namespace,
            minSdkPremiseMissing,
            ast != null && ast.minSdkUnsafe
        )

        val combinedFingerprint = "$fingerprint:${xmlInputs.fingerprint}"

        return AndroidLintModel(
            module,
            androidModule,
            moduleRoot,
            projectRoot,
            variant,
            sdkHome,
            compileSdk,
            compileTarget,
            minSdk,
            targetSdk,
            namespace,
            isLibrary,
            minSdkPremiseMissing,
            lintModelModule,
            lintModelVariant,
            ruleJars,
            ruleJarFingerprints,
            combinedFingerprint,
            lintXmlFingerprint,
            xmlInputs
        )
    }

    @JvmStatic
    fun parseCleanAst(ktFile: KtFile?): CleanAstResult {
        if (ktFile == null) {
            return CleanAstResult(null, null, null, null, null, null, true, true, true, true)
        }

        val isApp = detectAppPlugin(ktFile)
        val isLibrary = isApp?.not()

        val androidBlocks = ArrayList<KtCallExpression>()
        for (rawStmt in topLevelStatements(ktFile)) {
            val stmt = unwrap(rawStmt)
            if (stmt is KtCallExpression && name(stmt) == "android" && body(stmt) != null) {
                androidBlocks.add(stmt)
            }
        }

        if (androidBlocks.isEmpty()) {
            return CleanAstResult(null, null, null, null, null, isLibrary, true, false, false, false)
        }

        var hasProductFlavors = false
        var buildTypesOverridesMinSdk = false

        for (block in androidBlocks) {
            val body = body(block) ?: continue
            for (rawStmt in body.statements) {
                val stmt = unwrap(rawStmt)
                if (stmt is KtCallExpression) {
                    val cName = name(stmt)
                    if (cName == "productFlavors" && body(stmt) != null) {
                        hasProductFlavors = true
                    } else if (cName == "buildTypes" && body(stmt) != null) {
                        val btBody = body(stmt)
                        if (btBody != null) {
                            for (elem in PsiTreeUtil.collectElements(btBody) { true }) {
                                val text = elem.text
                                if (text == "minSdk" || text == "minSdkVersion" || text == "minSdkPreview") {
                                    buildTypesOverridesMinSdk = true
                                    break
                                }
                            }
                        }
                    }
                }
            }
        }

        var compileSdk: Int? = null
        var compileTarget: String? = null
        var compileSdkDynamic = false
        var namespace: String? = null

        for (block in androidBlocks) {
            val body = body(block) ?: continue
            for (rawStatement in body.statements) {
                ProgressManager.checkCanceled()
                val statement = unwrap(rawStatement)
                if (statement is KtBinaryExpression && statement.operationReference.text == "=") {
                    val left = statement.left?.text ?: ""
                    if (left == "compileSdk" || left == "compileSdkVersion") {
                        val v = parseDecimalInteger(statement.right)
                        if (v != null && !compileSdkDynamic) {
                            compileSdk = v
                            compileTarget = "android-$v"
                        } else {
                            compileSdkDynamic = true
                            compileSdk = null
                            compileTarget = null
                        }
                    } else if (left == "compileSdkPreview") {
                        val preview = literal(statement.right)
                        if (!preview.isNullOrBlank() && !compileSdkDynamic) {
                            compileTarget = "android-$preview"
                            compileSdk = null
                        } else {
                            compileSdkDynamic = true
                            compileSdk = null
                            compileTarget = null
                        }
                    } else if (left == "namespace") {
                        val v = literal(statement.right)
                        namespace = if (!v.isNullOrBlank()) v else null
                    }
                } else if (statement is KtCallExpression) {
                    val cName = name(statement)
                    if (cName == "compileSdk" || cName == "compileSdkVersion") {
                        if (statement.valueArguments.size == 1) {
                            val v = parseDecimalInteger(statement.valueArguments[0].getArgumentExpression())
                            if (v != null && !compileSdkDynamic) {
                                compileSdk = v
                                compileTarget = "android-$v"
                            } else {
                                compileSdkDynamic = true
                                compileSdk = null
                                compileTarget = null
                            }
                        } else {
                            val csBody = body(statement)
                            if (csBody != null) {
                                var v: Int? = null
                                for (inner in PsiTreeUtil.collectElementsOfType(csBody, KtCallExpression::class.java)) {
                                    if (name(inner) == "release" && inner.valueArguments.size == 1) {
                                        v = parseDecimalInteger(inner.valueArguments[0].getArgumentExpression())
                                    }
                                }
                                if (v != null && !compileSdkDynamic) {
                                    compileSdk = v
                                    compileTarget = "android-$v"
                                } else {
                                    compileSdkDynamic = true
                                    compileSdk = null
                                    compileTarget = null
                                }
                            } else {
                                compileSdkDynamic = true
                                compileSdk = null
                                compileTarget = null
                            }
                        }
                    } else if (cName == "compileSdkPreview") {
                        if (statement.valueArguments.size == 1) {
                            val preview = literal(statement.valueArguments[0].getArgumentExpression())
                            if (!preview.isNullOrBlank() && !compileSdkDynamic) {
                                compileTarget = "android-$preview"
                                compileSdk = null
                            } else {
                                compileSdkDynamic = true
                                compileSdk = null
                                compileTarget = null
                            }
                        } else {
                            compileSdkDynamic = true
                            compileSdk = null
                            compileTarget = null
                        }
                    } else if (cName == "namespace") {
                        if (statement.valueArguments.size == 1) {
                            val v = literal(statement.valueArguments[0].getArgumentExpression())
                            namespace = if (!v.isNullOrBlank()) v else null
                        }
                    }
                }
            }
        }

        var minSdk: Int? = null
        var targetSdk: Int? = null
        var minSdkFound = false
        var minSdkDynamic = false
        var targetSdkDynamic = false

        for (block in androidBlocks) {
            val body = body(block) ?: continue
            for (rawStmt in body.statements) {
                val stmt = unwrap(rawStmt)
                if (stmt is KtCallExpression && name(stmt) == "defaultConfig" && body(stmt) != null) {
                    val dfBody = body(stmt) ?: continue
                    for (rawDfStatement in dfBody.statements) {
                        ProgressManager.checkCanceled()
                        val dfStatement = unwrap(rawDfStatement)
                        if (dfStatement is KtBinaryExpression && dfStatement.operationReference.text == "=") {
                            val left = dfStatement.left?.text ?: ""
                            if (left == "minSdk" || left == "minSdkVersion") {
                                minSdkFound = true
                                val v = parseDecimalInteger(dfStatement.right)
                                if (v != null && !minSdkDynamic) {
                                    minSdk = v
                                } else {
                                    minSdkDynamic = true
                                    minSdk = null
                                }
                            } else if (left == "minSdkPreview") {
                                minSdkDynamic = true
                                minSdk = null
                            } else if (left == "targetSdk" || left == "targetSdkVersion") {
                                val v = parseDecimalInteger(dfStatement.right)
                                if (v != null && !targetSdkDynamic) {
                                    targetSdk = v
                                } else {
                                    targetSdkDynamic = true
                                    targetSdk = null
                                }
                            } else if (left == "targetSdkPreview") {
                                targetSdkDynamic = true
                                targetSdk = null
                            }
                        } else if (dfStatement is KtCallExpression) {
                            val cName = name(dfStatement)
                            if (cName == "minSdk" || cName == "minSdkVersion") {
                                minSdkFound = true
                                if (dfStatement.valueArguments.size == 1) {
                                    val v = parseDecimalInteger(dfStatement.valueArguments[0].getArgumentExpression())
                                    if (v != null && !minSdkDynamic) {
                                        minSdk = v
                                    } else {
                                        minSdkDynamic = true
                                        minSdk = null
                                    }
                                } else {
                                    minSdkDynamic = true
                                    minSdk = null
                                }
                            } else if (cName == "minSdkPreview") {
                                minSdkDynamic = true
                                minSdk = null
                            } else if (cName == "targetSdk" || cName == "targetSdkVersion") {
                                if (dfStatement.valueArguments.size == 1) {
                                    val v = parseDecimalInteger(dfStatement.valueArguments[0].getArgumentExpression())
                                    if (v != null && !targetSdkDynamic) {
                                        targetSdk = v
                                    } else {
                                        targetSdkDynamic = true
                                        targetSdk = null
                                    }
                                } else {
                                    targetSdkDynamic = true
                                    targetSdk = null
                                }
                            } else if (cName == "targetSdkPreview") {
                                targetSdkDynamic = true
                                targetSdk = null
                            }
                        }
                    }
                }
            }
        }

        val minSdkUnsafe = hasProductFlavors || buildTypesOverridesMinSdk || minSdkDynamic
        if (minSdkUnsafe) minSdk = null
        val minSdkPremiseMissing = minSdkUnsafe || !minSdkFound || (minSdk == null)

        if (compileSdkDynamic) {
            compileSdk = null
            compileTarget = null
        }
        if (targetSdkDynamic) {
            targetSdk = null
        }

        return CleanAstResult(
            minSdk,
            targetSdk,
            compileSdk,
            compileTarget,
            namespace,
            isLibrary,
            minSdkPremiseMissing,
            minSdkUnsafe,
            targetSdkDynamic,
            compileSdkDynamic
        )
    }

    @JvmStatic
    fun parseCleanAst(moduleNode: ModuleNode?): CleanAstResult {
        val statementBlock = moduleNode?.statementBlock
            ?: return CleanAstResult(null, null, null, null, null, null, true, true, true, true)

        val isApp = detectGroovyAppPlugin(moduleNode)
        val isLibrary = isApp?.not()

        val androidBlocks = ArrayList<MethodCallExpression>()
        for (s in statementBlock.statements) {
            if (s is ExpressionStatement) {
                val es = s.expression
                if (es is MethodCallExpression && es.methodAsString == "android" && getGroovyClosure(es) != null) {
                    androidBlocks.add(es)
                }
            }
        }

        if (androidBlocks.isEmpty()) {
            return CleanAstResult(null, null, null, null, null, isLibrary, true, false, false, false)
        }

        var hasProductFlavors = false
        var buildTypesOverridesMinSdk = false

        for (block in androidBlocks) {
            val ce = getGroovyClosure(block) ?: continue
            val body = ce.code as? BlockStatement ?: continue
            for (stmt in body.statements) {
                if (stmt is ExpressionStatement) {
                    val call = stmt.expression as? MethodCallExpression ?: continue
                    val cName = call.methodAsString
                    if (cName == "productFlavors" && getGroovyClosure(call) != null) {
                        hasProductFlavors = true
                    } else if (cName == "buildTypes" && getGroovyClosure(call) != null) {
                        val btClosure = getGroovyClosure(call)
                        val btBody = btClosure?.code as? BlockStatement
                        if (btBody != null && containsMinSdkOverride(btBody)) {
                            buildTypesOverridesMinSdk = true
                        }
                    }
                }
            }
        }

        var compileSdk: Int? = null
        var compileTarget: String? = null
        var compileSdkDynamic = false
        var namespace: String? = null

        for (block in androidBlocks) {
            val ce = getGroovyClosure(block) ?: continue
            val body = ce.code as? BlockStatement ?: continue
            for (statement in body.statements) {
                ProgressManager.checkCanceled()
                if (statement is ExpressionStatement) {
                    val expr = statement.expression
                    if (expr is BinaryExpression && expr.operation.text == "=") {
                        val left = expr.leftExpression.text
                        if (left == "compileSdk" || left == "compileSdkVersion") {
                            val v = parseGroovyDecimalInteger(expr.rightExpression)
                            if (v != null && !compileSdkDynamic) {
                                compileSdk = v
                                compileTarget = "android-$v"
                            } else {
                                compileSdkDynamic = true
                                compileSdk = null
                                compileTarget = null
                            }
                        } else if (left == "compileSdkPreview") {
                            val preview = parseGroovyLiteral(expr.rightExpression)
                            if (!preview.isNullOrBlank() && !compileSdkDynamic) {
                                compileTarget = "android-$preview"
                                compileSdk = null
                            } else {
                                compileSdkDynamic = true
                                compileSdk = null
                                compileTarget = null
                            }
                        } else if (left == "namespace") {
                            val v = parseGroovyLiteral(expr.rightExpression)
                            namespace = if (!v.isNullOrBlank()) v else null
                        }
                    } else if (expr is MethodCallExpression) {
                        val cName = expr.methodAsString
                        if (cName == "compileSdk" || cName == "compileSdkVersion") {
                            val v = parseGroovyDecimalInteger(expr.arguments)
                            if (v != null && !compileSdkDynamic) {
                                compileSdk = v
                                compileTarget = "android-$v"
                            } else {
                                compileSdkDynamic = true
                                compileSdk = null
                                compileTarget = null
                            }
                        } else if (cName == "compileSdkPreview") {
                            val preview = parseGroovyLiteral(expr.arguments)
                            if (!preview.isNullOrBlank() && !compileSdkDynamic) {
                                compileTarget = "android-$preview"
                                compileSdk = null
                            } else {
                                compileSdkDynamic = true
                                compileSdk = null
                                compileTarget = null
                            }
                        } else if (cName == "namespace") {
                            val v = parseGroovyLiteral(expr.arguments)
                            namespace = if (!v.isNullOrBlank()) v else null
                        }
                    }
                }
            }
        }

        var minSdk: Int? = null
        var targetSdk: Int? = null
        var minSdkFound = false
        var minSdkDynamic = false
        var targetSdkDynamic = false

        for (block in androidBlocks) {
            val ce = getGroovyClosure(block) ?: continue
            val body = ce.code as? BlockStatement ?: continue
            for (stmt in body.statements) {
                if (stmt is ExpressionStatement) {
                    val call = stmt.expression as? MethodCallExpression ?: continue
                    if (call.methodAsString == "defaultConfig") {
                        val dfCe = getGroovyClosure(call) ?: continue
                        val dfBody = dfCe.code as? BlockStatement ?: continue
                        for (dfStatement in dfBody.statements) {
                            ProgressManager.checkCanceled()
                            if (dfStatement is ExpressionStatement) {
                                val expr = dfStatement.expression
                                if (expr is BinaryExpression && expr.operation.text == "=") {
                                    val left = expr.leftExpression.text
                                    if (left == "minSdk" || left == "minSdkVersion") {
                                        minSdkFound = true
                                        val v = parseGroovyDecimalInteger(expr.rightExpression)
                                        if (v != null && !minSdkDynamic) {
                                            minSdk = v
                                        } else {
                                            minSdkDynamic = true
                                            minSdk = null
                                        }
                                    } else if (left == "minSdkPreview") {
                                        minSdkDynamic = true
                                        minSdk = null
                                    } else if (left == "targetSdk" || left == "targetSdkVersion") {
                                        val v = parseGroovyDecimalInteger(expr.rightExpression)
                                        if (v != null && !targetSdkDynamic) {
                                            targetSdk = v
                                        } else {
                                            targetSdkDynamic = true
                                            targetSdk = null
                                        }
                                    } else if (left == "targetSdkPreview") {
                                        targetSdkDynamic = true
                                        targetSdk = null
                                    }
                                } else if (expr is MethodCallExpression) {
                                    val cName = expr.methodAsString
                                    if (cName == "minSdk" || cName == "minSdkVersion") {
                                        minSdkFound = true
                                        val v = parseGroovyDecimalInteger(expr.arguments)
                                        if (v != null && !minSdkDynamic) {
                                            minSdk = v
                                        } else {
                                            minSdkDynamic = true
                                            minSdk = null
                                        }
                                    } else if (cName == "minSdkPreview") {
                                        minSdkDynamic = true
                                        minSdk = null
                                    } else if (cName == "targetSdk" || cName == "targetSdkVersion") {
                                        val v = parseGroovyDecimalInteger(expr.arguments)
                                        if (v != null && !targetSdkDynamic) {
                                            targetSdk = v
                                        } else {
                                            targetSdkDynamic = true
                                            targetSdk = null
                                        }
                                    } else if (cName == "targetSdkPreview") {
                                        targetSdkDynamic = true
                                        targetSdk = null
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        val minSdkUnsafe = hasProductFlavors || buildTypesOverridesMinSdk || minSdkDynamic
        if (minSdkUnsafe) minSdk = null
        val minSdkPremiseMissing = minSdkUnsafe || !minSdkFound || (minSdk == null)

        if (compileSdkDynamic) {
            compileSdk = null
            compileTarget = null
        }
        if (targetSdkDynamic) {
            targetSdk = null
        }

        return CleanAstResult(
            minSdk,
            targetSdk,
            compileSdk,
            compileTarget,
            namespace,
            isLibrary,
            minSdkPremiseMissing,
            minSdkUnsafe,
            targetSdkDynamic,
            compileSdkDynamic
        )
    }

    @JvmStatic
    fun parseCleanGroovyAst(script: String?): CleanAstResult {
        if (script.isNullOrBlank()) {
            return CleanAstResult(null, null, null, null, null, null, true, true, true, true)
        }
        return try {
            val unit = SourceUnit.create("build.gradle", script)
            unit.parse()
            unit.completePhase()
            unit.convert()
            parseCleanAst(unit.ast)
        } catch (_: Throwable) {
            CleanAstResult(null, null, null, null, null, null, true, true, true, true)
        }
    }

    private fun detectGroovyAppPlugin(moduleNode: ModuleNode?): Boolean? {
        val statementBlock = moduleNode?.statementBlock ?: return null
        for (s in statementBlock.statements) {
            if (s is ExpressionStatement) {
                val expr = s.expression
                if (expr is MethodCallExpression && expr.methodAsString == "plugins") {
                    val ce = getGroovyClosure(expr)
                    val bs = ce?.code as? BlockStatement
                    if (bs != null) {
                        for (ps in bs.statements) {
                            if (ps is ExpressionStatement) {
                                val pmc = ps.expression as? MethodCallExpression ?: continue
                                val pName = pmc.methodAsString
                                if (pName == "id") {
                                    val id = parseGroovyLiteral(pmc.arguments)
                                    if (id == "com.android.application") return true
                                    if (id == "com.android.library") return false
                                } else if (pName == "alias") {
                                    val text = pmc.arguments.text
                                    if (text.endsWith(".android.application") || text == "libs.plugins.android.application") {
                                        return true
                                    }
                                    if (text.endsWith(".android.library") || text == "libs.plugins.android.library") {
                                        return false
                                    }
                                }
                            }
                        }
                    }
                } else if (expr is MethodCallExpression && expr.methodAsString == "apply") {
                    val args = expr.arguments
                    if (args is TupleExpression) {
                        for (arg in args.expressions) {
                            if (arg is NamedArgumentListExpression) {
                                for (entry in arg.mapEntryExpressions) {
                                    if ("plugin" == parseGroovyLiteral(entry.keyExpression)) {
                                        val v = parseGroovyLiteral(entry.valueExpression)
                                        if ("com.android.application" == v) return true
                                        if ("com.android.library" == v) return false
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        return null
    }

    private fun containsMinSdkOverride(block: BlockStatement): Boolean {
        var found = false
        block.visit(object : org.codehaus.groovy.ast.CodeVisitorSupport() {
            override fun visitMethodCallExpression(call: MethodCallExpression) {
                val m = call.methodAsString
                if (m == "minSdk" || m == "minSdkVersion" || m == "minSdkPreview") {
                    found = true
                }
                super.visitMethodCallExpression(call)
            }

            override fun visitBinaryExpression(expression: BinaryExpression) {
                if (expression.operation.text == "=") {
                    val left = expression.leftExpression.text
                    if (left == "minSdk" || left == "minSdkVersion" || left == "minSdkPreview") {
                        found = true
                    }
                }
                super.visitBinaryExpression(expression)
            }
        })
        return found
    }

    private fun getGroovyClosure(mc: MethodCallExpression): ClosureExpression? {
        val args = mc.arguments
        if (args is ArgumentListExpression) {
            for (e in args.expressions) {
                if (e is ClosureExpression) return e
            }
        }
        return null
    }

    private fun parseGroovyLiteral(expr: Expression?): String? {
        if (expr is ArgumentListExpression && expr.expressions.size == 1) {
            return parseGroovyLiteral(expr.expressions[0])
        }
        if (expr is ConstantExpression) {
            val v = expr.value
            if (v is String) return v
        }
        return null
    }

    private fun parseGroovyDecimalInteger(expr: Expression?): Int? {
        if (expr is ArgumentListExpression && expr.expressions.size == 1) {
            return parseGroovyDecimalInteger(expr.expressions[0])
        }
        if (expr is ConstantExpression) {
            val v = expr.value
            if (v is Int) return v
            if (v is Number) return v.toInt()
            if (v is String && v.matches(Regex("^\\d+$"))) {
                try {
                    return v.toInt()
                } catch (_: NumberFormatException) {
                }
            }
        }
        return null
    }

    private fun topLevelStatements(ktFile: KtFile): List<KtExpression> {
        val raw = ArrayList<KtExpression>()
        val script = ktFile.script
        if (script?.blockExpression != null) {
            raw.addAll(script.blockExpression.statements)
        } else {
            for (child in ktFile.children) {
                if (child is KtScript && child.blockExpression != null) {
                    raw.addAll(child.blockExpression.statements)
                } else if (child is KtExpression) {
                    raw.add(child)
                }
            }
        }
        val statements = ArrayList<KtExpression>()
        for (expr in raw) {
            val unwrapped = unwrap(expr)
            if (unwrapped != null) {
                statements.add(unwrapped)
            }
        }
        return statements
    }

    private fun unwrap(expr: KtExpression?): KtExpression? {
        if (expr is KtScriptInitializer) {
            return expr.body
        }
        if (expr is KtAnonymousInitializer) {
            return expr.body
        }
        return expr
    }

    private fun detectAppPlugin(ktFile: KtFile?): Boolean? {
        if (ktFile == null) return null
        for (rawStmt in topLevelStatements(ktFile)) {
            val stmt = unwrap(rawStmt)
            if (stmt is KtCallExpression && name(stmt) == "plugins") {
                val body = body(stmt)
                if (body != null) {
                    for (rawPStmt in body.statements) {
                        val pStmt = unwrap(rawPStmt)
                        if (pStmt is KtCallExpression) {
                            val pName = name(pStmt)
                            if (pName == "id" && pStmt.valueArguments.size == 1) {
                                val id = literal(pStmt.valueArguments[0].getArgumentExpression())
                                if ("com.android.application" == id) return true
                                if ("com.android.library" == id) return false
                            } else if (pName == "alias" && pStmt.valueArguments.size == 1) {
                                val arg = pStmt.valueArguments.first().getArgumentExpression()
                                if (arg != null) {
                                    val text = arg.text
                                    if (text == "libs.plugins.android.application" || text.endsWith(".android.application")) {
                                        return true
                                    }
                                    if (text == "libs.plugins.android.library" || text.endsWith(".android.library")) {
                                        return false
                                    }
                                }
                            }
                        }
                    }
                }
            } else if (stmt is KtCallExpression && name(stmt) == "apply") {
                for (arg in stmt.valueArguments) {
                    val argExpr = arg.getArgumentExpression()
                    if (argExpr != null) {
                        val lit = literal(argExpr)
                        if ("com.android.application" == lit) return true
                        if ("com.android.library" == lit) return false
                    }
                }
            }
        }
        return null
    }

    private fun isAndroidModule(module: Module?): Boolean {
        if (module == null || module.isDisposed) return false
        if (AndroidContext.isAndroidModule(module)) return true
        for (entry in ModuleRootManager.getInstance(module).orderEntries) {
            if (entry is LibraryOrderEntry && entry.library != null) {
                for (url in entry.library!!.getUrls(OrderRootType.CLASSES)) {
                    var path = VfsUtilCore.urlToPath(url)
                    val sep = path.indexOf("!/")
                    if (sep >= 0) path = path.substring(0, sep)
                    if (path.contains("platforms/android-") && (path.endsWith("/android.jar") || path.endsWith("\\android.jar") || path == "android.jar")) {
                        return true
                    }
                }
            }
        }
        return false
    }

    private fun isAppModule(project: Project, module: Module?): Boolean {
        if (module == null || module.isDisposed) return false
        val root = AndroidContext.findModuleRoot(module) ?: return false
        val script = AndroidSources.gradleScript(project, root)
        if (script is KtFile) {
            val isApp = detectAppPlugin(script)
            if (isApp != null) return isApp
        } else {
            val groovy = AndroidSources.groovyAst(project, root)
            if (groovy != null) {
                val isApp = detectGroovyAppPlugin(groovy)
                if (isApp != null) return isApp
            }
        }
        return false
    }

    private fun name(call: KtCallExpression): String {
        return call.calleeExpression?.text?.trim() ?: ""
    }

    private fun body(call: KtCallExpression): KtBlockExpression? {
        val arguments = call.lambdaArguments
        if (arguments.isNotEmpty()) {
            val lambda = arguments[0].getLambdaExpression()
            return lambda?.bodyExpression
        }
        for (arg in call.valueArguments) {
            val expr = arg.getArgumentExpression()
            if (expr is KtLambdaExpression) {
                return expr.bodyExpression
            }
        }
        return null
    }

    private fun parseDecimalInteger(expr: KtExpression?): Int? {
        if (expr !is KtConstantExpression) return null
        val text = expr.text
        if (text != null && text.matches(Regex("^\\d+$"))) {
            try {
                return text.toInt()
            } catch (_: NumberFormatException) {
            }
        }
        return null
    }

    private fun literal(expression: KtExpression?): String? {
        if (expression !is KtStringTemplateExpression || expression.hasInterpolation()) return null
        val value = StringBuilder()
        for (entry in expression.entries) {
            if (entry is KtEscapeStringTemplateEntry) {
                value.append(entry.unescapedValue)
            } else {
                value.append(entry.text)
            }
        }
        return value.toString()
    }

    private fun computeLintXmlFingerprint(configFiles: List<Path>?): String {
        if (configFiles.isNullOrEmpty()) return "absent"
        var anyPresent = false
        val sb = StringBuilder()
        for (p in configFiles) {
            val norm = p.toAbsolutePath().normalize()
            val text = AndroidSources.text(norm)
            sb.append(norm).append(':')
            if (text != null) {
                anyPresent = true
                sb.append(sha256(text))
            } else {
                sb.append("absent")
            }
            sb.append(';')
        }
        if (!anyPresent) return "absent"
        return sha256(sb.toString())
    }

    private fun computeModelFingerprint(
        moduleName: String,
        androidModuleName: String,
        moduleRoot: String,
        projectRoot: String,
        variant: String?,
        compileSdk: Int?,
        compileTarget: String?,
        minSdk: Int?,
        targetSdk: Int?,
        namespace: String?,
        isLibrary: Boolean,
        minSdkPremiseMissing: Boolean,
        isBuilt: Boolean,
        trackedXmls: List<Path>
    ): String {
        val sb = StringBuilder()
        sb.append(moduleName).append(';')
            .append(androidModuleName).append(';')
            .append(moduleRoot).append(';')
            .append(projectRoot).append(';')
            .append(variant).append(';')
            .append(compileSdk).append(';')
            .append(compileTarget).append(';')
            .append(minSdk).append(';')
            .append(targetSdk).append(';')
            .append(namespace).append(';')
            .append(isLibrary).append(';')
            .append(minSdkPremiseMissing).append(';')
            .append(if (isBuilt) "built" else "clean")
        for (p in trackedXmls) {
            if (Files.isRegularFile(p)) {
                try {
                    sb.append(';').append(p).append(":size=").append(Files.size(p))
                        .append(":mtime=").append(Files.getLastModifiedTime(p).toMillis())
                        .append(":content=").append(sha256(Files.readString(p)))
                } catch (_: IOException) {
                    sb.append(';').append(p).append(":read_error")
                }
            } else {
                sb.append(';').append(p).append(":absent")
            }
        }
        return sha256(sb.toString())
    }

    private fun sha256(text: String?): String {
        if (text == null) return "null"
        try {
            val md = MessageDigest.getInstance("SHA-256")
            val bytes = md.digest(text.toByteArray(StandardCharsets.UTF_8))
            val sb = StringBuilder(bytes.size * 2)
            for (b in bytes) {
                val byteVal = b.toInt() and 0xFF
                sb.append(Character.forDigit((byteVal ushr 4) and 0xF, 16))
                sb.append(Character.forDigit(byteVal and 0xF, 16))
            }
            return sb.toString()
        } catch (e: NoSuchAlgorithmException) {
            throw RuntimeException(e)
        }
    }

    private fun resolveXmlInputs(
        project: Project,
        androidModule: Module,
        moduleRoot: Path,
        variant: String?,
        lintModelVariant: LintModelVariant?,
        minSdk: Int?,
        namespace: String?,
        minSdkPremiseMissing: Boolean,
        minSdkUnsafe: Boolean
    ): AndroidLintResources.Inputs {
        val resourceRoots = ArrayList<Path>()
        val manifests = ArrayList<Path>()
        var reliableMerged: Path? = null
        var reliableBlame: Path? = null

        if (lintModelVariant != null) {
            for (provider in lintModelVariant.sourceProviders) {
                for (res in provider.resDirectories) {
                    val resPath = res.toPath().toAbsolutePath().normalize()
                    if (!resourceRoots.contains(resPath)) {
                        resourceRoots.add(resPath)
                    }
                }
                for (mf in provider.manifestFiles) {
                    val mfPath = mf.toPath().toAbsolutePath().normalize()
                    if (!manifests.contains(mfPath)) {
                        manifests.add(mfPath)
                    }
                }
            }

            val merged = lintModelVariant.mergedManifest
            val blame = lintModelVariant.manifestMergeReport
            if (merged != null && merged.isFile) {
                val mergedPath = merged.toPath().toAbsolutePath().normalize()
                var reliable = true
                try {
                    val mergedTime = Files.getLastModifiedTime(mergedPath)
                    for (mf in manifests) {
                        if (Files.isRegularFile(mf)) {
                            if (Files.getLastModifiedTime(mf) > mergedTime) {
                                reliable = false
                                break
                            }
                        }
                    }
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {
                    reliable = false
                }
                if (reliable) {
                    reliableMerged = mergedPath
                    if (blame != null && blame.isFile) {
                        reliableBlame = blame.toPath().toAbsolutePath().normalize()
                    }
                }
            }
        } else {
            var layout: AndroidLayout? = null
            try {
                layout = getLayout(androidModule)
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
            }

            if (layout != null) {
                for (res in layout.resources) {
                    val norm = res.toAbsolutePath().normalize()
                    if (Files.isDirectory(norm) && !resourceRoots.contains(norm)) {
                        resourceRoots.add(norm)
                    }
                }
                for (mf in layout.manifests) {
                    val norm = mf.toAbsolutePath().normalize()
                    AndroidSources.observeCompiledArchive(norm)
                    if (Files.isRegularFile(norm) && !manifests.contains(norm)) {
                        manifests.add(norm)
                    }
                }
            }

            if (variant != null) {
                val varRes = moduleRoot.resolve("src").resolve(variant).resolve("res").normalize()
                if ((layout == null || layout.resources.contains(varRes))
                    && Files.isDirectory(varRes) && !resourceRoots.contains(varRes)
                ) {
                    resourceRoots.add(varRes)
                }
                val varMf = moduleRoot.resolve("src").resolve(variant).resolve("AndroidManifest.xml").normalize()
                if ((layout == null || layout.manifests.contains(varMf))
                    && Files.isRegularFile(varMf) && !manifests.contains(varMf)
                ) {
                    manifests.add(varMf)
                }
            }
            val mainRes = moduleRoot.resolve("src/main/res").normalize()
            if ((layout == null || layout.resources.contains(mainRes))
                && Files.isDirectory(mainRes) && !resourceRoots.contains(mainRes)
            ) {
                resourceRoots.add(mainRes)
            }
            val mainMf = moduleRoot.resolve("src/main/AndroidManifest.xml").normalize()
            if ((layout == null || layout.manifests.contains(mainMf))
                && Files.isRegularFile(mainMf) && !manifests.contains(mainMf)
            ) {
                manifests.add(mainMf)
            }
        }

        val complete = (namespace != null && resourceRoots.isNotEmpty())
        val fingerprint = computeXmlInputsFingerprint(
            moduleRoot,
            variant,
            androidModule,
            lintModelVariant,
            resourceRoots,
            manifests,
            reliableMerged,
            reliableBlame,
            complete
        )

        return AndroidLintResources.Inputs(
            resourceRoots,
            manifests,
            reliableMerged,
            reliableBlame,
            fingerprint,
            complete
        )
    }

    private fun hashResourceDirectory(md: MessageDigest, resDir: Path?) {
        if (resDir == null) return
        val norm = resDir.toAbsolutePath().normalize()
        md.update(norm.toString().toByteArray(StandardCharsets.UTF_8))
        if (Files.isDirectory(norm)) {
            AndroidSources.trackDirectory(norm)
            try {
                Files.list(norm).use { stream ->
                    val subfolders = stream.filter { Files.isDirectory(it) }.sorted().toList()
                    for (subfolder in subfolders) {
                        ProgressManager.checkCanceled()
                        AndroidSources.trackDirectory(subfolder)
                        md.update(subfolder.fileName.toString().toByteArray(StandardCharsets.UTF_8))
                        Files.list(subfolder).use { fileStream ->
                            val files = fileStream.filter { Files.isRegularFile(it) }.sorted().toList()
                            for (file in files) {
                                ProgressManager.checkCanceled()
                                AndroidSources.observeCompiledArchive(file)
                                md.update(file.fileName.toString().toByteArray(StandardCharsets.UTF_8))
                                if (file.toString().endsWith(".xml")) {
                                    val text = AndroidSources.text(file)
                                    if (text != null) {
                                        md.update(text.toByteArray(StandardCharsets.UTF_8))
                                    } else {
                                        md.update(Files.size(file).toString().toByteArray(StandardCharsets.UTF_8))
                                        md.update(
                                            Files.getLastModifiedTime(file).toMillis().toString()
                                                .toByteArray(StandardCharsets.UTF_8)
                                        )
                                    }
                                } else {
                                    md.update(Files.size(file).toString().toByteArray(StandardCharsets.UTF_8))
                                    md.update(
                                        Files.getLastModifiedTime(file).toMillis().toString()
                                            .toByteArray(StandardCharsets.UTF_8)
                                    )
                                }
                            }
                        }
                    }
                }
            } catch (_: IOException) {
            }
        } else {
            AndroidSources.observeCompiledArchive(norm)
        }
    }

    private fun hashManifestArtifact(digest: MessageDigest, path: Path) {
        ProgressManager.checkCanceled()
        digest.update(path.toString().toByteArray(StandardCharsets.UTF_8))
        val text = AndroidSources.text(path)
        digest.update(if (text == null) 0.toByte() else 1.toByte())
        if (text != null) {
            digest.update(text.toByteArray(StandardCharsets.UTF_8))
            digest.update(Files.getLastModifiedTime(path).toString().toByteArray(StandardCharsets.UTF_8))
        }
    }

    private fun computeXmlInputsFingerprint(
        moduleRoot: Path,
        variant: String?,
        androidModule: Module?,
        lintModelVariant: LintModelVariant?,
        resourceRoots: List<Path>,
        manifests: List<Path>,
        mergedManifest: Path?,
        manifestMergeReport: Path?,
        complete: Boolean
    ): String {
        try {
            val md = MessageDigest.getInstance("SHA-256")
            md.update(complete.toString().toByteArray(StandardCharsets.UTF_8))

            for (root in resourceRoots) {
                ProgressManager.checkCanceled()
                hashResourceDirectory(md, root)
            }

            for (manifest in manifests) {
                ProgressManager.checkCanceled()
                md.update(manifest.toString().toByteArray(StandardCharsets.UTF_8))
                AndroidSources.observeCompiledArchive(manifest)
                val text = AndroidSources.text(manifest)
                if (text != null) {
                    md.update(text.toByteArray(StandardCharsets.UTF_8))
                } else if (Files.isRegularFile(manifest)) {
                    md.update(Files.size(manifest).toString().toByteArray(StandardCharsets.UTF_8))
                    md.update(
                        Files.getLastModifiedTime(manifest).toMillis().toString().toByteArray(StandardCharsets.UTF_8)
                    )
                }
            }

            if (mergedManifest != null) hashManifestArtifact(md, mergedManifest)
            if (manifestMergeReport != null) hashManifestArtifact(md, manifestMergeReport)
            for (path in AndroidLintManifest.mergedManifestCandidates(moduleRoot, variant)) {
                if (path != mergedManifest) hashManifestArtifact(md, path)
            }
            for (path in AndroidLintManifest.mergerReportCandidates(moduleRoot, variant)) {
                if (path != manifestMergeReport) hashManifestArtifact(md, path)
            }

            val artifact = lintModelVariant?.artifact
            if (artifact?.dependencies != null) {
                for (lib in artifact.dependencies.getAll()) {
                    ProgressManager.checkCanceled()
                    md.update(lib.identifier.toByteArray(StandardCharsets.UTF_8))
                    if (lib is LintModelAndroidLibrary) {
                        val res = lib.resFolder
                        if (res != null && res.isDirectory) {
                            hashResourceDirectory(md, res.toPath())
                        }
                        val sym = lib.symbolFile
                        if (sym != null && sym.isFile) {
                            val symP = sym.toPath().toAbsolutePath().normalize()
                            AndroidSources.observeCompiledArchive(symP)
                            md.update(symP.toString().toByteArray(StandardCharsets.UTF_8))
                            md.update(Files.size(symP).toString().toByteArray(StandardCharsets.UTF_8))
                            md.update(
                                Files.getLastModifiedTime(symP).toMillis().toString()
                                    .toByteArray(StandardCharsets.UTF_8)
                            )
                        }
                        val pub = lib.publicResources
                        if (pub != null && pub.isFile) {
                            val pubP = pub.toPath().toAbsolutePath().normalize()
                            AndroidSources.observeCompiledArchive(pubP)
                            md.update(pubP.toString().toByteArray(StandardCharsets.UTF_8))
                            md.update(Files.size(pubP).toString().toByteArray(StandardCharsets.UTF_8))
                            md.update(
                                Files.getLastModifiedTime(pubP).toMillis().toString()
                                    .toByteArray(StandardCharsets.UTF_8)
                            )
                        }
                    }
                }
            } else if (androidModule != null && !androidModule.isDisposed) {
                val visited = LinkedHashSet<Module>()
                val queue: Queue<Module> = ArrayDeque()
                queue.add(androidModule)
                visited.add(androidModule)

                while (!queue.isEmpty()) {
                    val current = queue.poll()
                    for (entry in ModuleRootManager.getInstance(current).orderEntries) {
                        ProgressManager.checkCanceled()
                        if (entry is ModuleOrderEntry) {
                            val depMod = entry.module
                            if (depMod == null || depMod.isDisposed || !visited.add(depMod)) continue
                            queue.add(depMod)

                            val depRootVf = AndroidContext.findModuleRoot(depMod) ?: continue
                            val depRoot = Path.of(depRootVf.path).toAbsolutePath().normalize()
                            md.update(depMod.name.toByteArray(StandardCharsets.UTF_8))
                            md.update(depRoot.toString().toByteArray(StandardCharsets.UTF_8))

                            val depRoots = ArrayList<Path>()
                            val depLayout = getLayout(depMod)
                            if (depLayout != null) {
                                for (r in depLayout.resources) {
                                    val norm = r.toAbsolutePath().normalize()
                                    if (Files.isDirectory(norm) && !depRoots.contains(norm)) {
                                        depRoots.add(norm)
                                    }
                                }
                            }
                            val depVariant = AndroidContext.resolveVariant(depMod, depRootVf)
                            if (depVariant != null) {
                                val varRes = depRoot.resolve("src").resolve(depVariant).resolve("res").normalize()
                                if (Files.isDirectory(varRes) && !depRoots.contains(varRes)) {
                                    depRoots.add(varRes)
                                }
                            }
                            val mainRes = depRoot.resolve("src/main/res").normalize()
                            if (Files.isDirectory(mainRes) && !depRoots.contains(mainRes)) {
                                depRoots.add(mainRes)
                            }

                            for (depRes in depRoots) {
                                hashResourceDirectory(md, depRes)
                            }
                        } else if (entry is LibraryOrderEntry && entry.library != null) {
                            val libName = entry.libraryName
                            if (libName != null) md.update(libName.toByteArray(StandardCharsets.UTF_8))
                            for (url in entry.library!!.getUrls(OrderRootType.CLASSES)) {
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
                                    if (Files.isDirectory(resDir)) {
                                        hashResourceDirectory(md, resDir)
                                    }
                                    if (Files.isRegularFile(rTxt)) {
                                        AndroidSources.observeCompiledArchive(rTxt)
                                        md.update(rTxt.toString().toByteArray(StandardCharsets.UTF_8))
                                        md.update(Files.size(rTxt).toString().toByteArray(StandardCharsets.UTF_8))
                                        md.update(
                                            Files.getLastModifiedTime(rTxt).toMillis().toString()
                                                .toByteArray(StandardCharsets.UTF_8)
                                        )
                                    }
                                    if (Files.isRegularFile(pubTxt)) {
                                        AndroidSources.observeCompiledArchive(pubTxt)
                                        md.update(pubTxt.toString().toByteArray(StandardCharsets.UTF_8))
                                        md.update(Files.size(pubTxt).toString().toByteArray(StandardCharsets.UTF_8))
                                        md.update(
                                            Files.getLastModifiedTime(pubTxt).toMillis().toString()
                                                .toByteArray(StandardCharsets.UTF_8)
                                        )
                                    }
                                } catch (_: java.nio.file.InvalidPathException) {
                                }
                            }
                        }
                    }
                }
            }

            val digest = md.digest()
            val sb = StringBuilder(digest.size * 2)
            for (b in digest) {
                sb.append(String.format("%02x", b))
            }
            return sb.toString()
        } catch (e: CancellationException) {
            throw e
        } catch (e: NoSuchAlgorithmException) {
            throw AndroidQueryException.modelUnavailable("Cannot fingerprint XML inputs: ${e.message}")
        } catch (e: IOException) {
            throw AndroidQueryException.modelUnavailable("Cannot fingerprint XML inputs: ${e.message}")
        }
    }

    private fun hasRClasspath(module: Module?, moduleRoot: Path?): Boolean {
        if (module == null || module.isDisposed || moduleRoot == null) return false
        val directory = moduleRoot.resolve("build/intermediates")
        val rClassDirs = setOf(
            "compile_and_runtime_r_class_jar",
            "compile_r_class_jar",
            "compile_and_runtime_not_namespaced_r_class_jar"
        )
        for (entry in ModuleRootManager.getInstance(module).orderEntries) {
            if (entry !is LibraryOrderEntry || entry.library == null) continue
            for (url in entry.library!!.getUrls(OrderRootType.CLASSES)) {
                var path = VfsUtilCore.urlToPath(url)
                val sep = path.indexOf("!/")
                if (sep >= 0) path = path.substring(0, sep)
                try {
                    val file = Path.of(path).toAbsolutePath().normalize()
                    if (!file.startsWith(directory)) continue
                    val relative = directory.relativize(file)
                    if (relative.nameCount >= 3 && rClassDirs.contains(relative.getName(0).toString())) {
                        return true
                    }
                } catch (_: java.nio.file.InvalidPathException) {
                }
            }
        }
        return false
    }

    private fun getLayout(module: Module?): AndroidLayout? {
        if (module == null || module.isDisposed) return null
        val layouts = AndroidSources.scope().layouts
        layouts[module]?.let { return it }
        val root = AndroidContext.findModuleRoot(module) ?: return null
        val sources = LinkedHashSet<String>()
        val sourceRoot = Path.of(root.path).toAbsolutePath().normalize().resolve("src")
        for (url in ModuleRootManager.getInstance(module).sourceRootUrls) {
            val path = Path.of(VfsUtilCore.urlToPath(url)).toAbsolutePath().normalize()
            if (path.startsWith(sourceRoot) && path.nameCount > sourceRoot.nameCount) {
                sources.add(sourceRoot.relativize(path).getName(0).toString())
            }
        }
        val layout = AndroidLayout(module.project, root, AndroidContext.resolveVariant(module, root), sources)
        layouts[module] = layout
        return layout
    }
}
