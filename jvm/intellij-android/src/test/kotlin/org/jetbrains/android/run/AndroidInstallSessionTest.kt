package org.jetbrains.android.run

import com.android.adblib.AdbChannelFactory
import com.android.adblib.AdbDeviceFailResponseException
import com.android.adblib.AdbDeviceServices
import com.android.adblib.AdbFeatures
import com.android.adblib.AdbHostServices
import com.android.adblib.AdbInputChannel
import com.android.adblib.AdbSession
import com.android.adblib.AdbSessionHost
import com.android.adblib.DeviceList
import com.android.adblib.DeviceSelector
import com.android.adblib.ShellCollector
import com.android.adblib.ShellOptions
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.FlowCollector
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.ByteArrayOutputStream
import java.io.EOFException
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.time.Duration
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlin.time.Duration.Companion.seconds

class AndroidInstallSessionTest {
    @Rule
    @JvmField
    val tempFolder = TemporaryFolder()

    private lateinit var sessionHost: AdbSessionHost
    private lateinit var baseSession: AdbSession

    @Before
    fun setUp() {
        sessionHost = AdbSessionHost()
        baseSession = AdbSession.create(sessionHost)
    }

    @After
    fun tearDown() {
        baseSession.close()
        sessionHost.close()
    }

    @Test
    fun `api level below 21 fails immediately with prerequisite_missing and zero adb calls`() = runBlocking {
        val apk = writeApk("app-debug.apk", "apk-bytes")
        val adb = RecordingAdbSession(baseSession)
        val device = DeviceSelector.fromSerialNumber("emulator-5580")
        val install = AndroidInstallSession(adb, device, apiLevel = 19, userId = 0, deviceId = "emulator-5580")

        val ex = expectInstallFailure {
            install.install(listOf(apk))
        }

        assertEquals(AndroidRunErrorCode.PREREQUISITE_MISSING, ex.error.code)
        assertEquals(AndroidRunStage.INSTALLING, ex.error.stage)
        assertTrue(ex.error.detail.contains("API 21+"))
        assertFalse(ex.error.outcomeUnknown)
        assertNull(ex.error.cleanupError)
        assertEquals(0, adb.featureCalls.get())
        assertTrue(adb.commands.isEmpty())
        assertTrue(adb.openedFiles.isEmpty())
    }

    @Test
    fun `empty or invalid apk paths fail before creating session`() = runBlocking {
        val adb = RecordingAdbSession(baseSession)
        val device = DeviceSelector.fromSerialNumber("emulator-5580")
        val install = AndroidInstallSession(adb, device, apiLevel = 35, userId = 0)

        val emptyEx = expectInstallFailure { install.install(emptyList()) }
        assertEquals(AndroidRunErrorCode.INVALID_PARAMS, emptyEx.error.code)

        val missing = tempFolder.root.toPath().resolve("missing.apk")
        val missingEx = expectInstallFailure { install.install(listOf(missing)) }
        assertEquals(AndroidRunErrorCode.ARTIFACT_INVALID, missingEx.error.code)

        val dir = tempFolder.newFolder("apk-dir").toPath()
        val dirEx = expectInstallFailure { install.install(listOf(dir)) }
        assertEquals(AndroidRunErrorCode.ARTIFACT_INVALID, dirEx.error.code)

        assertTrue(adb.commands.isEmpty())
    }

