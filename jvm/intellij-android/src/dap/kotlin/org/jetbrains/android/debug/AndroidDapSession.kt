package org.jetbrains.android.debug

import com.jetbrains.dap.protocol.AttachRequestArguments
import com.jetbrains.dap.protocol.Breakpoint
import com.jetbrains.dap.protocol.BreakpointLocationsArguments
import com.jetbrains.dap.protocol.BreakpointLocationsResponse
import com.jetbrains.dap.protocol.BreakpointReason
import com.jetbrains.dap.protocol.CancelArguments
import com.jetbrains.dap.protocol.Capabilities
import com.jetbrains.dap.protocol.CapabilitiesEventArguments
import com.jetbrains.dap.protocol.CompletionsArguments
import com.jetbrains.dap.protocol.CompletionsResponse
import com.jetbrains.dap.protocol.ConfigurationDoneArguments
import com.jetbrains.dap.protocol.ContinueArguments
import com.jetbrains.dap.protocol.ContinueResponse
import com.jetbrains.dap.protocol.DapClient
import com.jetbrains.dap.protocol.DapException
import com.jetbrains.dap.protocol.DapLine
import com.jetbrains.dap.protocol.DapRequestFailedException
import com.jetbrains.dap.protocol.DapServer
import com.jetbrains.dap.protocol.DataBreakpointInfoArguments
import com.jetbrains.dap.protocol.DataBreakpointInfoResponse
import com.jetbrains.dap.protocol.DisassembleArguments
import com.jetbrains.dap.protocol.DisassembleResponse
import com.jetbrains.dap.protocol.DisconnectArguments
import com.jetbrains.dap.protocol.EvaluateArguments
import com.jetbrains.dap.protocol.EvaluateResponse
import com.jetbrains.dap.protocol.ExceptionInfoArguments
import com.jetbrains.dap.protocol.ExceptionInfoResponse
import com.jetbrains.dap.protocol.GotoArguments
import com.jetbrains.dap.protocol.GotoTargetsArguments
import com.jetbrains.dap.protocol.GotoTargetsResponse
import com.jetbrains.dap.protocol.InitializeRequestArguments
import com.jetbrains.dap.protocol.InitializedEventArguments
import com.jetbrains.dap.protocol.LaunchRequestArguments
import com.jetbrains.dap.protocol.LoadedSourcesArguments
import com.jetbrains.dap.protocol.LoadedSourcesResponse
import com.jetbrains.dap.protocol.LocationsArguments
import com.jetbrains.dap.protocol.LocationsResponse
import com.jetbrains.dap.protocol.MessageId
import com.jetbrains.dap.protocol.ModulesArguments
import com.jetbrains.dap.protocol.ModulesResponse
import com.jetbrains.dap.protocol.NextArguments
import com.jetbrains.dap.protocol.OutputCategory
import com.jetbrains.dap.protocol.OutputEventArguments
import com.jetbrains.dap.protocol.PauseArguments
import com.jetbrains.dap.protocol.ProgressEndEventArguments
import com.jetbrains.dap.protocol.ProgressStartEventArguments
import com.jetbrains.dap.protocol.ProgressUpdateEventArguments
import com.jetbrains.dap.protocol.ReadMemoryArguments
import com.jetbrains.dap.protocol.ReadMemoryResponse
import com.jetbrains.dap.protocol.RestartArguments
import com.jetbrains.dap.protocol.RestartFrameArguments
import com.jetbrains.dap.protocol.ReverseContinueArguments
import com.jetbrains.dap.protocol.ScopesArguments
import com.jetbrains.dap.protocol.ScopesResponse
import com.jetbrains.dap.protocol.SetBreakpointsArguments
import com.jetbrains.dap.protocol.SetBreakpointsResponse
import com.jetbrains.dap.protocol.SetDataBreakpointsArguments
import com.jetbrains.dap.protocol.SetDataBreakpointsResponse
import com.jetbrains.dap.protocol.SetExceptionBreakpointsArguments
import com.jetbrains.dap.protocol.SetExceptionBreakpointsResponse
import com.jetbrains.dap.protocol.SetExpressionArguments
import com.jetbrains.dap.protocol.SetExpressionResponse
import com.jetbrains.dap.protocol.SetFunctionBreakpointsArguments
import com.jetbrains.dap.protocol.SetFunctionBreakpointsResponse
import com.jetbrains.dap.protocol.SetInstructionBreakpointsArguments
import com.jetbrains.dap.protocol.SetInstructionBreakpointsResponse
import com.jetbrains.dap.protocol.SetVariableArguments
import com.jetbrains.dap.protocol.SetVariableResponse
import com.jetbrains.dap.protocol.SourceArguments
import com.jetbrains.dap.protocol.SourceResponse
import com.jetbrains.dap.protocol.StackTraceArguments
import com.jetbrains.dap.protocol.StackTraceResponse
import com.jetbrains.dap.protocol.StepBackArguments
import com.jetbrains.dap.protocol.StepInArguments
import com.jetbrains.dap.protocol.StepInTargetsArguments
import com.jetbrains.dap.protocol.StepInTargetsResponse
import com.jetbrains.dap.protocol.StepOutArguments
import com.jetbrains.dap.protocol.TerminateArguments
import com.jetbrains.dap.protocol.TerminateThreadsArguments
import com.jetbrains.dap.protocol.ThreadDumpArguments
import com.jetbrains.dap.protocol.ThreadDumpResponse
import com.jetbrains.dap.protocol.ThreadsResponse
import com.jetbrains.dap.protocol.VariablesArguments
import com.jetbrains.dap.protocol.VariablesResponse
import com.jetbrains.dap.protocol.WriteMemoryArguments
import com.jetbrains.dap.protocol.WriteMemoryResponse
import com.jetbrains.dap.protocol.currentDapRequest
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.cancel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.isActive
import kotlinx.coroutines.job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.jetbrains.android.run.AndroidAttachConfig
import org.jetbrains.android.run.AndroidDeployment
import org.jetbrains.android.run.AndroidExecutionHandle
import org.jetbrains.android.run.AndroidGradleContext
import org.jetbrains.android.run.AndroidGradleProject
import org.jetbrains.android.run.AndroidLaunchArguments
import org.jetbrains.android.run.AndroidLaunchConfig
import org.jetbrains.android.run.AndroidProcessExit
import org.jetbrains.android.run.AndroidRunError
import org.jetbrains.android.run.AndroidRunErrorCode
import org.jetbrains.android.run.AndroidRunException
import org.jetbrains.android.run.AndroidRunStage
import org.jetbrains.annotations.ApiStatus
import org.jetbrains.annotations.TestOnly
import java.nio.file.Path
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlin.time.Duration.Companion.milliseconds

