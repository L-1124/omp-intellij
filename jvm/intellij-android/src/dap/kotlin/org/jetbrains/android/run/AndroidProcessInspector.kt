package org.jetbrains.android.run

import com.android.adblib.ConnectedDevice
import com.android.adblib.DeviceSelector
import com.android.adblib.DeviceState
import com.android.adblib.ShellCommandOutput
import com.android.adblib.serialNumber
import com.android.adblib.shellAsText
import com.android.adblib.syncRecv
import com.android.adblib.tools.debugging.appProcessTracker
import com.android.adblib.tools.debugging.jdwpProcessTracker
import com.android.adblib.tools.debugging.scope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.job
import kotlinx.coroutines.launch
import kotlinx.coroutines.selects.select
import kotlinx.coroutines.withTimeout
import org.jetbrains.android.debug.AndroidDebugHandles
import java.nio.file.Path
import java.time.Duration

interface AndroidDeviceOperations {
    suspend fun getCurrentUser(device: ConnectedDevice, timeoutMs: Long): Int
    suspend fun resolveInstalledApkPaths(
        device: ConnectedDevice,
        userId: Int,
        packageName: String,
        timeoutMs: Long
    ): List<String>

    suspend fun pullFile(device: ConnectedDevice, remotePath: String, destination: Path, timeoutMs: Long)
    suspend fun queryAmsProcesses(
        device: ConnectedDevice,
        packageName: String,
        userId: Int? = null,
        timeoutMs: Long = 10_000L
    ): List<AndroidDebugHandles.ProcessInstanceIdentity>

    suspend fun startActivity(
        device: ConnectedDevice,
        userId: Int,
        componentName: String,
        debug: Boolean,
        timeoutMs: Long
    )

    suspend fun forceStopPackage(device: ConnectedDevice, userId: Int, packageName: String, timeoutMs: Long)
    suspend fun awaitProcessIdentity(
        device: ConnectedDevice,
        userId: Int,
        packageName: String,
        expectedProcessName: String,
        excludedPids: Set<Int> = emptySet(),
        timeoutMs: Long,
    ): AndroidDebugHandles.ProcessInstanceIdentity

    suspend fun awaitPackageStopped(device: ConnectedDevice, userId: Int, packageName: String, timeoutMs: Long)
    suspend fun monitorProcessExit(
        device: ConnectedDevice,
        identity: AndroidDebugHandles.ProcessInstanceIdentity,
        isDebuggable: Boolean,
        closeSignal: CompletableDeferred<AndroidProcessExit>,
    ): AndroidProcessExit
}