    @Test
    fun `abb_exec streams multi-apk with -r -t --user shutdownOutput=false and closes channels`() = runBlocking {
        val baseBytes = "base-apk-payload-0123456789".toByteArray(StandardCharsets.UTF_8)
        val splitBytes = "split-arm64-payload".toByteArray(StandardCharsets.UTF_8)
        val baseApk = writeApk("base.apk", baseBytes)
        val splitApk = writeApk("split_config.arm64_v8a.apk", splitBytes)

        val adb = RecordingAdbSession(baseSession).apply {
            hostFeatures = listOf(AdbFeatures.ABB_EXEC, "cmd", AdbFeatures.SHELL_V2)
            deviceFeatures = listOf(AdbFeatures.ABB_EXEC, "cmd", AdbFeatures.SHELL_V2)
        }
        val device = DeviceSelector.fromSerialNumber("emulator-5580")
        val outputs = CopyOnWriteArrayList<String>()
        val install = AndroidInstallSession(adb, device, apiLevel = 35, userId = 10, onOutput = { outputs.add(it) })

        install.install(listOf(baseApk, splitApk))

        assertEquals("1001", install.lastSessionId)
        assertEquals(4, adb.commands.size)

        val totalSize = (baseBytes.size + splitBytes.size).toLong()
        val create = adb.commands[0]
        assertEquals("abb_exec", create.transport)
        assertEquals(
            listOf("package", "install-create", "-r", "-t", "--user", "10", "-S", totalSize.toString()),
            create.args,
        )
        assertFalse(create.hasStdin)
        assertTrue(create.shutdownOutput)

        val write1 = adb.commands[1]
        assertEquals("abb_exec", write1.transport)
        assertEquals(
            listOf("package", "install-write", "-S", baseBytes.size.toString(), "1001", "base.apk", "-"),
            write1.args,
        )
        assertTrue(write1.hasStdin)
        assertFalse(write1.shutdownOutput)
        assertArrayEquals(baseBytes, write1.writtenBytes)

        val write2 = adb.commands[2]
        assertEquals("abb_exec", write2.transport)
        assertEquals(
            listOf(
                "package",
                "install-write",
                "-S",
                splitBytes.size.toString(),
                "1001",
                "split_config.arm64_v8a.apk",
                "-"
            ),
            write2.args,
        )
        assertTrue(write2.hasStdin)
        assertFalse(write2.shutdownOutput)
        assertArrayEquals(splitBytes, write2.writtenBytes)

        val commit = adb.commands[3]
        assertEquals("abb_exec", commit.transport)
        assertEquals(listOf("package", "install-commit", "1001"), commit.args)
        assertFalse(commit.hasStdin)
        assertTrue(commit.shutdownOutput)

        assertEquals(2, adb.openedFiles.size)
        assertTrue(adb.openedFiles.all { it.closed.get() })
        assertTrue(outputs.isNotEmpty())
    }

    @Test
    fun `falls back to cmd and pm when abb_exec is absent and sanitizes filenames`() = runBlocking {
        val apkBytes = "apk-content".toByteArray(StandardCharsets.UTF_8)
        val apk = writeApk("my app (1).apk", apkBytes)
        val device = DeviceSelector.fromSerialNumber("emulator-5580")

        // cmd fallback
        val cmdAdb = RecordingAdbSession(baseSession).apply {
            hostFeatures = listOf("cmd", AdbFeatures.SHELL_V2)
            deviceFeatures = listOf("cmd", AdbFeatures.SHELL_V2)
        }
        AndroidInstallSession(cmdAdb, device, apiLevel = 26, userId = 0).install(listOf(apk))
        assertEquals(3, cmdAdb.commands.size)
        assertEquals("shell", cmdAdb.commands[0].transport)
        assertEquals("cmd package install-create -r -t --user 0 -S ${apkBytes.size}", cmdAdb.commands[0].command)
        assertEquals("exec", cmdAdb.commands[1].transport)
        assertEquals("cmd package install-write -S ${apkBytes.size} 1001 my_app__1_.apk -", cmdAdb.commands[1].command)
        assertFalse(cmdAdb.commands[1].shutdownOutput)
        assertEquals("shell", cmdAdb.commands[2].transport)
        assertEquals("cmd package install-commit 1001", cmdAdb.commands[2].command)

        // pm fallback (API 21 without cmd or abb_exec)
        val pmAdb = RecordingAdbSession(baseSession).apply {
            hostFeatures = listOf(AdbFeatures.ABB_EXEC, "cmd")
            deviceFeatures = emptyList()
        }
        AndroidInstallSession(pmAdb, device, apiLevel = 21, userId = 0).install(listOf(apk))
        assertEquals(3, pmAdb.commands.size)
        assertEquals("shell", pmAdb.commands[0].transport)
        assertEquals("pm install-create -r -t --user 0 -S ${apkBytes.size}", pmAdb.commands[0].command)
        assertEquals("exec", pmAdb.commands[1].transport)
        assertEquals("pm install-write -S ${apkBytes.size} 1001 my_app__1_.apk -", pmAdb.commands[1].command)
        assertFalse(pmAdb.commands[1].shutdownOutput)
        assertEquals("shell", pmAdb.commands[2].transport)
        assertEquals("pm install-commit 1001", pmAdb.commands[2].command)
    }

