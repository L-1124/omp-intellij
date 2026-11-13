package org.jetbrains.android.run

import com.android.adblib.AdbFailResponseException
import com.android.adblib.AdbFeatures
import com.android.adblib.AdbInputChannel
import com.android.adblib.AdbProtocolErrorException
import com.android.adblib.AdbSession
import com.android.adblib.ClosedSessionException
import com.android.adblib.DeviceSelector
import com.android.adblib.TextShellCollector
import com.android.adblib.availableFeatures
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlin.time.Duration.Companion.milliseconds
import java.io.EOFException
import java.io.IOException
import java.net.ConnectException
import java.net.SocketException
import org.jetbrains.annotations.TestOnly
import java.nio.ByteBuffer
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import java.util.concurrent.atomic.AtomicBoolean

class AndroidInstallSession @TestOnly constructor(
    private val session: AdbSession,
    private val device: DeviceSelector,
    private val apiLevel: Int,
    private val userId: Int,
    deviceId: String? = null,
    private val onOutput: ((String) -> Unit)? = null,
    private val abandonTimeoutMs: Long = DEFAULT_ABANDON_TIMEOUT_MS,
    private val testSeam: TestSeam? = null,
) {
    constructor(
        session: AdbSession,
        device: DeviceSelector,
        apiLevel: Int,
        userId: Int,
        deviceId: String? = null,
        onOutput: ((String) -> Unit)? = null,
    ) : this(session, device, apiLevel, userId, deviceId, onOutput, DEFAULT_ABANDON_TIMEOUT_MS, null)

    @Volatile
    var lastSessionId: String? = null
        private set

    @TestOnly
    interface TestSeam {
        suspend fun beforeWrite(sessionId: String, apkIndex: Int, apk: Path) {}
        suspend fun beforeCommit(sessionId: String) {}
    }

    private enum class PmStrategy(val wireName: String) {
        ABB_EXEC("abb_exec"),
        CMD("cmd"),
        PM("pm"),
    }

    private data class PmOutputFailure(
        val detail: String,
        val emptyOutput: Boolean,
    )

    private class ExplicitPmRejectionException(
        val runError: AndroidRunError,
    ) : RuntimeException(runError.formattedWireMessage())

    private class TrackingInputChannel(
        private val delegate: AdbInputChannel,
    ) : AdbInputChannel {
        private val closed = AtomicBoolean(false)

        @Volatile
        var readFailure: Throwable? = null
            private set

        override suspend fun readBuffer(buffer: ByteBuffer, timeout: Long, unit: TimeUnit) {
            try {
                delegate.readBuffer(buffer, timeout, unit)
            } catch (ce: CancellationException) {
                throw ce
            } catch (t: Throwable) {
                if (readFailure == null) {
                    readFailure = t
                }
                throw t
            }
        }

        override suspend fun readExactly(buffer: ByteBuffer, timeout: Long, unit: TimeUnit) {
            try {
                delegate.readExactly(buffer, timeout, unit)
            } catch (ce: CancellationException) {
                throw ce
            } catch (t: Throwable) {
                if (readFailure == null) {
                    readFailure = t
                }
                throw t
            }
        }

        override fun close() {
            if (closed.compareAndSet(false, true)) {
                delegate.close()
            }
        }
    }

    private val effectiveDeviceId: String =
        deviceId?.takeIf { it.isNotBlank() } ?: device.toString().removePrefix("serial-")

    suspend fun install(apks: List<Path>) {
        if (apiLevel < MIN_STREAMING_API_LEVEL) {
            throw AndroidRunError(
                code = AndroidRunErrorCode.PREREQUISITE_MISSING,
                stage = AndroidRunStage.INSTALLING,
                detail = "Android streaming install requires API 21+ (device API $apiLevel)",
                device = effectiveDeviceId,
            ).toException()
        }
        if (userId < 0) {
            throw AndroidRunError(
                code = AndroidRunErrorCode.INVALID_PARAMS,
                stage = AndroidRunStage.INSTALLING,
                detail = "userId must be >= 0 (got $userId)",
                device = effectiveDeviceId,
            ).toException()
        }
        if (apks.isEmpty()) {
            throw AndroidRunError(
                code = AndroidRunErrorCode.INVALID_PARAMS,
                stage = AndroidRunStage.INSTALLING,
                detail = "At least one APK path is required for installation",
                device = effectiveDeviceId,
            ).toException()
        }

        val apkSizes = withContext(session.blockingIoDispatcher) {
            apks.map { apk ->
                if (!Files.exists(apk) || Files.isDirectory(apk) || !Files.isRegularFile(apk)) {
                    throw AndroidRunError(
                        code = AndroidRunErrorCode.ARTIFACT_INVALID,
                        stage = AndroidRunStage.INSTALLING,
                        detail = "Cannot install '$apk': file does not exist or is not a regular file",
                        device = effectiveDeviceId,
                    ).toException()
                }
                try {
                    Files.size(apk)
                } catch (e: IOException) {
                    throw AndroidRunError(
                        code = AndroidRunErrorCode.ARTIFACT_INVALID,
                        stage = AndroidRunStage.INSTALLING,
                        detail = "Cannot read size of '$apk': ${errorMessageOf(e)}",
                        device = effectiveDeviceId,
                    ).toException(e)
                }
            }
        }
        val totalSize = apkSizes.sum()

        val features = try {
            session.hostServices.availableFeatures(device)
        } catch (ce: CancellationException) {
            throw AndroidRunError(
                code = AndroidRunErrorCode.CANCELLED,
                stage = AndroidRunStage.INSTALLING,
                detail = "Installation cancelled while querying ADB device features",
                device = effectiveDeviceId,
            ).toException(ce)
        } catch (t: Throwable) {
            throw mapFailureToRunError(
                failure = t,
                defaultDetail = "Failed to query ADB device features",
                outcomeUnknown = false,
            ).toException(t)
        }

        val strategy = selectStrategy(features)
        var sessionId: String? = null
        var activeChannel: TrackingInputChannel? = null
        var activeApk: Path? = null
        var commitSent = false
        var commitConfirmed = false
        var primaryRunError: AndroidRunError? = null
        var primaryCause: Throwable? = null
        val cleanupErrors = mutableListOf<String>()
        val cleanupThrowables = mutableListOf<Throwable>()

        try {
            emitOutput("Creating install session for user $userId via ${strategy.wireName} (total $totalSize bytes)")
            val createOut = runPmCommand(
                strategy,
                listOf("install-create", "-r", "-t", "--user", userId.toString(), "-S", totalSize.toString()),
            )
            if (createOut.isNotBlank()) {
                emitOutput("install-create: $createOut")
            }

            val createdId = parseSessionId(createOut)
                ?: throw AndroidRunError(
                    code = AndroidRunErrorCode.INSTALL_FAILED,
                    stage = AndroidRunStage.INSTALLING,
                    detail = parsePmFailureOrNull("install-create", createOut)?.detail
                        ?: "PM install-create failed: ${createOut.trim()}",
                    device = effectiveDeviceId,
                    outputTail = createOut.takeIf { it.isNotBlank() },
                ).toException()

            sessionId = createdId
            lastSessionId = createdId

            val usedNames = HashSet<String>(apks.size)
            for ((index, apk) in apks.withIndex()) {
                currentCoroutineContext().ensureActive()
                testSeam?.beforeWrite(createdId, index, apk)
                val size = apkSizes[index]
                val entryName = resolveEntryName(strategy, apk, index, usedNames)

                val rawChannel = try {
                    session.channelFactory.openFile(apk)
                } catch (ce: CancellationException) {
                    throw ce
                } catch (t: Throwable) {
                    throw AndroidRunError(
                        code = AndroidRunErrorCode.INSTALL_FAILED,
                        stage = AndroidRunStage.INSTALLING,
                        detail = "Failed to open APK '$apk' for streaming: ${errorMessageOf(t)}",
                        device = effectiveDeviceId,
                    ).toException(t)
                }

                val trackingChannel = TrackingInputChannel(rawChannel)
                activeChannel = trackingChannel
                activeApk = apk

                var writeThrown: Throwable? = null
                try {
                    emitOutput("Streaming '${apk.fileName}' ($size bytes) to session $createdId")
                    val writeOut = runPmWrite(strategy, createdId, entryName, size, trackingChannel)
                    if (writeOut.isNotBlank()) {
                        emitOutput("install-write: $writeOut")
                    }
                    val writeFailure = parsePmFailureOrNull("install-write", writeOut)
                    if (writeFailure != null) {
                        throw AndroidRunError(
                            code = AndroidRunErrorCode.INSTALL_FAILED,
                            stage = AndroidRunStage.INSTALLING,
                            detail = writeFailure.detail,
                            device = effectiveDeviceId,
                            outputTail = writeOut.takeIf { it.isNotBlank() },
                        ).toException()
                    }
                } catch (ce: CancellationException) {
                    writeThrown = ce
                    throw ce
                } catch (t: Throwable) {
                    val sourceReadErr = trackingChannel.readFailure
                    val mapped = if (sourceReadErr != null && t !is AndroidRunException) {
                        AndroidRunError(
                            code = AndroidRunErrorCode.INSTALL_FAILED,
                            stage = AndroidRunStage.INSTALLING,
                            detail = "Failed to read APK '$apk' during install-write: ${errorMessageOf(sourceReadErr)}",
                            device = effectiveDeviceId,
                        ).toException(sourceReadErr)
                    } else {
                        t
                    }
                    writeThrown = mapped
                    throw mapped
                } finally {
                    activeChannel = null
                    activeApk = null
                    withContext(NonCancellable) {
                        try {
                            trackingChannel.close()
                        } catch (closeErr: Throwable) {
                            if (writeThrown != null) {
                                cleanupThrowables += closeErr
                                cleanupErrors += "Failed to close APK stream '$apk': ${errorMessageOf(closeErr)}"
                            } else {
                                throw AndroidRunError(
                                    code = AndroidRunErrorCode.INSTALL_FAILED,
                                    stage = AndroidRunStage.INSTALLING,
                                    detail = "Failed to close APK stream '$apk': ${errorMessageOf(closeErr)}",
                                    device = effectiveDeviceId,
                                ).toException(closeErr)
                            }
                        }
                    }
                }
            }

            testSeam?.beforeCommit(createdId)
            currentCoroutineContext().ensureActive()

            emitOutput("Committing install session $createdId")
            commitSent = true
            val commitOut = runPmCommand(strategy, listOf("install-commit", createdId))
            if (commitOut.isNotBlank()) {
                emitOutput("install-commit: $commitOut")
            }

            val commitFailure = parsePmFailureOrNull("install-commit", commitOut)
            if (commitFailure != null) {
                if (commitFailure.emptyOutput) {
                    throw AndroidRunError(
                        code = AndroidRunErrorCode.INSTALL_FAILED,
                        stage = AndroidRunStage.INSTALLING,
                        detail = "Install commit for session $createdId returned empty output; outcome unknown",
                        device = effectiveDeviceId,
                        outcomeUnknown = true,
                    ).toException()
                }
                throw ExplicitPmRejectionException(
                    AndroidRunError(
                        code = AndroidRunErrorCode.INSTALL_FAILED,
                        stage = AndroidRunStage.INSTALLING,
                        detail = commitFailure.detail,
                        device = effectiveDeviceId,
                        outputTail = commitOut.takeIf { it.isNotBlank() },
                        outcomeUnknown = false,
                    ),
                )
            }
            commitConfirmed = true
        } catch (ce: CancellationException) {
            val unknown = commitSent
            val sidLabel = sessionId?.let { " (session $it)" } ?: ""
            primaryCause = ce
            primaryRunError = AndroidRunError(
                code = AndroidRunErrorCode.CANCELLED,
                stage = AndroidRunStage.INSTALLING,
                detail = if (unknown) {
                    "Installation cancelled after commit was sent$sidLabel; outcome unknown"
                } else {
                    "Installation cancelled$sidLabel"
                },
                device = effectiveDeviceId,
                outcomeUnknown = unknown,
            )
        } catch (rejected: ExplicitPmRejectionException) {
            primaryCause = rejected
            primaryRunError = rejected.runError
        } catch (t: Throwable) {
            val unknown = commitSent
            val sidLabel = sessionId?.let { " (session $it)" } ?: ""
            primaryCause = t
            val baseError = mapFailureToRunError(
                failure = t,
                defaultDetail = if (unknown) {
                    "Install commit sent without acknowledgment$sidLabel; outcome unknown"
                } else {
                    "Package installation failed$sidLabel"
                },
                outcomeUnknown = unknown,
            )
            primaryRunError = if (unknown && !baseError.outcomeUnknown) {
                baseError.copy(outcomeUnknown = true)
            } else {
                baseError
            }
        } finally {
            val sid = sessionId
            if (sid != null && !commitConfirmed) {
                withContext(NonCancellable) {
                    activeChannel?.let { ch ->
                        val apkLabel = activeApk?.toString() ?: "apk"
                        try {
                            ch.close()
                        } catch (closeErr: Throwable) {
                            cleanupThrowables += closeErr
                            cleanupErrors += "Failed to close APK stream '$apkLabel': ${errorMessageOf(closeErr)}"
                        }
                        activeChannel = null
                        activeApk = null
                    }
                    try {
                        val abandonOut = withTimeout(abandonTimeoutMs.milliseconds) {
                            runPmCommand(strategy, listOf("install-abandon", sid))
                        }
                        if (abandonOut.isNotBlank()) {
                            emitOutput("install-abandon: $abandonOut")
                        }
                        if (!isAbandonCleanResult(abandonOut)) {
                            val detail = if (abandonOut.isBlank()) {
                                "PM install-abandon for session $sid returned empty output"
                            } else {
                                "PM install-abandon for session $sid failed: $abandonOut"
                            }
                            cleanupErrors += detail
                        }
                    } catch (abandonErr: Throwable) {
                        cleanupThrowables += abandonErr
                        cleanupErrors += formatAbandonFailure(sid, abandonErr)
                    }
                }
            }
        }

        val initialError = primaryRunError
        if (initialError != null) {
            var finalError: AndroidRunError = initialError
            for (cleanupMsg in cleanupErrors) {
                finalError = finalError.withCleanupError(cleanupMsg)
            }
            val exception = finalError.toException(primaryCause)
            for (suppressed in cleanupThrowables) {
                if (suppressed !== primaryCause) {
                    exception.addSuppressed(suppressed)
                }
            }
            throw exception
        }
    }

    private fun selectStrategy(features: Set<String>): PmStrategy = when {
        AdbFeatures.ABB_EXEC in features -> PmStrategy.ABB_EXEC
        CMD_FEATURE in features -> PmStrategy.CMD
        else -> PmStrategy.PM
    }

    private suspend fun runPmCommand(strategy: PmStrategy, parts: List<String>): String {
        val flow: Flow<String> = when (strategy) {
            PmStrategy.ABB_EXEC -> session.deviceServices.abb_exec(
                device = device,
                args = listOf("package") + parts,
                shellCollector = TextShellCollector(),
                stdinChannel = null,
                shutdownOutput = true,
            )

            PmStrategy.CMD -> session.deviceServices.shell(
                device = device,
                command = (listOf("cmd", "package") + parts).joinToString(" "),
                shellCollector = TextShellCollector(),
            )

            PmStrategy.PM -> session.deviceServices.shell(
                device = device,
                command = (listOf("pm") + parts).joinToString(" "),
                shellCollector = TextShellCollector(),
            )
        }
        return collectFlowOutput(flow)
    }

    private suspend fun runPmWrite(
        strategy: PmStrategy,
        sessionId: String,
        entryName: String,
        size: Long,
        channel: AdbInputChannel,
    ): String {
        val parts = listOf("install-write", "-S", size.toString(), sessionId, entryName, "-")
        val flow: Flow<String> = when (strategy) {
            PmStrategy.ABB_EXEC -> session.deviceServices.abb_exec(
                device = device,
                args = listOf("package") + parts,
                shellCollector = TextShellCollector(),
                stdinChannel = channel,
                shutdownOutput = false,
            )

            PmStrategy.CMD -> session.deviceServices.exec(
                device = device,
                command = (listOf("cmd", "package") + parts).joinToString(" "),
                shellCollector = TextShellCollector(),
                stdinChannel = channel,
                shutdownOutput = false,
            )

            PmStrategy.PM -> session.deviceServices.exec(
                device = device,
                command = (listOf("pm") + parts).joinToString(" "),
                shellCollector = TextShellCollector(),
                stdinChannel = channel,
                shutdownOutput = false,
            )
        }
        return collectFlowOutput(flow)
    }

    private suspend fun collectFlowOutput(flow: Flow<String>): String {
        val builder = StringBuilder()
        flow.collect { chunk ->
            builder.append(chunk)
        }
        return builder.toString().trim()
    }

    private fun resolveEntryName(
        strategy: PmStrategy,
        apk: Path,
        index: Int,
        usedNames: MutableSet<String>,
    ): String {
        val raw = apk.fileName?.toString()?.takeIf { it.isNotBlank() } ?: "apk_$index.apk"
        val base = when (strategy) {
            PmStrategy.ABB_EXEC -> if (raw.startsWith("-")) "apk_$raw" else raw
            PmStrategy.CMD, PmStrategy.PM -> {
                val sanitized = sanitizeApkName(raw)
                if (sanitized.isEmpty() || sanitized.startsWith("-")) "apk_$sanitized" else sanitized
            }
        }
        var candidate = base
        var suffix = 1
        while (!usedNames.add(candidate)) {
            candidate = "${index}_${suffix++}_$base"
        }
        return candidate
    }

    private fun mapFailureToRunError(
        failure: Throwable,
        defaultDetail: String,
        outcomeUnknown: Boolean,
    ): AndroidRunError {
        if (failure is AndroidRunException) {
            return if (outcomeUnknown && !failure.error.outcomeUnknown) {
                failure.error.copy(outcomeUnknown = true)
            } else {
                failure.error
            }
        }
        if (isDeviceOfflineFailure(failure)) {
            val detail = if (outcomeUnknown) {
                "$defaultDetail (${errorMessageOf(failure)})"
            } else {
                "Device '$effectiveDeviceId' went offline during installation: ${errorMessageOf(failure)}"
            }
            return AndroidRunError(
                code = AndroidRunErrorCode.DEVICE_OFFLINE,
                stage = AndroidRunStage.INSTALLING,
                detail = detail,
                device = effectiveDeviceId,
                outcomeUnknown = outcomeUnknown,
            )
        }
        return AndroidRunError(
            code = AndroidRunErrorCode.INSTALL_FAILED,
            stage = AndroidRunStage.INSTALLING,
            detail = "$defaultDetail: ${errorMessageOf(failure)}",
            device = effectiveDeviceId,
            outcomeUnknown = outcomeUnknown,
        )
    }

    private fun formatAbandonFailure(sessionId: String, failure: Throwable): String {
        return when {
            failure is TimeoutCancellationException ->
                "Incomplete device cleanup: install-abandon for session $sessionId timed out after ${abandonTimeoutMs}ms"

            isDeviceOfflineFailure(failure) ->
                "Incomplete device cleanup: device offline while abandoning session $sessionId (${errorMessageOf(failure)})"

            else ->
                "Failed to abandon install session $sessionId: ${errorMessageOf(failure)}"
        }
    }

    private fun emitOutput(line: String) {
        val callback = onOutput ?: return
        runCatching { callback(line) }
    }

    companion object {
        const val MIN_STREAMING_API_LEVEL: Int = 21
        const val DEFAULT_ABANDON_TIMEOUT_MS: Long = 5_000L
        private const val CMD_FEATURE: String = "cmd"
        private const val SUCCESS_PREFIX: String = "Success"

        private val CREATE_SESSION_PATTERN = Regex("""Success:\s*.*\[(\d+)\]""")
        private val FAILURE_PATTERN = Regex("""Failure\s+\[(([^:\]]*)(:.*)?)\]""")
        private val FILE_NAME_CLEANER = Regex("""[^A-Za-z0-9._-]""")
        private val EXPLICIT_SESSION_NOT_FOUND_REGEX = Regex(
            """(?i)\b(unknown\s+session(?:\s+id)?|session(?:\s+\d+)?\s+not\s+found|session(?:\s+\d+)?\s+does\s+not\s+exist|no\s+(?:such|active)\s+session|invalid\s+session(?:\s+id)?)\b"""
        )

        internal fun sanitizeApkName(filename: String): String = FILE_NAME_CLEANER.replace(filename, "_")

        internal fun parseSessionId(output: String): String? {
            val trimmed = output.trim()
            if (trimmed.isEmpty()) return null
            return CREATE_SESSION_PATTERN.find(trimmed)?.groupValues?.get(1)
        }

        internal fun isAbandonCleanResult(output: String): Boolean {
            val trimmed = output.trim()
            if (trimmed.isEmpty()) return false
            val firstNonBlank = trimmed.lineSequence().firstOrNull { it.isNotBlank() }?.trim() ?: return false
            if (firstNonBlank.startsWith(SUCCESS_PREFIX)) return true
            return EXPLICIT_SESSION_NOT_FOUND_REGEX.containsMatchIn(trimmed)
        }

        private fun parsePmFailureOrNull(command: String, output: String): PmOutputFailure? {
            val trimmed = output.trim()
            if (trimmed.isEmpty()) {
                return PmOutputFailure("PM $command returned empty output", emptyOutput = true)
            }
            var success = false
            var failureMessage = ""
            for (rawLine in trimmed.lineSequence()) {
                val line = rawLine.trim()
                if (line.isEmpty()) continue
                if (line.startsWith(SUCCESS_PREFIX)) {
                    success = true
                    failureMessage = ""
                    continue
                }
                success = false
                val match = FAILURE_PATTERN.matchEntire(line)
                if (match != null) {
                    failureMessage = match.groupValues[1]
                } else if (failureMessage.isEmpty()) {
                    failureMessage = line
                } else {
                    failureMessage += "; $line"
                }
            }
            if (success) return null
            return PmOutputFailure("PM $command failed: $failureMessage", emptyOutput = false)
        }


        private fun isDeviceOfflineFailure(failure: Throwable): Boolean {
            for (cause in generateSequence(failure) { it.cause }) {
                when (cause) {
                    is ClosedSessionException -> return true
                    is EOFException, is ConnectException, is SocketException -> return true
                    is AdbFailResponseException -> {
                        if (containsOfflineToken(cause.failMessage)) return true
                    }

                    is AdbProtocolErrorException, is IOException -> {
                        val msg = cause.message.orEmpty()
                        if (containsOfflineToken(msg)) return true
                    }

                    is TimeoutException -> {
                        val msg = cause.message.orEmpty()
                        if (containsOfflineToken(msg)) return true
                    }
                }
            }
            return false
        }

        private fun containsOfflineToken(message: String): Boolean {
            val lower = message.lowercase()
            return lower.contains("offline") ||
                    lower.contains("not found") ||
                    lower.contains("unauthorized") ||
                    lower.contains("disconnected") ||
                    lower.contains("closed") ||
                    lower.contains("broken pipe") ||
                    lower.contains("connection reset") ||
                    lower.contains("no such device")
        }

        private fun errorMessageOf(t: Throwable): String =
            t.message?.takeIf { it.isNotBlank() } ?: t::class.java.simpleName
    }
}
