package org.jetbrains.android.debug

import com.android.adblib.*
import com.android.adblib.tools.debugging.*
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.util.Disposer
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.serialization.json.*
import java.io.File
import java.net.InetSocketAddress
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import java.time.Duration
import java.util.*
import java.util.concurrent.*
import java.util.concurrent.CancellationException
import java.util.concurrent.atomic.AtomicBoolean

open class AndroidDebugService(
    val host: AdbSessionHost,
    val handles: AndroidDebugHandles
) : Disposable {

    private val workerExecutor: ExecutorService = Executors.newVirtualThreadPerTaskExecutor()
    private val scheduler: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor { r ->
        Thread(r, "android-debug-service-scheduler").apply { isDaemon = true }
    }
    private val disposed = AtomicBoolean(false)

    private val adbLock = Any()

    @Volatile
    private var currentAdbPath: String? = null

    @Volatile
    private var serverController: AdbServerController? = null

    @Volatile
    private var channelProvider: AdbServerChannelProvider? = null

    @Volatile
    var parentSession: AdbSession? = null
        private set

    constructor() : this(AdbSessionHost(), AndroidDebugHandles())

    fun resolveAdbPath(explicitAdbPath: String?): Path? {
        val isWindows = System.getProperty("os.name", "").lowercase(Locale.ROOT).startsWith("win")
        val exeName = if (isWindows) "adb.exe" else "adb"

        if (explicitAdbPath != null) {
            if (explicitAdbPath.isBlank()) {
                throw AndroidDebugException("invalid_params", "adbPath must not be empty or blank")
            }
            val p = Paths.get(explicitAdbPath)
            if (!Files.isRegularFile(p)) {
                throw AndroidDebugException("adb_not_found", "Explicit ADB path does not exist: $explicitAdbPath")
            }
            return p
        }

        val androidHome = System.getenv("ANDROID_HOME")
        if (!androidHome.isNullOrBlank()) {
            val p = Paths.get(androidHome, "platform-tools", exeName)
            if (Files.isRegularFile(p)) {
                return p
            }
        }

        val sdkRoot = System.getenv("ANDROID_SDK_ROOT")
        if (!sdkRoot.isNullOrBlank()) {
            val p = Paths.get(sdkRoot, "platform-tools", exeName)
            if (Files.isRegularFile(p)) {
                return p
            }
        }

        val pathEnv = System.getenv("PATH")
        if (!pathEnv.isNullOrBlank()) {
            for (entry in pathEnv.split(File.pathSeparator)) {
                if (entry.isNotBlank()) {
                    val p = Paths.get(entry, exeName)
                    if (Files.isRegularFile(p)) {
                        return p
                    }
                }
            }
        }

        return null
    }

    fun ensureAdbSessionInitialized(explicitAdbPath: String?, timeoutMs: Long) {
        val adbPath = resolveAdbPath(explicitAdbPath)
        val adbPathStr = adbPath?.toAbsolutePath()?.toString()

        synchronized(adbLock) {
            if (parentSession != null && !disposed.get() && currentAdbPath == adbPathStr) {
                return
            }

            // If path changed or previous session closed, tear down old session cleanly
            if (serverController != null) {
                try {
                    serverController!!.close()
                } catch (_: Throwable) {
                }
                serverController = null
            }
            if (parentSession != null) {
                try {
                    parentSession!!.close()
                } catch (_: Throwable) {
                }
                parentSession = null
            }

            currentAdbPath = adbPathStr
            val configFlow = MutableStateFlow(
                AdbServerConfiguration(adbPath, 5037, false, false, emptyMap())
            )
            val controller = AdbServerController.createServerController(host, configFlow)
            serverController = controller
            val provider = controller.channelProvider
            channelProvider = provider

            try {
                val startFuture = CompletableFuture<Unit?>()
                val job = CoroutineScope(host.ioDispatcher).launch {
                    try {
                        controller.start()
                        startFuture.complete(null)
                    } catch (t: Throwable) {
                        startFuture.completeExceptionally(t)
                    }
                }
                try {
                    startFuture.get(minOf(timeoutMs, 15000L), TimeUnit.MILLISECONDS)
                } finally {
                    job.cancel()
                }
            } catch (e: TimeoutException) {
                throw AndroidDebugException("timeout", "Timed out waiting for ADB server startup", e)
            } catch (e: InterruptedException) {
                Thread.currentThread().interrupt()
                throw CancellationException("Interrupted starting ADB server")
            } catch (e: ExecutionException) {
                val cause = e.cause ?: e
                if (cause is CancellationException) {
                    throw cause
                }
                throw AndroidDebugException("adb_unavailable", "Failed to start ADB server: ${cause.message}", cause)
            }

            parentSession = AdbSession.create(host, provider, Duration.ofMillis(timeoutMs))
        }
    }

    fun prepare(
        packageName: String?,
        pid: Int?,
        deviceId: String?,
        adbPath: String?,
        timeoutMs: Int?
    ): JsonObject {
        if (disposed.get()) {
            throw AndroidDebugException("cleanup_failed", "Android debug service has been disposed")
        }

        if ((packageName == null && pid == null) || (packageName != null && pid != null)) {
            throw AndroidDebugException("invalid_params", "Must specify either packageName or pid, not both")
        }
        if (packageName != null && packageName.isBlank()) {
            throw AndroidDebugException("invalid_params", "packageName must not be blank")
        }
        if (deviceId != null && deviceId.isBlank()) {
            throw AndroidDebugException("invalid_params", "deviceId must not be blank")
        }
        if (pid != null && pid <= 0) {
            throw AndroidDebugException("invalid_params", "pid must be a positive integer")
        }
        val timeout = timeoutMs?.toLong() ?: 10000L
        if (timeout < 1 || timeout > 300000L) {
            throw AndroidDebugException("invalid_params", "timeoutMs must be between 1 and 300000")
        }

        val deadlineNanos = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeout)

        ensureAdbSessionInitialized(adbPath, timeout)

        val childSession =
            AdbSession.createChildSession(parentSession!!, host, channelProvider!!, Duration.ofMillis(timeout))
        var reservedTargetId: AndroidDebugHandles.TargetId? = null
        var published = false

        try {
            val device = selectDevice(childSession, deviceId, deadlineNanos)
            val process = selectProcess(device, packageName, pid, deadlineNanos)

            // Phase 1: Atomic reservation BEFORE proxy creation to prevent concurrent races
            val targetId = AndroidDebugHandles.TargetId(
                device.serialNumber,
                process.pid
            )
            if (!handles.tryReserveTarget(targetId)) {
                throw AndroidDebugException(
                    "lease_conflict",
                    "Target $targetId is already prepared or claimed by another debug session"
                )
            }
            reservedTargetId = targetId

            // Phase 2: JDWP proxy socket binding
            val proxyServer = process.jdwpProxySocketServer
            val status = awaitProxyStatus(childSession.scope, proxyServer.proxyStatusFlow, deadlineNanos)

            if (status.socketAddress.isError) {
                throw AndroidDebugException("proxy_failed", status.socketAddress.getErrorMessageOrThrow())
            }
            if (!status.socketAddress.hasValue) {
                throw AndroidDebugException("proxy_failed", "JDWP proxy did not bind to a valid socket address")
            }

            val socketAddress = status.socketAddress.getOrThrow()
            val port = socketAddress.port
            if (port <= 0 || port > 65535) {
                throw AndroidDebugException("proxy_failed", "Invalid proxy port bound: $port")
            }

            // Verify device and process are still active before publishing
            if (device.deviceInfoFlow.value.deviceState != DeviceState.ONLINE || !process.scope.isActive) {
                throw AndroidDebugException(
                    "target_changed",
                    "Target device or process exited before debug session established"
                )
            }

            val processName = resolveProcessName(process)
            val handle = handles.recordPrepared(
                device.serialNumber,
                process.pid,
                processName,
                "127.0.0.1",
                port,
                childSession,
                AndroidDebugHandles.DEFAULT_TTL_MS
            )

            // Phase 3: Attach lifecycle listeners for device disconnect and process exit
            val processJob = process.scope.coroutineContext.job
            processJob.invokeOnCompletion { _ ->
                scheduler.execute {
                    try {
                        handles.release(handle.cleanupKey)
                    } catch (_: Throwable) {
                    }
                }
            }
            val deviceJob = device.scope.coroutineContext.job
            deviceJob.invokeOnCompletion { _ ->
                scheduler.execute {
                    try {
                        handles.release(handle.cleanupKey)
                    } catch (_: Throwable) {
                    }
                }
            }

            published = true
            return buildPreparedResponse(handle, timeout)
        } finally {
            if (!published) {
                if (reservedTargetId != null) {
                    handles.cancelReservation(reservedTargetId)
                }
                try {
                    childSession.close()
                } catch (_: Throwable) {
                }
            }
        }
    }

    fun claim(host: String?, port: Int, ownerJob: Job?): JsonObject {
        if (!isLoopbackHost(host)) {
            throw AndroidDebugException("invalid_params", "Host must be a loopback address: $host")
        }
        if (port < 1 || port > 65535) {
            throw AndroidDebugException("invalid_params", "Port must be between 1 and 65535: $port")
        }

        // Avoid AdbSession creation: claim only inspects handles in memory
        val result = handles.claim(host!!, port, ownerJob)
        val map = linkedMapOf<String, JsonElement>()
        map["claimed"] = JsonPrimitive(result.claimed)
        if (result.claimed) {
            map["cleanupKey"] = JsonPrimitive(result.cleanupKey)
        }
        return JsonObject(map)
    }

    fun release(cleanupKey: String?): JsonObject {
        if (cleanupKey.isNullOrBlank()) {
            throw AndroidDebugException("invalid_params", "cleanupKey must not be null or blank")
        }
        try {
            UUID.fromString(cleanupKey)
        } catch (_: IllegalArgumentException) {
            throw AndroidDebugException("invalid_params", "cleanupKey must be a valid UUID string: $cleanupKey")
        }

        // Avoid AdbSession creation: release delegates to handles in memory
        val result = handles.release(cleanupKey)
        val map = linkedMapOf<String, JsonElement>()
        map["success"] = JsonPrimitive(result.success)
        map["cleaned"] = JsonPrimitive(result.cleaned)
        if (result.reason != null) {
            map["reason"] = JsonPrimitive(result.reason)
        }
        return JsonObject(map)
    }

    private fun remainingMs(deadlineNanos: Long): Long {
        val rem = TimeUnit.NANOSECONDS.toMillis(deadlineNanos - System.nanoTime())
        if (rem <= 0) {
            throw AndroidDebugException("timeout", "Prepare operation timed out")
        }
        return rem
    }

    private fun selectDevice(
        childSession: AdbSession,
        requestedDeviceId: String?,
        deadlineNanos: Long
    ): ConnectedDevice {
        val tracker = childSession.connectedDevicesTracker
        val devicesFlow = tracker.connectedDevices

        // Wait until flow is initialized
        try {
            awaitFlow(
                childSession.scope,
                devicesFlow,
                { list -> !list.flowStatus.isStartOfFlow },
                remainingMs(deadlineNanos),
                "Timed out waiting for ADB device tracker to initialize"
            )
        } catch (e: Exception) {
            when (e) {
                is CancellationException, is InterruptedException -> {
                    throw CancellationException("Request cancelled while waiting for device tracker")
                }

                else -> throw mapFlowException(e, "no_device", "Timed out waiting for device connection")
            }
        }

        if (!requestedDeviceId.isNullOrBlank()) {
            var device = tracker.device(requestedDeviceId)
            if (device == null) {
                try {
                    awaitFlow(
                        childSession.scope,
                        devicesFlow,
                        { list -> list.any { requestedDeviceId == it.serialNumber } },
                        remainingMs(deadlineNanos),
                        "Device $requestedDeviceId not connected"
                    )
                } catch (e: Exception) {
                    when (e) {
                        is CancellationException, is InterruptedException -> {
                            throw CancellationException("Request cancelled while waiting for device $requestedDeviceId")
                        }

                        else -> throw AndroidDebugException("no_device", "Device $requestedDeviceId not connected")
                    }
                }
                device = tracker.device(requestedDeviceId)
            }
            if (device == null) {
                throw AndroidDebugException("no_device", "Device $requestedDeviceId not found")
            }

            val state = device.deviceInfo.deviceState
            return when (state) {
                DeviceState.ONLINE -> device
                DeviceState.UNAUTHORIZED -> throw AndroidDebugException(
                    "unauthorized_device",
                    "Device $requestedDeviceId is unauthorized"
                )

                DeviceState.OFFLINE -> throw AndroidDebugException(
                    "device_offline",
                    "Device $requestedDeviceId is offline"
                )

                else -> throw AndroidDebugException("device_offline", "Device $requestedDeviceId is in state $state")
            }
        }

        // Auto-select single online device
        var currentDevices = devicesFlow.value
        var online = currentDevices.filter { it.isOnline }

        if (online.size == 1) {
            return online[0]
        } else if (online.size > 1) {
            val candidateElements = online.map { d ->
                JsonObject(mapOf("deviceId" to JsonPrimitive(d.serialNumber)))
            }
            throw AndroidDebugException(
                "ambiguous_device",
                "Multiple online devices found; please specify deviceId",
                JsonArray(candidateElements)
            )
        }

        // 0 online devices: wait on flow until deadline
        try {
            awaitFlow(
                childSession.scope,
                devicesFlow,
                { list -> list.any { it.isOnline } },
                remainingMs(deadlineNanos),
                "No online devices appeared within timeout"
            )
        } catch (e: Exception) {
            when (e) {
                is CancellationException, is InterruptedException -> {
                    throw CancellationException("Request cancelled while waiting for online device")
                }

                else -> {
                }
            }
        }

        currentDevices = devicesFlow.value
        online = currentDevices.filter { it.isOnline }
        if (online.size == 1) {
            return online[0]
        } else if (online.size > 1) {
            val candidateElements = online.map { d ->
                JsonObject(mapOf("deviceId" to JsonPrimitive(d.serialNumber)))
            }
            throw AndroidDebugException(
                "ambiguous_device",
                "Multiple online devices found; please specify deviceId",
                JsonArray(candidateElements)
            )
        }

        // Still 0 online: check non-ready devices
        if (currentDevices.isEmpty()) {
            throw AndroidDebugException("no_device", "No connected Android devices found")
        } else if (currentDevices.size == 1) {
            val single = currentDevices[0]
            val state = single.deviceInfo.deviceState
            if (state == DeviceState.UNAUTHORIZED) {
                throw AndroidDebugException("unauthorized_device", "Connected device is unauthorized")
            } else if (state == DeviceState.OFFLINE) {
                throw AndroidDebugException("device_offline", "Connected device is offline")
            }
        }
        throw AndroidDebugException("ambiguous_device", "Multiple non-ready devices found; none online")
    }

    private fun selectProcess(
        device: ConnectedDevice,
        packageName: String?,
        pid: Int?,
        deadlineNanos: Long
    ): JdwpProcess {
        val tracker = device.jdwpProcessTracker
        val processFlow = tracker.processesFlow

        try {
            awaitFlow(
                device.scope,
                processFlow,
                { list -> !list.flowStatus.isStartOfFlow },
                remainingMs(deadlineNanos),
                "Timed out waiting for JDWP process tracker to initialize"
            )
        } catch (e: Exception) {
            when (e) {
                is CancellationException, is InterruptedException -> {
                    throw CancellationException("Request cancelled waiting for process tracker initialization")
                }

                else -> throw mapFlowException(e, "process_not_found", "Timed out waiting for processes")
            }
        }

        if (pid != null) {
            return selectProcessByPid(device, processFlow, pid, deadlineNanos)
        } else {
            return selectProcessByPackage(device, processFlow, packageName!!, deadlineNanos)
        }
    }

    private fun selectProcessByPid(
        device: ConnectedDevice,
        processFlow: StateFlow<JdwpProcessList>,
        targetPid: Int,
        deadlineNanos: Long
    ): JdwpProcess {
        // Fast path: already present in process list
        val process = findProcessByPid(processFlow.value, targetPid)
        if (process != null) {
            return process
        }

        // Check AppProcessTracker for non-debuggable target
        checkNotJdwpPid(device, targetPid)

        // Reactive wait without ad-hoc loops
        val processFound = CompletableFuture<JdwpProcess>()
        val job = device.scope.launch {
            processFlow.collect { list ->
                val p = findProcessByPid(list, targetPid)
                if (p != null) {
                    processFound.complete(p)
                }
            }
        }

        try {
            return processFound.get(remainingMs(deadlineNanos), TimeUnit.MILLISECONDS)
        } catch (e: TimeoutException) {
            checkNotJdwpPid(device, targetPid)
            throw AndroidDebugException("process_not_found", "No JDWP process found with PID $targetPid")
        } catch (e: InterruptedException) {
            Thread.currentThread().interrupt()
            throw CancellationException("Request cancelled while waiting for process PID $targetPid")
        } catch (e: ExecutionException) {
            throw mapFlowException(e, "process_not_found", "Error finding process PID $targetPid")
        } finally {
            job.cancel()
        }
    }

    private fun selectProcessByPackage(
        device: ConnectedDevice,
        processFlow: StateFlow<JdwpProcessList>,
        targetPackage: String,
        deadlineNanos: Long
    ): JdwpProcess {
        val propertyListeners = ConcurrentHashMap<JdwpProcess, Job>()
        val resolved = CompletableFuture<JdwpProcess>()
        val evaluate = Runnable {
            try {
                val match = selectPackageMatch(processFlow.value, { it.properties }, targetPackage, false)
                if (match != null) resolved.complete(match)
            } catch (t: Throwable) {
                resolved.completeExceptionally(t)
            }
        }
        val listCollector = device.scope.launch {
            processFlow.collect { list ->
                val active = HashSet(list)
                for (p in list) {
                    propertyListeners.computeIfAbsent(p) { proc ->
                        proc.scope.launch {
                            proc.propertiesFlow.collect { _ ->
                                evaluate.run()
                            }
                        }
                    }
                }
                for (known in ArrayList(propertyListeners.keys)) {
                    if (known !in active) {
                        val job = propertyListeners.remove(known)
                        job?.cancel()
                    }
                }
                evaluate.run()
            }
        }
        try {
            evaluate.run()
            return resolved.get(remainingMs(deadlineNanos), TimeUnit.MILLISECONDS)
        } catch (_: TimeoutException) {
            val match = selectPackageMatch(processFlow.value, { it.properties }, targetPackage, true)
            if (match != null) return match
            checkNotJdwpPackage(device, targetPackage)
            throw AndroidDebugException("process_not_found", "No debuggable process found for package $targetPackage")
        } catch (e: ExecutionException) {
            val cause = e.cause
            if (cause is RuntimeException) throw cause
            if (cause is Error) throw cause
            throw AndroidDebugException("process_not_found", cause.toString(), cause)
        } catch (e: InterruptedException) {
            Thread.currentThread().interrupt()
            throw CancellationException("Request cancelled while waiting for package $targetPackage")
        } finally {
            listCollector.cancel()
            for (job in propertyListeners.values) job.cancel()
        }
    }

    private fun findProcessByPid(list: List<JdwpProcess>, pid: Int): JdwpProcess? {
        return list.firstOrNull { it.pid == pid }
    }

    private fun checkNotJdwpPid(device: ConnectedDevice, pid: Int) {
        try {
            val appTracker = device.appProcessTracker
            val appProcesses = appTracker.appProcessFlow.value
            for (ap in appProcesses) {
                if (ap.pid == pid && !ap.debuggable) {
                    throw AndroidDebugException("not_jdwp", "Process $pid exists but is not debuggable (not JDWP)")
                }
            }
        } catch (e: AndroidDebugException) {
            throw e
        } catch (ce: CancellationException) {
            throw ce
        } catch (t: Throwable) {
            if (t is LinkageError) {
                throw t
            }
        }
    }

    private fun checkNotJdwpPackage(device: ConnectedDevice, packageName: String) {
        try {
            val appTracker = device.appProcessTracker
            val appProcesses = appTracker.appProcessFlow.value
            for (ap in appProcesses) {
                val procOpt = ap.propertiesFlow.value.processName
                val procName = if (procOpt.hasValue) procOpt.getOrThrow() else null
                if (procName != null && (procName == packageName || procName.startsWith("$packageName:"))) {
                    if (!ap.debuggable) {
                        throw AndroidDebugException("not_jdwp", "Process $packageName exists but is not debuggable")
                    }
                }
            }
        } catch (e: AndroidDebugException) {
            throw e
        } catch (ce: CancellationException) {
            throw ce
        } catch (t: Throwable) {
            if (t is LinkageError) {
                throw t
            }
        }
    }

    private fun resolveProcessName(process: JdwpProcess): String {
        val props = process.properties
        if (props.processName.hasValue) {
            return props.processName.getOrThrow()
        }
        if (props.packageName.hasValue) {
            return props.packageName.getOrThrow()
        }
        return "pid:${process.pid}"
    }

    private fun awaitProxyStatus(
        scope: CoroutineScope,
        statusFlow: StateFlow<JdwpProxySocketServerStatus>,
        deadlineNanos: Long
    ): JdwpProxySocketServerStatus {
        try {
            return awaitFlow(
                scope,
                statusFlow,
                { status ->
                    val socketAddress = status.socketAddress
                    socketAddress.hasValue || socketAddress.isError
                },
                remainingMs(deadlineNanos),
                "Timed out waiting for JDWP proxy server to bind socket"
            )
        } catch (e: Exception) {
            when (e) {
                is CancellationException, is InterruptedException -> {
                    throw CancellationException("Request cancelled while waiting for JDWP proxy socket")
                }

                else -> throw mapFlowException(e, "proxy_failed", "Timed out waiting for proxy status")
            }
        }
    }

    private fun buildPreparedResponse(handle: AndroidDebugHandles.DebugHandle, timeoutMs: Long): JsonObject {
        val debugObj = linkedMapOf<String, JsonElement>()
        debugObj["action"] = JsonPrimitive("attach")
        debugObj["adapter"] = JsonPrimitive("intellij")
        debugObj["host"] = JsonPrimitive(handle.host)
        debugObj["port"] = JsonPrimitive(handle.port)
        debugObj["timeout"] = JsonPrimitive(maxOf(1, (timeoutMs / 1000L).toInt()))

        val root = linkedMapOf<String, JsonElement>()
        root["success"] = JsonPrimitive(true)
        root["cleanupKey"] = JsonPrimitive(handle.cleanupKey)
        root["expiresAt"] = JsonPrimitive(handle.expiresAt)
        root["deviceId"] = JsonPrimitive(handle.deviceId)
        root["pid"] = JsonPrimitive(handle.pid)
        root["processName"] = JsonPrimitive(handle.processName)
        root["host"] = JsonPrimitive(handle.host)
        root["port"] = JsonPrimitive(handle.port)
        root["jdwpTarget"] = JsonPrimitive("jdwp:${handle.pid}")
        root["debug"] = JsonObject(debugObj)

        return JsonObject(root)
    }

    private fun mapFlowException(e: Exception, defaultReason: String, defaultMessage: String): AndroidDebugException {
        if (e is AndroidDebugException) {
            return e
        }
        if (e.cause is AndroidDebugException) {
            return e.cause as AndroidDebugException
        }
        if (e is CancellationException) {
            throw e
        }
        if (e.cause is CancellationException) {
            throw e.cause as CancellationException
        }
        return AndroidDebugException(defaultReason, "$defaultMessage: ${e.message}", e)
    }

    private fun isLoopbackHost(host: String?): Boolean {
        if (host.isNullOrBlank()) {
            return false
        }
        return host == "127.0.0.1"
                || host.equals("localhost", ignoreCase = true)
                || host == "::1"
                || host == "[::1]"
                || host == "0:0:0:0:0:0:0:1"
                || host == "[0:0:0:0:0:0:0:1]"
    }

    override fun dispose() {
        if (disposed.compareAndSet(false, true)) {
            handles.closeAll()
            synchronized(adbLock) {
                if (serverController != null) {
                    try {
                        serverController!!.close()
                    } catch (_: Throwable) {
                    }
                }
                if (parentSession != null) {
                    try {
                        parentSession!!.close()
                    } catch (_: Throwable) {
                    }
                }
            }
            try {
                host.close()
            } catch (_: Throwable) {
            }
            workerExecutor.shutdownNow()
            scheduler.shutdownNow()
        }
    }

    companion object {
        @Volatile
        private var instance: AndroidDebugService? = null
        private val instanceLock = Any()

        @JvmStatic
        fun getInstance(): AndroidDebugService {
            var s = instance
            if (s == null) {
                synchronized(instanceLock) {
                    s = instance
                    if (s == null) {
                        s = AndroidDebugService()
                        val app = ApplicationManager.getApplication()
                        if (app != null) {
                            try {
                                Disposer.register(app, s!!)
                            } catch (_: Throwable) {
                            }
                        }
                        instance = s
                    }
                }
            }
            return s!!
        }

        @JvmStatic
        fun setInstanceForTesting(testInstance: AndroidDebugService?) {
            synchronized(instanceLock) {
                instance = testInstance
            }
        }

        @JvmStatic
        fun matchesPackageName(props: JdwpProcessProperties, targetPackage: String): Boolean {
            if (props.packageNames.hasValue) {
                val pkgList = props.packageNames.getOrThrow()
                if (pkgList.contains(targetPackage)) {
                    return true
                }
            }
            if (props.processName.hasValue) {
                val name = props.processName.getOrThrow()
                if (name == targetPackage || name.startsWith("$targetPackage:")) {
                    return true
                }
            }
            return false
        }

        @JvmStatic
        fun selectPackageMatch(
            processes: List<JdwpProcess>,
            propertiesOf: (JdwpProcess) -> JdwpProcessProperties,
            targetPackage: String,
            settled: Boolean
        ): JdwpProcess? {
            val matches = mutableListOf<JdwpProcess>()
            var loading = false
            var unsupported = false
            for (process in processes) {
                val props = propertiesOf(process)
                if (matchesPackageName(props, targetPackage)) {
                    matches.add(process)
                    continue
                }
                val packages = props.packageNames
                val name = props.processName
                val packageKnown = packages.hasValue && packages.getOrThrow().isNotEmpty()
                val nameKnown = name.hasValue && name.getOrThrow().isNotBlank()
                if (!packageKnown && !nameKnown) {
                    if (packages.isError || name.isError) {
                        unsupported = true
                    } else {
                        loading = true
                    }
                }
            }
            if (matches.size > 1) {
                matches.sortBy { it.pid }
                val candidates = mutableListOf<JsonElement>()
                for (p in matches) {
                    val props = propertiesOf(p)
                    val name = if (props.processName.hasValue) {
                        props.processName.getOrThrow()
                    } else if (props.packageName.hasValue) {
                        props.packageName.getOrThrow()
                    } else {
                        "pid:${p.pid}"
                    }
                    val item = linkedMapOf<String, JsonElement>()
                    item["pid"] = JsonPrimitive(p.pid)
                    item["processName"] = JsonPrimitive(name)
                    candidates.add(JsonObject(item))
                }
                throw AndroidDebugException(
                    "ambiguous_process",
                    "Multiple processes match package $targetPackage",
                    JsonArray(candidates)
                )
            }
            if (matches.size == 1 && (!loading || settled)) {
                return matches[0]
            }
            if (settled && matches.isEmpty() && unsupported) {
                throw AndroidDebugException(
                    "process_not_found",
                    "Device process metadata cannot confirm package $targetPackage; specify --pid explicitly"
                )
            }
            return null
        }

        @JvmStatic
        @Throws(Exception::class)
        fun <T> awaitFlow(
            scope: CoroutineScope,
            flow: StateFlow<T>,
            predicate: (T) -> Boolean,
            timeoutMs: Long,
            timeoutMessage: String
        ): T {
            val current = flow.value
            if (predicate(current)) {
                return current
            }

            val future = CompletableFuture<T>()
            val job = scope.launch {
                try {
                    flow.collect { value ->
                        try {
                            if (predicate(value)) {
                                future.complete(value)
                            }
                        } catch (t: Throwable) {
                            future.completeExceptionally(t)
                        }
                    }
                } catch (t: Throwable) {
                    future.completeExceptionally(t)
                }
            }

            try {
                return future.get(timeoutMs, TimeUnit.MILLISECONDS)
            } catch (e: TimeoutException) {
                throw AndroidDebugException("timeout", timeoutMessage, e)
            } catch (e: InterruptedException) {
                Thread.currentThread().interrupt()
                throw CancellationException("Flow wait interrupted")
            } finally {
                job.cancel()
            }
        }
    }
}