    @Test
    fun `write cancellation closes stream runs NonCancellable abandon and skips next stage`() = runBlocking {
        val apk = writeApk("base.apk", "0123456789abcdef")
        val writeSuspended = CompletableDeferred<Unit>()
        val adb = RecordingAdbSession(baseSession).apply {
            openFileWrapper = { _, delegate ->
                var reads = 0
                object : AdbInputChannel by delegate {
                    override suspend fun readBuffer(buffer: ByteBuffer, timeout: Long, unit: TimeUnit) {
                        if (reads++ > 0) {
                            writeSuspended.complete(Unit)
                            awaitCancellation()
                        }
                        delegate.readBuffer(buffer, timeout, unit)
                    }
                }
            }
        }
        val device = DeviceSelector.fromSerialNumber("emulator-5580")
        val install = AndroidInstallSession(adb, device, apiLevel = 35, userId = 0)

        var nextStageRan = false
        var caught: AndroidRunException? = null
        val job = launch {
            try {
                install.install(listOf(apk))
                nextStageRan = true
            } catch (ex: AndroidRunException) {
                caught = ex
            }
        }

        withTimeout(5.seconds) { writeSuspended.await() }
        job.cancelAndJoin()

        assertFalse(nextStageRan)
        val ex = caught ?: error("Expected AndroidRunException")
        assertEquals(AndroidRunErrorCode.CANCELLED, ex.error.code)
        assertEquals(AndroidRunStage.INSTALLING, ex.error.stage)
        assertFalse(ex.error.outcomeUnknown)
        assertNull(ex.error.cleanupError)
        assertEquals("1001", install.lastSessionId)

        assertTrue(adb.openedFiles.single().closed.get())
        assertEquals(listOf("install-create", "install-write", "install-abandon"), adb.commands.map { it.pmSubcommand })
        assertEquals(listOf("package", "install-abandon", "1001"), adb.commands.last().args)
    }

    @Test
    fun `pre-commit cancellation via minimal seam abandons session without sending commit`() = runBlocking {
        val apk = writeApk("base.apk", "payload")
        val adb = RecordingAdbSession(baseSession)
        val device = DeviceSelector.fromSerialNumber("emulator-5580")
        val beforeCommitGate = CompletableDeferred<Unit>()
        val seam = object : AndroidInstallSession.TestSeam {
            override suspend fun beforeCommit(sessionId: String) {
                beforeCommitGate.complete(Unit)
                awaitCancellation()
            }
        }
        val install = AndroidInstallSession(adb, device, apiLevel = 35, userId = 0, testSeam = seam)

        var nextStageRan = false
        var caught: AndroidRunException? = null
        val job = launch {
            try {
                install.install(listOf(apk))
                nextStageRan = true
            } catch (ex: AndroidRunException) {
                caught = ex
            }
        }

        withTimeout(5.seconds) { beforeCommitGate.await() }
        job.cancelAndJoin()

        assertFalse(nextStageRan)
        val ex = caught ?: error("Expected AndroidRunException")
        assertEquals(AndroidRunErrorCode.CANCELLED, ex.error.code)
        assertFalse(ex.error.outcomeUnknown)
        assertNull(ex.error.cleanupError)
        assertEquals(listOf("install-create", "install-write", "install-abandon"), adb.commands.map { it.pmSubcommand })
    }

