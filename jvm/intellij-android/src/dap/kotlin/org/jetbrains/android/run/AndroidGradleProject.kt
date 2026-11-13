package org.jetbrains.android.run

import com.android.ide.common.build.GenericBuiltArtifactsLoader
import com.android.ide.common.build.GenericBuiltArtifactsSplitOutputMatcher
import com.android.utils.ILogger
import com.intellij.openapi.diagnostic.Logger
import com.intellij.platform.workspace.jps.entities.ModuleEntity
import com.intellij.platform.workspace.jps.entities.customImlData
import com.intellij.platform.workspace.jps.entities.exModuleOptions
import com.intellij.platform.workspace.storage.EntityStorage
import com.jetbrains.ls.api.core.LSServer
import com.jetbrains.ls.snapshot.api.impl.core.InitializeOptions
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.InternalCoroutinesApi
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.job
import org.gradle.api.Incubating
import org.jetbrains.annotations.ApiStatus
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import org.gradle.tooling.BuildCancelledException
import org.gradle.tooling.CancellationTokenSource
import org.gradle.tooling.GradleConnectionException
import org.gradle.tooling.GradleConnector
import org.gradle.tooling.LongRunningOperation
import org.gradle.tooling.ProjectConnection
import org.gradle.tooling.ResultHandler
import java.io.ByteArrayOutputStream
import java.io.OutputStream
import java.net.URI
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.InvalidPathException
import java.nio.file.Path
import kotlin.time.Duration.Companion.milliseconds

data class AndroidGradleRootContext(
    val buildRoot: Path,
    val javaHome: Path? = null,
    val env: Map<String, String> = emptyMap(),
    val systemProperties: Map<String, String> = emptyMap(),
    val offline: Boolean = false,
)

data class AndroidGradleContext(
    val workspaceDirectory: Path? = null,
    val defaultSdk: Path? = null,
    val importedRoots: Map<Path, AndroidGradleRootContext> = emptyMap(),
) {
    @Suppress("UnstableApiUsage")
    companion object {
        private const val LSP_IMPORT_JAVA_HOME_OPTION = "lsp.import.java.home"
        private val LOG = Logger.getInstance(AndroidGradleContext::class.java)

        fun capture(server: LSServer): AndroidGradleContext {
            val workspaceConfig = runCatching { server.workspaceConfig }.getOrNull()
            val storage = runCatching { server.workspaceStructure.getEntityStorage() }.getOrNull()
            return capture(
                workspaceFolders = workspaceConfig?.workspaceFolders.orEmpty(),
                rootUri = workspaceConfig?.rootUri?.uri,
                importOptions = workspaceConfig?.importOptions,
                entityStorage = storage,
            )
        }

        @ApiStatus.Internal
        fun capture(
            workspaceFolders: List<Path>,
            rootUri: String?,
            importOptions: InitializeOptions?,
            entityStorage: EntityStorage?,
        ): AndroidGradleContext {
            val workspaceDirectory = workspaceFolders
                .firstOrNull()
                ?.toAbsolutePath()
                ?.normalize()
                ?: parseFileUriPath(rootUri)

            val defaultSdk = importOptions?.defaultSdk?.toAbsolutePath()?.normalize()

            val roots = LinkedHashMap<Path, AndroidGradleRootContext>()
            for (configured in importOptions?.projects.orEmpty()) {
                if (!"gradle".equals(configured.type, ignoreCase = true)) {
                    continue
                }
                val rootPath = parseFileUriPath(configured.path.uri) ?: continue
                val existing = roots[rootPath]
                val configuredEnv = configured.env?.toMap() ?: emptyMap()
                val configuredSysProps = configured.systemProperties?.toMap() ?: emptyMap()
                val configuredJavaHome = configured.javaHome?.toAbsolutePath()?.normalize()
                roots[rootPath] = AndroidGradleRootContext(
                    buildRoot = rootPath,
                    javaHome = configuredJavaHome ?: existing?.javaHome,
                    env = if (existing == null) configuredEnv else existing.env + configuredEnv,
                    systemProperties = if (existing == null) configuredSysProps else existing.systemProperties + configuredSysProps,
                    offline = configured.offline || (existing?.offline == true),
                )
            }

            if (entityStorage != null) {
                extractEntityStorageJavaHomes(entityStorage, roots)
            }

            return AndroidGradleContext(
                workspaceDirectory = workspaceDirectory,
                defaultSdk = defaultSdk,
                importedRoots = roots.toMap(),
            )
        }

        @ApiStatus.Internal
        private fun extractEntityStorageJavaHomes(
            entityStorage: EntityStorage,
            roots: MutableMap<Path, AndroidGradleRootContext>,
        ) {
            for (module in entityStorage.entities(ModuleEntity::class.java)) {
                val exOptions = module.exModuleOptions ?: continue
                if (!"GRADLE".equals(exOptions.externalSystem, ignoreCase = true)) {
                    continue
                }
                val rootPath = parseFilePath(exOptions.rootProjectPath) ?: continue
                val stampedJavaHome = module.customImlData
                    ?.customModuleOptions
                    ?.get(LSP_IMPORT_JAVA_HOME_OPTION)
                    ?.takeIf { it.isNotBlank() }
                    ?.let(::parseFilePath)
                    ?: continue
                val existing = roots[rootPath]
                if (existing == null) {
                    roots[rootPath] = AndroidGradleRootContext(
                        buildRoot = rootPath,
                        javaHome = stampedJavaHome,
                    )
                } else if (existing.javaHome == null) {
                    roots[rootPath] = existing.copy(javaHome = stampedJavaHome)
                }
            }
        }

        internal fun parseFileUriPath(rawUri: String?): Path? {
            if (rawUri.isNullOrBlank()) return null
            return try {
                val uri = URI.create(rawUri)
                if ("file".equals(uri.scheme, ignoreCase = true)) {
                    Path.of(uri).toAbsolutePath().normalize()
                } else {
                    null
                }
            } catch (e: IllegalArgumentException) {
                LOG.debug("Ignoring non-file URI in workspace config: $rawUri", e)
                null
            } catch (e: InvalidPathException) {
                LOG.debug("Ignoring invalid file URI path in workspace config: $rawUri", e)
                null
            }
        }

        private fun parseFilePath(rawPath: String?): Path? {
            if (rawPath.isNullOrBlank()) return null
            return try {
                Path.of(rawPath.trim()).toAbsolutePath().normalize()
            } catch (_: InvalidPathException) {
                null
            }
        }
    }
}

