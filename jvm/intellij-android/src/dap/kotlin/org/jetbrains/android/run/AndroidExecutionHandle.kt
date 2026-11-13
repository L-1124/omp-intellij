package org.jetbrains.android.run

import com.android.adblib.ConnectedDevice
import com.android.adblib.DeviceState
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.jetbrains.android.debug.AndroidDebugHandles
import java.util.concurrent.atomic.AtomicBoolean

data class AndroidProcessExit(
    val exitCode: Int? = null,
    val deviceOffline: Boolean = false,
    val reason: String? = null,
)

class AndroidExecutionHandle internal constructor(
    val pid: Int,
    val deviceId: String,
    val userId: Int,
    val packageName: String,
    val processName: String,
    val port: Int?,
    val isApplication: Boolean,
    val identity: AndroidDebugHandles.ProcessInstanceIdentity,
    private val handles: AndroidDebugHandles,
    private val device: ConnectedDevice,
    private val deviceOps: AndroidDeviceOperations,
    private val isDebuggable: Boolean,
    private val appCleanupKey: String?,
    private val jdwpCleanupKey: String?,
    private val stopTimeoutMs: Long = 5_000L,
    private val extraCleanup: (suspend () -> Unit)? = null,
) {
    val kind: AndroidDebugHandles.ExecutionKind =
        if (isApplication) AndroidDebugHandles.ExecutionKind.APPLICATION else AndroidDebugHandles.ExecutionKind.JDWP

    private val closeMutex = Mutex()
    private val closeCompleted = AtomicBoolean(false)
    private val closeSignal = CompletableDeferred<AndroidProcessExit>()
    private val exitDeferred = CompletableDeferred<AndroidProcessExit>()
    private val monitorStarted = AtomicBoolean(false)

    suspend fun close(terminateApplication: Boolean) {
        closeMutex.withLock {
            if (closeCompleted.get()) {
                closeSignal.complete(
                    AndroidProcessExit(exitCode = null, deviceOffline = false, reason = "closed")
                )
                if (!isApplication && terminateApplication) {
                    throw AndroidRunException(
                        AndroidRunError(
                            code = AndroidRunErrorCode.INVALID_PARAMS,
                            stage = AndroidRunStage.CLEANUP,
                            detail = "terminateDebuggee=true is not permitted for external attach",
                            device = deviceId,
                        )
                    )
                }
                return
            }

            withContext(NonCancellable) {
                var primaryError: AndroidRunException? = null
                val cleanupErrors = ArrayList<String>()

                val allowStop = isApplication && terminateApplication
                if (!isApplication && terminateApplication) {
                    primaryError = AndroidRunException(
                        AndroidRunError(
                            code = AndroidRunErrorCode.INVALID_PARAMS,
                            stage = AndroidRunStage.CLEANUP,
                            detail = "terminateDebuggee=true is not permitted for external attach",
                            device = deviceId,
                        )
                    )
                }

                if (jdwpCleanupKey != null) {
                    try {
                        handles.release(jdwpCleanupKey)
                    } catch (t: Throwable) {
                        cleanupErrors.add(formatFailure(t))
                    }
                }

                if (allowStop) {
                    try {
                        stopIfSameInstance()
                    } catch (t: Throwable) {
                        cleanupErrors.add(formatFailure(t))
                    }
                }

                if (appCleanupKey != null) {
                    try {
                        handles.releaseApplication(appCleanupKey)
                    } catch (t: Throwable) {
                        cleanupErrors.add(formatFailure(t))
                    }
                }

                if (extraCleanup != null) {
                    try {
                        extraCleanup.invoke()
                    } catch (t: Throwable) {
                        cleanupErrors.add(formatFailure(t))
                    }
                }

                closeCompleted.set(true)
                closeSignal.complete(
                    AndroidProcessExit(exitCode = null, deviceOffline = false, reason = "closed")
                )

                if (primaryError != null) {
                    var err = primaryError
                    if (cleanupErrors.isNotEmpty()) {
                        err = err.withCleanupError(cleanupErrors.joinToString("; "))
                    }
                    throw err
                }
                if (cleanupErrors.isNotEmpty()) {
                    throw AndroidRunException(
                        AndroidRunError(
                            code = AndroidRunErrorCode.CLEANUP_FAILED,
                            stage = AndroidRunStage.CLEANUP,
                            detail = cleanupErrors.joinToString("; "),
                            device = deviceId,
                        )
                    )
                }
            }
        }
    }

    suspend fun awaitExit(): AndroidProcessExit {
        if (closeCompleted.get()) {
            val closed = AndroidProcessExit(exitCode = null, deviceOffline = false, reason = "closed")
            exitDeferred.complete(closed)
            return exitDeferred.await()
        }
        if (monitorStarted.compareAndSet(false, true)) {
            val observed = try {
                deviceOps.monitorProcessExit(device, identity, isDebuggable, closeSignal)
            } catch (e: CancellationException) {
                throw e
            } catch (_: Throwable) {
                val offline = device.deviceInfoFlow.value.deviceState != DeviceState.ONLINE
                AndroidProcessExit(
                    exitCode = null,
                    deviceOffline = offline,
                    reason = if (offline) "device_offline" else "process_exited",
                )
            }
            exitDeferred.complete(observed)
            return observed
        }
        return exitDeferred.await()
    }

    private suspend fun stopIfSameInstance() {
        val state = device.deviceInfoFlow.value.deviceState
        if (state != DeviceState.ONLINE) {
            throw AndroidRunException(
                AndroidRunError(
                    code = AndroidRunErrorCode.DEVICE_OFFLINE,
                    stage = AndroidRunStage.CLEANUP,
                    detail = "Device $deviceId is offline ($state); skipped force-stop of $packageName",
                    device = deviceId,
                )
            )
        }
        val running = deviceOps.queryAmsProcesses(device, packageName, userId, stopTimeoutMs)
        val sameInstanceAlive = running.any { identity.matchesInstance(it) }
        if (!sameInstanceAlive) {
            // Either our instance already exited or an external restart replaced it.
            // Preserve any new external instance instead of calling package-wide force-stop.
            return
        }
        deviceOps.forceStopPackage(device, userId, packageName, stopTimeoutMs)
    }

    private fun formatFailure(t: Throwable): String {
        if (t is AndroidRunException) {
            return t.error.formattedWireMessage()
        }
        val msg = t.message?.takeIf { it.isNotBlank() } ?: t::class.java.simpleName
        return msg
    }
}