    @Test
    fun `commit cancellation after device reply emitted but before confirm sets outcomeUnknown=true and skips next stage`() =
        runBlocking {
            val apk = writeApk("base.apk", "payload")
            val commitReplyObserved = CompletableDeferred<Unit>()
            val adb = RecordingAdbSession(baseSession).apply {
                commitBehavior = { _, collector, flowCollector ->
                    // Emit Success chunk as in InstallProbe, then suspend before collection finishes.
                    collector.start(flowCollector)
                    collector.collect(flowCollector, ByteBuffer.wrap("Success\n".toByteArray(StandardCharsets.UTF_8)))
                    collector.end(flowCollector)
                    commitReplyObserved.complete(Unit)
                    awaitCancellation()
                }
            }
            val device = DeviceSelector.fromSerialNumber("emulator-5580")
            val install = AndroidInstallSession(adb, device, apiLevel = 35, userId = 0)

            var nextStageRan = false
            var caught: AndroidRunException? = null
            val job = launch {
                try {
                    install.install(listOf(apk))
                    nextStageRan = true
                } catch (ex: AndroidRunException) {
                    caught = ex
                }
            }

            withTimeout(5.seconds) { commitReplyObserved.await() }
            job.cancelAndJoin()

            assertFalse(nextStageRan)
            val ex = caught ?: error("Expected AndroidRunException")
            assertEquals(AndroidRunErrorCode.CANCELLED, ex.error.code)
            assertEquals(AndroidRunStage.INSTALLING, ex.error.stage)
            assertTrue(ex.error.outcomeUnknown)
            assertEquals("true", ex.error.toVariables()["outcomeUnknown"])
            assertNull(ex.error.cleanupError)
            // Must abandon, never retry commit, never uninstall, never launch next stage.
            assertEquals(
                listOf("install-create", "install-write", "install-commit", "install-abandon"),
                adb.commands.map { it.pmSubcommand },
            )
        }

    @Test
    fun `commit transport failure and empty output set outcomeUnknown=true while explicit PM failure sets outcomeUnknown=false`() =
        runBlocking {
            val apk = writeApk("base.apk", "payload")
            val device = DeviceSelector.fromSerialNumber("emulator-5580")

            // Transport EOF after commit sent -> outcomeUnknown=true, DEVICE_OFFLINE
            val eofAdb = RecordingAdbSession(baseSession).apply {
                commitBehavior = { _, _, _ -> throw EOFException("ADB socket EOF during commit") }
            }
            val eofEx = expectInstallFailure {
                AndroidInstallSession(eofAdb, device, apiLevel = 35, userId = 0).install(listOf(apk))
            }
            assertEquals(AndroidRunErrorCode.DEVICE_OFFLINE, eofEx.error.code)
            assertTrue(eofEx.error.outcomeUnknown)

            // Empty commit response -> outcomeUnknown=true, INSTALL_FAILED
            val emptyAdb = RecordingAdbSession(baseSession).apply {
                commitOutput = ""
            }
            val emptyEx = expectInstallFailure {
                AndroidInstallSession(emptyAdb, device, apiLevel = 35, userId = 0).install(listOf(apk))
            }
            assertEquals(AndroidRunErrorCode.INSTALL_FAILED, emptyEx.error.code)
            assertTrue(emptyEx.error.outcomeUnknown)

            // Explicit PM Failure [...] -> outcomeUnknown=false, INSTALL_FAILED
            val rejectAdb = RecordingAdbSession(baseSession).apply {
                commitOutput = "Failure [INSTALL_FAILED_TEST_ONLY: installPackageLI]"
            }
            val rejectEx = expectInstallFailure {
                AndroidInstallSession(rejectAdb, device, apiLevel = 35, userId = 0).install(listOf(apk))
            }
            assertEquals(AndroidRunErrorCode.INSTALL_FAILED, rejectEx.error.code)
            assertFalse(rejectEx.error.outcomeUnknown)
            assertTrue(rejectEx.error.detail.contains("INSTALL_FAILED_TEST_ONLY"))
        }

