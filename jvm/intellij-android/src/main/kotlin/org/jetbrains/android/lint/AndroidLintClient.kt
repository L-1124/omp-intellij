package org.jetbrains.android.lint

import com.android.ide.common.resources.ResourceRepository
import com.android.tools.lint.client.api.CompositeIssueRegistry
import com.android.tools.lint.client.api.Configuration
import com.android.tools.lint.client.api.ConfigurationHierarchy
import com.android.tools.lint.client.api.GradleVisitor
import com.android.tools.lint.client.api.IssueRegistry
import com.android.tools.lint.client.api.JarFileIssueRegistry
import com.android.tools.lint.client.api.LintBaseline
import com.android.tools.lint.client.api.LintClient
import com.android.tools.lint.client.api.LintDriver
import com.android.tools.lint.client.api.LintOptionsConfiguration
import com.android.tools.lint.client.api.LintRequest
import com.android.tools.lint.client.api.LintXmlConfiguration
import com.android.tools.lint.client.api.ResourceRepositoryScope
import com.android.tools.lint.client.api.UastGradleVisitor
import com.android.tools.lint.client.api.UastParser
import com.android.tools.lint.client.api.Vendor
import com.android.tools.lint.client.api.XmlParser
import com.android.tools.lint.detector.api.Context
import com.android.tools.lint.detector.api.DefaultPosition
import com.android.tools.lint.detector.api.Desugaring
import com.android.tools.lint.detector.api.GradleContext
import com.android.tools.lint.detector.api.GradleScanner
import com.android.tools.lint.detector.api.Incident
import com.android.tools.lint.detector.api.Issue
import com.android.tools.lint.detector.api.JavaContext
import com.android.tools.lint.detector.api.Location
import com.android.tools.lint.detector.api.Option
import com.android.tools.lint.detector.api.PartialResult
import com.android.tools.lint.detector.api.Platform
import com.android.tools.lint.detector.api.Scope
import com.android.tools.lint.detector.api.Severity
import com.android.tools.lint.detector.api.TextFormat
import com.android.tools.lint.helpers.DefaultJavaEvaluator
import com.android.tools.lint.helpers.DefaultUastParser
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.module.Module
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.roots.LanguageLevelModuleExtension
import com.intellij.openapi.roots.LanguageLevelProjectExtension
import com.intellij.openapi.roots.ModuleRootManager
import com.intellij.pom.java.LanguageLevel
import com.intellij.psi.JavaDirectoryService
import com.intellij.psi.JavaPsiFacade
import com.intellij.psi.PsiClass
import com.intellij.psi.PsiElement
import com.intellij.psi.PsiFile
import com.intellij.psi.PsiPackage
import com.intellij.util.lang.UrlClassLoader
import org.codehaus.groovy.ast.ASTNode
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
import org.jetbrains.android.context.AndroidQueryException
import org.jetbrains.android.resource.AndroidSources
import org.jetbrains.kotlin.config.ApiVersion
import org.jetbrains.kotlin.config.KotlinFacetSettingsProvider
import org.jetbrains.kotlin.config.LanguageVersionSettings
import org.jetbrains.kotlin.config.LanguageVersionSettingsImpl
import java.io.File
import java.io.IOException
import java.net.URL
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.nio.file.attribute.BasicFileAttributes
import java.nio.file.attribute.FileTime
import java.security.MessageDigest
import java.util.Collections
import java.util.EnumSet
import java.util.HexFormat
import java.util.LinkedHashMap
import java.util.LinkedHashSet
import java.util.UUID
import java.util.WeakHashMap
import java.util.concurrent.CancellationException