interface AndroidRunHandle {
    val pid: Int
    val deviceId: String
    val userId: Int
    val packageName: String
    val processName: String
    val port: Int?
    val isApplication: Boolean

    suspend fun close(terminateApplication: Boolean)
    suspend fun awaitExit(): AndroidProcessExit
}

interface AndroidRunBackend {
    suspend fun launch(
        config: AndroidLaunchConfig,
        ownerScope: CoroutineScope,
        onStage: (AndroidRunStage) -> Unit,
        onOutput: (String) -> Unit,
    ): AndroidRunHandle

    suspend fun attach(
        config: AndroidAttachConfig,
        ownerScope: CoroutineScope,
        onStage: (AndroidRunStage) -> Unit,
        onOutput: (String) -> Unit,
    ): AndroidRunHandle
}

class DefaultAndroidRunBackend(
    private val gradleContext: AndroidGradleContext,
    private val service: AndroidDebugService,
) : AndroidRunBackend {

    private val deployment by lazy(LazyThreadSafetyMode.SYNCHRONIZED) {
        AndroidDeployment(
            service = service,
            gradleProject = AndroidGradleProject(gradleContext),
        )
    }

    override suspend fun launch(
        config: AndroidLaunchConfig,
        ownerScope: CoroutineScope,
        onStage: (AndroidRunStage) -> Unit,
        onOutput: (String) -> Unit,
    ): AndroidRunHandle {
        val handle = deployment.launch(config, ownerScope, onStage, onOutput)
        return ExecutionHandleAdapter(handle)
    }

    override suspend fun attach(
        config: AndroidAttachConfig,
        ownerScope: CoroutineScope,
        onStage: (AndroidRunStage) -> Unit,
        onOutput: (String) -> Unit,
    ): AndroidRunHandle {
        val handle = deployment.attach(config, ownerScope, onStage, onOutput)
        return ExecutionHandleAdapter(handle)
    }

    private class ExecutionHandleAdapter(
        private val delegate: AndroidExecutionHandle,
    ) : AndroidRunHandle {
        override val pid: Int get() = delegate.pid
        override val deviceId: String get() = delegate.deviceId
        override val userId: Int get() = delegate.userId
        override val packageName: String get() = delegate.packageName
        override val processName: String get() = delegate.processName
        override val port: Int? get() = delegate.port
        override val isApplication: Boolean get() = delegate.isApplication

        override suspend fun close(terminateApplication: Boolean) {
            delegate.close(terminateApplication)
        }

        override suspend fun awaitExit(): AndroidProcessExit = delegate.awaitExit()
    }
}