    @Test
    fun `source read failure closes stream abandons session and skips commit`() = runBlocking {
        val apk = writeApk("base.apk", "payload")
        val adb = RecordingAdbSession(baseSession).apply {
            openFileWrapper = { _, delegate ->
                object : AdbInputChannel by delegate {
                    override suspend fun readBuffer(buffer: ByteBuffer, timeout: Long, unit: TimeUnit) {
                        throw IOException("Simulated source APK read failure")
                    }
                }
            }
        }
        val device = DeviceSelector.fromSerialNumber("emulator-5580")

        var nextStageRan = false
        val ex = expectInstallFailure {
            AndroidInstallSession(adb, device, apiLevel = 35, userId = 0).install(listOf(apk))
            nextStageRan = true
        }

        assertFalse(nextStageRan)
        assertEquals(AndroidRunErrorCode.INSTALL_FAILED, ex.error.code)
        assertFalse(ex.error.outcomeUnknown)
        assertNull(ex.error.cleanupError)
        assertTrue(ex.error.detail.contains("Failed to read APK"))
        assertTrue(ex.error.detail.contains("Simulated source APK read failure"))
        assertTrue(adb.openedFiles.single().closed.get())
        assertEquals(listOf("install-create", "install-write", "install-abandon"), adb.commands.map { it.pmSubcommand })
    }

    @Test
    fun `cleanup failure aggregation preserves primary error stream close failure and abandon failure`() = runBlocking {
        val apk = writeApk("base.apk", "payload")
        val adb = RecordingAdbSession(baseSession).apply {
            openFileWrapper = { _, delegate ->
                object : AdbInputChannel by delegate {
                    override suspend fun readBuffer(buffer: ByteBuffer, timeout: Long, unit: TimeUnit) {
                        throw IOException("Primary read failure")
                    }

                    override fun close() {
                        delegate.close()
                        throw IOException("Stream close failure")
                    }
                }
            }
            abandonBehavior = { "Failure [INSTALL_FAILED_INTERNAL_ERROR]" }
        }
        val device = DeviceSelector.fromSerialNumber("emulator-5580")

        val ex = expectInstallFailure {
            AndroidInstallSession(adb, device, apiLevel = 35, userId = 0).install(listOf(apk))
        }

        // Primary error code and detail must remain intact (not overwritten by cleanup_failed).
        assertEquals(AndroidRunErrorCode.INSTALL_FAILED, ex.error.code)
        assertEquals(AndroidRunStage.INSTALLING, ex.error.stage)
        assertTrue(ex.error.detail.contains("Primary read failure"))
        val cleanup = ex.error.cleanupError ?: error("Expected cleanupError")
        assertTrue(cleanup.contains("Stream close failure"))
        assertTrue(cleanup.contains("INSTALL_FAILED_INTERNAL_ERROR"))
        assertTrue(ex.error.formattedWireMessage().contains("(cleanup_failed:"))
        assertTrue(ex.suppressed.any { it.message?.contains("Stream close failure") == true })
    }

    @Test
    fun `abandon timeout inside NonCancellable aggregates cleanup failure onto cancellation`() = runBlocking {
        val apk = writeApk("base.apk", "payload")
        val writeSuspended = CompletableDeferred<Unit>()
        val adb = RecordingAdbSession(baseSession).apply {
            openFileWrapper = { _, delegate ->
                var reads = 0
                object : AdbInputChannel by delegate {
                    override suspend fun readBuffer(buffer: ByteBuffer, timeout: Long, unit: TimeUnit) {
                        if (reads++ > 0) {
                            writeSuspended.complete(Unit)
                            awaitCancellation()
                        }
                        delegate.readBuffer(buffer, timeout, unit)
                    }
                }
            }
            abandonBehavior = {
                awaitCancellation()
            }
        }
        val device = DeviceSelector.fromSerialNumber("emulator-5580")
        val install = AndroidInstallSession(
            adb,
            device,
            apiLevel = 35,
            userId = 0,
            abandonTimeoutMs = 50L,
        )

        var caught: AndroidRunException? = null
        val job = launch {
            try {
                install.install(listOf(apk))
            } catch (ex: AndroidRunException) {
                caught = ex
            }
        }
        withTimeout(5.seconds) { writeSuspended.await() }
        job.cancelAndJoin()

        val ex = caught ?: error("Expected AndroidRunException")
        assertEquals(AndroidRunErrorCode.CANCELLED, ex.error.code)
        assertFalse(ex.error.outcomeUnknown)
        val cleanup = ex.error.cleanupError ?: error("Expected abandon timeout cleanupError")
        assertTrue(cleanup.contains("timed out"))
    }

