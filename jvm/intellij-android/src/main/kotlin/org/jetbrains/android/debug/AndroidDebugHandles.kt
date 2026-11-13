package org.jetbrains.android.debug

import com.android.adblib.AdbSession
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.DisposableHandle
import kotlinx.coroutines.Job
import kotlinx.coroutines.job
import java.util.Collections
import java.util.HashMap
import java.util.LinkedHashMap
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

open class AndroidDebugHandles private constructor(
    private val scheduler: ScheduledExecutorService,
    private val ownsScheduler: Boolean
) {
    enum class HandleState {
        PREPARED,
        CLAIMED,
        CLOSING,
        CLOSED
    }

    enum class ExecutionKind {
        APPLICATION,
        JDWP
    }

    data class DeploymentKey(val deviceId: String, val userId: Int, val packageName: String) {
        init {
            require(deviceId.isNotBlank()) { "deviceId must not be blank" }
            require(userId >= 0) { "userId must be non-negative" }
            require(packageName.isNotBlank()) { "packageName must not be blank" }
        }
    }

    data class ProcessInstanceIdentity(
        val pid: Int,
        val userId: Int,
        val uid: Int? = null,
        val packageName: String,
        val processName: String,
        val startSeq: Long? = null,
        val amsRecord: String? = null
    ) {
        fun matchesInstance(other: ProcessInstanceIdentity): Boolean {
            if (pid != other.pid) return false
            if (userId != other.userId) return false
            if (packageName != other.packageName) return false
            if (processName != other.processName) return false
            if (uid != null && other.uid != null && uid != other.uid) return false
            if (startSeq != null && other.startSeq != null && startSeq != other.startSeq) return false
            if (amsRecord != null && other.amsRecord != null && amsRecord != other.amsRecord) return false
            return true
        }
    }

    @JvmRecord
    data class TargetId(val deviceId: String, val pid: Int) {
        init {
            requireNotNull(deviceId) { "deviceId must not be null" }
        }
    }

    class DebugHandle(
        val cleanupKey: String,
        val expiresAt: Long,
        val deviceId: String,
        val pid: Int,
        val processName: String,
        val host: String,
        val port: Int,
        val childSession: AdbSession?
    ) {
        val targetId: TargetId = TargetId(deviceId, pid)
        val kind: ExecutionKind = ExecutionKind.JDWP

        @Volatile
        var state: HandleState = HandleState.PREPARED
            internal set

        @Volatile
        internal var expirationFuture: ScheduledFuture<*>? = null

        @Volatile
        var ownerJob: Job? = null
            internal set

        @Volatile
        internal var ownerDisposableHandle: DisposableHandle? = null

        @Volatile
        var lastCloseError: Throwable? = null
            internal set

        @Volatile
        internal var closingStarted: Boolean = false

        @Volatile
        var closeFuture: CompletableFuture<Boolean> = CompletableFuture()
            internal set
    }

    class ApplicationHandle(
        val cleanupKey: String,
        val deploymentKey: DeploymentKey,
        val identity: ProcessInstanceIdentity,
        val jdwpCleanupKey: String?,
        val port: Int?
    ) {
        val kind: ExecutionKind = ExecutionKind.APPLICATION

        @Volatile
        var state: HandleState = HandleState.CLAIMED
            internal set

        @Volatile
        var ownerJob: Job? = null
            internal set

        @Volatile
        internal var ownerDisposableHandle: DisposableHandle? = null

        @Volatile
        internal var onDisposeCleanup: (() -> Unit)? = null
    }

    @JvmRecord
    data class ClaimResult(val claimed: Boolean, val cleanupKey: String?) {
        companion object {
            @JvmStatic
            fun notClaimed(): ClaimResult = ClaimResult(false, null)

            @JvmStatic
            fun claimed(cleanupKey: String?): ClaimResult = ClaimResult(true, cleanupKey)
        }
    }

    @JvmRecord
    data class ReleaseResult(val success: Boolean, val cleaned: Boolean, val reason: String?) {
        companion object {
            @JvmStatic
            fun successCleaned(): ReleaseResult = ReleaseResult(true, true, null)

            @JvmStatic
            fun successAlreadyCleaned(): ReleaseResult = ReleaseResult(true, false, "already_cleaned")
        }
    }

    private val lock = Any()
    private val handlesByKey = HashMap<String, DebugHandle>()
    private val handlesByPort = HashMap<Int, DebugHandle>()
    private val activeTargets = HashMap<TargetId, Any>()
    private val activeDeployments = HashMap<DeploymentKey, Any>()
    private val appHandlesByKey = HashMap<String, ApplicationHandle>()

    private val expiredPortTombstones = object : LinkedHashMap<Int, Long>(32, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<Int, Long>?): Boolean {
            return size > MAX_EXPIRED_PORT_TOMBSTONES
        }
    }

    constructor() : this(
        Executors.newSingleThreadScheduledExecutor { r ->
            Thread(r, "android-debug-handles-ttl").apply { isDaemon = true }
        },
        true
    )

    constructor(scheduler: ScheduledExecutorService) : this(
        scheduler,
        false
    )

    fun tryReserveTarget(targetId: TargetId): Boolean {
        synchronized(lock) {
            if (activeTargets.containsKey(targetId)) {
                return false
            }
            activeTargets[targetId] = RESERVATION_PLACEHOLDER
            return true
        }
    }

    fun cancelReservation(targetId: TargetId) {
        synchronized(lock) {
            if (activeTargets[targetId] === RESERVATION_PLACEHOLDER) {
                activeTargets.remove(targetId)
            }
        }
    }

    fun tryReserveDeployment(key: DeploymentKey): Boolean {
        synchronized(lock) {
            if (activeDeployments.containsKey(key)) {
                return false
            }
            activeDeployments[key] = DEPLOYMENT_RESERVATION_PLACEHOLDER
            return true
        }
    }

    fun cancelDeploymentReservation(key: DeploymentKey) {
        synchronized(lock) {
            if (activeDeployments[key] === DEPLOYMENT_RESERVATION_PLACEHOLDER) {
                activeDeployments.remove(key)
            }
        }
    }

    fun isDeploymentReserved(key: DeploymentKey): Boolean {
        synchronized(lock) {
            return activeDeployments.containsKey(key)
        }
    }

    @JvmOverloads
    fun recordApplication(
        key: DeploymentKey,
        identity: ProcessInstanceIdentity,
        jdwpCleanupKey: String? = null,
        port: Int? = null,
        ownerJob: Job? = null,
        onDisposeCleanup: (() -> Unit)? = null
    ): ApplicationHandle {
        val cleanupKey = UUID.randomUUID().toString()
        synchronized(lock) {
            val existing = activeDeployments[key]
            if (existing != null && existing !== DEPLOYMENT_RESERVATION_PLACEHOLDER) {
                throw AndroidDebugException(
                    "target_busy",
                    "Application target $key is already active"
                )
            }
            if (ownerJob != null && (ownerJob.isCompleted || ownerJob.isCancelled)) {
                if (existing === DEPLOYMENT_RESERVATION_PLACEHOLDER) {
                    activeDeployments.remove(key)
                }
                throw AndroidDebugException(
                    "lease_conflict",
                    "Owner connection scope is already cancelled or closed"
                )
            }

            val handle = ApplicationHandle(
                cleanupKey = cleanupKey,
                deploymentKey = key,
                identity = identity,
                jdwpCleanupKey = jdwpCleanupKey,
                port = port
            )
            handle.ownerJob = ownerJob
            handle.onDisposeCleanup = onDisposeCleanup
            activeDeployments[key] = handle
            appHandlesByKey[cleanupKey] = handle
            return handle
        }
    }

    fun getApplicationHandle(cleanupKey: String): ApplicationHandle? {
        synchronized(lock) {
            return appHandlesByKey[cleanupKey]
        }
    }

    fun getActiveApplication(key: DeploymentKey): ApplicationHandle? {
        synchronized(lock) {
            return activeDeployments[key] as? ApplicationHandle
        }
    }

    fun releaseApplication(cleanupKey: String): Boolean {
        val handle: ApplicationHandle?
        synchronized(lock) {
            handle = appHandlesByKey.remove(cleanupKey) ?: return false
            handle.state = HandleState.CLOSED
            handle.onDisposeCleanup = null
            handle.ownerDisposableHandle?.let {
                try {
                    it.dispose()
                } catch (_: Throwable) {
                }
                handle.ownerDisposableHandle = null
            }
            if (activeDeployments[handle.deploymentKey] === handle) {
                activeDeployments.remove(handle.deploymentKey)
            }
        }
        return true
    }

    @JvmOverloads
    fun recordPrepared(
        deviceId: String,
        pid: Int,
        processName: String,
        host: String,
        port: Int,
        childSession: AdbSession?,
        ttlMs: Long = DEFAULT_TTL_MS
    ): DebugHandle {
        val targetId = TargetId(deviceId, pid)
        val cleanupKey = UUID.randomUUID().toString()
        val expiresAt = System.currentTimeMillis() + ttlMs

        val handle: DebugHandle
        synchronized(lock) {
            val existing = activeTargets[targetId]
            if (existing != null && existing !== RESERVATION_PLACEHOLDER) {
                throw AndroidDebugException(
                    "lease_conflict",
                    "Target $targetId is already prepared or claimed by an active debug session"
                )
            }
            if (handlesByPort.containsKey(port)) {
                throw AndroidDebugException(
                    "lease_conflict",
                    "Port $port is already allocated to an active debug handle"
                )
            }

            handle = DebugHandle(cleanupKey, expiresAt, deviceId, pid, processName, host, port, childSession)
            val future = scheduler.schedule({ handleExpired(cleanupKey) }, ttlMs, TimeUnit.MILLISECONDS)
            handle.expirationFuture = future

            handlesByKey[cleanupKey] = handle
            handlesByPort[port] = handle
            activeTargets[targetId] = handle
            expiredPortTombstones.remove(port)
        }
        return handle
    }

    private fun recordExpiredPortLocked(port: Int) {
        expiredPortTombstones[port] = System.currentTimeMillis()
    }

    private fun beginCloseLocked(handle: DebugHandle): CompletableFuture<Boolean> {
        recordExpiredPortLocked(handle.port)
        handle.state = HandleState.CLOSING
        handle.expirationFuture?.let {
            it.cancel(false)
            handle.expirationFuture = null
        }
        handle.ownerDisposableHandle?.let {
            try {
                it.dispose()
            } catch (_: Throwable) {
            }
            handle.ownerDisposableHandle = null
        }
        if (!handle.closingStarted || handle.closeFuture.isCompletedExceptionally) {
            val attempt = if (handle.closeFuture.isCompletedExceptionally) {
                CompletableFuture<Boolean>()
            } else {
                handle.closeFuture
            }
            handle.closeFuture = attempt
            handle.closingStarted = true
            scheduler.execute { doClose(handle, attempt) }
        }
        return handle.closeFuture
    }

    private fun handleExpired(cleanupKey: String) {
        synchronized(lock) {
            val handle = handlesByKey[cleanupKey]
            if (handle == null || handle.state != HandleState.PREPARED) {
                return
            }
            beginCloseLocked(handle)
        }
    }

    @OptIn(kotlinx.coroutines.InternalCoroutinesApi::class)
    fun claim(host: String, port: Int, ownerJob: Job?): ClaimResult {
        synchronized(lock) {
            val handle = handlesByPort[port]
            if (handle == null) {
                if (expiredPortTombstones[port] != null) {
                    throw AndroidDebugException("lease_expired", "Debug handle has already expired or closed")
                }
                return ClaimResult.notClaimed()
            }

            if (handle.state == HandleState.CLOSED || handle.state == HandleState.CLOSING) {
                throw AndroidDebugException("lease_expired", "Debug handle has already expired or is closing")
            }

            if (handle.state == HandleState.PREPARED && System.currentTimeMillis() >= handle.expiresAt) {
                beginCloseLocked(handle)
                throw AndroidDebugException("lease_expired", "Debug handle has expired")
            }

            if (handle.state == HandleState.CLAIMED) {
                if (handle.ownerJob == ownerJob) {
                    return ClaimResult.claimed(handle.cleanupKey)
                }
                throw AndroidDebugException(
                    "lease_conflict",
                    "Debug handle on port $port is already claimed by another connection"
                )
            }

            if (handle.state == HandleState.PREPARED) {
                if (ownerJob != null && (ownerJob.isCompleted || ownerJob.isCancelled)) {
                    beginCloseLocked(handle)
                    throw AndroidDebugException(
                        "lease_conflict",
                        "Owner connection scope is already cancelled or closed"
                    )
                }

                // Valid claim
                handle.expirationFuture?.let {
                    it.cancel(false)
                    handle.expirationFuture = null
                }
                handle.state = HandleState.CLAIMED
                handle.ownerJob = ownerJob

                if (ownerJob != null) {
                    // Completion can wait for debugger children that need this proxy to close first.
                    handle.ownerDisposableHandle = ownerJob.invokeOnCompletion(
                        onCancelling = true,
                        invokeImmediately = true
                    ) { _ ->
                        synchronized(lock) {
                            if (handle.state != HandleState.CLOSED) beginCloseLocked(handle)
                        }
                    }
                }
                return ClaimResult.claimed(handle.cleanupKey)
            }

            // Any other state throws lease_expired
            throw AndroidDebugException("lease_expired", "Debug handle is in state ${handle.state}")
        }
    }

    fun release(cleanupKey: String): ReleaseResult {
        val handle: DebugHandle?
        val closeFutureToWait: CompletableFuture<Boolean>
        synchronized(lock) {
            handle = handlesByKey[cleanupKey]
            if (handle == null || handle.state == HandleState.CLOSED) {
                return ReleaseResult.successAlreadyCleaned()
            }
            closeFutureToWait = beginCloseLocked(handle)
        }

        try {
            closeFutureToWait.get(10, TimeUnit.SECONDS)
            return ReleaseResult.successCleaned()
        } catch (e: TimeoutException) {
            throw AndroidDebugException("cleanup_failed", "Timed out waiting for debug handle cleanup", e)
        } catch (e: InterruptedException) {
            Thread.currentThread().interrupt()
            throw AndroidDebugException("cleanup_failed", "Interrupted waiting for debug handle cleanup", e)
        } catch (e: ExecutionException) {
            val cause = e.cause ?: e
            throw AndroidDebugException("cleanup_failed", "Error during debug handle cleanup: ${cause.message}", cause)
        }
    }

    private fun doClose(handle: DebugHandle, attempt: CompletableFuture<Boolean>) {
        try {
            closeAttachedDebugSession(handle.port)

            val childSession = handle.childSession
            if (childSession != null) {
                childSession.close()
                val job = childSession.scope.coroutineContext.job
                if (!job.isCompleted) {
                    val jobDone = CompletableFuture<Unit?>()
                    val registration = job.invokeOnCompletion { _ ->
                        jobDone.complete(null)
                    }
                    try {
                        jobDone.get(1, TimeUnit.SECONDS)
                    } finally {
                        registration.dispose()
                    }
                }
            }
            synchronized(lock) {
                handle.lastCloseError = null
            }
        } catch (t: Throwable) {
            if (t is InterruptedException) Thread.currentThread().interrupt()
            synchronized(lock) {
                handle.lastCloseError = t
            }
            attempt.completeExceptionally(t)
            return
        }
        synchronized(lock) {
            handle.state = HandleState.CLOSED
            if (handlesByKey[handle.cleanupKey] === handle) {
                handlesByKey.remove(handle.cleanupKey)
            }
            if (handlesByPort[handle.port] === handle) {
                handlesByPort.remove(handle.port)
            }
            if (activeTargets[handle.targetId] === handle) {
                activeTargets.remove(handle.targetId)
            }
        }
        attempt.complete(true)
    }

    private fun closeAttachedDebugSession(port: Int) {
        try {
            val app = com.intellij.openapi.application.ApplicationManager.getApplication() ?: return
            val pm = com.intellij.openapi.project.ProjectManager.getInstance() ?: return
            val portStr = port.toString()
            for (project in pm.openProjects) {
                val xdm = com.intellij.xdebugger.XDebuggerManager.getInstance(project) ?: continue
                for (session in xdm.debugSessions) {
                    val xProcess = session.debugProcess
                    if (xProcess is com.intellij.debugger.engine.JavaDebugProcess) {
                        val debugProcess = xProcess.debuggerSession.process
                        val conn = debugProcess.connection
                        if (conn != null && portStr == conn.applicationAddress) {
                            debugProcess.managerThread.schedule(object :
                                com.intellij.debugger.engine.events.DebuggerCommandImpl(
                                    com.intellij.debugger.impl.PrioritizedTask.Priority.HIGH
                                ) {
                                override fun action() {
                                    debugProcess.stop(false)
                                }
                            })
                        }
                    }
                }
            }
        } catch (_: Throwable) {
        }
    }

    fun closeAll() {
        val toClose = mutableListOf<CompletableFuture<Boolean>>()
        val appDisposeCallbacks = mutableListOf<() -> Unit>()
        synchronized(lock) {
            for (appHandle in appHandlesByKey.values) {
                if (appHandle.state != HandleState.CLOSED) {
                    appHandle.state = HandleState.CLOSED
                    appHandle.ownerDisposableHandle?.let {
                        try {
                            it.dispose()
                        } catch (_: Throwable) {
                        }
                        appHandle.ownerDisposableHandle = null
                    }
                    appHandle.onDisposeCleanup?.let { cb ->
                        appDisposeCallbacks.add(cb)
                    }
                    appHandle.onDisposeCleanup = null
                }
            }
            for (handle in handlesByKey.values) {
                if (handle.state != HandleState.CLOSED) {
                    toClose.add(beginCloseLocked(handle))
                }
            }
        }

        for (cb in appDisposeCallbacks) {
            try {
                cb()
            } catch (_: Throwable) {
            }
        }

        for (attempt in toClose) {
            try {
                attempt.get(10, TimeUnit.SECONDS)
            } catch (_: Throwable) {
            }
        }

        synchronized(lock) {
            handlesByKey.clear()
            handlesByPort.clear()
            activeTargets.clear()
            activeDeployments.clear()
            appHandlesByKey.clear()
            expiredPortTombstones.clear()
        }

        if (ownsScheduler) {
            scheduler.shutdownNow()
        }
    }

    fun getHandle(cleanupKey: String): DebugHandle? {
        synchronized(lock) {
            return handlesByKey[cleanupKey]
        }
    }

    fun getHandleByPort(port: Int): DebugHandle? {
        synchronized(lock) {
            return handlesByPort[port]
        }
    }

    fun isTargetReserved(targetId: TargetId): Boolean {
        synchronized(lock) {
            return activeTargets.containsKey(targetId)
        }
    }

    companion object {
        const val DEFAULT_TTL_MS: Long = 300_000L // 5 minutes
        const val MAX_EXPIRED_PORT_TOMBSTONES: Int = 128
        private val RESERVATION_PLACEHOLDER = Any()
        private val DEPLOYMENT_RESERVATION_PLACEHOLDER = Any()
    }
}