@ApiStatus.Experimental
@Suppress("UnstableApiUsage")
class AndroidDapSession(
    private val projectDirectory: Path?,
    private val scope: CoroutineScope,
    private val serverStoppedSignal: CompletableDeferred<Unit> = CompletableDeferred(),
    private val nativeStoppedSignal: CompletableDeferred<Unit>,
    private val backend: AndroidRunBackend,
    private val sourceConverter: AndroidDapSourceConverter = AndroidDapSourceConverter(),
    private val downstreamClient: DapClient,
    nativeFactory: (DapClient) -> DapServer,
) : DapServer {

    @TestOnly
    constructor(
        native: DapServer,
        client: DapClient,
        projectDirectory: Path?,
        scope: CoroutineScope,
        serverStoppedSignal: CompletableDeferred<Unit> = CompletableDeferred(),
        nativeStoppedSignal: CompletableDeferred<Unit> = CompletableDeferred(Unit),
        backend: AndroidRunBackend,
        sourceConverter: AndroidDapSourceConverter = AndroidDapSourceConverter(),
    ) : this(
        projectDirectory = projectDirectory,
        scope = scope,
        serverStoppedSignal = serverStoppedSignal,
        nativeStoppedSignal = nativeStoppedSignal,
        backend = backend,
        sourceConverter = sourceConverter,
        downstreamClient = client,
        nativeFactory = { _ -> native },
    )

    private enum class SessionMode {
        UNSTARTED,
        LAUNCH_DEBUG,
        LAUNCH_NO_DEBUG,
        EXTERNAL_ATTACH,
    }

    private val sessionMode = AtomicReference(SessionMode.UNSTARTED)
    private val started = AtomicBoolean(false)
    private val disconnectHandled = AtomicBoolean(false)
    private val cleanupStarted = AtomicBoolean(false)
    private val cleanupDeferred = CompletableDeferred<Unit>()
    private val noDebugConfigurationDone = CompletableDeferred<Unit>()

    private val activeHandle = AtomicReference<AndroidRunHandle?>(null)
    private val activeDeviceId = AtomicReference<String?>(null)
    private val currentCapabilities = AtomicReference<Capabilities?>(null)
    private val supportTerminateDebuggeeFlag = AtomicBoolean(false)
    private val isNoDebugSession = AtomicBoolean(false)

    @Volatile
    private var supportsProgressReporting: Boolean = false

    private val startupLock = Any()
    private var startupJob: Job? = null
    private var startupRequestId: MessageId? = null
    private var startupCancelledReason: String? = null

    @Volatile
    private var exitObserverJob: Job? = null

    private val startupOutputBytes = AtomicInteger(0)
    private val cleanupScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private val eventFilter = AndroidDapEventFilter(
        downstream = downstreamClient,
        sourceConverter = sourceConverter,
        processIdentityProvider = { currentProcessIdentity() },
        capabilitiesPatcher = { caps ->
            patchCapabilities(
                caps = caps,
                noDebug = isNoDebugSession.get(),
                supportTerminateDebuggee = supportTerminateDebuggeeFlag.get(),
            )
        },
        onNativeTerminated = {
            if (cleanupStarted.compareAndSet(false, true)) {
                cleanupScope.launch {
                    try {
                        runCleanup(
                            terminateRequested = false,
                            disconnectNative = false,
                            restartArg = null,
                            emitErrorOutputOnFailure = true,
                        )
                    } finally {
                        cleanupScope.cancel()
                    }
                }
            }
        },
    )

    private val native: DapServer = nativeFactory(eventFilter)

    init {
        scope.coroutineContext.job.invokeOnCompletion {
            cancelActiveStartup("Android DAP connection closed")
            exitObserverJob?.cancel()
            if (cleanupStarted.compareAndSet(false, true)) {
                val terminateOnClose = activeHandle.get()?.isApplication == true
                cleanupScope.launch {
                    try {
                        runCleanup(
                            terminateRequested = terminateOnClose,
                            disconnectNative = false,
                            restartArg = null,
                            emitErrorOutputOnFailure = false,
                        )
                    } finally {
                        serverStoppedSignal.complete(Unit)
                        cleanupScope.cancel()
                    }
                }
            } else if (cleanupDeferred.isCompleted) {
                serverStoppedSignal.complete(Unit)
                cleanupScope.cancel()
            } else {
                cleanupDeferred.invokeOnCompletion {
                    serverStoppedSignal.complete(Unit)
                    cleanupScope.cancel()
                }
            }
        }
    }

    override suspend fun initialize(args: InitializeRequestArguments): Capabilities {
        supportsProgressReporting = args.supportsProgressReporting == true
        sourceConverter.useUriPathFormat =
            args.pathFormat?.value?.equals("uri", ignoreCase = true) == true

        val nativeCapabilities = checkNotNull(native.initialize(args.copy(adapterID = NATIVE_ADAPTER_ID)))
        val exposed = patchCapabilities(
            caps = nativeCapabilities,
            noDebug = isNoDebugSession.get(),
            supportTerminateDebuggee = supportTerminateDebuggeeFlag.get(),
        )
        currentCapabilities.set(exposed)
        return exposed
    }

    override suspend fun launch(args: LaunchRequestArguments) {
        if (!started.compareAndSet(false, true)) {
            throw AndroidRunError(
                code = AndroidRunErrorCode.INVALID_PARAMS,
                stage = AndroidRunStage.CONFIGURING,
                detail = "launch/attach can only be called once per DAP session",
            ).toDapException()
        }
        if (cleanupStarted.get()) {
            throw AndroidRunError(
                code = AndroidRunErrorCode.INVALID_PARAMS,
                stage = AndroidRunStage.CONFIGURING,
                detail = "DAP session is already closed",
            ).toDapException()
        }

        val projectDir = projectDirectory ?: throw AndroidRunError(
            code = AndroidRunErrorCode.INVALID_PARAMS,
            stage = AndroidRunStage.CONFIGURING,
            detail = "Workspace project directory is unavailable",
        ).toDapException()

        val config = AndroidLaunchArguments.parseLaunch(args, projectDir)
        activeDeviceId.set(config.deviceId)
        val noDebug = config.noDebug
        isNoDebugSession.set(noDebug)
        sessionMode.set(if (noDebug) SessionMode.LAUNCH_NO_DEBUG else SessionMode.LAUNCH_DEBUG)

        val requestId = currentDapRequest()?.requestId
        runStartupBlock(
            requestId = requestId,
            isAttach = false,
            deviceId = config.deviceId,
            timeoutMs = config.timeoutMs.toLong(),
        ) { onStage, onOutput ->
            val handle = backend.launch(
                config = config,
                ownerScope = scope,
                onStage = onStage,
                onOutput = onOutput,
            )
            activeHandle.set(handle)
            supportTerminateDebuggeeFlag.set(true)

            if (noDebug) {
                val noDebugCaps = patchCapabilities(
                    caps = currentCapabilities.get() ?: Capabilities(),
                    noDebug = true,
                    supportTerminateDebuggee = true,
                )
                currentCapabilities.set(noDebugCaps)
                eventFilter.capabilities(CapabilitiesEventArguments(noDebugCaps))
                eventFilter.initialized(InitializedEventArguments())
                noDebugConfigurationDone.await()
                eventFilter.emitAndroidProcessIfNeeded(
                    AndroidProcessIdentity(
                        name = handle.processName.ifBlank { handle.packageName },
                        pid = handle.pid,
                        isExternalAttach = false,
                    )
                )
            } else {
                val ownedCaps = patchCapabilities(
                    caps = currentCapabilities.get() ?: Capabilities(),
                    noDebug = false,
                    supportTerminateDebuggee = true,
                )
                currentCapabilities.set(ownedCaps)
                eventFilter.capabilities(CapabilitiesEventArguments(ownedCaps))
                onStage(AndroidRunStage.ATTACHING)
                val jdwpPort = handle.port ?: throw AndroidRunError(
                    code = AndroidRunErrorCode.START_FAILED,
                    stage = AndroidRunStage.ATTACHING,
                    detail = "JDWP proxy port unavailable for debug launch",
                    device = config.deviceId,
                ).toException()
                native.attach(
                    AttachRequestArguments(
                        restart = null,
                        port = jdwpPort,
                        adapterArguments = args.adapterArguments,
                    )
                )
                eventFilter.emitAndroidProcessIfNeeded(
                    AndroidProcessIdentity(
                        name = handle.processName.ifBlank { handle.packageName },
                        pid = handle.pid,
                        isExternalAttach = false,
                    )
                )
            }
            startProcessExitObserver(handle)
        }
    }

    override suspend fun attach(args: AttachRequestArguments) {
        if (!started.compareAndSet(false, true)) {
            throw AndroidRunError(
                code = AndroidRunErrorCode.INVALID_PARAMS,
                stage = AndroidRunStage.CONFIGURING,
                detail = "launch/attach can only be called once per DAP session",
            ).toDapException()
        }
        if (cleanupStarted.get()) {
            throw AndroidRunError(
                code = AndroidRunErrorCode.INVALID_PARAMS,
                stage = AndroidRunStage.CONFIGURING,
                detail = "DAP session is already closed",
            ).toDapException()
        }

        val projectDir = projectDirectory ?: throw AndroidRunError(
            code = AndroidRunErrorCode.INVALID_PARAMS,
            stage = AndroidRunStage.CONFIGURING,
            detail = "Workspace project directory is unavailable",
        ).toDapException()

        val config = AndroidLaunchArguments.parseAttach(args, projectDir)
        activeDeviceId.set(config.deviceId)
        isNoDebugSession.set(false)
        sessionMode.set(SessionMode.EXTERNAL_ATTACH)

        val requestId = currentDapRequest()?.requestId
        runStartupBlock(
            requestId = requestId,
            isAttach = true,
            deviceId = config.deviceId,
            timeoutMs = DEFAULT_ATTACH_TIMEOUT_MS,
        ) { onStage, onOutput ->
            val handle = backend.attach(
                config = config,
                ownerScope = scope,
                onStage = onStage,
                onOutput = onOutput,
            )
            activeHandle.set(handle)
            onStage(AndroidRunStage.ATTACHING)
            val jdwpPort = handle.port ?: throw AndroidRunError(
                code = AndroidRunErrorCode.START_FAILED,
                stage = AndroidRunStage.ATTACHING,
                detail = "JDWP proxy port unavailable for attach",
                device = config.deviceId,
            ).toException()
            native.attach(
                AttachRequestArguments(
                    restart = args.restart,
                    port = jdwpPort,
                    adapterArguments = args.adapterArguments,
                )
            )
            eventFilter.emitAndroidProcessIfNeeded(
                AndroidProcessIdentity(
                    name = handle.processName.ifBlank { handle.packageName },
                    pid = handle.pid,
                    isExternalAttach = true,
                )
            )
            startProcessExitObserver(handle)
        }
    }

    override suspend fun configurationDone(args: ConfigurationDoneArguments) {
        if (isNoDebugSession.get()) {
            noDebugConfigurationDone.complete(Unit)
            return
        }
        native.configurationDone(args)
    }

    override suspend fun disconnect(args: DisconnectArguments) {
        if (!disconnectHandled.compareAndSet(false, true)) {
            withContext(NonCancellable) {
                cleanupDeferred.await()
            }
            return
        }

        val mode = sessionMode.get()
        val handle = activeHandle.get()
        val terminateRequested = when {
            handle != null -> args.terminateDebuggee ?: handle.isApplication
            else -> args.terminateDebuggee ?: false
        }
        val rejectExternalStop = mode == SessionMode.EXTERNAL_ATTACH && args.terminateDebuggee == true

        withContext(NonCancellable) {
            cancelActiveStartup("Android DAP session disconnected")
            exitObserverJob?.cancel()

            val failure = if (cleanupStarted.compareAndSet(false, true)) {
                runCleanup(
                    terminateRequested = terminateRequested,
                    disconnectNative = true,
                    restartArg = args.restart,
                    emitErrorOutputOnFailure = false,
                )
            } else {
                cleanupDeferred.await()
                null
            }
            if (failure != null) {
                throw failure
            }
            if (rejectExternalStop) {
                throw AndroidRunError(
                    code = AndroidRunErrorCode.INVALID_PARAMS,
                    stage = AndroidRunStage.CLEANUP,
                    detail = EXTERNAL_ATTACH_STOP_DENIED_MESSAGE,
                    device = activeDeviceId.get(),
                ).toDapException()
            }
        }
    }

    override suspend fun terminate(args: TerminateArguments) {
        throw AndroidRunError(
            code = AndroidRunErrorCode.INVALID_PARAMS,
            stage = AndroidRunStage.CONFIGURING,
            detail = "terminate request is not supported; use disconnect",
        ).toDapException()
    }

    override suspend fun cancel(args: CancelArguments) {
        val targetRequestId = args.requestId
        val activeStartupJob = synchronized(startupLock) {
            val activeJob = startupJob
            val activeRequestId = startupRequestId
            val hit = activeJob != null && (
                    (targetRequestId != null && activeRequestId == targetRequestId) ||
                            args.progressId == PROGRESS_ID
                    )
            if (hit) {
                startupCancelledReason = "Android DAP startup cancelled"
                activeJob.cancel(CancellationException("Android DAP startup cancelled"))
                activeJob
            } else {
                null
            }
        }
        if (activeStartupJob != null) {
            withContext(NonCancellable) {
                activeStartupJob.join()
            }
            return
        }
        if (isNoDebugSession.get()) {
            return
        }
        if (targetRequestId != null) {
            native.cancel(args)
        }
    }

    override suspend fun setBreakpoints(args: SetBreakpointsArguments): SetBreakpointsResponse {
        val nativeArgs = sourceConverter.toNativeRequest(args)
        if (isNoDebugSession.get()) {
            val clientSource = sourceConverter.toClientSource(nativeArgs.source)
            val breakpoints = if (nativeArgs.breakpoints != null) {
                nativeArgs.breakpoints!!.map { bp ->
                    Breakpoint(
                        verified = false,
                        message = NO_DEBUG_BREAKPOINT_MESSAGE,
                        reason = BreakpointReason.Failed,
                        source = clientSource,
                        line = bp.line,
                        column = bp.column,
                    )
                }
            } else {
                nativeArgs.lines.orEmpty().map { lineNum ->
                    Breakpoint(
                        verified = false,
                        message = NO_DEBUG_BREAKPOINT_MESSAGE,
                        reason = BreakpointReason.Failed,
                        source = clientSource,
                        line = DapLine(lineNum),
                    )
                }
            }
            return SetBreakpointsResponse(breakpoints)
        }
        return sourceConverter.toClientResponse(native.setBreakpoints(nativeArgs))
    }

    override suspend fun setFunctionBreakpoints(
        args: SetFunctionBreakpointsArguments
    ): SetFunctionBreakpointsResponse {
        if (isNoDebugSession.get()) {
            return SetFunctionBreakpointsResponse(
                args.breakpoints.map {
                    Breakpoint(
                        verified = false,
                        message = NO_DEBUG_BREAKPOINT_MESSAGE,
                        reason = BreakpointReason.Failed,
                    )
                }
            )
        }
        return native.setFunctionBreakpoints(args)
    }

    override suspend fun setDataBreakpoints(
        args: SetDataBreakpointsArguments
    ): SetDataBreakpointsResponse {
        if (isNoDebugSession.get()) {
            return SetDataBreakpointsResponse(
                args.breakpoints.map {
                    Breakpoint(
                        verified = false,
                        message = NO_DEBUG_BREAKPOINT_MESSAGE,
                        reason = BreakpointReason.Failed,
                    )
                }
            )
        }
        return native.setDataBreakpoints(args)
    }

    override suspend fun setExceptionBreakpoints(
        args: SetExceptionBreakpointsArguments
    ): SetExceptionBreakpointsResponse? {
        if (isNoDebugSession.get()) {
            return SetExceptionBreakpointsResponse(
                args.filters.map {
                    Breakpoint(
                        verified = false,
                        message = NO_DEBUG_BREAKPOINT_MESSAGE,
                        reason = BreakpointReason.Failed,
                    )
                }
            )
        }
        return native.setExceptionBreakpoints(args)
    }

    override suspend fun setInstructionBreakpoints(
        args: SetInstructionBreakpointsArguments
    ): SetInstructionBreakpointsResponse {
        if (isNoDebugSession.get()) {
            return SetInstructionBreakpointsResponse(
                args.breakpoints.map {
                    Breakpoint(
                        verified = false,
                        message = NO_DEBUG_BREAKPOINT_MESSAGE,
                        reason = BreakpointReason.Failed,
                    )
                }
            )
        }
        return native.setInstructionBreakpoints(args)
    }

    override suspend fun restart(args: RestartArguments) {
        rejectInNoDebug("restart")
        native.restart(args)
    }

    override suspend fun breakpointLocations(
        args: BreakpointLocationsArguments
    ): BreakpointLocationsResponse {
        rejectInNoDebug("breakpointLocations")
        return native.breakpointLocations(sourceConverter.toNativeRequest(args))
    }

    override suspend fun dataBreakpointInfo(
        args: DataBreakpointInfoArguments
    ): DataBreakpointInfoResponse {
        rejectInNoDebug("dataBreakpointInfo")
        return native.dataBreakpointInfo(args)
    }

    override suspend fun threads(): ThreadsResponse {
        rejectInNoDebug("threads")
        return native.threads()
    }

    override suspend fun stackTrace(args: StackTraceArguments): StackTraceResponse {
        rejectInNoDebug("stackTrace")
        return sourceConverter.toClientResponse(native.stackTrace(args))
    }

    override suspend fun scopes(args: ScopesArguments): ScopesResponse {
        rejectInNoDebug("scopes")
        return sourceConverter.toClientResponse(native.scopes(args))
    }

    override suspend fun variables(args: VariablesArguments): VariablesResponse {
        rejectInNoDebug("variables")
        return native.variables(args)
    }

    override suspend fun continueExecution(args: ContinueArguments): ContinueResponse {
        rejectInNoDebug("continue")
        return native.continueExecution(args)
    }

    override suspend fun next(args: NextArguments) {
        rejectInNoDebug("next")
        native.next(args)
    }

    override suspend fun stepIn(args: StepInArguments) {
        rejectInNoDebug("stepIn")
        native.stepIn(args)
    }

    override suspend fun stepOut(args: StepOutArguments) {
        rejectInNoDebug("stepOut")
        native.stepOut(args)
    }

    override suspend fun pause(args: PauseArguments) {
        rejectInNoDebug("pause")
        native.pause(args)
    }

    override suspend fun stepBack(args: StepBackArguments) {
        rejectInNoDebug("stepBack")
        native.stepBack(args)
    }

    override suspend fun reverseContinue(args: ReverseContinueArguments) {
        rejectInNoDebug("reverseContinue")
        native.reverseContinue(args)
    }

    override suspend fun goto(args: GotoArguments) {
        rejectInNoDebug("goto")
        native.goto(args)
    }

    override suspend fun restartFrame(args: RestartFrameArguments) {
        rejectInNoDebug("restartFrame")
        native.restartFrame(args)
    }

    override suspend fun terminateThreads(args: TerminateThreadsArguments) {
        rejectInNoDebug("terminateThreads")
        native.terminateThreads(args)
    }

    override suspend fun setVariable(args: SetVariableArguments): SetVariableResponse {
        rejectInNoDebug("setVariable")
        return native.setVariable(args)
    }

    override suspend fun evaluate(args: EvaluateArguments): EvaluateResponse {
        rejectInNoDebug("evaluate")
        return native.evaluate(args)
    }

    override suspend fun setExpression(args: SetExpressionArguments): SetExpressionResponse {
        rejectInNoDebug("setExpression")
        return native.setExpression(args)
    }

    override suspend fun source(args: SourceArguments): SourceResponse {
        rejectInNoDebug("source")
        return native.source(sourceConverter.toNativeRequest(args))
    }

    override suspend fun loadedSources(args: LoadedSourcesArguments): LoadedSourcesResponse {
        rejectInNoDebug("loadedSources")
        return sourceConverter.toClientResponse(native.loadedSources(args))
    }

    override suspend fun gotoTargets(args: GotoTargetsArguments): GotoTargetsResponse {
        rejectInNoDebug("gotoTargets")
        return native.gotoTargets(sourceConverter.toNativeRequest(args))
    }

    override suspend fun stepInTargets(args: StepInTargetsArguments): StepInTargetsResponse {
        rejectInNoDebug("stepInTargets")
        return native.stepInTargets(args)
    }

    override suspend fun readMemory(args: ReadMemoryArguments): ReadMemoryResponse? {
        rejectInNoDebug("readMemory")
        return native.readMemory(args)
    }

    override suspend fun locations(args: LocationsArguments): LocationsResponse? {
        rejectInNoDebug("locations")
        return native.locations(args)?.let(sourceConverter::toClientResponse)
    }

    override suspend fun writeMemory(args: WriteMemoryArguments): WriteMemoryResponse? {
        rejectInNoDebug("writeMemory")
        return native.writeMemory(args)
    }

    override suspend fun disassemble(args: DisassembleArguments): DisassembleResponse? {
        rejectInNoDebug("disassemble")
        return native.disassemble(args)?.let(sourceConverter::toClientResponse)
    }

    override suspend fun modules(args: ModulesArguments): ModulesResponse {
        rejectInNoDebug("modules")
        return native.modules(args)
    }

    override suspend fun completions(args: CompletionsArguments): CompletionsResponse {
        rejectInNoDebug("completions")
        return native.completions(args)
    }

    override suspend fun exceptionInfo(args: ExceptionInfoArguments): ExceptionInfoResponse {
        rejectInNoDebug("exceptionInfo")
        return native.exceptionInfo(args)
    }

    override suspend fun threadDump(args: ThreadDumpArguments): ThreadDumpResponse {
        rejectInNoDebug("threadDump")
        return native.threadDump(args)
    }

    suspend fun closeAndCleanupOnConnectionClose() {
        withContext(NonCancellable) {
            cancelActiveStartup("Android DAP connection closed")
            exitObserverJob?.cancel()
            if (cleanupStarted.compareAndSet(false, true)) {
                val terminateOnClose = activeHandle.get()?.isApplication == true
                try {
                    runCleanup(
                        terminateRequested = terminateOnClose,
                        disconnectNative = scope.isActive,
                        restartArg = null,
                        emitErrorOutputOnFailure = false,
                    )
                } finally {
                    serverStoppedSignal.complete(Unit)
                    cleanupScope.cancel()
                }
            } else {
                cleanupDeferred.await()
                serverStoppedSignal.complete(Unit)
                cleanupScope.cancel()
            }
        }
    }

    private suspend fun runStartupBlock(
        requestId: MessageId?,
        isAttach: Boolean,
        deviceId: String,
        timeoutMs: Long,
        block: suspend (
            onStage: (AndroidRunStage) -> Unit,
            onOutput: (String) -> Unit,
        ) -> Unit,
    ) {
        val stageLock = Any()
        var currentStage = AndroidRunStage.CONFIGURING
        var lastEmittedStage: AndroidRunStage? = null
        var progressStarted = false
        var progressEnded = false
        var endMessage = "completed"

        val progressRequestId = requestId?.id
            ?.takeIf { it in Int.MIN_VALUE..Int.MAX_VALUE }
            ?.toInt()

        if (supportsProgressReporting) {
            synchronized(stageLock) {
                progressStarted = true
                lastEmittedStage = AndroidRunStage.CONFIGURING
                try {
                    downstreamClient.progressStart(
                        ProgressStartEventArguments(
                            progressId = PROGRESS_ID,
                            title = if (isAttach) "Android Attach" else "Android Launch",
                            requestId = progressRequestId,
                            cancellable = true,
                            message = AndroidRunStage.CONFIGURING.wireName,
                            percentage = null,
                        )
                    )
                } catch (_: Throwable) {
                    progressStarted = false
                }
            }
        }

        val onStage: (AndroidRunStage) -> Unit = { stage ->
            synchronized(stageLock) {
                currentStage = stage
                if (supportsProgressReporting && progressStarted && !progressEnded && lastEmittedStage != stage) {
                    lastEmittedStage = stage
                    try {
                        downstreamClient.progressUpdate(
                            ProgressUpdateEventArguments(
                                progressId = PROGRESS_ID,
                                message = stage.wireName,
                                percentage = null,
                            )
                        )
                    } catch (_: Throwable) {
                    }
                }
            }
        }

        val onOutput: (String) -> Unit = { line ->
            emitBoundedStartupOutput(line)
        }

        try {
            coroutineScope {
                val childJob = coroutineContext.job
                synchronized(startupLock) {
                    startupJob = childJob
                    startupRequestId = requestId
                }
                try {
                    withTimeout(timeoutMs.milliseconds) {
                        block(onStage, onOutput)
                    }
                } finally {
                    synchronized(startupLock) {
                        if (startupJob === childJob) {
                            startupJob = null
                            startupRequestId = null
                        }
                    }
                }
            }
        } catch (t: Throwable) {
            endMessage =
                if (t is CancellationException || (t is AndroidRunException && t.error.code == AndroidRunErrorCode.CANCELLED)) {
                    "cancelled"
                } else {
                    "failed"
                }
            val cleanupError = withContext(NonCancellable) {
                cleanupFailedStartupHandleIfOwned()
            }
            val stageSnapshot = synchronized(stageLock) { currentStage }
            throw mapStartupFailure(
                failure = t,
                stage = stageSnapshot,
                isAttach = isAttach,
                deviceId = deviceId,
                timeoutMs = timeoutMs,
                cleanupError = cleanupError,
            )
        } finally {
            withContext(NonCancellable) {
                synchronized(stageLock) {
                    if (progressStarted && !progressEnded) {
                        progressEnded = true
                        try {
                            downstreamClient.progressEnd(
                                ProgressEndEventArguments(
                                    progressId = PROGRESS_ID,
                                    message = endMessage,
                                )
                            )
                        } catch (ce: CancellationException) {
                            throw ce
                        } catch (_: Throwable) {
                        }
                    }
                }
            }
        }
    }

    private suspend fun cleanupFailedStartupHandleIfOwned(): Throwable? {
        if (cleanupStarted.get()) {
            return null
        }
        val handle = activeHandle.getAndSet(null) ?: return null
        supportTerminateDebuggeeFlag.set(false)
        return try {
            handle.close(terminateApplication = handle.isApplication)
            null
        } catch (ce: CancellationException) {
            throw ce
        } catch (t: Throwable) {
            t
        }
    }

    private fun mapStartupFailure(
        failure: Throwable,
        stage: AndroidRunStage,
        isAttach: Boolean,
        deviceId: String,
        timeoutMs: Long,
        cleanupError: Throwable?,
    ): DapException {
        if (failure is DapException) {
            if (cleanupError == null) {
                return failure
            }
            return AndroidRunError(
                code = if (stage == AndroidRunStage.ATTACHING) AndroidRunErrorCode.START_FAILED else AndroidRunErrorCode.INVALID_PARAMS,
                stage = stage,
                detail = failure.message ?: "Android startup failed",
                device = deviceId,
            ).withCleanupError(cleanupError).toDapException(failure)
        }

        if (failure is AndroidRunException) {
            val enriched = if (cleanupError != null) failure.withCleanupError(cleanupError) else failure
            return enriched.toDapException()
        }

        if (failure is TimeoutCancellationException) {
            val error = AndroidRunError(
                code = AndroidRunErrorCode.CANCELLED,
                stage = stage,
                detail = "Android ${if (isAttach) "attach" else "launch"} timed out after ${timeoutMs}ms",
                device = deviceId,
            )
            return (if (cleanupError != null) error.withCleanupError(cleanupError) else error).toDapException(
                failure
            )
        }

        if (failure is CancellationException) {
            val reason = synchronized(startupLock) { startupCancelledReason }
                ?: failure.message?.takeIf { it.isNotBlank() }
                ?: "Android ${if (isAttach) "attach" else "launch"} cancelled"
            val error = AndroidRunError(
                code = AndroidRunErrorCode.CANCELLED,
                stage = stage,
                detail = reason,
                device = deviceId,
            )
            return (if (cleanupError != null) error.withCleanupError(cleanupError) else error).toDapException(
                failure
            )
        }

        val defaultCode = when (stage) {
            AndroidRunStage.CONFIGURING -> AndroidRunErrorCode.INVALID_PARAMS
            AndroidRunStage.BUILDING -> AndroidRunErrorCode.BUILD_FAILED
            AndroidRunStage.INSTALLING -> AndroidRunErrorCode.INSTALL_FAILED
            AndroidRunStage.STARTING, AndroidRunStage.ATTACHING -> AndroidRunErrorCode.START_FAILED
            AndroidRunStage.CLEANUP -> AndroidRunErrorCode.CLEANUP_FAILED
        }
        val error = AndroidRunError(
            code = defaultCode,
            stage = stage,
            detail = formatThrowableSummary(failure),
            device = deviceId,
        )
        return (if (cleanupError != null) error.withCleanupError(cleanupError) else error).toDapException(failure)
    }

    private suspend fun runCleanup(
        terminateRequested: Boolean,
        disconnectNative: Boolean,
        restartArg: Boolean?,
        emitErrorOutputOnFailure: Boolean,
    ): DapException? {
        try {
            val startupToAwait = synchronized(startupLock) {
                startupJob?.also {
                    startupCancelledReason = startupCancelledReason ?: "Android DAP session closed"
                    it.cancel(CancellationException("Android DAP session closed"))
                }
            }
            startupToAwait?.join()

            var nativeDisconnectError: Throwable? = null
            try {
                if (disconnectNative) {
                    native.disconnect(
                        DisconnectArguments(
                            restart = restartArg,
                            terminateDebuggee = false,
                            suspendDebuggee = false,
                        )
                    )
                }
                if (activeHandle.get()?.port != null) {
                    // Native disconnect schedules VM resume/dispose on its background teardown.
                    nativeStoppedSignal.await()
                }
            } catch (ce: CancellationException) {
                throw ce
            } catch (t: Throwable) {
                nativeDisconnectError = t
            }

            var handleCloseError: Throwable? = null
            val handle = activeHandle.getAndSet(null)
            if (handle != null) {
                try {
                    handle.close(terminateRequested)
                } catch (ce: CancellationException) {
                    throw ce
                } catch (t: Throwable) {
                    handleCloseError = t
                }
            }

            if (emitErrorOutputOnFailure) {
                val errors = listOfNotNull(handleCloseError, nativeDisconnectError)
                if (errors.isNotEmpty()) {
                    val summary = errors.joinToString("; ") { formatThrowableSummary(it) }
                    emitBoundedOutput(
                        OutputCategory.Stderr,
                        "Android cleanup warning: $summary\n",
                    )
                }
            }

            try {
                eventFilter.emitTerminatedOnce()
            } catch (_: Throwable) {
            }

            return combineCleanupFailures(
                handleCloseError = handleCloseError,
                nativeDisconnectError = nativeDisconnectError,
                deviceId = handle?.deviceId ?: activeDeviceId.get(),
            )
        } finally {
            cleanupDeferred.complete(Unit)
        }
    }

    private fun combineCleanupFailures(
        handleCloseError: Throwable?,
        nativeDisconnectError: Throwable?,
        deviceId: String?,
    ): DapException? {
        if (handleCloseError == null && nativeDisconnectError == null) {
            return null
        }
        val primary = handleCloseError ?: nativeDisconnectError!!
        val secondary = if (handleCloseError != null) nativeDisconnectError else null

        if (primary is DapException) {
            if (secondary == null) return primary
            return AndroidRunError(
                code = AndroidRunErrorCode.CLEANUP_FAILED,
                stage = AndroidRunStage.CLEANUP,
                detail = primary.message ?: "Cleanup failed",
                device = deviceId,
            ).withCleanupError(secondary).toDapException(primary)
        }
        if (primary is AndroidRunException) {
            val enriched = if (secondary != null) primary.withCleanupError(secondary) else primary
            return enriched.toDapException()
        }
        val err = AndroidRunError(
            code = AndroidRunErrorCode.CLEANUP_FAILED,
            stage = AndroidRunStage.CLEANUP,
            detail = formatThrowableSummary(primary),
            device = deviceId,
        )
        return (if (secondary != null) err.withCleanupError(secondary) else err).toDapException(primary)
    }

    private fun startProcessExitObserver(handle: AndroidRunHandle) {
        val job = scope.launch(Dispatchers.IO) {
            val exit = try {
                handle.awaitExit()
            } catch (_: CancellationException) {
                return@launch
            } catch (t: Throwable) {
                emitBoundedOutput(
                    OutputCategory.Stderr,
                    "Android process monitor failed: ${formatThrowableSummary(t)}\n",
                )
                triggerObserverCleanup()
                return@launch
            }
            if (exit.reason == "closed" || cleanupStarted.get()) {
                return@launch
            }
            if (exit.exitCode != null) {
                try {
                    eventFilter.emitVerifiedExited(exit.exitCode)
                } catch (_: Throwable) {
                }
            }
            if (exit.deviceOffline) {
                emitBoundedOutput(
                    OutputCategory.Stderr,
                    "Android device ${handle.deviceId} went offline; closing session.\n",
                )
            }
            triggerObserverCleanup()
        }
        exitObserverJob = job
    }

    private suspend fun triggerObserverCleanup() {
        if (cleanupStarted.compareAndSet(false, true)) {
            withContext(NonCancellable) {
                runCleanup(
                    terminateRequested = false,
                    disconnectNative = scope.isActive,
                    restartArg = null,
                    emitErrorOutputOnFailure = true,
                )
            }
        }
    }

    private fun currentProcessIdentity(): AndroidProcessIdentity? {
        val handle = activeHandle.get() ?: return null
        return AndroidProcessIdentity(
            name = handle.processName.ifBlank { handle.packageName },
            pid = handle.pid,
            isExternalAttach = !handle.isApplication,
        )
    }

    private fun cancelActiveStartup(reason: String) {
        synchronized(startupLock) {
            startupCancelledReason = startupCancelledReason ?: reason
            startupJob?.cancel(CancellationException(reason))
        }
    }

    private fun rejectInNoDebug(methodName: String) {
        if (isNoDebugSession.get()) {
            throw AndroidRunError(
                code = AndroidRunErrorCode.INVALID_PARAMS,
                stage = AndroidRunStage.CONFIGURING,
                detail = "$methodName is not supported in noDebug mode",
                device = activeDeviceId.get(),
            ).toDapException()
        }
    }

    private fun emitBoundedStartupOutput(raw: String) {
        val trimmed = raw.trimEnd('\r', '\n')
        if (trimmed.isEmpty()) return
        val chunk = if (trimmed.length > MAX_OUTPUT_CHUNK_CHARS) {
            trimmed.take(MAX_OUTPUT_CHUNK_CHARS - 3) + "..."
        } else {
            trimmed
        }
        val line = "$chunk\n"
        val currentTotal = startupOutputBytes.get()
        if (currentTotal >= MAX_STARTUP_OUTPUT_BYTES) {
            return
        }
        if (startupOutputBytes.addAndGet(line.length) > MAX_STARTUP_OUTPUT_BYTES) {
            return
        }
        emitBoundedOutput(OutputCategory.Console, line)
    }

    private fun emitBoundedOutput(category: OutputCategory, text: String) {
        val bounded = if (text.length > MAX_OUTPUT_CHUNK_CHARS) {
            text.take(MAX_OUTPUT_CHUNK_CHARS - 4) + "...\n"
        } else {
            text
        }
        try {
            eventFilter.output(
                OutputEventArguments(
                    category = category,
                    output = bounded,
                )
            )
        } catch (_: Throwable) {
        }
    }

    private fun patchCapabilities(
        caps: Capabilities,
        noDebug: Boolean,
        supportTerminateDebuggee: Boolean,
    ): Capabilities {
        val base = caps.copy(
            supportsTerminateRequest = false,
            supportsCancelRequest = true,
            supportSuspendDebuggee = false,
            supportTerminateDebuggee = supportTerminateDebuggee,
        )
        if (!noDebug) {
            return base
        }
        return base.copy(
            supportsConfigurationDoneRequest = true,
            supportsFunctionBreakpoints = false,
            supportsConditionalBreakpoints = false,
            supportsHitConditionalBreakpoints = false,
            supportsEvaluateForHovers = false,
            exceptionBreakpointFilters = emptyList(),
            supportsStepBack = false,
            supportsSetVariable = false,
            supportsRestartFrame = false,
            supportsGotoTargetsRequest = false,
            supportsStepInTargetsRequest = false,
            supportsCompletionsRequest = false,
            completionTriggerCharacters = null,
            supportsModulesRequest = false,
            additionalModuleColumns = null,
            supportedChecksumAlgorithms = null,
            supportsRestartRequest = false,
            supportsExceptionOptions = false,
            supportsValueFormattingOptions = false,
            supportsExceptionInfoRequest = false,
            supportsDelayedStackTraceLoading = false,
            supportsLoadedSourcesRequest = false,
            supportsLogPoints = false,
            supportsTerminateThreadsRequest = false,
            supportsSetExpression = false,
            supportsDataBreakpoints = false,
            supportsReadMemoryRequest = false,
            supportsWriteMemoryRequest = false,
            supportsDisassembleRequest = false,
            supportsBreakpointLocationsRequest = false,
            supportsSteppingGranularity = false,
            supportsInstructionBreakpoints = false,
            supportsExceptionFilterOptions = false,
            supportsSingleThreadExecutionRequests = false,
            supportsDataBreakpointBytes = false,
            breakpointModes = emptyList(),
            supportsLocationsRequest = false,
            supportsThreadDumpRequest = false,
        )
    }

    private fun formatThrowableSummary(t: Throwable): String {
        if (t is AndroidRunException) {
            return t.error.formattedWireMessage()
        }
        return t.message?.takeIf { it.isNotBlank() } ?: t::class.java.simpleName
    }

    companion object {
        const val NATIVE_ADAPTER_ID = "intellij_jvm"
        const val PROGRESS_ID = "org.intellij.android.launch"
        const val DEFAULT_ATTACH_TIMEOUT_MS = 120_000L
        const val MAX_OUTPUT_CHUNK_CHARS = 1024
        const val MAX_STARTUP_OUTPUT_BYTES = 65_536
        const val NO_DEBUG_BREAKPOINT_MESSAGE = "Breakpoints are disabled in noDebug mode"
        const val EXTERNAL_ATTACH_STOP_DENIED_MESSAGE =
            "terminateDebuggee=true is not permitted for external attach"
    }
}