    @Test
    fun `only explicit PM session-not-found counts as clean abandon state`() = runBlocking {
        val apk = writeApk("base.apk", "payload")
        val device = DeviceSelector.fromSerialNumber("emulator-5580")

        val cleanOutputs = listOf(
            "Success",
            "Unknown session 1001",
            "Error: unknown session id 1001",
            "Session 1001 not found",
            "Failure [INSTALL_FAILED_ABORTED: Unknown session 1001]",
        )
        for (reply in cleanOutputs) {
            val adb = failingWriteSession(reply)
            val ex = expectInstallFailure {
                AndroidInstallSession(adb, device, apiLevel = 35, userId = 0).install(listOf(apk))
            }
            assertEquals(AndroidRunErrorCode.INSTALL_FAILED, ex.error.code)
            assertNull("Expected clean abandon for '$reply', got ${ex.error.cleanupError}", ex.error.cleanupError)
        }

        val nonCleanOutputs = listOf(
            "",
            "Failure [INSTALL_FAILED_INTERNAL_ERROR]",
            "SecurityException: Caller has no access to session 1001",
            "Error: failed to abandon session",
        )
        for (reply in nonCleanOutputs) {
            val adb = failingWriteSession(reply)
            val ex = expectInstallFailure {
                AndroidInstallSession(adb, device, apiLevel = 35, userId = 0).install(listOf(apk))
            }
            assertEquals(AndroidRunErrorCode.INSTALL_FAILED, ex.error.code)
            assertNotNull("Expected cleanupError for '$reply'", ex.error.cleanupError)
        }
    }

    @Test
    fun `device offline reports device_offline and incomplete device cleanup`() = runBlocking {
        val apk = writeApk("base.apk", "payload")
        val device = DeviceSelector.fromSerialNumber("emulator-5580")

        // Offline during write + offline during abandon
        val writeOfflineAdb = RecordingAdbSession(baseSession).apply {
            writeBehavior = { throw AdbDeviceFailResponseException(device, "abb_exec", "device offline") }
            abandonBehavior = {
                throw AdbDeviceFailResponseException(device, "abb_exec", "device 'emulator-5580' not found")
            }
        }
        val writeEx = expectInstallFailure {
            AndroidInstallSession(writeOfflineAdb, device, apiLevel = 35, userId = 0).install(listOf(apk))
        }
        assertEquals(AndroidRunErrorCode.DEVICE_OFFLINE, writeEx.error.code)
        assertFalse(writeEx.error.outcomeUnknown)
        val writeCleanup = writeEx.error.cleanupError ?: error("Expected incomplete cleanup")
        assertTrue(writeCleanup.contains("Incomplete device cleanup"))
        assertTrue(writeCleanup.contains("device offline"))

        // Offline after commit sent + offline during abandon -> outcomeUnknown=true + incomplete cleanup
        val commitOfflineAdb = RecordingAdbSession(baseSession).apply {
            commitBehavior = { _, _, _ ->
                throw AdbDeviceFailResponseException(device, "abb_exec", "device offline")
            }
            abandonBehavior = {
                throw AdbDeviceFailResponseException(device, "abb_exec", "device offline")
            }
        }
        val commitEx = expectInstallFailure {
            AndroidInstallSession(commitOfflineAdb, device, apiLevel = 35, userId = 0).install(listOf(apk))
        }
        assertEquals(AndroidRunErrorCode.DEVICE_OFFLINE, commitEx.error.code)
        assertTrue(commitEx.error.outcomeUnknown)
        val commitCleanup = commitEx.error.cleanupError ?: error("Expected incomplete cleanup")
        assertTrue(commitCleanup.contains("Incomplete device cleanup"))
    }