class AndroidProcessInspector(
    private val shellRunner: suspend (ConnectedDevice, String, Long) -> ShellCommandOutput = { device, command, timeoutMs ->
        val selector = DeviceSelector.fromSerialNumber(device.serialNumber)
        withTimeout(timeoutMs) {
            device.session.deviceServices.shellAsText(
                device = selector,
                command = command,
                commandTimeout = Duration.ofMillis(timeoutMs),
            )
        }
    },
    private val filePuller: suspend (ConnectedDevice, String, Path, Long) -> Unit = { device, remotePath, destination, timeoutMs ->
        val selector = DeviceSelector.fromSerialNumber(device.serialNumber)
        withTimeout(timeoutMs) {
            device.session.deviceServices.syncRecv(selector, remotePath, destination)
        }
    },
    private val pollIntervalMs: Long = 50L,
    private val exitPollIntervalMs: Long = 250L,
) : AndroidDeviceOperations {

    override suspend fun getCurrentUser(device: ConnectedDevice, timeoutMs: Long): Int {
        ensureDeviceOnline(device)
        val output = runShell(device, "am get-current-user", timeoutMs, AndroidRunStage.CONFIGURING)
        val raw = output.stdout.trim()
        val parsed = raw.lineSequence().firstOrNull { it.isNotBlank() }?.trim()?.toIntOrNull()
        if (output.exitCode != 0 || parsed == null || parsed < 0) {
            ensureDeviceOnline(device)
            throw AndroidRunException(
                AndroidRunError(
                    code = AndroidRunErrorCode.PREREQUISITE_MISSING,
                    stage = AndroidRunStage.CONFIGURING,
                    detail = "Failed to query current Android user on ${device.serialNumber}: ${output.stderr.ifBlank { raw }}",
                    device = device.serialNumber,
                    exitCode = output.exitCode,
                    outputTail = combinedOutput(output),
                )
            )
        }
        return parsed
    }

    override suspend fun resolveInstalledApkPaths(
        device: ConnectedDevice,
        userId: Int,
        packageName: String,
        timeoutMs: Long,
    ): List<String> {
        validateUserId(userId, device.serialNumber)
        validatePackageName(packageName, device.serialNumber)
        ensureDeviceOnline(device)

        val output = runShell(
            device,
            "pm path --user $userId $packageName",
            timeoutMs,
            AndroidRunStage.CONFIGURING,
        )
        val paths = output.stdout
            .lineSequence()
            .map { it.trim() }
            .filter { it.startsWith("package:") }
            .map { it.removePrefix("package:").trim() }
            .filter { it.startsWith("/") }
            .toList()

        if (output.exitCode != 0 || paths.isEmpty()) {
            ensureDeviceOnline(device)
            throw AndroidRunException(
                AndroidRunError(
                    code = AndroidRunErrorCode.ARTIFACT_INVALID,
                    stage = AndroidRunStage.CONFIGURING,
                    detail = "Package $packageName is not installed for user $userId on ${device.serialNumber}",
                    device = device.serialNumber,
                    exitCode = output.exitCode,
                    outputTail = combinedOutput(output),
                )
            )
        }

        val baseFirst = paths.sortedBy { if (it.endsWith("/base.apk")) 0 else 1 }
        return baseFirst
    }

    override suspend fun pullFile(
        device: ConnectedDevice,
        remotePath: String,
        destination: Path,
        timeoutMs: Long,
    ) {
        ensureDeviceOnline(device)
        try {
            filePuller(device, remotePath, destination, timeoutMs)
        } catch (e: CancellationException) {
            if (e is TimeoutCancellationException) {
                throw AndroidRunException(
                    AndroidRunError(
                        code = AndroidRunErrorCode.ARTIFACT_INVALID,
                        stage = AndroidRunStage.CONFIGURING,
                        detail = "Timed out pulling APK from $remotePath on ${device.serialNumber}",
                        device = device.serialNumber,
                    ),
                    e,
                )
            }
            throw e
        } catch (e: AndroidRunException) {
            throw e
        } catch (t: Throwable) {
            ensureDeviceOnline(device)
            throw AndroidRunException(
                AndroidRunError(
                    code = AndroidRunErrorCode.ARTIFACT_INVALID,
                    stage = AndroidRunStage.CONFIGURING,
                    detail = "Failed to pull APK $remotePath from ${device.serialNumber}: ${t.message}",
                    device = device.serialNumber,
                ),
                t,
            )
        }
    }

    override suspend fun queryAmsProcesses(
        device: ConnectedDevice,
        packageName: String,
        userId: Int?,
        timeoutMs: Long,
    ): List<AndroidDebugHandles.ProcessInstanceIdentity> {
        validatePackageName(packageName, device.serialNumber)
        if (userId != null) validateUserId(userId, device.serialNumber)
        ensureDeviceOnline(device)

        val output = runShell(
            device,
            "dumpsys activity processes $packageName",
            timeoutMs,
            AndroidRunStage.CONFIGURING,
        )
        if (output.exitCode != 0) {
            ensureDeviceOnline(device)
            throw AndroidRunException(
                AndroidRunError(
                    code = AndroidRunErrorCode.START_FAILED,
                    stage = AndroidRunStage.STARTING,
                    detail = "dumpsys activity processes failed for $packageName (exit=${output.exitCode})",
                    device = device.serialNumber,
                    exitCode = output.exitCode,
                    outputTail = combinedOutput(output),
                )
            )
        }
        return parseDumpsysActivityProcesses(output.stdout, packageName, userId)
    }

    override suspend fun startActivity(
        device: ConnectedDevice,
        userId: Int,
        componentName: String,
        debug: Boolean,
        timeoutMs: Long,
    ) {
        validateUserId(userId, device.serialNumber)
        validateComponentName(componentName, device.serialNumber)
        ensureDeviceOnline(device)

        val debugFlag = if (debug) "-D " else ""
        val command = "am start --user $userId ${debugFlag}-n $componentName"
        val output = runShell(device, command, timeoutMs, AndroidRunStage.STARTING)
        val combined = combinedOutput(output)
        val failureReason = validateAmStartOutput(output.stdout, output.stderr, output.exitCode)
        if (failureReason != null) {
            ensureDeviceOnline(device)
            throw AndroidRunException(
                AndroidRunError(
                    code = AndroidRunErrorCode.START_FAILED,
                    stage = AndroidRunStage.STARTING,
                    detail = "Failed to start $componentName for user $userId: $failureReason",
                    device = device.serialNumber,
                    exitCode = output.exitCode,
                    outputTail = combined,
                )
            )
        }
    }

    override suspend fun forceStopPackage(
        device: ConnectedDevice,
        userId: Int,
        packageName: String,
        timeoutMs: Long,
    ) {
        validateUserId(userId, device.serialNumber)
        validatePackageName(packageName, device.serialNumber)
        ensureDeviceOnline(device)

        val output = runShell(
            device,
            "am force-stop --user $userId $packageName",
            timeoutMs,
            AndroidRunStage.CLEANUP,
        )
        val combined = combinedOutput(output)
        if (output.exitCode != 0 || containsShellError(output.stdout) || containsShellError(output.stderr)) {
            ensureDeviceOnline(device)
            throw AndroidRunException(
                AndroidRunError(
                    code = AndroidRunErrorCode.CLEANUP_FAILED,
                    stage = AndroidRunStage.CLEANUP,
                    detail = "am force-stop failed for $packageName (user $userId)",
                    device = device.serialNumber,
                    exitCode = output.exitCode,
                    outputTail = combined,
                )
            )
        }
    }

    override suspend fun awaitProcessIdentity(
        device: ConnectedDevice,
        userId: Int,
        packageName: String,
        expectedProcessName: String,
        excludedPids: Set<Int>,
        timeoutMs: Long,
    ): AndroidDebugHandles.ProcessInstanceIdentity {
        return try {
            withTimeout(timeoutMs) {
                while (true) {
                    ensureDeviceOnline(device)
                    val processes = queryAmsProcesses(device, packageName, userId, minOf(timeoutMs, 5_000L))
                    val match = processes.firstOrNull {
                        it.processName == expectedProcessName && it.pid !in excludedPids
                    }
                    if (match != null) {
                        return@withTimeout match
                    }
                    delay(pollIntervalMs)
                }
                @Suppress("UNREACHABLE_CODE")
                error("Unreachable")
            }
        } catch (timeout: TimeoutCancellationException) {
            ensureDeviceOnline(device)
            throw AndroidRunException(
                AndroidRunError(
                    code = AndroidRunErrorCode.START_FAILED,
                    stage = AndroidRunStage.STARTING,
                    detail = "Timed out waiting for AMS process '$expectedProcessName' of $packageName (user $userId) to start",
                    device = device.serialNumber,
                ),
                timeout,
            )
        }
    }

    override suspend fun awaitPackageStopped(
        device: ConnectedDevice,
        userId: Int,
        packageName: String,
        timeoutMs: Long,
    ) {
        try {
            withTimeout(timeoutMs) {
                while (true) {
                    ensureDeviceOnline(device)
                    val remaining = queryAmsProcesses(device, packageName, userId, minOf(timeoutMs, 5_000L))
                    if (remaining.isEmpty()) {
                        return@withTimeout
                    }
                    delay(pollIntervalMs)
                }
            }
        } catch (_: TimeoutCancellationException) {
            // Best-effort wait; excludedPids also prevents matching stale PIDs.
        }
    }

    override suspend fun monitorProcessExit(
        device: ConnectedDevice,
        identity: AndroidDebugHandles.ProcessInstanceIdentity,
        isDebuggable: Boolean,
        closeSignal: CompletableDeferred<AndroidProcessExit>,
    ): AndroidProcessExit {
        return coroutineScope {
            val result = CompletableDeferred<AndroidProcessExit>()

            val closeWatcher = launch {
                val exit = closeSignal.await()
                result.complete(exit)
            }

            val deviceWatcher = launch {
                try {
                    device.deviceInfoFlow.first { it.deviceState != DeviceState.ONLINE }
                    result.complete(
                        AndroidProcessExit(
                            exitCode = null,
                            deviceOffline = true,
                            reason = "device_offline",
                        )
                    )
                } catch (_: CancellationException) {
                } catch (_: Throwable) {
                    result.complete(
                        AndroidProcessExit(
                            exitCode = null,
                            deviceOffline = true,
                            reason = "device_offline",
                        )
                    )
                }
            }

            val processWatcher = launch {
                try {
                    if (device.deviceInfoFlow.value.deviceState != DeviceState.ONLINE) {
                        result.complete(
                            AndroidProcessExit(
                                exitCode = null,
                                deviceOffline = true,
                                reason = "device_offline"
                            )
                        )
                        return@launch
                    }

                    val jdwpProc = if (isDebuggable) {
                        device.jdwpProcessTracker.processesFlow.value.firstOrNull { it.pid == identity.pid }
                    } else {
                        null
                    }
                    if (jdwpProc != null) {
                        jdwpProc.scope.coroutineContext.job.join()
                        val offline = device.deviceInfoFlow.value.deviceState != DeviceState.ONLINE
                        result.complete(
                            AndroidProcessExit(
                                exitCode = null,
                                deviceOffline = offline,
                                reason = if (offline) "device_offline" else "process_exited",
                            )
                        )
                        return@launch
                    }

                    val appProc = device.appProcessTracker.appProcessFlow.value.firstOrNull { it.pid == identity.pid }
                    if (appProc != null) {
                        appProc.scope.coroutineContext.job.join()
                        val offline = device.deviceInfoFlow.value.deviceState != DeviceState.ONLINE
                        result.complete(
                            AndroidProcessExit(
                                exitCode = null,
                                deviceOffline = offline,
                                reason = if (offline) "device_offline" else "process_exited",
                            )
                        )
                        return@launch
                    }

                    // Non-debuggable/non-profileable release apps are not listed in track-app:
                    // observe AMS ProcessRecord identity directly.
                    while (!result.isCompleted) {
                        delay(exitPollIntervalMs)
                        if (device.deviceInfoFlow.value.deviceState != DeviceState.ONLINE) {
                            result.complete(
                                AndroidProcessExit(
                                    exitCode = null,
                                    deviceOffline = true,
                                    reason = "device_offline"
                                )
                            )
                            return@launch
                        }
                        val current = try {
                            queryAmsProcesses(device, identity.packageName, identity.userId, 5_000L)
                        } catch (e: AndroidRunException) {
                            if (e.error.code == AndroidRunErrorCode.DEVICE_OFFLINE) {
                                result.complete(
                                    AndroidProcessExit(
                                        exitCode = null,
                                        deviceOffline = true,
                                        reason = "device_offline"
                                    )
                                )
                                return@launch
                            }
                            continue
                        }
                        val stillAlive = current.any { identity.matchesInstance(it) }
                        if (!stillAlive) {
                            result.complete(
                                AndroidProcessExit(
                                    exitCode = null,
                                    deviceOffline = false,
                                    reason = "process_exited",
                                )
                            )
                            return@launch
                        }
                    }
                } catch (_: CancellationException) {
                } catch (_: Throwable) {
                    val offline = device.deviceInfoFlow.value.deviceState != DeviceState.ONLINE
                    result.complete(
                        AndroidProcessExit(
                            exitCode = null,
                            deviceOffline = offline,
                            reason = if (offline) "device_offline" else "process_exited",
                        )
                    )
                }
            }

            try {
                result.await()
            } finally {
                closeWatcher.cancel()
                deviceWatcher.cancel()
                processWatcher.cancel()
            }
        }
    }

    private suspend fun runShell(
        device: ConnectedDevice,
        command: String,
        timeoutMs: Long,
        stage: AndroidRunStage,
    ): ShellCommandOutput {
        return try {
            shellRunner(device, command, timeoutMs)
        } catch (e: CancellationException) {
            if (e is TimeoutCancellationException) {
                ensureDeviceOnline(device)
                throw AndroidRunException(
                    AndroidRunError(
                        code = if (stage == AndroidRunStage.STARTING) AndroidRunErrorCode.START_FAILED else AndroidRunErrorCode.CLEANUP_FAILED,
                        stage = stage,
                        detail = "Device command timed out: $command",
                        device = device.serialNumber,
                    ),
                    e,
                )
            }
            throw e
        } catch (e: AndroidRunException) {
            throw e
        } catch (t: Throwable) {
            ensureDeviceOnline(device)
            throw AndroidRunException(
                AndroidRunError(
                    code = AndroidRunErrorCode.DEVICE_OFFLINE,
                    stage = stage,
                    detail = "ADB command '$command' failed on ${device.serialNumber}: ${t.message}",
                    device = device.serialNumber,
                ),
                t,
            )
        }
    }

    private fun ensureDeviceOnline(device: ConnectedDevice) {
        val state = device.deviceInfoFlow.value.deviceState
        if (state != DeviceState.ONLINE) {
            throw AndroidRunException(
                AndroidRunError(
                    code = AndroidRunErrorCode.DEVICE_OFFLINE,
                    stage = AndroidRunStage.CONFIGURING,
                    detail = "Device ${device.serialNumber} is not online ($state)",
                    device = device.serialNumber,
                )
            )
        }
    }

    companion object {
        private val SAFE_PACKAGE_REGEX = Regex("^[A-Za-z_][A-Za-z0-9_]*(\\.[A-Za-z_][A-Za-z0-9_]*)+$")
        private val SAFE_COMPONENT_REGEX = Regex("^[A-Za-z0-9_.$]+/[A-Za-z0-9_.$]+$")
        private val PROCESS_RECORD_HEADER_REGEX = Regex(
            """\*APP\*\s+UID\s+(\d+)\s+ProcessRecord\{([^}\s]+\s+(\d+):([^/\s}]+)/([^}]+))\}"""
        )
        private val FALLBACK_PROCESS_RECORD_REGEX = Regex(
            """ProcessRecord\{([^}\s]+\s+(\d+):([^/\s}]+)/([^}]+))\}"""
        )
        private val USER_UID_REGEX = Regex("""\buser\s+#(\d+)\s+uid=(\d+)""")
        private val START_SEQ_REGEX = Regex("""\bstartSeq=(\d+)""")
        private val PKG_LIST_REGEX = Regex("""\b(?:packageList|pkgList)=\{([^}]*)\}""")
        private val USER_TAG_REGEX = Regex("""^u(\d+)""")

        fun validateUserId(userId: Int, deviceId: String?) {
            if (userId < 0) {
                throw AndroidRunException(
                    AndroidRunError(
                        code = AndroidRunErrorCode.INVALID_PARAMS,
                        stage = AndroidRunStage.CONFIGURING,
                        detail = "userId must be non-negative: $userId",
                        device = deviceId,
                    )
                )
            }
        }

        fun validatePackageName(packageName: String, deviceId: String?) {
            if (!SAFE_PACKAGE_REGEX.matches(packageName)) {
                throw AndroidRunException(
                    AndroidRunError(
                        code = AndroidRunErrorCode.INVALID_PARAMS,
                        stage = AndroidRunStage.CONFIGURING,
                        detail = "Invalid Android package name: $packageName",
                        device = deviceId,
                    )
                )
            }
        }

        fun validateComponentName(componentName: String, deviceId: String?) {
            if (!SAFE_COMPONENT_REGEX.matches(componentName)) {
                throw AndroidRunException(
                    AndroidRunError(
                        code = AndroidRunErrorCode.INVALID_PARAMS,
                        stage = AndroidRunStage.STARTING,
                        detail = "Invalid Android component name: $componentName",
                        device = deviceId,
                    )
                )
            }
        }

        fun validateAmStartOutput(stdout: String, stderr: String, exitCode: Int): String? {
            if (exitCode != 0) {
                return "am start exited with code $exitCode"
            }
            val combined = listOf(stdout.trim(), stderr.trim()).filter { it.isNotEmpty() }.joinToString("\n")
            if (combined.isEmpty()) {
                return "am start produced no output"
            }
            if (containsShellError(stdout) || containsShellError(stderr)) {
                return combined
            }
            if (!stdout.contains("Starting:")) {
                return "am start output missing 'Starting:': $combined"
            }
            return null
        }

        private fun containsShellError(text: String): Boolean {
            for (rawLine in text.lineSequence()) {
                val line = rawLine.trim()
                if (line.isEmpty()) continue
                if (line.startsWith("Error:", ignoreCase = true) ||
                    line.startsWith("Error type ", ignoreCase = true) ||
                    line.contains("Exception:", ignoreCase = false) ||
                    line.contains("Permission Denial", ignoreCase = true) ||
                    line.contains("Unknown option", ignoreCase = true) ||
                    line.contains("does not exist", ignoreCase = true) ||
                    line.contains("unable to resolve Intent", ignoreCase = true) ||
                    line.contains("Activity not started", ignoreCase = true)
                ) {
                    return true
                }
            }
            return false
        }

        fun parseDumpsysActivityProcesses(
            dumpsysOutput: String,
            targetPackage: String,
            targetUserId: Int? = null,
        ): List<AndroidDebugHandles.ProcessInstanceIdentity> {
            data class MutableRecord(
                val amsRecord: String,
                val pid: Int,
                val processName: String,
                var userId: Int,
                var uid: Int?,
                var startSeq: Long? = null,
                val packages: MutableSet<String> = LinkedHashSet(),
            )

            val records = ArrayList<MutableRecord>()
            var current: MutableRecord? = null
            var inProcessesSection = false

            for (rawLine in dumpsysOutput.lineSequence()) {
                val trimmed = rawLine.trim()
                if (trimmed.isEmpty()) continue

                if (trimmed.startsWith("OOM levels:") ||
                    trimmed.startsWith("Process OOM control") ||
                    trimmed.startsWith("Process LRU list") ||
                    trimmed.startsWith("PID mappings:") ||
                    trimmed.startsWith("mHomeProcess:") ||
                    trimmed.startsWith("mPreviousProcess:")
                ) {
                    current = null
                    inProcessesSection = false
                    continue
                }

                if (trimmed.startsWith("All known processes:") || trimmed.startsWith("*APP*")) {
                    inProcessesSection = true
                }

                val appMatch = PROCESS_RECORD_HEADER_REGEX.find(trimmed)
                if (appMatch != null) {
                    inProcessesSection = true
                    val uid = appMatch.groupValues[1].toIntOrNull()
                    val recordBody = appMatch.groupValues[2]
                    val pid = appMatch.groupValues[3].toIntOrNull()
                    if (pid == null || pid <= 0) {
                        current = null
                        continue
                    }
                    val processName = appMatch.groupValues[4]
                    val userTag = appMatch.groupValues[5]
                    val parsedUser = USER_TAG_REGEX.find(userTag)?.groupValues?.get(1)?.toIntOrNull() ?: 0
                    current = MutableRecord(
                        amsRecord = recordBody,
                        pid = pid,
                        processName = processName,
                        userId = parsedUser,
                        uid = uid,
                    )
                    records.add(current)
                    continue
                }

                if (inProcessesSection && trimmed.startsWith("Proc #")) {
                    val procMatch = FALLBACK_PROCESS_RECORD_REGEX.find(trimmed)
                    if (procMatch != null) {
                        val recordBody = procMatch.groupValues[1]
                        val pid = procMatch.groupValues[2].toIntOrNull()
                        if (pid == null || pid <= 0) {
                            current = null
                            continue
                        }
                        val processName = procMatch.groupValues[3]
                        val userTag = procMatch.groupValues[4]
                        val parsedUser = USER_TAG_REGEX.find(userTag)?.groupValues?.get(1)?.toIntOrNull() ?: 0
                        current = MutableRecord(
                            amsRecord = recordBody,
                            pid = pid,
                            processName = processName,
                            userId = parsedUser,
                            uid = null,
                        )
                        records.add(current)
                        continue
                    }
                }

                val rec = current ?: continue
                USER_UID_REGEX.find(trimmed)?.let { m ->
                    m.groupValues[1].toIntOrNull()?.let { rec.userId = it }
                    m.groupValues[2].toIntOrNull()?.let { rec.uid = it }
                }
                START_SEQ_REGEX.find(trimmed)?.let { m ->
                    m.groupValues[1].toLongOrNull()?.let { rec.startSeq = it }
                }
                PKG_LIST_REGEX.find(trimmed)?.let { m ->
                    for (pkg in m.groupValues[1].split(',')) {
                        val cleaned = pkg.trim()
                        if (cleaned.isNotEmpty()) rec.packages.add(cleaned)
                    }
                }
            }

            val result = ArrayList<AndroidDebugHandles.ProcessInstanceIdentity>()
            val seenPids = HashSet<Int>()
            for (rec in records) {
                val matchesPkg = if (rec.packages.isNotEmpty()) {
                    targetPackage in rec.packages
                } else {
                    rec.processName == targetPackage || rec.processName.startsWith("$targetPackage:")
                }
                if (!matchesPkg) continue
                if (targetUserId != null && rec.userId != targetUserId) continue
                if (!seenPids.add(rec.pid)) continue
                result.add(
                    AndroidDebugHandles.ProcessInstanceIdentity(
                        pid = rec.pid,
                        userId = rec.userId,
                        uid = rec.uid,
                        packageName = targetPackage,
                        processName = rec.processName,
                        startSeq = rec.startSeq,
                        amsRecord = rec.amsRecord,
                    )
                )
            }
            return result
        }

        private fun combinedOutput(output: ShellCommandOutput): String? {
            val combined = listOf(output.stdout.trim(), output.stderr.trim())
                .filter { it.isNotEmpty() }
                .joinToString("\n")
            return combined.ifBlank { null }
        }
    }
}