open class AndroidLintClient(
    private val model: AndroidLintModel?,
    private val mainFile: PsiFile?,
    private val contents: String?,
    private val scope: Scope?,
    selectedIssueIds: Set<String>?
) : LintClient(CLIENT_STUDIO) {

    private val selectedIssueIds: Set<String>? = selectedIssueIds?.let { java.util.Set.copyOf(it) }
    private val ideaProject: Project? = mainFile?.project ?: model?.module?.takeIf { !it.isDisposed }?.project
    private val ideaModule: Module? = model?.module
    private val mainFilePath: Path? = mainFile?.virtualFile?.toNioPath()?.toAbsolutePath()?.normalize()
    override val xmlParser: XmlParser = AndroidLintXmlParser(this)
    private var manifest: AndroidLintManifest? = null
    private var analysisComplete: Boolean = false
    private var xmlParsingFailed: Boolean = false
    private val collectedIncidents: MutableList<Incident> = ArrayList()
    private val partialResults: MutableMap<Issue, PartialResult> = LinkedHashMap()
    private var cachedAarRegistries: List<JarFileIssueRegistry>? = null
    private var cachedAarLoadFailed: Boolean = false
    private var issueEnumerationComplete: Boolean = false
    private var issueEnumerationFailed: Boolean = false
    private var activeBaseline: LintBaseline? = null

    @Volatile
    private var lastDetectorFailure: Throwable? = null

    init {
        val root = model?.projectRoot
        if (root != null) {
            configurations.rootDir = root.toFile()
        }
        if (this.selectedIssueIds != null) {
            configurations.overrides = SelectionOverrideConfiguration(configurations, this.selectedIssueIds)
        }
    }

    override fun readFile(file: File): CharSequence {
        ProgressManager.checkCanceled()
        val filePath = file.toPath().toAbsolutePath().normalize()
        if (mainFilePath != null && filePath == mainFilePath) {
            return contents ?: ""
        }
        val text = AndroidSources.text(filePath)
        return text ?: ""
    }

    override fun getUastParser(project: com.android.tools.lint.detector.api.Project?): UastParser {
        val proj =
            ideaProject ?: mainFile?.project ?: model?.module?.project ?: error("UAST parser requires an IDEA project")
        return AndroidUastParser(project, proj, mainFile, mainFilePath)
    }

    override fun getXmlDocument(file: File, contents: CharSequence?): org.w3c.dom.Document? {
        ProgressManager.checkCanceled()
        return xmlParser.parseXml(contents ?: readFile(file), file)
    }

    private fun manifest(): AndroidLintManifest {
        var m = manifest
        if (m == null) {
            m = AndroidLintManifest(model, ideaProject, this)
            manifest = m
        }
        return m
    }

    override fun getMergedManifest(project: com.android.tools.lint.detector.api.Project): org.w3c.dom.Document? {
        val target = if (scope == Scope.MANIFEST && mainFilePath != null) mainFilePath.toFile() else null
        return manifest().getMergedManifest(
            project,
            target,
            if (target == null) null else getXmlDocument(target, contents)
        )
    }

    override fun resolveMergeManifestSources(mergedManifest: org.w3c.dom.Document, reportFile: Any) {
        manifest().resolveMergeManifestSources(mergedManifest, reportFile)
    }

    override fun findManifestSourceNode(mergedNode: org.w3c.dom.Node): com.android.utils.Pair<File, out org.w3c.dom.Node>? {
        return manifest().findManifestSourceNode(mergedNode)
    }

    override fun findManifestSourceLocation(mergedNode: org.w3c.dom.Node): Location? {
        return manifest().findManifestSourceLocation(mergedNode)
    }

    fun xmlSource(file: File): PsiFile? {
        val path = file.toPath().toAbsolutePath().normalize()
        if (path == mainFilePath) return mainFile
        val proj = ideaProject ?: return null
        return AndroidSources.diskXml(proj, path)
    }

    fun xmlParsingFailed() {
        xmlParsingFailed = true
    }

    override fun openConnection(url: java.net.URL): java.net.URLConnection? = null

    override fun openConnection(url: java.net.URL, timeout: Int): java.net.URLConnection? = null

    override fun getDesugaring(project: com.android.tools.lint.detector.api.Project): Set<Desugaring> {
        val desugaring = EnumSet.noneOf(Desugaring::class.java)
        try {
            desugaring.addAll(super.getDesugaring(project))
        } catch (_: Throwable) {
            desugaring.addAll(Desugaring.DEFAULT)
        }
        if (project.isCoreLibraryDesugaringEnabled || model?.coreLibraryDesugaringEnabled == true) {
            desugaring.add(Desugaring.JAVA_8_LIBRARY)
        }
        return desugaring
    }

    override fun getGradleVisitor(): GradleVisitor {
        if (mainFilePath?.fileName?.toString()?.endsWith(".gradle.kts") == true) {
            val proj = ideaProject
            if (proj != null && model != null) {
                val moduleDir = model.moduleRoot?.toFile() ?: File(".")
                val lintProject = createLintProject(model, moduleDir, mainFilePath.toFile())
                val driver = LintDriver(
                    AndroidLintIssueRegistry(scope = Scope.GRADLE_FILE),
                    this,
                    LintRequest(this, listOf(mainFilePath.toFile()))
                )
                val javaContext = JavaContext(driver, lintProject, lintProject, mainFilePath.toFile())
                javaContext.uastParser = getUastParser(lintProject)
                return UastGradleVisitor(javaContext)
            }
        }
        return AndroidGroovyGradleVisitor(this)
    }

    override fun getResources(
        project: com.android.tools.lint.detector.api.Project,
        scope: ResourceRepositoryScope
    ): ResourceRepository {
        return AndroidLintResources.getRepository(
            model,
            scope,
            mainFilePath,
            mainFile as? com.intellij.psi.xml.XmlFile
        )
    }

    override fun getPartialResults(
        project: com.android.tools.lint.detector.api.Project,
        issue: Issue
    ): PartialResult {
        val result = partialResults.computeIfAbsent(issue) { key ->
            PartialResult(key, LinkedHashMap())
        }
        return PartialResult.withRequestedProject(result, project)
    }

    override fun getSdkHome(): File? {
        return model?.sdkHome?.toFile()
    }

    override fun getCacheDir(name: String?, create: Boolean): File {
        val cacheRoot = Path.of(System.getProperty("java.io.tmpdir"), "android-lint-cache")
        val dir = if (name != null) cacheRoot.resolve(name) else cacheRoot
        if (create) {
            try {
                Files.createDirectories(dir)
            } catch (_: IOException) {
            }
        }
        return dir.toFile()
    }

    override fun createUrlClassLoader(files: List<File>, parent: ClassLoader): ClassLoader {
        val cacheAarDir = getCacheDir("aar", true)
        val copiedPaths = ArrayList<Path>()
        for (f in files) {
            if (f.isFile) {
                try {
                    val copied = copyToAarCache(f.toPath(), cacheAarDir.toPath())
                    copiedPaths.add(copied)
                } catch (e: CancellationException) {
                    throw e
                } catch (e: IOException) {
                    LOG.warn("Failed to copy AAR jar to cache: $f", e)
                }
            }
        }
        return UrlClassLoader.build().parent(parent).allowLock(false).files(copiedPaths).get()
    }

    @Deprecated("Use the List<File> version")
    override fun createUrlClassLoader(urls: Array<URL>, parent: ClassLoader): ClassLoader {
        val files = ArrayList<File>()
        for (url in urls) {
            if ("file".equals(url.protocol, ignoreCase = true)) {
                try {
                    files.add(File(url.toURI()))
                } catch (_: Exception) {
                    files.add(File(url.path))
                }
            }
        }
        return createUrlClassLoader(files, parent)
    }

    override fun findGlobalRuleJars(driver: LintDriver?, warnDeprecated: Boolean): List<File> {
        return emptyList()
    }

    override fun findRuleJars(project: com.android.tools.lint.detector.api.Project): Iterable<File> {
        return emptyList()
    }

    override fun getConfiguration(
        project: com.android.tools.lint.detector.api.Project,
        driver: LintDriver?
    ): Configuration {
        var effectiveXmlConfig: Configuration? = null

        if (model != null) {
            val projectRoot = model.projectRoot
            val moduleRoot = model.moduleRoot
            val configFiles = configurationFiles(projectRoot, moduleRoot)
            var previous: Configuration? = null
            for (configPath in configFiles) {
                val text = AndroidSources.text(configPath)
                if (!text.isNullOrEmpty()) {
                    val config = LintXmlConfiguration.create(configurations, configPath.toFile(), text)
                    if (previous != null) {
                        configurations.setParent(config, previous)
                    }
                    previous = config
                }
            }
            effectiveXmlConfig = previous
        }

        val buildModule = project.buildModule
        val lintOptions = buildModule?.lintOptions
        if (buildModule != null && lintOptions != null) {
            return configurations.createLintOptionsConfiguration(
                project,
                lintOptions,
                false,
                effectiveXmlConfig
            ) {
                val configuration = LintOptionsConfiguration(
                    configurations,
                    lintOptions,
                    false
                )
                configuration.associatedLocation = Location.create(project.dir)
                configuration
            }
        }
        if (effectiveXmlConfig != null) {
            return effectiveXmlConfig
        }
        return super.getConfiguration(project, driver)
    }

    override fun report(context: Context, incident: Incident, format: TextFormat) {
        if (incident.severity == Severity.IGNORE) return
        val location = incident.location
        if (location == Location.NONE) return
        val file = location.file
        val incidentPath = file.toPath().toAbsolutePath().normalize()
        if (mainFilePath == null || incidentPath != mainFilePath) return
        val start = location.start
        val end = location.end
        if (start == null || end == null || start.offset < 0 || start.offset >= end.offset) {
            return
        }
        var msg = incident.message
        if (msg != null) {
            msg = format.convertTo(msg, TextFormat.RAW)
        }
        incident.message = msg
        val baseline = activeBaseline
        if (baseline != null && baseline.findAndMark(incident)) return
        collectedIncidents.add(incident)
    }

    override fun log(severity: Severity, exception: Throwable?, format: String?, vararg args: Any) {
        if (exception is CancellationException) {
            throw exception
        }
        if (exception?.cause is CancellationException) {
            throw (exception.cause as CancellationException)
        }
        var root: Throwable? = exception
        while (root?.cause != null && root.cause !== root) {
            if (root is LinkageError) {
                break
            }
            root = root.cause
        }
        if (root is RuntimeException || root is java.lang.Error) {
            lastDetectorFailure = root
            if (root is java.lang.Error) throw root
            throw (root as RuntimeException)
        }
        val msg = if (format != null) {
            try {
                String.format(format, *args)
            } catch (_: Exception) {
                format
            }
        } else {
            exception?.message ?: ""
        }
        LOG.debug("AndroidLintClient: $msg", exception)
    }

    override fun runReadAction(runnable: Runnable) {
        ProgressManager.checkCanceled()
        try {
            runnable.run()
        } catch (canceled: CancellationException) {
            throw canceled
        } catch (failure: Throwable) {
            if (failure is RuntimeException || failure is java.lang.Error) {
                lastDetectorFailure = failure
            }
            throw failure
        }
    }

    override fun <T> runReadAction(computable: com.intellij.openapi.util.Computable<T>): T {
        ProgressManager.checkCanceled()
        try {
            return computable.compute()
        } catch (canceled: CancellationException) {
            throw canceled
        } catch (failure: Throwable) {
            if (failure is RuntimeException || failure is java.lang.Error) {
                lastDetectorFailure = failure
            }
            throw failure
        }
    }

    override fun getJavaLanguageLevel(project: com.android.tools.lint.detector.api.Project): LanguageLevel {
        val mod = ideaModule
        if (mod != null && !mod.isDisposed) {
            val ext = ModuleRootManager.getInstance(mod)
                .getModuleExtension(LanguageLevelModuleExtension::class.java)
            val extLevel = ext?.languageLevel
            if (extLevel != null) {
                return extLevel
            }
            val proj = ideaProject
            if (proj != null && !proj.isDisposed) {
                val projectLevel = LanguageLevelProjectExtension.getInstance(proj).languageLevel
                if (projectLevel != null) {
                    return projectLevel
                }
            }
        }
        return LanguageLevel.JDK_17
    }

    override fun getKotlinLanguageLevel(project: com.android.tools.lint.detector.api.Project): LanguageVersionSettings {
        val mod = ideaModule
        val proj = ideaProject
        if (mod != null && !mod.isDisposed && proj != null && !proj.isDisposed) {
            try {
                val provider = proj.getService(KotlinFacetSettingsProvider::class.java)
                if (provider != null) {
                    val settings = provider.getSettings(mod)
                    val langLevel = settings?.languageLevel
                    val apiLevel = settings?.apiLevel
                    if (langLevel != null && apiLevel != null) {
                        return LanguageVersionSettingsImpl(
                            langLevel,
                            ApiVersion.createByLanguageVersion(apiLevel)
                        )
                    }
                }
            } catch (e: CancellationException) {
                throw e
            } catch (_: Throwable) {
            }
        }
        return LanguageVersionSettingsImpl.DEFAULT
    }

    fun availableIssues(): List<Issue> {
        return availableIssues(scope ?: Scope.JAVA_FILE)
    }

    internal fun availableIssues(targetScope: Scope): List<Issue> {
        ProgressManager.checkCanceled()
        val currentModel = model
        if (currentModel == null) {
            issueEnumerationComplete = true
            return emptyList()
        }
        val moduleDir = currentModel.moduleRoot?.toFile()
        if (moduleDir == null) {
            issueEnumerationFailed = true
            return emptyList()
        }

        val project = createLintProject(currentModel, moduleDir, null)
        val builtin = createBuiltinRegistry(currentModel, targetScope)
        val aarRegistries = assembleAarRegistries(currentModel, project, null)
        if (cachedAarLoadFailed) {
            issueEnumerationFailed = true
        }

        val registries = ArrayList<IssueRegistry>(1 + aarRegistries.size)
        registries.add(builtin)
        registries.addAll(aarRegistries)
        val uniqueRegistries = ArrayList<IssueRegistry>(LinkedHashSet(registries))

        val enumerated = runWithIsolationInternal(
            uniqueRegistries,
            onFailure = { issueEnumerationFailed = true }
        ) { reg ->
            ProgressManager.checkCanceled()
            val lastApplicableById = LinkedHashMap<String, Issue>()
            for (issue in reg.issues) {
                ProgressManager.checkCanceled()
                if (isApplicableForEnumeration(issue, targetScope, currentModel.minSdkPremiseMissing)) {
                    lastApplicableById[issue.id] = issue
                }
            }
            val selected = ArrayList<Issue>(lastApplicableById.size)
            for ((id, fallback) in lastApplicableById) {
                ProgressManager.checkCanceled()
                val representative = reg.getIssue(id)
                if (representative != null &&
                    representative.id == id &&
                    isApplicableForEnumeration(representative, targetScope, currentModel.minSdkPremiseMissing)
                ) {
                    selected.add(representative)
                } else {
                    selected.add(fallback)
                }
            }
            selected
        }

        val deduped = LinkedHashMap<String, Issue>(enumerated.size)
        for (issue in enumerated) {
            deduped[issue.id] = issue
        }
        issueEnumerationComplete = true
        return java.util.List.copyOf(deduped.values)
    }

    internal fun isIssueEnumerationComplete(): Boolean {
        return issueEnumerationComplete && !issueEnumerationFailed
    }

    fun analyze(): List<Incident> {
        ProgressManager.checkCanceled()
        if (selectedIssueIds != null && selectedIssueIds.isEmpty()) {
            analysisComplete = true
            return emptyList()
        }
        if (model == null || mainFilePath == null) {
            return emptyList()
        }
        val moduleDir = model.moduleRoot?.toFile() ?: return emptyList()
        val mainIoFile = mainFilePath.toFile()
        val hasContent = contents != null || mainIoFile.isFile
        if (!hasContent) return emptyList()

        val effectiveScope = scope ?: Scope.JAVA_FILE
        val builtin = createBuiltinRegistry(model, effectiveScope)
        val preProject = createLintProject(model, moduleDir, mainIoFile)

        val preDriver = if (model.ruleJars.isNotEmpty()) {
            val request = LintRequest(this, listOf(mainIoFile))
            request.setProjects(listOf(preProject))
            request.setScope(EnumSet.of(effectiveScope))
            request.setPlatform(Platform.ANDROID_SET)
            LintDriver(builtin, this, request).also {
                it.checkTestSources = true
                it.checkDependencies = false
            }
        } else {
            null
        }

        val aarRegistries = assembleAarRegistries(model, preProject, preDriver)
        val registries = ArrayList<IssueRegistry>(1 + aarRegistries.size)
        registries.add(builtin)
        registries.addAll(aarRegistries)
        val uniqueRegistries = ArrayList<IssueRegistry>(LinkedHashSet(registries))

        return runWithIsolation(uniqueRegistries) { reg ->
            ProgressManager.checkCanceled()
            collectedIncidents.clear()
            partialResults.clear()
            lastDetectorFailure = null

            val executionRegistry = pruneRegistryForSelection(reg)
            if (executionRegistry == null) {
                analysisComplete = true
                return@runWithIsolation emptyList()
            }

            val runProject = createLintProject(model, moduleDir, mainIoFile)

            val req = LintRequest(this, listOf(mainIoFile))
            req.setProjects(listOf(runProject))
            req.setScope(EnumSet.of(effectiveScope))
            req.setPlatform(Platform.ANDROID_SET)

            val driver = LintDriver(executionRegistry, this, req)
            driver.checkTestSources = true
            driver.checkDependencies = false

            val baselineFile = model.lintModelModule?.lintOptions?.baselineFile
                ?: model.moduleRoot.resolve("lint-baseline.xml").toFile()
            val baseline = if (baselineFile != null && baselineFile.isFile) {
                LintBaseline(this, baselineFile).also {
                    it.writeOnClose = false
                }
            } else {
                null
            }
            if (baseline != null) {
                driver.baseline = baseline
            }
            activeBaseline = baseline
            try {
                driver.analyze()
            } finally {
                activeBaseline = null
                baseline?.close()
            }

            val failure = lastDetectorFailure
            if (failure != null) {
                lastDetectorFailure = null
                if (failure is java.lang.Error) throw failure
                if (failure is RuntimeException) throw failure
                throw RuntimeException(failure)
            }

            analysisComplete = true
            java.util.List.copyOf(collectedIncidents)
        }
    }

    fun isAnalysisComplete(): Boolean {
        return analysisComplete && !xmlParsingFailed
    }

    private fun createLintProject(
        currentModel: AndroidLintModel,
        moduleDir: File,
        mainIoFile: File?
    ): AndroidLintProject {
        val project = AndroidLintProject(
            this,
            moduleDir,
            ideaModule,
            currentModel,
            currentModel.lintModelModule,
            currentModel.lintModelVariant
        )
        if (mainIoFile != null) {
            project.addFile(mainIoFile)
        }
        return project
    }

    private fun createBuiltinRegistry(
        currentModel: AndroidLintModel,
        targetScope: Scope
    ): IssueRegistry {
        if (currentModel.minSdkPremiseMissing) {
            LOG.debug("Skipping ApiDetector checks: minSdk premise missing for module " + (ideaModule?.name ?: ""))
        }
        return AndroidLintIssueRegistry.create(currentModel.minSdkPremiseMissing, targetScope)
    }

    private fun isApplicableForEnumeration(
        issue: Issue,
        targetScope: Scope,
        minSdkPremiseMissing: Boolean
    ): Boolean {
        if (!AndroidLintIssueRegistry.isIssueSupported(issue, targetScope)) {
            return false
        }
        if (minSdkPremiseMissing && AndroidLintIssueRegistry.isApiDetectorIssue(issue)) {
            return false
        }
        return true
    }

    private fun pruneRegistryForSelection(registry: IssueRegistry): IssueRegistry? {
        val selected = selectedIssueIds ?: return registry
        if (selected.isEmpty()) return null
        val filtered = registry.issues.filter { it.id in selected }
        if (filtered.isEmpty()) return null
        return SelectedIssueRegistry(registry, filtered)
    }

    private fun assembleAarRegistries(
        currentModel: AndroidLintModel,
        project: AndroidLintProject,
        driver: LintDriver?
    ): List<JarFileIssueRegistry> {
        cachedAarRegistries?.let { return it }
        val ruleJars = currentModel.ruleJars
        if (ruleJars.isEmpty()) {
            val empty = emptyList<JarFileIssueRegistry>()
            cachedAarRegistries = empty
            return empty
        }
        val loaded = ArrayList<JarFileIssueRegistry>()
        for (jarPath in ruleJars) {
            ProgressManager.checkCanceled()
            AndroidSources.observeCompiledArchive(jarPath)
            if (!Files.isRegularFile(jarPath)) {
                cachedAarLoadFailed = true
                continue
            }
            try {
                val jarRegistries = loadAarRegistries(jarPath, project, driver)
                if (jarRegistries.isEmpty()) {
                    cachedAarLoadFailed = true
                } else {
                    loaded.addAll(jarRegistries)
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: AndroidQueryException) {
                throw e
            } catch (t: Throwable) {
                cachedAarLoadFailed = true
                LOG.warn("Failed to load lint rules from $jarPath", t)
            }
        }
        val result = java.util.List.copyOf(loaded)
        cachedAarRegistries = result
        return result
    }

    private fun loadAarRegistries(
        originalJar: Path,
        project: AndroidLintProject,
        driver: LintDriver?
    ): List<JarFileIssueRegistry> {
        try {
            AndroidSources.observeCompiledArchive(originalJar)
            val beforeStamp = readSourceFileStamp(originalJar)
            if (beforeStamp == null) {
                cachedAarLoadFailed = true
                return emptyList()
            }
            val cacheAarDir = getCacheDir("aar", true)
            val copiedJar = copyToAarCache(originalJar, cacheAarDir.toPath())
            val lastModified = beforeStamp.modified.toMillis()
            val size = beforeStamp.size
            val key = AarCacheKey(copiedJar, lastModified, size)

            var moduleCache: MutableMap<AarCacheKey, List<JarFileIssueRegistry>>? = null
            val mod = ideaModule
            if (mod != null && !mod.isDisposed) {
                moduleCache = MODULE_AAR_CACHE.computeIfAbsent(mod) {
                    Collections.synchronizedMap(
                        object : LinkedHashMap<AarCacheKey, List<JarFileIssueRegistry>>(16, 0.75f, true) {
                            override fun removeEldestEntry(eldest: MutableMap.MutableEntry<AarCacheKey, List<JarFileIssueRegistry>>?): Boolean {
                                return size > 32
                            }
                        }
                    )
                }
                val cached = moduleCache[key]
                if (!cached.isNullOrEmpty() && cached.all { it.isUpToDate }) {
                    val afterStamp = readSourceFileStamp(originalJar)
                    if (afterStamp == null || afterStamp != beforeStamp) {
                        throw AndroidQueryException("content_modified", -32801)
                    }
                    return cached
                }
            }

            val list = JarFileIssueRegistry.get(
                this,
                listOf(copiedJar.toFile()),
                project,
                driver,
                true
            )
            val afterStamp = readSourceFileStamp(originalJar)
            if (afterStamp == null || afterStamp != beforeStamp) {
                throw AndroidQueryException("content_modified", -32801)
            }
            if (!list.isNullOrEmpty()) {
                moduleCache?.put(key, list)
                return list
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: AndroidQueryException) {
            throw e
        } catch (t: Throwable) {
            lastDetectorFailure = null
            cachedAarLoadFailed = true
            LOG.warn("Failed to load AAR lint registry from $originalJar", t)
        }
        return emptyList()
    }

    private class SelectedIssueRegistry(
        private val delegate: IssueRegistry,
        issues: List<Issue>
    ) : IssueRegistry() {
        override val issues: List<Issue> = java.util.List.copyOf(issues)
        override val vendor: Vendor? get() = delegate.vendor
        override val api: Int get() = delegate.api
        override val minApi: Int get() = delegate.minApi
        override val maxApi: Int get() = delegate.maxApi
        override val deletedIssues: List<String> get() = delegate.deletedIssues
        override val isUpToDate: Boolean get() = delegate.isUpToDate
        override fun cacheable(): Boolean = false
    }

    private class SelectionOverrideConfiguration(
        configurations: ConfigurationHierarchy,
        private val selectedIds: Set<String>
    ) : Configuration(configurations) {
        init {
            isOverriding = true
            fileLevel = false
        }

        override var baselineFile: File? = null

        override fun getDefinedSeverity(
            issue: Issue,
            source: Configuration,
            visibleDefault: Severity
        ): Severity? {
            return if (issue.id in selectedIds) null else Severity.IGNORE
        }

        override fun addConfiguredIssues(
            targetMap: MutableMap<String, Severity>,
            registry: IssueRegistry,
            specificOnly: Boolean
        ) {
        }

        override fun getOption(issue: Issue, name: String, default: String?): String? = default

        override fun getOption(option: Option): Any? = null

        override fun getOptionAsFile(issue: Issue, name: String, default: File?): File? = default

        override fun ignore(context: Context, issue: Issue, location: Location?, message: String) {
        }

        override fun ignore(issue: Issue, file: File) {
        }

        override fun ignore(issueId: String, file: File) {
        }

        override fun setSeverity(issue: Issue, severity: Severity?) {
        }
    }

    private data class SourceFileStamp(
        val size: Long,
        val modified: FileTime,
        val fileKey: Any?
    )

    private data class AarCacheKey(val copiedJarPath: Path, val originalLastModified: Long, val originalSize: Long)

    private class AndroidUastParser(
        project: com.android.tools.lint.detector.api.Project?,
        ideaProject: Project,
        private val mainFile: PsiFile?,
        private val mainFilePath: Path?
    ) : DefaultUastParser(project, ideaProject) {
        init {
            prepared = true
        }

        override fun parse(context: com.android.tools.lint.detector.api.JavaContext): org.jetbrains.uast.UFile? {
            if (mainFile != null && mainFilePath != null && context.file != null) {
                if (context.file.toPath().toAbsolutePath().normalize() == mainFilePath) {
                    val uElem = org.jetbrains.uast.UastFacade.convertElementWithParent(
                        mainFile,
                        org.jetbrains.uast.UFile::class.java
                    )
                    if (uElem is org.jetbrains.uast.UFile) {
                        return uElem
                    }
                }
            }
            return super.parse(context)
        }

        override fun createEvaluator(
            project: com.android.tools.lint.detector.api.Project?,
            p: Project
        ): DefaultJavaEvaluator {
            var mod: Module? = null
            if (project is AndroidLintProject) {
                mod = project.ideaModule
                if (mod == null && project.model != null) {
                    mod = project.model.module
                }
            }
            return AndroidJavaEvaluator(p, project, mod)
        }
    }

    private class AndroidJavaEvaluator(
        private val ideaProject: Project?,
        lintProject: com.android.tools.lint.detector.api.Project?,
        private val ideaModule: Module?
    ) : DefaultJavaEvaluator(ideaProject, lintProject) {

        override fun getPackage(node: PsiElement): PsiPackage? {
            val containingFile = if (node is PsiFile) node else node.containingFile
            if (containingFile != null) {
                val dir = containingFile.parent
                if (dir != null) {
                    val pkg = JavaDirectoryService.getInstance().getPackage(dir)
                    if (pkg != null) {
                        return pkg
                    }
                }
            }
            return super.getPackage(node)
        }

        override fun findClass(qualifiedName: String): PsiClass? {
            ProgressManager.checkCanceled()
            val mod = ideaModule
            val proj = ideaProject
            if (mod != null && !mod.isDisposed && proj != null) {
                val scope = mod.getModuleWithDependenciesAndLibrariesScope(true)
                return JavaPsiFacade.getInstance(proj).findClass(qualifiedName, scope)
            }
            return super.findClass(qualifiedName)
        }
    }

    companion object {
        private val LOG = Logger.getInstance(AndroidLintClient::class.java)
        private val MODULE_AAR_CACHE: MutableMap<Module, MutableMap<AarCacheKey, List<JarFileIssueRegistry>>> =
            Collections.synchronizedMap(WeakHashMap())

        @JvmStatic
        fun configurationFiles(projectRoot: Path?, moduleRoot: Path?): List<Path> {
            if (projectRoot == null && moduleRoot == null) {
                return emptyList()
            }
            if (projectRoot == null) {
                return listOf(moduleRoot!!.toAbsolutePath().normalize().resolve("lint.xml"))
            }
            if (moduleRoot == null) {
                return listOf(projectRoot.toAbsolutePath().normalize().resolve("lint.xml"))
            }

            val normProject = projectRoot.toAbsolutePath().normalize()
            val normModule = moduleRoot.toAbsolutePath().normalize()

            if (normProject == normModule) {
                return listOf(normProject.resolve("lint.xml"))
            }

            if (!normModule.startsWith(normProject)) {
                return listOf(normProject.resolve("lint.xml"), normModule.resolve("lint.xml"))
            }

            val rel = normProject.relativize(normModule)
            val result = ArrayList<Path>(rel.nameCount + 1)
            result.add(normProject.resolve("lint.xml"))
            var current = normProject
            for (i in 0 until rel.nameCount) {
                current = current.resolve(rel.getName(i))
                result.add(current.resolve("lint.xml"))
            }
            return Collections.unmodifiableList(result)
        }

        @JvmStatic
        fun runWithIsolation(
            registries: List<IssueRegistry>?,
            runner: (IssueRegistry) -> List<Incident>
        ): List<Incident> {
            return runWithIsolationInternal(registries, null, runner)
        }

        private inline fun <T> runWithIsolationInternal(
            registries: List<IssueRegistry>?,
            noinline onFailure: (() -> Unit)?,
            runner: (IssueRegistry) -> List<T>
        ): List<T> {
            if (registries.isNullOrEmpty()) {
                return emptyList()
            }
            if (registries.size == 1) {
                return try {
                    runner(registries[0])
                } catch (e: CancellationException) {
                    throw e
                } catch (e: AndroidQueryException) {
                    throw e
                } catch (t: Throwable) {
                    onFailure?.invoke()
                    LOG.warn("Failed lint registry execution: ${registries[0]}", t)
                    emptyList()
                }
            }

            return try {
                val composite = CompositeIssueRegistry(ArrayList(registries))
                runner(composite)
            } catch (e: CancellationException) {
                throw e
            } catch (e: AndroidQueryException) {
                throw e
            } catch (t: Throwable) {
                LOG.warn("Composite lint registry execution failed, retrying with per-registry isolation", t)
                val combined = ArrayList<T>()
                for (registry in registries) {
                    try {
                        val batch = runner(registry)
                        if (batch.isNotEmpty()) {
                            combined.addAll(batch)
                        }
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: AndroidQueryException) {
                        throw e
                    } catch (regError: Throwable) {
                        onFailure?.invoke()
                        LOG.warn("Skipping failing lint issue registry: $registry", regError)
                    }
                }
                combined
            }
        }

        private fun readSourceFileStamp(path: Path): SourceFileStamp? {
            return try {
                val attrs = Files.readAttributes(path, BasicFileAttributes::class.java)
                SourceFileStamp(attrs.size(), attrs.lastModifiedTime(), attrs.fileKey())
            } catch (_: IOException) {
                null
            }
        }

        private fun copyToAarCache(originalJar: Path, cacheDir: Path): Path {
            val md = try {
                MessageDigest.getInstance("SHA-256")
            } catch (e: Exception) {
                throw IOException("SHA-256 not available", e)
            }

            val buf = ByteArray(65536)
            Files.newInputStream(originalJar).use { input ->
                var r: Int
                while (input.read(buf).also { r = it } != -1) {
                    ProgressManager.checkCanceled()
                    md.update(buf, 0, r)
                }
            }

            val sha256 = HexFormat.of().formatHex(md.digest())
            val target = cacheDir.resolve("$sha256.jar")
            val originalSize = Files.size(originalJar)

            if (Files.exists(target) && Files.size(target) == originalSize) {
                return target
            }

            val temp = cacheDir.resolve("$sha256.tmp.${UUID.randomUUID()}")
            try {
                Files.copy(originalJar, temp, StandardCopyOption.REPLACE_EXISTING)
                try {
                    Files.move(temp, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
                } catch (_: AtomicMoveNotSupportedException) {
                    Files.move(temp, target, StandardCopyOption.REPLACE_EXISTING)
                }
            } finally {
                try {
                    Files.deleteIfExists(temp)
                } catch (_: IOException) {
                }
            }
            return target
        }
    }
}

private class AndroidGroovyGradleVisitor(private val client: LintClient) : GradleVisitor() {
    override fun visitBuildScript(context: GradleContext, detectors: List<GradleScanner>) {
        val file = context.file
        val contents = client.readFile(file).toString()
        if (contents.isBlank()) return
        val unit = try {
            SourceUnit.create(file.name, contents).apply {
                parse()
                completePhase()
                convert()
            }
        } catch (_: Throwable) {
            return
        }
        val moduleNode = unit.ast ?: return
        val statementBlock = moduleNode.statementBlock ?: return

        for (detector in detectors) {
            if (detector.customVisitor) {
                detector.visitBuildScript(context)
            }
        }

        walkStatements(context, detectors, statementBlock.statements, "", "", contents)
    }

    private fun walkStatements(
        context: GradleContext,
        detectors: List<GradleScanner>,
        statements: List<Statement>,
        parent: String,
        parentParent: String,
        contents: String
    ) {
        for (statement in statements) {
            if (statement is ExpressionStatement) {
                walkExpression(context, detectors, statement.expression, parent, parentParent, contents)
            }
        }
    }

    private fun walkExpression(
        context: GradleContext,
        detectors: List<GradleScanner>,
        expr: Expression,
        parent: String,
        parentParent: String,
        contents: String
    ) {
        when (expr) {
            is MethodCallExpression -> {
                val methodName = expr.methodAsString
                    ?: (expr.method as? ConstantExpression)?.value?.toString()
                    ?: ""
                val namedArgs = LinkedHashMap<String, String>()
                val unnamedArgs = ArrayList<String>()

                val rawArgs = expr.arguments
                if (rawArgs is ArgumentListExpression) {
                    for (arg in rawArgs.expressions) {
                        if (arg is NamedArgumentListExpression) {
                            for (entry in arg.mapEntryExpressions) {
                                namedArgs[entry.keyExpression.text] = sourceText(contents, entry.valueExpression)
                            }
                        } else if (arg is MapEntryExpression) {
                            namedArgs[arg.keyExpression.text] = sourceText(contents, arg.valueExpression)
                        } else if (arg !is ClosureExpression) {
                            unnamedArgs.add(sourceText(contents, arg))
                        }
                    }
                } else if (rawArgs is TupleExpression) {
                    for (arg in rawArgs.expressions) {
                        if (arg !is ClosureExpression) {
                            unnamedArgs.add(sourceText(contents, arg))
                        }
                    }
                }

                for (detector in detectors) {
                    // The current overload delegates to legacy detectors exactly once.
                    detector.checkMethodCall(context, methodName, parent, parentParent, namedArgs, unnamedArgs, expr)
                }

                val closure = (rawArgs as? ArgumentListExpression)?.expressions?.filterIsInstance<ClosureExpression>()
                    ?.firstOrNull()
                    ?: (rawArgs as? TupleExpression)?.expressions?.filterIsInstance<ClosureExpression>()?.firstOrNull()
                if (closure != null && closure.code is BlockStatement) {
                    walkStatements(
                        context,
                        detectors,
                        (closure.code as BlockStatement).statements,
                        methodName,
                        parent,
                        contents
                    )
                }
            }

            is BinaryExpression -> {
                val prop = expr.leftExpression.text
                val value = sourceText(contents, expr.rightExpression)
                for (detector in detectors) {
                    // Real AST cookies preserve independent property and value locations.
                    detector.checkDslPropertyAssignment(
                        context,
                        prop,
                        value,
                        parent,
                        parentParent,
                        expr.leftExpression,
                        expr.rightExpression,
                        expr
                    )
                }
            }

            is MapEntryExpression -> {
                val prop = expr.keyExpression.text
                val value = sourceText(contents, expr.valueExpression)
                for (detector in detectors) {
                    detector.checkDslPropertyAssignment(
                        context,
                        prop,
                        value,
                        parent,
                        parentParent,
                        expr.keyExpression,
                        expr.valueExpression,
                        expr
                    )
                }
            }
        }
    }

    private fun sourceText(contents: String, expression: Expression): String {
        val start = offsetOf(contents, expression.lineNumber, expression.columnNumber)
        val end = offsetOf(contents, expression.lastLineNumber, expression.lastColumnNumber)
        return contents.substring(start, end)
    }

    override fun createLocation(context: GradleContext, cookie: Any): Location {
        if (cookie is ASTNode && cookie.lineNumber > 0) {
            val contents = client.readFile(context.file)
            val line = (cookie.lineNumber - 1).coerceAtLeast(0)
            val col = (cookie.columnNumber - 1).coerceAtLeast(0)
            val endLine = (cookie.lastLineNumber - 1).coerceAtLeast(line)
            val endCol = (cookie.lastColumnNumber - 1).coerceAtLeast(col)
            val startOffset = offsetOf(contents, cookie.lineNumber, cookie.columnNumber)
            val endOffset = offsetOf(contents, cookie.lastLineNumber, cookie.lastColumnNumber)
            return Location.create(
                context.file,
                DefaultPosition(line, col, startOffset),
                DefaultPosition(endLine, endCol, endOffset)
            )
        }
        return Location.create(context.file)
    }

    override fun getStartOffset(context: GradleContext, cookie: Any): Int {
        val loc = createLocation(context, cookie)
        return loc.start?.offset ?: -1
    }

    private fun offsetOf(contents: CharSequence, line1: Int, col1: Int): Int {
        if (line1 <= 0) return 0
        var curLine = 1
        for (i in 0 until contents.length) {
            if (curLine == line1) {
                return (i + (col1 - 1)).coerceIn(0, contents.length)
            }
            if (contents[i] == '\n') curLine++
        }
        return contents.length
    }
}