    private fun failingWriteSession(abandonReply: String): RecordingAdbSession =
        RecordingAdbSession(baseSession).apply {
            writeBehavior = { "Failure [INSTALL_FAILED_INSUFFICIENT_STORAGE]" }
            abandonBehavior = { abandonReply }
        }

    private fun writeApk(name: String, content: String): Path =
        writeApk(name, content.toByteArray(StandardCharsets.UTF_8))

    private fun writeApk(name: String, bytes: ByteArray): Path {
        val path = tempFolder.root.toPath().resolve(name)
        Files.write(path, bytes)
        return path
    }

    private suspend fun expectInstallFailure(block: suspend () -> Unit): AndroidRunException {
        try {
            block()
            fail("Expected AndroidRunException")
        } catch (ex: AndroidRunException) {
            return ex
        }
        throw AssertionError("Unreachable")
    }

    private class RecordedCommand(
        val transport: String,
        val args: List<String>,
        val command: String,
        val hasStdin: Boolean,
        val shutdownOutput: Boolean,
        @Volatile var writtenBytes: ByteArray? = null,
    ) {
        val pmSubcommand: String
            get() = when {
                args.size >= 2 && args[0] == "package" -> args[1]
                command.startsWith("cmd package ") -> command.removePrefix("cmd package ").substringBefore(' ')
                command.startsWith("pm ") -> command.removePrefix("pm ").substringBefore(' ')
                else -> command
            }
    }

    private class TrackedFileChannel(
        private val delegate: AdbInputChannel,
    ) : AdbInputChannel {
        val closed = AtomicBoolean(false)

        override suspend fun readBuffer(buffer: ByteBuffer, timeout: Long, unit: TimeUnit) {
            delegate.readBuffer(buffer, timeout, unit)
        }

        override fun close() {
            closed.set(true)
            delegate.close()
        }
    }

