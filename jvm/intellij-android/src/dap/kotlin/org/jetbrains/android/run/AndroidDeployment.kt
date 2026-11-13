package org.jetbrains.android.run

import com.android.adblib.AdbSession
import com.android.adblib.ConnectedDevice
import com.android.adblib.DeviceSelector
import com.android.adblib.serialNumber
import com.android.adblib.DeviceState
import com.android.adblib.tools.debugging.jdwpProcessTracker
import com.android.adblib.tools.debugging.properties
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.InternalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.job
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.jetbrains.android.debug.AndroidDebugException
import org.jetbrains.android.debug.AndroidDebugHandles
import org.jetbrains.android.debug.AndroidDebugService
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.TimeUnit

class AndroidDeployment @JvmOverloads constructor(
    private val service: AndroidDebugService,
    private val gradleProject: AndroidGradleProject? = null,
    private val apkInspector: AndroidApkManifestInspector = AndroidApkManifestInspector(),
    private val deviceOps: AndroidDeviceOperations = AndroidProcessInspector(),
    private val installSessionFactory: (
        session: AdbSession,
        device: DeviceSelector,
        apiLevel: Int,
        userId: Int,
        deviceId: String,
        onOutput: (String) -> Unit,
    ) -> AndroidInstallSession = { session, device, apiLevel, userId, deviceId, onOutput ->
        AndroidInstallSession(
            session = session,
            device = device,
            apiLevel = apiLevel,
            userId = userId,
            deviceId = deviceId,
            onOutput = onOutput,
        )
    },
) {
    suspend fun launch(
        config: AndroidLaunchConfig,
        ownerScope: CoroutineScope,
        onStage: (AndroidRunStage) -> Unit = {},
        onOutput: (String) -> Unit = {},
    ): AndroidExecutionHandle {
        return withLinkedOwnerScope(ownerScope) { ownerJob ->
            executeLaunch(config, ownerJob, onStage, onOutput)
        }
    }

    suspend fun attach(
        config: AndroidAttachConfig,
        ownerScope: CoroutineScope,
        onStage: (AndroidRunStage) -> Unit = {},
        onOutput: (String) -> Unit = {},
    ): AndroidExecutionHandle {
        return withLinkedOwnerScope(ownerScope) { ownerJob ->
            executeAttach(config, ownerJob, onStage, onOutput)
        }
    }

    private suspend fun executeLaunch(
        config: AndroidLaunchConfig,
        ownerJob: Job,
        onStage: (AndroidRunStage) -> Unit,
        onOutput: (String) -> Unit,
    ): AndroidExecutionHandle {
        val deadlineNanos = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(config.timeoutMs.toLong())
        var currentStage = AndroidRunStage.CONFIGURING
        onStage(AndroidRunStage.CONFIGURING)

        val device = runMapped(currentStage, config.deviceId) {
            service.resolveOnlineDevice(
                deviceId = config.deviceId,
                timeoutMs = remainingMs(deadlineNanos, currentStage, config.deviceId),
            )
        }
        val apiLevel = runMapped(currentStage, device.serialNumber) {
            service.readDeviceApiLevel(device)
        }
        val deviceAbis = runMapped(currentStage, device.serialNumber) {
            service.readDeviceAbis(device)
        }
        val userId = runMapped(currentStage, device.serialNumber) {
            val resolved = config.userId ?: deviceOps.getCurrentUser(
                device,
                remainingMs(deadlineNanos, currentStage, device.serialNumber),
            )
            AndroidProcessInspector.validateUserId(resolved, device.serialNumber)
            resolved
        }

        val resolvedTarget = resolveLaunchArtifacts(
            config = config,
            device = device,
            userId = userId,
            deviceAbis = deviceAbis,
            deadlineNanos = deadlineNanos,
            onStage = { stage ->
                currentStage = stage
                onStage(stage)
            },
            onOutput = onOutput,
        )
        currentStage = AndroidRunStage.CONFIGURING

        val packageName = resolvedTarget.validated.packageName
        val deploymentKey = AndroidDebugHandles.DeploymentKey(device.serialNumber, userId, packageName)
        if (!service.handles.tryReserveDeployment(deploymentKey)) {
            throw AndroidRunException(
                AndroidRunError(
                    code = AndroidRunErrorCode.TARGET_BUSY,
                    stage = AndroidRunStage.CONFIGURING,
                    detail = "Another launch is already active for $packageName (user $userId) on ${device.serialNumber}",
                    device = device.serialNumber,
                )
            )
        }

        var published = false
        var startedIdentity: AndroidDebugHandles.ProcessInstanceIdentity? = null
        var debugHandle: AndroidDebugHandles.DebugHandle? = null

        try {
            val runningBefore = runMapped(currentStage, device.serialNumber) {
                deviceOps.queryAmsProcesses(
                    device = device,
                    packageName = packageName,
                    userId = userId,
                    timeoutMs = remainingMs(deadlineNanos, currentStage, device.serialNumber),
                )
            }
            if (runningBefore.isNotEmpty() && !config.restartApp) {
                throw AndroidRunException(
                    AndroidRunError(
                        code = AndroidRunErrorCode.TARGET_RUNNING,
                        stage = AndroidRunStage.CONFIGURING,
                        detail = "Target application $packageName (user $userId) is already running (pids=${runningBefore.map { it.pid }}); set restartApp=true to restart or use attach",
                        device = device.serialNumber,
                    )
                )
            }

            if (resolvedTarget.apksToInstall.isNotEmpty()) {
                currentStage = AndroidRunStage.INSTALLING
                onStage(AndroidRunStage.INSTALLING)
                val installBudgetMs = remainingMs(deadlineNanos, currentStage, device.serialNumber)
                val installer = installSessionFactory(
                    device.session,
                    DeviceSelector.fromSerialNumber(device.serialNumber),
                    apiLevel,
                    userId,
                    device.serialNumber,
                    onOutput,
                )
                try {
                    withTimeout(installBudgetMs) {
                        installer.install(resolvedTarget.apksToInstall)
                    }
                } catch (e: TimeoutCancellationException) {
                    throw AndroidRunException(
                        AndroidRunError(
                            code = AndroidRunErrorCode.INSTALL_FAILED,
                            stage = AndroidRunStage.INSTALLING,
                            detail = "APK installation timed out for $packageName on ${device.serialNumber}",
                            device = device.serialNumber,
                        ),
                        e,
                    )
                }
            }

            currentStage = AndroidRunStage.STARTING
            onStage(AndroidRunStage.STARTING)

            var excludedPids = emptySet<Int>()
            if (config.restartApp) {
                val runningBeforeStart = runMapped(currentStage, device.serialNumber) {
                    deviceOps.queryAmsProcesses(
                        device = device,
                        packageName = packageName,
                        userId = userId,
                        timeoutMs = remainingMs(deadlineNanos, currentStage, device.serialNumber),
                    )
                }
                if (runningBeforeStart.isNotEmpty()) {
                    runMapped(currentStage, device.serialNumber) {
                        deviceOps.forceStopPackage(
                            device = device,
                            userId = userId,
                            packageName = packageName,
                            timeoutMs = remainingMs(deadlineNanos, currentStage, device.serialNumber),
                        )
                    }
                    deviceOps.awaitPackageStopped(
                        device = device,
                        userId = userId,
                        packageName = packageName,
                        timeoutMs = minOf(remainingMs(deadlineNanos, currentStage, device.serialNumber), 3_000L),
                    )
                    excludedPids = runningBeforeStart.map { it.pid }.toSet()
                }
            }

            runMapped(currentStage, device.serialNumber) {
                deviceOps.startActivity(
                    device = device,
                    userId = userId,
                    componentName = resolvedTarget.validated.launchComponent.componentName,
                    debug = !config.noDebug,
                    timeoutMs = remainingMs(deadlineNanos, currentStage, device.serialNumber),
                )
            }

            val identity = runMapped(currentStage, device.serialNumber) {
                deviceOps.awaitProcessIdentity(
                    device = device,
                    userId = userId,
                    packageName = packageName,
                    expectedProcessName = resolvedTarget.validated.processName,
                    excludedPids = excludedPids,
                    timeoutMs = remainingMs(deadlineNanos, currentStage, device.serialNumber),
                )
            }
            startedIdentity = identity

            if (!config.noDebug) {
                currentStage = AndroidRunStage.ATTACHING
                onStage(AndroidRunStage.ATTACHING)
                debugHandle = runMapped(currentStage, device.serialNumber) {
                    service.prepareByPid(
                        device = device,
                        pid = identity.pid,
                        ownerJob = ownerJob,
                        timeoutMs = remainingMs(deadlineNanos, currentStage, device.serialNumber),
                    )
                }
            }

            val appHandle = runMapped(currentStage, device.serialNumber) {
                service.handles.recordApplication(
                    key = deploymentKey,
                    identity = identity,
                    jdwpCleanupKey = debugHandle?.cleanupKey,
                    port = debugHandle?.port,
                    ownerJob = ownerJob,
                )
            }

            val executionHandle = AndroidExecutionHandle(
                pid = identity.pid,
                deviceId = device.serialNumber,
                userId = userId,
                packageName = packageName,
                processName = identity.processName,
                port = debugHandle?.port,
                isApplication = true,
                identity = identity,
                handles = service.handles,
                device = device,
                deviceOps = deviceOps,
                isDebuggable = resolvedTarget.validated.debuggable,
                appCleanupKey = appHandle.cleanupKey,
                jdwpCleanupKey = debugHandle?.cleanupKey,
            )
            published = true
            return executionHandle
        } catch (failure: Throwable) {
            val cleanupErrors = ArrayList<String>()
            withContext(NonCancellable) {
                debugHandle?.let { dh ->
                    try {
                        service.handles.release(dh.cleanupKey)
                    } catch (t: Throwable) {
                        cleanupErrors.add(formatCleanupThrowable(t))
                    }
                }
                startedIdentity?.let { identity ->
                    try {
                        stopStartedInstanceIfAlive(device, identity)
                    } catch (t: Throwable) {
                        cleanupErrors.add(formatCleanupThrowable(t))
                    }
                }
                service.handles.cancelDeploymentReservation(deploymentKey)
            }

            if (failure is AndroidRunException) {
                if (cleanupErrors.isNotEmpty()) {
                    throw failure.withCleanupError(cleanupErrors.joinToString("; "))
                }
                throw failure
            }
            if (failure is CancellationException) {
                if (cleanupErrors.isNotEmpty()) {
                    throw AndroidRunException(
                        AndroidRunError(
                            code = AndroidRunErrorCode.CANCELLED,
                            stage = currentStage,
                            detail = "Android launch cancelled",
                            device = device.serialNumber,
                        ).withCleanupError(cleanupErrors.joinToString("; ")),
                        failure,
                    )
                }
                throw failure
            }
            val mapped = mapToRunException(failure, currentStage, device.serialNumber)
            if (cleanupErrors.isNotEmpty()) {
                throw mapped.withCleanupError(cleanupErrors.joinToString("; "))
            }
            throw mapped
        } finally {
            if (!published) {
                service.handles.cancelDeploymentReservation(deploymentKey)
            }
        }
    }

    private suspend fun executeAttach(
        config: AndroidAttachConfig,
        ownerJob: Job,
        onStage: (AndroidRunStage) -> Unit,
        @Suppress("UNUSED_PARAMETER") onOutput: (String) -> Unit,
    ): AndroidExecutionHandle {
        val currentStage = AndroidRunStage.CONFIGURING
        onStage(AndroidRunStage.CONFIGURING)

        val device = runMapped(currentStage, config.deviceId) {
            service.resolveOnlineDevice(
                deviceId = config.deviceId,
                timeoutMs = DEFAULT_ATTACH_TIMEOUT_MS,
            )
        }
        val userId = runMapped(currentStage, device.serialNumber) {
            val resolved = config.userId ?: deviceOps.getCurrentUser(device, DEFAULT_ATTACH_TIMEOUT_MS)
            AndroidProcessInspector.validateUserId(resolved, device.serialNumber)
            resolved
        }

        onStage(AndroidRunStage.ATTACHING)
        val attachStage = AndroidRunStage.ATTACHING

        val identity = selectAttachProcessIdentity(config, device, userId, attachStage)
        var debugHandle: AndroidDebugHandles.DebugHandle? = null
        var published = false
        try {
            debugHandle = runMapped(attachStage, device.serialNumber) {
                service.prepareByPid(
                    device = device,
                    pid = identity.pid,
                    ownerJob = ownerJob,
                    timeoutMs = DEFAULT_ATTACH_TIMEOUT_MS,
                )
            }
            val resolvedProcessName =
                if (identity.processName == "pid:${identity.pid}" && debugHandle.processName.isNotBlank()) {
                    debugHandle.processName
                } else {
                    identity.processName
                }
            val resolvedIdentity = identity.copy(processName = resolvedProcessName)
            val executionHandle = AndroidExecutionHandle(
                pid = resolvedIdentity.pid,
                deviceId = device.serialNumber,
                userId = userId,
                packageName = config.packageName,
                processName = resolvedIdentity.processName,
                port = debugHandle.port,
                isApplication = false,
                identity = resolvedIdentity,
                handles = service.handles,
                device = device,
                deviceOps = deviceOps,
                isDebuggable = true,
                appCleanupKey = null,
                jdwpCleanupKey = debugHandle.cleanupKey,
            )
            published = true
            return executionHandle
        } catch (failure: Throwable) {
            val cleanupErrors = ArrayList<String>()
            withContext(NonCancellable) {
                if (!published && debugHandle != null) {
                    try {
                        service.handles.release(debugHandle.cleanupKey)
                    } catch (t: Throwable) {
                        cleanupErrors.add(formatCleanupThrowable(t))
                    }
                }
            }
            if (failure is AndroidRunException) {
                if (cleanupErrors.isNotEmpty()) {
                    throw failure.withCleanupError(cleanupErrors.joinToString("; "))
                }
                throw failure
            }
            if (failure is CancellationException) {
                if (cleanupErrors.isNotEmpty()) {
                    throw AndroidRunException(
                        AndroidRunError(
                            code = AndroidRunErrorCode.CANCELLED,
                            stage = attachStage,
                            detail = "Android attach cancelled",
                            device = device.serialNumber,
                        ).withCleanupError(cleanupErrors.joinToString("; ")),
                        failure,
                    )
                }
                throw failure
            }
            val mapped = mapToRunException(failure, attachStage, device.serialNumber)
            if (cleanupErrors.isNotEmpty()) {
                throw mapped.withCleanupError(cleanupErrors.joinToString("; "))
            }
            throw mapped
        }
    }

    private suspend fun selectAttachProcessIdentity(
        config: AndroidAttachConfig,
        device: ConnectedDevice,
        userId: Int,
        stage: AndroidRunStage,
    ): AndroidDebugHandles.ProcessInstanceIdentity {
        val amsProcesses = runMapped(stage, device.serialNumber) {
            deviceOps.queryAmsProcesses(
                device = device,
                packageName = config.packageName,
                userId = userId,
                timeoutMs = DEFAULT_ATTACH_TIMEOUT_MS,
            )
        }

        if (config.pid != null) {
            val amsMatch = amsProcesses.firstOrNull { it.pid == config.pid }
            if (amsMatch != null) {
                return amsMatch
            }
            val allUserProcesses = runMapped(stage, device.serialNumber) {
                deviceOps.queryAmsProcesses(
                    device = device,
                    packageName = config.packageName,
                    userId = null,
                    timeoutMs = DEFAULT_ATTACH_TIMEOUT_MS,
                )
            }
            val wrongUserMatch = allUserProcesses.firstOrNull { it.pid == config.pid }
            if (wrongUserMatch != null) {
                throw AndroidRunException(
                    AndroidRunError(
                        code = AndroidRunErrorCode.START_FAILED,
                        stage = stage,
                        detail = "Process PID ${config.pid} for ${config.packageName} belongs to user ${wrongUserMatch.userId}, not user $userId",
                        device = device.serialNumber,
                    )
                )
            }
            val jdwpProc = device.jdwpProcessTracker.processesFlow.value.firstOrNull { it.pid == config.pid }
            if (jdwpProc != null && AndroidDebugService.matchesPackageName(jdwpProc.properties, config.packageName)) {
                val procName = if (jdwpProc.properties.processName.hasValue) {
                    jdwpProc.properties.processName.getOrThrow()
                } else {
                    "pid:${config.pid}"
                }
                return AndroidDebugHandles.ProcessInstanceIdentity(
                    pid = config.pid,
                    userId = userId,
                    packageName = config.packageName,
                    processName = procName,
                )
            }
            throw AndroidRunException(
                AndroidRunError(
                    code = AndroidRunErrorCode.START_FAILED,
                    stage = stage,
                    detail = "Process PID ${config.pid} is not running for ${config.packageName} (user $userId)",
                    device = device.serialNumber,
                )
            )
        }

        if (config.processName != null) {
            val matches = amsProcesses.filter { it.processName == config.processName }
            if (matches.isEmpty()) {
                throw AndroidRunException(
                    AndroidRunError(
                        code = AndroidRunErrorCode.START_FAILED,
                        stage = stage,
                        detail = "No running process named '${config.processName}' found for ${config.packageName} (user $userId)",
                        device = device.serialNumber,
                    )
                )
            }
            if (matches.size > 1) {
                val summary = matches.sortedBy { it.pid }.joinToString(", ") { "${it.pid}:${it.processName}" }
                throw AndroidRunException(
                    AndroidRunError(
                        code = AndroidRunErrorCode.AMBIGUOUS_PROCESS,
                        stage = stage,
                        detail = "Multiple processes match '${config.processName}' for ${config.packageName} (user $userId): $summary; specify android.pid",
                        device = device.serialNumber,
                    )
                )
            }
            return matches[0]
        }

        if (amsProcesses.isEmpty()) {
            throw AndroidRunException(
                AndroidRunError(
                    code = AndroidRunErrorCode.START_FAILED,
                    stage = stage,
                    detail = "No running process found for ${config.packageName} (user $userId)",
                    device = device.serialNumber,
                )
            )
        }
        if (amsProcesses.size > 1) {
            val summary = amsProcesses.sortedBy { it.pid }.joinToString(", ") { "${it.pid}:${it.processName}" }
            throw AndroidRunException(
                AndroidRunError(
                    code = AndroidRunErrorCode.AMBIGUOUS_PROCESS,
                    stage = stage,
                    detail = "Multiple processes match package ${config.packageName} (user $userId): $summary; specify android.pid or android.processName",
                    device = device.serialNumber,
                )
            )
        }
        return amsProcesses[0]
    }

    private data class ResolvedTargetArtifacts(
        val validated: ValidatedApkSet,
        val apksToInstall: List<Path>,
    )

    private suspend fun resolveLaunchArtifacts(
        config: AndroidLaunchConfig,
        device: ConnectedDevice,
        userId: Int,
        deviceAbis: List<String>,
        deadlineNanos: Long,
        onStage: (AndroidRunStage) -> Unit,
        onOutput: (String) -> Unit,
    ): ResolvedTargetArtifacts {
        return when (val target = config.target) {
            is AndroidLaunchTarget.Gradle -> {
                val project = gradleProject ?: AndroidGradleProject()
                val built = project.resolveAndBuild(
                    target = target,
                    deviceAbis = deviceAbis,
                    onStage = onStage,
                    onOutput = onOutput,
                )
                onStage(AndroidRunStage.CONFIGURING)
                val validated = apkInspector.validateAndResolveLaunch(
                    apks = built.resolvedPaths,
                    deviceAbis = deviceAbis,
                    requestedActivity = config.activity,
                    requireDebuggable = !config.noDebug,
                    expectedPackageName = built.applicationId,
                    deviceId = device.serialNumber,
                )
                ResolvedTargetArtifacts(validated = validated, apksToInstall = built.resolvedPaths)
            }

            is AndroidLaunchTarget.Apks -> {
                val validated = apkInspector.validateAndResolveLaunch(
                    apks = target.files,
                    deviceAbis = deviceAbis,
                    requestedActivity = config.activity,
                    requireDebuggable = !config.noDebug,
                    expectedPackageName = null,
                    deviceId = device.serialNumber,
                )
                ResolvedTargetArtifacts(validated = validated, apksToInstall = target.files)
            }

            is AndroidLaunchTarget.Installed -> {
                val remotePaths = deviceOps.resolveInstalledApkPaths(
                    device = device,
                    userId = userId,
                    packageName = target.packageName,
                    timeoutMs = remainingMs(deadlineNanos, AndroidRunStage.CONFIGURING, device.serialNumber),
                )
                val tempDir = withContext(Dispatchers.IO) {
                    Files.createTempDirectory("omp-android-installed-")
                }
                try {
                    var selectedValidated: ValidatedApkSet? = null
                    var lastError: AndroidRunException? = null
                    for ((index, remotePath) in remotePaths.withIndex()) {
                        val localApk = tempDir.resolve("apk-$index.apk")
                        deviceOps.pullFile(
                            device = device,
                            remotePath = remotePath,
                            destination = localApk,
                            timeoutMs = remainingMs(deadlineNanos, AndroidRunStage.CONFIGURING, device.serialNumber),
                        )
                        val inspected = apkInspector.inspectApk(localApk)
                        if (inspected.splitName != null) {
                            continue
                        }
                        try {
                            selectedValidated = apkInspector.validateAndResolveLaunch(
                                apks = listOf(localApk),
                                deviceAbis = deviceAbis,
                                requestedActivity = config.activity,
                                requireDebuggable = !config.noDebug,
                                expectedPackageName = target.packageName,
                                deviceId = device.serialNumber,
                            )
                            break
                        } catch (e: AndroidRunException) {
                            lastError = e
                            break
                        }
                    }
                    if (lastError != null) {
                        throw lastError
                    }
                    val validated = selectedValidated ?: throw AndroidRunException(
                        AndroidRunError(
                            code = AndroidRunErrorCode.ARTIFACT_INVALID,
                            stage = AndroidRunStage.CONFIGURING,
                            detail = "Installed package ${target.packageName} has no base APK at ${remotePaths.joinToString()}",
                            device = device.serialNumber,
                        )
                    )
                    ResolvedTargetArtifacts(validated = validated, apksToInstall = emptyList())
                } finally {
                    withContext(Dispatchers.IO + NonCancellable) {
                        tempDir.toFile().deleteRecursively()
                    }
                }
            }
        }
    }

    private suspend fun stopStartedInstanceIfAlive(
        device: ConnectedDevice,
        identity: AndroidDebugHandles.ProcessInstanceIdentity,
    ) {
        if (device.deviceInfoFlow.value.deviceState != DeviceState.ONLINE) {
            return
        }
        val current = deviceOps.queryAmsProcesses(device, identity.packageName, identity.userId, 5_000L)
        if (current.any { identity.matchesInstance(it) }) {
            deviceOps.forceStopPackage(device, identity.userId, identity.packageName, 5_000L)
        }
    }

    @OptIn(InternalCoroutinesApi::class)
    private suspend fun <T> withLinkedOwnerScope(
        ownerScope: CoroutineScope,
        block: suspend (ownerJob: Job) -> T,
    ): T {
        val ownerJob = ownerScope.coroutineContext.job
        if (ownerJob.isCancelled || ownerJob.isCompleted) {
            throw CancellationException("Owner DAP connection scope is already closed")
        }
        return coroutineScope {
            val workJob = coroutineContext.job
            val registration = ownerJob.invokeOnCompletion(onCancelling = true) { cause ->
                workJob.cancel(
                    CancellationException(cause?.message ?: "Owner DAP connection closed", cause)
                )
            }
            try {
                if (ownerJob.isCancelled || ownerJob.isCompleted) {
                    throw CancellationException("Owner DAP connection scope was cancelled")
                }
                block(ownerJob)
            } finally {
                registration.dispose()
            }
        }
    }

    private suspend fun <T> runMapped(
        stage: AndroidRunStage,
        deviceId: String?,
        block: suspend () -> T,
    ): T {
        return try {
            block()
        } catch (e: AndroidRunException) {
            throw e
        } catch (e: AndroidDebugException) {
            throw mapDebugException(e, stage, deviceId)
        } catch (e: TimeoutCancellationException) {
            throw AndroidRunException(
                AndroidRunError(
                    code = timeoutCodeForStage(stage),
                    stage = stage,
                    detail = e.message ?: "Operation timed out during ${stage.wireName}",
                    device = deviceId,
                ),
                e,
            )
        }
    }

    private fun remainingMs(deadlineNanos: Long, stage: AndroidRunStage, deviceId: String?): Long {
        val rem = TimeUnit.NANOSECONDS.toMillis(deadlineNanos - System.nanoTime())
        if (rem <= 0) {
            throw AndroidRunException(
                AndroidRunError(
                    code = timeoutCodeForStage(stage),
                    stage = stage,
                    detail = "Android deployment timed out during ${stage.wireName}",
                    device = deviceId,
                )
            )
        }
        return rem
    }

    private fun timeoutCodeForStage(stage: AndroidRunStage): AndroidRunErrorCode = when (stage) {
        AndroidRunStage.CONFIGURING -> AndroidRunErrorCode.DEVICE_OFFLINE
        AndroidRunStage.BUILDING -> AndroidRunErrorCode.BUILD_FAILED
        AndroidRunStage.INSTALLING -> AndroidRunErrorCode.INSTALL_FAILED
        AndroidRunStage.STARTING, AndroidRunStage.ATTACHING -> AndroidRunErrorCode.START_FAILED
        AndroidRunStage.CLEANUP -> AndroidRunErrorCode.CLEANUP_FAILED
    }

    private fun mapToRunException(
        t: Throwable,
        stage: AndroidRunStage,
        deviceId: String?,
    ): AndroidRunException {
        return when (t) {
            is AndroidRunException -> t
            is AndroidDebugException -> mapDebugException(t, stage, deviceId)
            is TimeoutCancellationException -> AndroidRunException(
                AndroidRunError(
                    code = timeoutCodeForStage(stage),
                    stage = stage,
                    detail = t.message ?: "Operation timed out during ${stage.wireName}",
                    device = deviceId,
                ),
                t,
            )

            else -> AndroidRunException(
                AndroidRunError(
                    code = timeoutCodeForStage(stage),
                    stage = stage,
                    detail = t.message ?: t::class.java.simpleName,
                    device = deviceId,
                ),
                t,
            )
        }
    }

    private fun mapDebugException(
        e: AndroidDebugException,
        stage: AndroidRunStage,
        deviceId: String?,
    ): AndroidRunException {
        val code = when (e.reason) {
            "invalid_params" -> AndroidRunErrorCode.INVALID_PARAMS
            "adb_not_found", "adb_unavailable", "prerequisite_missing" -> AndroidRunErrorCode.PREREQUISITE_MISSING
            "no_device", "unauthorized_device", "device_offline" -> AndroidRunErrorCode.DEVICE_OFFLINE
            "lease_conflict", "target_busy" -> AndroidRunErrorCode.TARGET_BUSY
            "target_running" -> AndroidRunErrorCode.TARGET_RUNNING
            "ambiguous_process" -> AndroidRunErrorCode.AMBIGUOUS_PROCESS
            "not_jdwp", "not_debuggable" -> AndroidRunErrorCode.NOT_DEBUGGABLE
            "cleanup_failed" -> AndroidRunErrorCode.CLEANUP_FAILED
            "process_not_found", "target_changed", "proxy_failed", "timeout" -> timeoutCodeForStage(stage)
            else -> timeoutCodeForStage(stage)
        }
        return AndroidRunException(
            AndroidRunError(
                code = code,
                stage = stage,
                detail = e.message ?: e.reason,
                device = deviceId,
            ),
            e,
        )
    }

    private fun formatCleanupThrowable(t: Throwable): String {
        return if (t is AndroidRunException) {
            t.error.formattedWireMessage()
        } else {
            t.message?.takeIf { it.isNotBlank() } ?: t::class.java.simpleName
        }
    }

    companion object {
        const val DEFAULT_ATTACH_TIMEOUT_MS: Long = 10_000L
    }
}