data class GradleResolvedArtifacts(
    val buildRoot: Path,
    val module: String,
    val variant: String,
    val applicationId: String?,
    val abiFilters: Set<String>?,
    val listingFile: Path,
    val resolvedPaths: List<Path>,
)

data class GradleExecutionSpec(
    val buildRoot: Path,
    val javaHome: Path?,
    val environment: Map<String, String>,
    val systemProperties: Map<String, String>,
    val gradleUserHome: Path?,
    val offline: Boolean,
)

open class AndroidGradleProject @JvmOverloads constructor(
    private val context: AndroidGradleContext = AndroidGradleContext(),
    private val connectorFactory: (Path) -> GradleConnector = { root ->
        GradleConnector.newConnector()
            .forProjectDirectory(root.toFile())
            .useBuildDistribution()
    },
    private val processEnvProvider: () -> Map<String, String> = { System.getenv() },
    private val cancelCompletionWaitMs: Long = DEFAULT_CANCEL_COMPLETION_WAIT_MS,
) {
    open suspend fun queryModels(
        buildRoot: Path,
        onOutput: (String) -> Unit = {},
    ): AndroidRunModelResultDto {
        val normalizedRoot = validateBuildRoot(buildRoot)
        val spec = resolveExecutionSpec(normalizedRoot)
        validateFullJdk(
            javaHome = spec.javaHome,
            stage = AndroidRunStage.CONFIGURING,
            module = null,
            variant = null,
        )

        val modelResult = runCancellableGradleOperation<AndroidRunModelResultDto>(
            spec = spec,
            stage = AndroidRunStage.CONFIGURING,
            module = null,
            variant = null,
            operationDescription = "Gradle Android model query at $normalizedRoot",
            onOutput = onOutput,
        ) { connection, tokenSource, stdout, stderr ->
            val executer = connection.action(AndroidRunModelAction())
            configureOperation(executer, spec, tokenSource, stdout, stderr)
            executer to { handler: ResultHandler<AndroidRunModelResultDto> -> executer.run(handler) }
        }

        validateModelCompatibility(modelResult, moduleFilter = null)
        return modelResult
    }

    open suspend fun resolveAndBuild(
        target: AndroidLaunchTarget.Gradle,
        deviceAbis: List<String>,
        onStage: (AndroidRunStage) -> Unit,
        onOutput: (String) -> Unit,
    ): GradleResolvedArtifacts {
        onStage(AndroidRunStage.CONFIGURING)
        val normalizedRoot = validateBuildRoot(target.buildRoot)
        val spec = resolveExecutionSpec(normalizedRoot)
        validateFullJdk(
            javaHome = spec.javaHome,
            stage = AndroidRunStage.CONFIGURING,
            module = target.module,
            variant = target.variant,
        )

        val modelResult = runCancellableGradleOperation<AndroidRunModelResultDto>(
            spec = spec,
            stage = AndroidRunStage.CONFIGURING,
            module = target.module,
            variant = target.variant,
            operationDescription = "Gradle Android model query for ${target.module} (${target.variant})",
            onOutput = onOutput,
        ) { connection, tokenSource, stdout, stderr ->
            val executer = connection.action(AndroidRunModelAction())
            configureOperation(executer, spec, tokenSource, stdout, stderr)
            executer to { handler: ResultHandler<AndroidRunModelResultDto> -> executer.run(handler) }
        }

        validateModelCompatibility(modelResult, moduleFilter = target.module)

        val projectModel = findRequiredApplicationModule(modelResult, target, normalizedRoot)
        val variantModel = projectModel.variants.firstOrNull { it.name == target.variant }
            ?: throw AndroidRunError(
                code = AndroidRunErrorCode.INVALID_PARAMS,
                stage = AndroidRunStage.CONFIGURING,
                detail = "Variant '${target.variant}' not found in ${target.module}; available variants: [${
                    projectModel.variants.joinToString(
                        ", "
                    ) { it.name }
                }]",
                module = target.module,
                variant = target.variant,
            ).toException()

        val listingFile = variantModel.listingFile?.toPath()?.toAbsolutePath()?.normalize()
            ?: throw AndroidRunError(
                code = AndroidRunErrorCode.ARTIFACT_INVALID,
                stage = AndroidRunStage.CONFIGURING,
                detail = "AGP model did not provide assembleTaskOutputListingFile for ${target.module}:${target.variant}",
                module = target.module,
                variant = target.variant,
            ).toException()

        if (target.build) {
            val assembleTask = variantModel.assembleTask?.takeIf { it.isNotBlank() }
                ?: throw AndroidRunError(
                    code = AndroidRunErrorCode.ARTIFACT_INVALID,
                    stage = AndroidRunStage.CONFIGURING,
                    detail = "AGP model did not provide assembleTaskName for ${target.module}:${target.variant}",
                    module = target.module,
                    variant = target.variant,
                ).toException()

            onStage(AndroidRunStage.BUILDING)
            validateFullJdk(
                javaHome = spec.javaHome,
                stage = AndroidRunStage.BUILDING,
                module = target.module,
                variant = target.variant,
            )

            runCancellableGradleOperation<Void?>(
                spec = spec,
                stage = AndroidRunStage.BUILDING,
                module = target.module,
                variant = target.variant,
                operationDescription = "Gradle build task $assembleTask",
                onOutput = onOutput,
            ) { connection, tokenSource, stdout, stderr ->
                val launcher = connection.newBuild().forTasks(assembleTask)
                configureOperation(launcher, spec, tokenSource, stdout, stderr)
                launcher to { handler: ResultHandler<Void?> -> launcher.run(handler) }
            }
        } else {
            if (!Files.isRegularFile(listingFile)) {
                throw AndroidRunError(
                    code = AndroidRunErrorCode.ARTIFACT_INVALID,
                    stage = AndroidRunStage.CONFIGURING,
                    detail = "Existing build output listing file is missing for build=false: $listingFile",
                    module = target.module,
                    variant = target.variant,
                ).toException()
            }
        }

        val resolutionStage = if (target.build) AndroidRunStage.BUILDING else AndroidRunStage.CONFIGURING
        val logger = CapturingAndroidLogger()
        val builtArtifacts = GenericBuiltArtifactsLoader.loadFromFile(listingFile.toFile(), logger)
        if (builtArtifacts == null || builtArtifacts.elements.isEmpty()) {
            val loggerDetail = logger.summary()
            val suffix = if (loggerDetail.isNotEmpty()) " ($loggerDetail)" else ""
            throw AndroidRunError(
                code = AndroidRunErrorCode.ARTIFACT_INVALID,
                stage = resolutionStage,
                detail = "Failed to load APK build artifacts from listing file $listingFile$suffix",
                module = target.module,
                variant = target.variant,
            ).toException()
        }

        val variantAbiFilters = variantModel.abiFilters ?: emptySet()
        val selectedFiles = GenericBuiltArtifactsSplitOutputMatcher.computeBestOutput(
            builtArtifacts,
            variantAbiFilters,
            deviceAbis,
        )
        if (selectedFiles.isEmpty()) {
            throw AndroidRunError(
                code = AndroidRunErrorCode.ABI_MISMATCH,
                stage = resolutionStage,
                detail = "No APK output in ${target.module}:${target.variant} is compatible with device ABIs [${
                    deviceAbis.joinToString(
                        ", "
                    )
                }] (variant abiFilters=${variantModel.abiFilters})",
                module = target.module,
                variant = target.variant,
            ).toException()
        }
        if (selectedFiles.size != 1) {
            throw AndroidRunError(
                code = AndroidRunErrorCode.ARTIFACT_INVALID,
                stage = resolutionStage,
                detail = "Expected a single compatible APK from ${target.module}:${target.variant}, got ${selectedFiles.size}: ${
                    selectedFiles.joinToString(
                        ", "
                    )
                }",
                module = target.module,
                variant = target.variant,
            ).toException()
        }

        val selectedApk = selectedFiles[0].toPath().toAbsolutePath().normalize()
        if (selectedApk.fileName.toString().endsWith(".aab", ignoreCase = true)) {
            throw AndroidRunError(
                code = AndroidRunErrorCode.UNSUPPORTED_ARTIFACT,
                stage = resolutionStage,
                detail = "AAB artifacts are not supported: $selectedApk",
                module = target.module,
                variant = target.variant,
            ).toException()
        }
        if (!Files.isRegularFile(selectedApk)) {
            throw AndroidRunError(
                code = AndroidRunErrorCode.ARTIFACT_INVALID,
                stage = resolutionStage,
                detail = "Resolved APK file does not exist: $selectedApk",
                module = target.module,
                variant = target.variant,
            ).toException()
        }

        val resolvedAppId = builtArtifacts.applicationId.takeIf { it.isNotBlank() }
            ?: variantModel.applicationId?.takeIf { it.isNotBlank() }

        return GradleResolvedArtifacts(
            buildRoot = normalizedRoot,
            module = projectModel.module,
            variant = variantModel.name,
            applicationId = resolvedAppId,
            abiFilters = variantModel.abiFilters,
            listingFile = listingFile,
            resolvedPaths = listOf(selectedApk),
        )
    }

    fun resolveExecutionSpec(buildRoot: Path): GradleExecutionSpec {
        val normalizedRoot = buildRoot.toAbsolutePath().normalize()
        val exactRoot = context.importedRoots[normalizedRoot]
        val processEnv = processEnvProvider()

        val mergedEnv = LinkedHashMap<String, String>()
        mergedEnv.putAll(processEnv)
        if (exactRoot != null && exactRoot.env.isNotEmpty()) {
            mergedEnv.putAll(exactRoot.env)
        }

        val resolvedJavaHome = exactRoot?.javaHome
            ?: exactRoot?.env?.get("JAVA_HOME")?.takeIf { it.isNotBlank() }?.let(::parseNormalizedPath)
            ?: context.defaultSdk
            ?: processEnv["JAVA_HOME"]?.takeIf { it.isNotBlank() }?.let(::parseNormalizedPath)
            ?: System.getProperty("java.home")?.takeIf { it.isNotBlank() }?.let(::parseNormalizedPath)

        if (resolvedJavaHome != null) {
            mergedEnv["JAVA_HOME"] = resolvedJavaHome.toString()
        }

        val gradleUserHome =
            exactRoot?.env?.get("GRADLE_USER_HOME")?.takeIf { it.isNotBlank() }?.let(::parseNormalizedPath)
                ?: System.getProperty(LSP_GRADLE_USER_HOME_PROP)?.takeIf { it.isNotBlank() }?.let(::parseNormalizedPath)
                ?: processEnv["GRADLE_USER_HOME"]?.takeIf { it.isNotBlank() }?.let(::parseNormalizedPath)

        val offline = exactRoot?.offline == true || java.lang.Boolean.getBoolean(LSP_GRADLE_OFFLINE_PROP)

        return GradleExecutionSpec(
            buildRoot = normalizedRoot,
            javaHome = resolvedJavaHome,
            environment = mergedEnv,
            systemProperties = exactRoot?.systemProperties ?: emptyMap(),
            gradleUserHome = gradleUserHome,
            offline = offline,
        )
    }

    fun validateFullJdk(
        javaHome: Path?,
        stage: AndroidRunStage,
        module: String?,
        variant: String?,
    ): Path {
        if (javaHome == null || !Files.isDirectory(javaHome)) {
            throw AndroidRunError(
                code = AndroidRunErrorCode.PREREQUISITE_MISSING,
                stage = stage,
                detail = "Gradle JDK directory is missing or invalid (${javaHome ?: "unset"}); configure a full JDK such as JDK 21",
                module = module,
                variant = variant,
            ).toException()
        }

        val binDir = javaHome.resolve("bin")
        val hasJava = Files.isRegularFile(binDir.resolve("java")) || Files.isRegularFile(binDir.resolve("java.exe"))
        if (!hasJava) {
            throw AndroidRunError(
                code = AndroidRunErrorCode.PREREQUISITE_MISSING,
                stage = stage,
                detail = "Selected JDK at $javaHome is missing bin/java; configure a full JDK such as JDK 21",
                module = module,
                variant = variant,
            ).toException()
        }

        val hasJlink = Files.isRegularFile(binDir.resolve("jlink")) || Files.isRegularFile(binDir.resolve("jlink.exe"))
        if (!hasJlink) {
            throw AndroidRunError(
                code = AndroidRunErrorCode.PREREQUISITE_MISSING,
                stage = stage,
                detail = "Selected JDK at $javaHome is missing jlink (trimmed JBR is not supported for AGP builds); configure a full JDK such as JDK 21",
                module = module,
                variant = variant,
            ).toException()
        }

        return javaHome
    }

    private fun validateBuildRoot(buildRoot: Path): Path {
        val normalized = buildRoot.toAbsolutePath().normalize()
        if (!Files.isDirectory(normalized)) {
            throw AndroidRunError(
                code = AndroidRunErrorCode.INVALID_PARAMS,
                stage = AndroidRunStage.CONFIGURING,
                detail = "Gradle buildRoot directory does not exist: $normalized",
            ).toException()
        }
        return normalized
    }

    @Suppress("UnstableApiUsage")
    @Incubating
    private fun configureOperation(
        operation: LongRunningOperation,
        spec: GradleExecutionSpec,
        tokenSource: CancellationTokenSource,
        stdout: OutputStream,
        stderr: OutputStream,
    ) {
        spec.javaHome?.let { operation.setJavaHome(it.toFile()) }
        if (spec.environment.isNotEmpty()) {
            operation.setEnvironmentVariables(spec.environment)
        }
        if (spec.systemProperties.isNotEmpty()) {
            operation.withSystemProperties(spec.systemProperties)
        }
        if (spec.offline) {
            operation.addArguments("--offline")
        }
        operation.setStandardOutput(stdout)
        operation.setStandardError(stderr)
        operation.withCancellationToken(tokenSource.token())
    }

    @OptIn(InternalCoroutinesApi::class)
    private suspend fun <T> runCancellableGradleOperation(
        spec: GradleExecutionSpec,
        stage: AndroidRunStage,
        module: String?,
        variant: String?,
        operationDescription: String,
        onOutput: (String) -> Unit,
        startOperation: (
            connection: ProjectConnection,
            tokenSource: CancellationTokenSource,
            stdout: OutputStream,
            stderr: OutputStream,
        ) -> Pair<LongRunningOperation, (ResultHandler<T>) -> Unit>,
    ): T {
        val tail = BoundedOutputTail(AndroidRunError.MAX_OUTPUT_TAIL_LENGTH)
        val emitLine: (String) -> Unit = { line ->
            tail.appendLine(line)
            onOutput(line)
        }
        val stdout = BoundedLineOutputStream(emitLine)
        val stderr = BoundedLineOutputStream(emitLine)

        currentCoroutineContext().ensureActive()
        val connector = connectorFactory(spec.buildRoot)
        spec.gradleUserHome?.let { connector.useGradleUserHomeDir(it.toFile()) }

        val connection = withContext(Dispatchers.IO) {
            connector.connect()
        }

        val tokenSource = GradleConnector.newCancellationTokenSource()
        val done = CompletableDeferred<Result<T>>()
        val currentJob = currentCoroutineContext().job
        val cancelRegistration = currentJob.invokeOnCompletion(onCancelling = true) { cause ->
            if (cause != null) {
                tokenSource.cancel()
            }
        }

        try {
            if (currentJob.isCancelled) {
                tokenSource.cancel()
                throw AndroidRunError(
                    code = AndroidRunErrorCode.CANCELLED,
                    stage = stage,
                    detail = "$operationDescription was cancelled",
                    module = module,
                    variant = variant,
                    outputTail = tail.snapshot(),
                ).toException()
            }
            val (_, invoker) = startOperation(connection, tokenSource, stdout, stderr)
            invoker(object : ResultHandler<T> {
                override fun onComplete(result: T) {
                    done.complete(Result.success(result))
                }

                override fun onFailure(failure: GradleConnectionException) {
                    done.complete(Result.failure(failure))
                }
            })

            val outcome = try {
                done.await()
            } catch (cancelled: CancellationException) {
                tokenSource.cancel()
                val settled = withContext(NonCancellable) {
                    withTimeoutOrNull(cancelCompletionWaitMs.milliseconds) {
                        done.await()
                    }
                }
                stdout.flushRemaining()
                stderr.flushRemaining()
                val baseError = AndroidRunError(
                    code = AndroidRunErrorCode.CANCELLED,
                    stage = stage,
                    detail = "$operationDescription was cancelled",
                    module = module,
                    variant = variant,
                    outputTail = tail.snapshot(),
                )
                val withCleanup = if (settled == null) {
                    baseError.withCleanupError("Timed out waiting ${cancelCompletionWaitMs}ms for Gradle operation completion after cancellation")
                } else {
                    baseError
                }
                throw withCleanup.toException(cancelled)
            }

            stdout.flushRemaining()
            stderr.flushRemaining()

            return outcome.getOrElse { failure ->
                if (failure is BuildCancelledException || hasCause<BuildCancelledException>(failure)) {
                    throw AndroidRunError(
                        code = AndroidRunErrorCode.CANCELLED,
                        stage = stage,
                        detail = "$operationDescription was cancelled",
                        module = module,
                        variant = variant,
                        outputTail = tail.snapshot(),
                    ).toException(failure)
                }
                val detail = summarizeGradleFailure(operationDescription, failure)
                throw AndroidRunError(
                    code = AndroidRunErrorCode.BUILD_FAILED,
                    stage = stage,
                    detail = detail,
                    module = module,
                    variant = variant,
                    outputTail = tail.snapshot(),
                ).toException(failure)
            }
        } finally {
            cancelRegistration.dispose()
            // A dispatcher change must not replace the operation error on return to a cancelled job.
            withContext(NonCancellable) {
                withContext(Dispatchers.IO) {
                    runCatching { stdout.flushRemaining() }
                    runCatching { stderr.flushRemaining() }
                    runCatching { connection.close() }
                }
            }
        }
    }

    private fun validateModelCompatibility(
        modelResult: AndroidRunModelResultDto,
        moduleFilter: String?,
    ) {
        if (modelResult.versionFailureDiagnostics.isNotEmpty()) {
            val relevant = if (moduleFilter != null) {
                modelResult.versionFailureDiagnostics.filter { it.startsWith("$moduleFilter:") }
            } else {
                modelResult.versionFailureDiagnostics
            }
            if (relevant.isNotEmpty()) {
                throw AndroidRunError(
                    code = AndroidRunErrorCode.UNSUPPORTED_AGP,
                    stage = AndroidRunStage.CONFIGURING,
                    detail = "Incompatible or incomplete AGP v2 models (AGP 9.4.1 required): ${relevant.joinToString("; ")}",
                    module = moduleFilter,
                ).toException()
            }
        }

        for (project in modelResult.projects) {
            if (moduleFilter != null && project.module != moduleFilter) {
                continue
            }
            if (!isSupportedAgpVersion(project.agpVersion)) {
                throw AndroidRunError(
                    code = AndroidRunErrorCode.UNSUPPORTED_AGP,
                    stage = AndroidRunStage.CONFIGURING,
                    detail = "Unsupported AGP version '${project.agpVersion ?: "unknown"}' for ${project.module}; AGP 9.4.x is required",
                    module = project.module,
                ).toException()
            }
        }
    }

    private fun findRequiredApplicationModule(
        modelResult: AndroidRunModelResultDto,
        target: AndroidLaunchTarget.Gradle,
        normalizedRoot: Path,
    ): AndroidProjectModelDto {
        val appCandidates = modelResult.projects.filter { it.isApplication }.map { it.module }
        val match = modelResult.projects.firstOrNull { it.module == target.module }
        if (match == null) {
            val nonAndroidHint = if (target.module in modelResult.nonAndroidProjectPaths) {
                "Gradle project '${target.module}' at $normalizedRoot does not apply an Android plugin"
            } else {
                "Gradle module '${target.module}' was not found at $normalizedRoot"
            }
            val includedHint = if (modelResult.includedBuildRoots.isNotEmpty()) {
                "; includedBuilds=[${modelResult.includedBuildRoots.joinToString(", ")}]"
            } else {
                ""
            }
            throw AndroidRunError(
                code = AndroidRunErrorCode.INVALID_PARAMS,
                stage = AndroidRunStage.CONFIGURING,
                detail = "$nonAndroidHint; available application modules: [${appCandidates.joinToString(", ")}]$includedHint",
                module = target.module,
                variant = target.variant,
            ).toException()
        }

        if (!match.isApplication) {
            val code = if (match.projectType == "DYNAMIC_FEATURE") {
                AndroidRunErrorCode.UNSUPPORTED_ARTIFACT
            } else {
                AndroidRunErrorCode.INVALID_PARAMS
            }
            throw AndroidRunError(
                code = code,
                stage = AndroidRunStage.CONFIGURING,
                detail = "Gradle module '${target.module}' has projectType=${match.projectType}, expected APPLICATION; available application modules: [${
                    appCandidates.joinToString(
                        ", "
                    )
                }]",
                module = target.module,
                variant = target.variant,
            ).toException()
        }
        return match
    }

    private class CapturingAndroidLogger : ILogger {
        private val messages = ArrayList<String>()

        override fun error(t: Throwable?, msgFormat: String?, vararg args: Any?) {
            val formatted = format(msgFormat, *args)
            val detail = listOfNotNull(formatted.takeIf { it.isNotBlank() }, t?.message?.takeIf { it.isNotBlank() })
                .joinToString(": ")
            if (detail.isNotBlank()) {
                messages.add(detail)
            }
            LOG.warn(detail, t)
        }

        override fun warning(msgFormat: String?, vararg args: Any?) {
            val formatted = format(msgFormat, *args)
            if (formatted.isNotBlank()) {
                messages.add(formatted)
                LOG.info(formatted)
            }
        }

        override fun quiet(msgFormat: String?, vararg args: Any?) {
            val formatted = format(msgFormat, *args)
            if (formatted.isNotBlank()) {
                messages.add(formatted)
                LOG.info(formatted)
            }
        }


        override fun info(msgFormat: String?, vararg args: Any?) {
        }

        override fun verbose(msgFormat: String?, vararg args: Any?) {
        }

        fun summary(): String = messages.take(3).joinToString("; ")

        private fun format(msgFormat: String?, vararg args: Any?): String {
            if (msgFormat.isNullOrBlank()) return ""
            return if (args.isEmpty()) msgFormat else runCatching { String.format(msgFormat, *args) }.getOrDefault(
                msgFormat
            )
        }
    }

    private class BoundedOutputTail(private val maxChars: Int) {
        private val buffer = StringBuilder()

        @Synchronized
        fun appendLine(line: String) {
            if (buffer.isNotEmpty()) {
                buffer.append('\n')
            }
            buffer.append(line)
            if (buffer.length > maxChars) {
                buffer.delete(0, buffer.length - maxChars)
            }
        }

        @Synchronized
        fun snapshot(): String? = if (buffer.isEmpty()) null else buffer.toString()
    }

    private class BoundedLineOutputStream(
        private val onLine: (String) -> Unit,
    ) : OutputStream() {
        private val lineBytes = ByteArrayOutputStream(256)

        @Synchronized
        override fun write(b: Int) {
            if (b == '\n'.code) {
                emitBuffered()
            } else if (b != '\r'.code) {
                if (lineBytes.size() < MAX_RAW_LINE_BYTES) {
                    lineBytes.write(b)
                }
            }
        }

        @Synchronized
        override fun write(b: ByteArray, off: Int, len: Int) {
            if (off < 0 || len < 0 || off + len > b.size) {
                throw IndexOutOfBoundsException()
            }
            var start = off
            val end = off + len
            for (i in off until end) {
                if (b[i] == '\n'.code.toByte()) {
                    appendChunk(b, start, i - start)
                    emitBuffered()
                    start = i + 1
                }
            }
            if (start < end) {
                appendChunk(b, start, end - start)
            }
        }

        @Synchronized
        fun flushRemaining() {
            if (lineBytes.size() > 0) {
                emitBuffered()
            }
        }

        private fun appendChunk(b: ByteArray, off: Int, len: Int) {
            for (i in off until off + len) {
                val byteVal = b[i]
                if (byteVal == '\r'.code.toByte()) continue
                if (lineBytes.size() >= MAX_RAW_LINE_BYTES) break
                lineBytes.write(byteVal.toInt())
            }
        }

        private fun emitBuffered() {
            val raw = lineBytes.toString(StandardCharsets.UTF_8)
            lineBytes.reset()
            if (raw.isEmpty()) return
            val bounded = if (raw.length <= MAX_EMITTED_LINE_CHARS) {
                raw
            } else {
                raw.take(MAX_EMITTED_LINE_CHARS - 3) + "..."
            }
            onLine(bounded)
        }
    }

    companion object {
        const val LSP_GRADLE_USER_HOME_PROP = "com.jetbrains.ls.imports.gradle.gradleUserHome"
        const val LSP_GRADLE_OFFLINE_PROP = "com.jetbrains.ls.imports.gradle.offline"
        const val DEFAULT_CANCEL_COMPLETION_WAIT_MS = 15_000L
        private const val MAX_RAW_LINE_BYTES = 4096
        private const val MAX_EMITTED_LINE_CHARS = 1024
        private val LOG = Logger.getInstance(AndroidGradleProject::class.java)
        private val AGP_VERSION_REGEX = Regex("^(\\d+)\\.(\\d+)(?:\\.(\\d+))?.*$")

        internal fun isSupportedAgpVersion(agpVersion: String?): Boolean {
            if (agpVersion.isNullOrBlank()) return false
            val match = AGP_VERSION_REGEX.matchEntire(agpVersion.trim()) ?: return false
            val major = match.groupValues[1].toIntOrNull() ?: return false
            val minor = match.groupValues[2].toIntOrNull() ?: return false
            return major == 9 && minor >= 4
        }

        private fun parseNormalizedPath(raw: String): Path? {
            return try {
                Path.of(raw.trim()).toAbsolutePath().normalize()
            } catch (_: InvalidPathException) {
                null
            }
        }

        private inline fun <reified E : Throwable> hasCause(t: Throwable): Boolean {
            var current: Throwable? = t
            var depth = 0
            while (current != null && depth < 16) {
                if (current is E) return true
                current = current.cause
                depth++
            }
            return false
        }

        private fun summarizeGradleFailure(operationDescription: String, failure: Throwable): String {
            val messages = ArrayList<String>()
            var current: Throwable? = failure
            var depth = 0
            while (current != null && depth < 8) {
                val msg = current.message?.trim()
                if (!msg.isNullOrEmpty() && messages.lastOrNull() != msg) {
                    messages.add(msg)
                }
                current = current.cause
                depth++
            }
            return if (messages.isEmpty()) {
                "$operationDescription failed (${failure::class.java.simpleName})"
            } else {
                "$operationDescription failed: ${messages.last()}"
            }
        }
    }
}