    private class RecordingAdbSession(
        private val base: AdbSession,
    ) : AdbSession by base {
        var hostFeatures: List<String> = listOf(AdbFeatures.ABB_EXEC, "cmd", AdbFeatures.SHELL_V2)
        var deviceFeatures: List<String> = listOf(AdbFeatures.ABB_EXEC, "cmd", AdbFeatures.SHELL_V2)
        var nextSessionId: Int = 1001
        var writeBehavior: (suspend () -> String)? = null
        var commitOutput: String = "Success"
        var commitBehavior: (suspend (String, ShellCollector<String>, FlowCollector<String>) -> Unit)? = null
        var abandonBehavior: (suspend () -> String)? = null
        var openFileWrapper: ((Path, AdbInputChannel) -> AdbInputChannel)? = null

        val featureCalls = AtomicInteger(0)
        val commands = CopyOnWriteArrayList<RecordedCommand>()
        val openedFiles = CopyOnWriteArrayList<TrackedFileChannel>()

        override val hostServices: AdbHostServices = object : AdbHostServices by base.hostServices {
            override val session: AdbSession
                get() = this@RecordingAdbSession

            override suspend fun hostFeatures(): List<String> {
                featureCalls.incrementAndGet()
                return hostFeatures
            }

            override suspend fun features(device: DeviceSelector): List<String> = deviceFeatures

            override fun trackDevices(format: AdbHostServices.DeviceInfoFormat): Flow<DeviceList> =
                flowOf(DeviceList(emptyList(), emptyList()))
        }

        override val channelFactory: AdbChannelFactory = object : AdbChannelFactory by base.channelFactory {
            override suspend fun openFile(path: Path): AdbInputChannel {
                val raw = base.channelFactory.openFile(path)
                val wrapped = openFileWrapper?.invoke(path, raw) ?: raw
                val tracked = TrackedFileChannel(wrapped)
                openedFiles.add(tracked)
                return tracked
            }
        }

        override val deviceServices: AdbDeviceServices = object : AdbDeviceServices by base.deviceServices {
            override val session: AdbSession
                get() = this@RecordingAdbSession

            override fun <T> abb_exec(
                device: DeviceSelector,
                args: List<String>,
                shellCollector: ShellCollector<T>,
                stdinChannel: AdbInputChannel?,
                commandTimeout: Duration,
                bufferSize: Int,
                shutdownOutput: Boolean,
            ): Flow<T> = executeFakeCommand(
                transport = "abb_exec",
                args = args,
                command = args.joinToString(" "),
                subcommand = args.getOrElse(1) { "" },
                shellCollector = shellCollector,
                stdinChannel = stdinChannel,
                shutdownOutput = shutdownOutput,
            )

            override fun <T> exec(
                device: DeviceSelector,
                command: String,
                shellCollector: ShellCollector<T>,
                stdinChannel: AdbInputChannel?,
                commandTimeout: Duration,
                bufferSize: Int,
                shutdownOutput: Boolean,
            ): Flow<T> = executeFakeCommand(
                transport = "exec",
                args = emptyList(),
                command = command,
                subcommand = extractShellSubcommand(command),
                shellCollector = shellCollector,
                stdinChannel = stdinChannel,
                shutdownOutput = shutdownOutput,
            )

            override fun <T> shell(
                device: DeviceSelector,
                command: String,
                shellCollector: ShellCollector<T>,
                shellOptions: ShellOptions?,
                stdinChannel: AdbInputChannel?,
                commandTimeout: Duration,
                bufferSize: Int,
                shutdownOutput: Boolean,
                stripCrLf: Boolean,
            ): Flow<T> = executeFakeCommand(
                transport = "shell",
                args = emptyList(),
                command = command,
                subcommand = extractShellSubcommand(command),
                shellCollector = shellCollector,
                stdinChannel = stdinChannel,
                shutdownOutput = shutdownOutput,
            )
        }

        private fun extractShellSubcommand(command: String): String = when {
            command.startsWith("cmd package ") -> command.removePrefix("cmd package ").substringBefore(' ')
            command.startsWith("pm ") -> command.removePrefix("pm ").substringBefore(' ')
            else -> command
        }

        @Suppress("UNCHECKED_CAST")
        private fun <T> executeFakeCommand(
            transport: String,
            args: List<String>,
            command: String,
            subcommand: String,
            shellCollector: ShellCollector<T>,
            stdinChannel: AdbInputChannel?,
            shutdownOutput: Boolean,
        ): Flow<T> = flow {
            val recorded = RecordedCommand(
                transport = transport,
                args = args,
                command = command,
                hasStdin = stdinChannel != null,
                shutdownOutput = shutdownOutput,
            )
            commands.add(recorded)

            val writtenBytes = if (stdinChannel != null) {
                drainChannel(stdinChannel).also { recorded.writtenBytes = it }
            } else {
                null
            }

            if (subcommand == "install-commit" && commitBehavior != null) {
                val stringCollector = shellCollector as ShellCollector<String>
                val stringFlowCollector = this as FlowCollector<String>
                commitBehavior!!.invoke(commitOutput, stringCollector, stringFlowCollector)
                return@flow
            }

            val response = when (subcommand) {
                "install-create" -> "Success: created install session [${nextSessionId++}]"
                "install-write" -> writeBehavior?.invoke() ?: "Success: streamed ${writtenBytes?.size ?: 0} bytes"
                "install-commit" -> commitOutput
                "install-abandon" -> abandonBehavior?.invoke() ?: "Success"
                else -> error("Unexpected PM subcommand: $subcommand ($command)")
            }

            shellCollector.start(this)
            if (response.isNotEmpty()) {
                shellCollector.collect(this, ByteBuffer.wrap(response.toByteArray(StandardCharsets.UTF_8)))
            }
            shellCollector.end(this)
        }

        private suspend fun drainChannel(channel: AdbInputChannel): ByteArray {
            val out = ByteArrayOutputStream()
            val buffer = ByteBuffer.allocate(8)
            while (true) {
                buffer.clear()
                channel.readBuffer(buffer)
                buffer.flip()
                if (!buffer.hasRemaining()) {
                    break
                }
                val chunk = ByteArray(buffer.remaining())
                buffer.get(chunk)
                out.write(chunk, 0, chunk.size)
            }
            return out.toByteArray()
        }
    }
}
