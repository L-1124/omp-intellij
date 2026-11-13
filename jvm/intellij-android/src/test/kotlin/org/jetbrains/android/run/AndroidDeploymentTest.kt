package org.jetbrains.android.run

import com.android.adblib.AdbSession
import com.android.adblib.ConnectedDevice
import com.android.adblib.DeviceInfo
import com.android.adblib.DeviceList
import com.android.adblib.DeviceSelector
import com.android.adblib.serialNumber
import com.android.adblib.DeviceState
import com.android.adblib.testing.FakeAdbSession
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.jetbrains.android.debug.AndroidDebugException
import org.jetbrains.android.debug.AndroidDebugHandles
import org.jetbrains.android.debug.AndroidDebugService
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

class AndroidDeploymentTest {
    @get:Rule
    val tempFolder = TemporaryFolder()

    private lateinit var fakeSession: FakeAdbSession
    private lateinit var handles: AndroidDebugHandles
    private lateinit var service: FakeDeploymentDebugService

    @Before
    fun setUp() {
        fakeSession = FakeAdbSession()
        handles = AndroidDebugHandles()
        service = FakeDeploymentDebugService(fakeSession, handles)
    }

    @After
    fun tearDown() {
        service.setParentSessionForTesting(null)
        handles.closeAll()
        fakeSession.close()
        service.dispose()
    }

    private fun registerOnlineDevice(
        deviceId: String = "emulator-5580",
        apiLevel: Int = 35,
        abis: List<String> = listOf("arm64-v8a", "x86_64"),
    ): ConnectedDevice {
        val current = fakeSession.hostServices.devices.filter { it.serialNumber != deviceId }
        fakeSession.hostServices.devices = DeviceList(
            current + DeviceInfo(deviceId, DeviceState.ONLINE),
            emptyList(),
        )
        fakeSession.deviceServices.configureDeviceFeatures(listOf("cmd", "shell_v2"))
        fakeSession.deviceServices.configureDeviceProperties(
            DeviceSelector.fromSerialNumber(deviceId),
            mapOf(
                "ro.build.version.sdk" to apiLevel.toString(),
                "ro.product.cpu.abilist" to abis.joinToString(","),
            ),
        )
        service.apiLevels[deviceId] = apiLevel
        service.abisByDevice[deviceId] = abis
        return runBlocking {
            service.resolveOnlineDevice(deviceId)
        }
    }

    private fun configureFakeInstallCommands(
        deviceId: String,
        apkSize: Long,
        userId: Int,
        apkName: String,
        sessionId: String = "42",
    ) {
        val selector = DeviceSelector.fromSerialNumber(deviceId)
        fakeSession.deviceServices.configureShellCommand(
            selector,
            "cmd package install-create -r -t --user $userId -S $apkSize",
            "Success: created install session [$sessionId]\n",
        )
        fakeSession.deviceServices.configureShellCommand(
            selector,
            "cmd package install-write -S $apkSize $sessionId $apkName -",
            "Success: streamed $apkSize bytes\n",
        )
        fakeSession.deviceServices.configureShellCommand(
            selector,
            "cmd package install-commit $sessionId",
            "Success\n",
        )
        fakeSession.deviceServices.configureShellCommand(
            selector,
            "cmd package install-abandon $sessionId",
            "Success\n",
        )
    }

    private class FakeDeploymentDebugService(
        private val fakeAdb: FakeAdbSession,
        handles: AndroidDebugHandles,
    ) : AndroidDebugService(fakeAdb.host, handles) {
        val apiLevels = LinkedHashMap<String, Int>()
        val abisByDevice = LinkedHashMap<String, List<String>>()
        val preparedPids = CopyOnWriteArrayList<Pair<String, Int>>()
        var nextPort = AtomicInteger(52000)
        var prepareGate: (suspend (String, Int) -> Unit)? = null
        var prepareFailure: Throwable? = null
        var failReleasePort: Int? = null

        override suspend fun acquireAdbSession(adbPath: String?, timeoutMs: Long): AdbSession {
            return fakeAdb
        }

        override suspend fun readDeviceAbis(device: ConnectedDevice): List<String> =
            abisByDevice[device.serialNumber] ?: listOf("arm64-v8a")

        override suspend fun readDeviceApiLevel(device: ConnectedDevice): Int =
            apiLevels[device.serialNumber] ?: 35

        override suspend fun prepareByPid(
            device: ConnectedDevice,
            pid: Int,
            ownerJob: Job?,
            timeoutMs: Long,
        ): AndroidDebugHandles.DebugHandle {
            preparedPids.add(device.serialNumber to pid)
            prepareGate?.invoke(device.serialNumber, pid)
            prepareFailure?.let { throw it }

            if (ownerJob != null && (ownerJob.isCancelled || ownerJob.isCompleted)) {
                throw AndroidDebugException("lease_conflict", "Owner connection scope is already cancelled or closed")
            }
            val targetId = AndroidDebugHandles.TargetId(device.serialNumber, pid)
            if (!handles.tryReserveTarget(targetId)) {
                throw AndroidDebugException("target_busy", "Target $targetId is already prepared or claimed")
            }
            val port = nextPort.getAndIncrement()
            val handle = handles.recordPrepared(
                device.serialNumber,
                pid,
                "proc:$pid",
                "127.0.0.1",
                port,
                null,
                AndroidDebugHandles.DEFAULT_TTL_MS,
            )
            handles.claim("127.0.0.1", port, ownerJob)
            return handle
        }
    }

    private class FakeDeviceOperations : AndroidDeviceOperations {
        var currentUser: Int = 0
        var getCurrentUserCalls = AtomicInteger(0)
        val installedPaths = LinkedHashMap<Pair<Int, String>, List<String>>()
        val pulledTempDirsSeen = CopyOnWriteArrayList<Path>()
        val amsByKey = LinkedHashMap<Pair<Int, String>, MutableList<AndroidDebugHandles.ProcessInstanceIdentity>>()
        val startedCommands = CopyOnWriteArrayList<Triple<Int, String, Boolean>>()
        val forceStopped = CopyOnWriteArrayList<Pair<Int, String>>()
        val startGate = AtomicBoolean(false)
        var startGateDeferred: CompletableDeferred<Unit>? = null
        var forceStopFailure: Throwable? = null
        var nextExitResult: CompletableDeferred<AndroidProcessExit>? = null
        var nextIdentityOnStart: ((Int, String) -> AndroidDebugHandles.ProcessInstanceIdentity)? = null

        override suspend fun getCurrentUser(device: ConnectedDevice, timeoutMs: Long): Int {
            getCurrentUserCalls.incrementAndGet()
            return currentUser
        }

        override suspend fun resolveInstalledApkPaths(
            device: ConnectedDevice,
            userId: Int,
            packageName: String,
            timeoutMs: Long,
        ): List<String> {
            return installedPaths[userId to packageName]
                ?: throw AndroidRunException(
                    AndroidRunError(
                        code = AndroidRunErrorCode.ARTIFACT_INVALID,
                        stage = AndroidRunStage.CONFIGURING,
                        detail = "Package $packageName not installed for user $userId",
                        device = device.serialNumber,
                    )
                )
        }

        override suspend fun pullFile(device: ConnectedDevice, remotePath: String, destination: Path, timeoutMs: Long) {
            destination.parent?.let { pulledTempDirsSeen.add(it) }
            Files.writeString(destination, "pulled:$remotePath")
        }

        override suspend fun queryAmsProcesses(
            device: ConnectedDevice,
            packageName: String,
            userId: Int?,
            timeoutMs: Long,
        ): List<AndroidDebugHandles.ProcessInstanceIdentity> {
            return synchronized(amsByKey) {
                if (userId != null) {
                    amsByKey[userId to packageName]?.toList().orEmpty()
                } else {
                    amsByKey.entries
                        .filter { it.key.second == packageName }
                        .flatMap { it.value }
                }
            }
        }

        override suspend fun startActivity(
            device: ConnectedDevice,
            userId: Int,
            componentName: String,
            debug: Boolean,
            timeoutMs: Long,
        ) {
            startedCommands.add(Triple(userId, componentName, debug))
            startGateDeferred?.let { gate ->
                gate.complete(Unit)
            }
            val pkg = componentName.substringBefore('/')
            val generated = nextIdentityOnStart?.invoke(userId, pkg)
            if (generated != null) {
                synchronized(amsByKey) {
                    amsByKey.getOrPut(userId to pkg) { mutableListOf() }.add(generated)
                }
            }
        }

        override suspend fun forceStopPackage(
            device: ConnectedDevice,
            userId: Int,
            packageName: String,
            timeoutMs: Long,
        ) {
            forceStopped.add(userId to packageName)
            forceStopFailure?.let { throw it }
            synchronized(amsByKey) {
                amsByKey.remove(userId to packageName)
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
            val matches = queryAmsProcesses(device, packageName, userId, timeoutMs)
            return matches.firstOrNull { it.processName == expectedProcessName && it.pid !in excludedPids }
                ?: throw AndroidRunException(
                    AndroidRunError(
                        code = AndroidRunErrorCode.START_FAILED,
                        stage = AndroidRunStage.STARTING,
                        detail = "Process $expectedProcessName not found for $packageName (user $userId)",
                    )
                )
        }

        override suspend fun awaitPackageStopped(
            device: ConnectedDevice,
            userId: Int,
            packageName: String,
            timeoutMs: Long,
        ) {
        }

        override suspend fun monitorProcessExit(
            device: ConnectedDevice,
            identity: AndroidDebugHandles.ProcessInstanceIdentity,
            isDebuggable: Boolean,
            closeSignal: CompletableDeferred<AndroidProcessExit>,
        ): AndroidProcessExit {
            val exitLatch = nextExitResult ?: return closeSignal.await()
            while (true) {
                if (closeSignal.isCompleted) return closeSignal.await()
                if (exitLatch.isCompleted) return exitLatch.await()
                delay(10)
            }
        }
    }

    private class FakeAapt2Runner(
        private val badging: String,
        private val xmlTree: String,
    ) : Aapt2Runner {
        override suspend fun dumpBadging(apk: Path): String = badging
        override suspend fun dumpXmlTree(apk: Path, entryPath: String): String = xmlTree
    }

    private fun createApkFile(name: String = "app-debug.apk"): Path {
        val file = tempFolder.newFile(name).toPath()
        Files.writeString(file, "fake-apk-payload-$name")
        return file
    }

    private fun debugBadging(pkg: String, activity: String = "$pkg.MainActivity", debuggable: Boolean = true): String {
        val dbg = if (debuggable) "application-debuggable\n" else ""
        return "package: name='$pkg' versionCode='1' versionName='1.0'\n${dbg}launchable-activity: name='$activity'\n"
    }

    private fun manifestXml(
        pkg: String,
        debuggable: Boolean = true,
        appProcess: String? = null,
        activityName: String = ".MainActivity",
        activityProcess: String? = null,
        aliasName: String? = null,
    ): String = buildString {
        appendLine("E: manifest")
        appendLine("  A: package=\"$pkg\"")
        appendLine("  A: android:versionCode=1")
        appendLine("    E: application")
        if (debuggable) {
            appendLine("      A: android:debuggable=true")
        }
        if (appProcess != null) {
            appendLine("      A: android:process=\"$appProcess\"")
        }
        appendLine("      E: activity")
        appendLine("        A: android:name=\"$activityName\"")
        appendLine("        A: android:exported=true")
        if (activityProcess != null) {
            appendLine("        A: android:process=\"$activityProcess\"")
        }
        if (aliasName == null) {
            appendLine("        E: intent-filter")
            appendLine("          E: action")
            appendLine("            A: android:name=\"android.intent.action.MAIN\"")
            appendLine("          E: category")
            appendLine("            A: android:name=\"android.intent.category.LAUNCHER\"")
        } else {
            appendLine("      E: activity-alias")
            appendLine("        A: android:name=\"$aliasName\"")
            appendLine("        A: android:targetActivity=\"$activityName\"")
            appendLine("        A: android:exported=true")
            appendLine("        E: intent-filter")
            appendLine("          E: action")
            appendLine("            A: android:name=\"android.intent.action.MAIN\"")
            appendLine("          E: category")
            appendLine("            A: android.intent.category.LAUNCHER\"")
        }
    }

    private fun launchConfig(
        deviceId: String = "emulator-5580",
        userId: Int? = null,
        target: AndroidLaunchTarget,
        activity: String? = null,
        restartApp: Boolean = false,
        noDebug: Boolean = false,
        timeoutMs: Int = 15_000,
    ): AndroidLaunchConfig = AndroidLaunchConfig(
        project = tempFolder.root.toPath(),
        cwd = tempFolder.root.toPath(),
        program = null,
        noDebug = noDebug,
        deviceId = deviceId,
        userId = userId,
        target = target,
        activity = activity,
        restartApp = restartApp,
        timeoutMs = timeoutMs,
    )

    @Test
    fun testRestartAppFalseRejectsRunningSameUserBeforeInstallOrStopAndRespectsDifferentUser() = runBlocking {
        registerOnlineDevice("emulator-5580")
        val apk = createApkFile("app-debug.apk")
        val apkSize = Files.size(apk)
        val pkg = "com.example.fixture"
        val ops = FakeDeviceOperations()
        ops.currentUser = 0
        ops.amsByKey[0 to pkg] = mutableListOf(
            AndroidDebugHandles.ProcessInstanceIdentity(
                pid = 5100,
                userId = 0,
                uid = 10243,
                packageName = pkg,
                processName = pkg,
                startSeq = 50L,
                amsRecord = "rec5100",
            )
        )

        val installCount = AtomicInteger(0)
        val deployment = AndroidDeployment(
            service = service,
            apkInspector = AndroidApkManifestInspector(
                FakeAapt2Runner(debugBadging(pkg), manifestXml(pkg))
            ),
            deviceOps = ops,
            installSessionFactory = { session, device, api, user, devId, onOut ->
                installCount.incrementAndGet()
                AndroidInstallSession(session, device, api, user, devId, onOut)
            },
        )

        val ownerScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        try {
            try {
                deployment.launch(
                    launchConfig(target = AndroidLaunchTarget.Apks(listOf(apk)), restartApp = false),
                    ownerScope,
                )
                fail("Expected TARGET_RUNNING")
            } catch (e: AndroidRunException) {
                assertEquals(AndroidRunErrorCode.TARGET_RUNNING, e.error.code)
                assertEquals(AndroidRunStage.CONFIGURING, e.error.stage)
                assertTrue(e.error.detail.contains("5100"))
            }

            assertEquals("Install must NOT run before target_running check", 0, installCount.get())
            assertTrue("force-stop must NOT run on target_running", ops.forceStopped.isEmpty())
            assertTrue("Original process must remain alive", ops.amsByKey[0 to pkg]!!.any { it.pid == 5100 })
            assertFalse(
                "Deployment reservation must be released",
                handles.isDeploymentReserved(AndroidDebugHandles.DeploymentKey("emulator-5580", 0, pkg))
            )

            // Launching the same package for user 10 must NOT collide with user 0
            configureFakeInstallCommands("emulator-5580", apkSize, userId = 10, apkName = apk.fileName.toString())
            ops.nextIdentityOnStart = { uid, p ->
                AndroidDebugHandles.ProcessInstanceIdentity(
                    pid = 6200,
                    userId = uid,
                    uid = 1010243,
                    packageName = p,
                    processName = p,
                    startSeq = 60L,
                    amsRecord = "rec6200",
                )
            }

            val handle = deployment.launch(
                launchConfig(userId = 10, target = AndroidLaunchTarget.Apks(listOf(apk)), restartApp = false),
                ownerScope,
            )
            assertEquals(10, handle.userId)
            assertEquals(6200, handle.pid)
            assertTrue(handle.isApplication)
            assertNotNull(handle.port)
            assertEquals(1, ops.startedCommands.size)
            assertEquals(10, ops.startedCommands[0].first)
            assertTrue(ops.startedCommands[0].third) // -D debug flag
            // User 0 original process is untouched
            assertEquals(5100, ops.amsByKey[0 to pkg]!![0].pid)

            handle.close(terminateApplication = true)
            assertEquals(listOf(10 to pkg), ops.forceStopped.toList())
            assertEquals(5100, ops.amsByKey[0 to pkg]!![0].pid)
        } finally {
            ownerScope.cancel()
        }
    }

    @Test
    fun testConcurrentLaunchSameDeviceUserPackageReturnsTargetBusy() = runBlocking {
        registerOnlineDevice("emulator-5580")
        val apk = createApkFile("concurrent.apk")
        val apkSize = Files.size(apk)
        val pkg = "com.example.concurrent"
        configureFakeInstallCommands("emulator-5580", apkSize, userId = 0, apkName = apk.fileName.toString())

        val ops = FakeDeviceOperations()
        ops.nextIdentityOnStart = { uid, p ->
            AndroidDebugHandles.ProcessInstanceIdentity(
                pid = 7001,
                userId = uid,
                packageName = p,
                processName = p,
                startSeq = 70L,
            )
        }
        val enteredWrite = CompletableDeferred<Unit>()
        val releaseWrite = CompletableDeferred<Unit>()

        val deployment = AndroidDeployment(
            service = service,
            apkInspector = AndroidApkManifestInspector(FakeAapt2Runner(debugBadging(pkg), manifestXml(pkg))),
            deviceOps = ops,
            installSessionFactory = { session, device, api, user, devId, onOut ->
                AndroidInstallSession(
                    session = session,
                    device = device,
                    apiLevel = api,
                    userId = user,
                    deviceId = devId,
                    onOutput = onOut,
                    testSeam = object : AndroidInstallSession.TestSeam {
                        override suspend fun beforeWrite(sessionId: String, apkIndex: Int, apk: Path) {
                            enteredWrite.complete(Unit)
                            releaseWrite.await()
                        }
                    },
                )
            },
        )

        val owner1 = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val owner2 = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        try {
            val firstLaunch = async {
                deployment.launch(launchConfig(userId = 0, target = AndroidLaunchTarget.Apks(listOf(apk))), owner1)
            }
            enteredWrite.await()

            try {
                deployment.launch(launchConfig(userId = 0, target = AndroidLaunchTarget.Apks(listOf(apk))), owner2)
                fail("Expected TARGET_BUSY for concurrent launch on same device/user/package")
            } catch (e: AndroidRunException) {
                assertEquals(AndroidRunErrorCode.TARGET_BUSY, e.error.code)
            }

            releaseWrite.complete(Unit)
            val handle = firstLaunch.await()
            handle.close(terminateApplication = false)
        } finally {
            owner1.cancel()
            owner2.cancel()
        }
    }

    @Test
    fun testAliasCustomProcessSelectsExactPidNeverMainProcess() = runBlocking {
        registerOnlineDevice("emulator-5580")
        val apk = createApkFile("alias-proc.apk")
        configureFakeInstallCommands("emulator-5580", Files.size(apk), userId = 0, apkName = apk.fileName.toString())
        val pkg = "com.example.aliasproc"

        val ops = FakeDeviceOperations()
        ops.nextIdentityOnStart = { uid, p ->
            // Simulate BOTH main process (pid 8001) and alias target's :custom process (pid 8002) appearing
            synchronized(ops.amsByKey) {
                ops.amsByKey.getOrPut(uid to p) { mutableListOf() }.add(
                    AndroidDebugHandles.ProcessInstanceIdentity(
                        pid = 8001,
                        userId = uid,
                        uid = 10243,
                        packageName = p,
                        processName = p,
                        startSeq = 80L,
                    )
                )
            }
            AndroidDebugHandles.ProcessInstanceIdentity(
                pid = 8002,
                userId = uid,
                uid = 10243,
                packageName = p,
                processName = "$p:custom",
                startSeq = 81L,
            )
        }

        val deployment = AndroidDeployment(
            service = service,
            apkInspector = AndroidApkManifestInspector(
                FakeAapt2Runner(
                    debugBadging(pkg, activity = "$pkg.AliasLauncher"),
                    manifestXml(
                        pkg = pkg,
                        activityName = ".TargetActivity",
                        activityProcess = ":custom",
                        aliasName = ".AliasLauncher",
                    ),
                )
            ),
            deviceOps = ops,
        )

        val owner = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        try {
            val handle = deployment.launch(
                launchConfig(userId = 0, target = AndroidLaunchTarget.Apks(listOf(apk))),
                owner,
            )
            assertEquals(8002, handle.pid)
            assertEquals("$pkg:custom", handle.processName)
            assertEquals(listOf("emulator-5580" to 8002), service.preparedPids.toList())
            assertEquals("$pkg/$pkg.AliasLauncher", ops.startedCommands[0].second)
            handle.close(terminateApplication = false)
        } finally {
            owner.cancel()
        }
    }

    @Test
    fun testInstalledTargetPullsToTempCleansUpInFinallyAndSkipsInstall() = runBlocking {
        registerOnlineDevice("emulator-5580")
        val pkg = "com.example.installed"
        val ops = FakeDeviceOperations()
        ops.installedPaths[0 to pkg] = listOf("/data/app/~~abc/base.apk")

        val installCount = AtomicInteger(0)
        val deployment = AndroidDeployment(
            service = service,
            apkInspector = AndroidApkManifestInspector(
                FakeAapt2Runner(debugBadging(pkg, debuggable = false), manifestXml(pkg, debuggable = false))
            ),
            deviceOps = ops,
            installSessionFactory = { session, device, api, user, devId, onOut ->
                installCount.incrementAndGet()
                AndroidInstallSession(session, device, api, user, devId, onOut)
            },
        )

        val owner = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        try {
            // Fails debuggable check in debug mode; temp directory must STILL be deleted in finally
            try {
                deployment.launch(
                    launchConfig(userId = 0, target = AndroidLaunchTarget.Installed(pkg), noDebug = false),
                    owner,
                )
                fail("Expected NOT_DEBUGGABLE")
            } catch (e: AndroidRunException) {
                assertEquals(AndroidRunErrorCode.NOT_DEBUGGABLE, e.error.code)
            }
            assertEquals(0, installCount.get())
            assertEquals(1, ops.pulledTempDirsSeen.size)
            assertFalse("Pulled temp dir must be deleted in finally", Files.exists(ops.pulledTempDirsSeen[0]))

            // Now launch in noDebug=true mode -> succeeds without JDWP
            ops.nextIdentityOnStart = { uid, p ->
                AndroidDebugHandles.ProcessInstanceIdentity(
                    pid = 9100,
                    userId = uid,
                    uid = 10243,
                    packageName = p,
                    processName = p,
                    startSeq = 91L,
                    amsRecord = "rec9100",
                )
            }
            val handle = deployment.launch(
                launchConfig(userId = 0, target = AndroidLaunchTarget.Installed(pkg), noDebug = true),
                owner,
            )
            assertNull(handle.port)
            assertTrue(handle.isApplication)
            assertEquals(9100, handle.pid)
            assertTrue("prepareByPid must not run in noDebug", service.preparedPids.isEmpty())
            assertFalse(ops.startedCommands[0].third) // no -D flag
            assertFalse("Second temp dir must be cleaned up", Files.exists(ops.pulledTempDirsSeen[1]))
            handle.close(terminateApplication = true)
        } finally {
            owner.cancel()
        }
    }

    @Test
    fun testExternalAttachRefusesTerminateAndPreservesProcessAcrossClose() = runBlocking {
        registerOnlineDevice("emulator-5580")
        val pkg = "com.example.extattach"
        val ops = FakeDeviceOperations()
        ops.currentUser = 0
        ops.amsByKey[0 to pkg] = mutableListOf(
            AndroidDebugHandles.ProcessInstanceIdentity(
                pid = 3100,
                userId = 0,
                uid = 10243,
                packageName = pkg,
                processName = pkg,
                startSeq = 11L,
            ),
            AndroidDebugHandles.ProcessInstanceIdentity(
                pid = 3101,
                userId = 0,
                uid = 10243,
                packageName = pkg,
                processName = "$pkg:worker",
                startSeq = 12L,
            ),
        )

        val deployment = AndroidDeployment(service = service, deviceOps = ops)
        val owner = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        try {
            // Ambiguous without pid/processName
            try {
                deployment.attach(
                    AndroidAttachConfig(
                        project = tempFolder.root.toPath(),
                        cwd = tempFolder.root.toPath(),
                        deviceId = "emulator-5580",
                        userId = null,
                        packageName = pkg,
                        pid = null,
                        processName = null,
                    ),
                    owner,
                )
                fail("Expected AMBIGUOUS_PROCESS")
            } catch (e: AndroidRunException) {
                assertEquals(AndroidRunErrorCode.AMBIGUOUS_PROCESS, e.error.code)
                assertEquals(AndroidRunStage.ATTACHING, e.error.stage)
            }

            // Select by processName -> attaches to exact PID 3101
            val handle = deployment.attach(
                AndroidAttachConfig(
                    project = tempFolder.root.toPath(),
                    cwd = tempFolder.root.toPath(),
                    deviceId = "emulator-5580",
                    userId = 0,
                    packageName = pkg,
                    pid = null,
                    processName = "$pkg:worker",
                ),
                owner,
            )
            assertFalse(handle.isApplication)
            assertEquals(3101, handle.pid)
            assertNotNull(handle.port)
            val jdwpPort = handle.port!!
            assertNotNull(handles.getHandleByPort(jdwpPort))

            // close(true) must reject stopping external process while STILL detaching JDWP
            try {
                handle.close(terminateApplication = true)
                fail("Expected INVALID_PARAMS when terminateApplication=true on external attach")
            } catch (e: AndroidRunException) {
                assertEquals(AndroidRunErrorCode.INVALID_PARAMS, e.error.code)
                assertTrue(e.error.detail.contains("external attach"))
            }
            assertTrue("External attach must NEVER call force-stop", ops.forceStopped.isEmpty())
            assertNull("JDWP handle must still be released", handles.getHandleByPort(jdwpPort))
            assertEquals(2, ops.amsByKey[0 to pkg]!!.size)

            // Subsequent close(false) is idempotent
            handle.close(terminateApplication = false)
        } finally {
            owner.cancel()
        }
    }

    @Test
    fun testStaleApplicationHandlePreservesExternallyRestartedInstanceAndRetainsFailures() = runBlocking {
        registerOnlineDevice("emulator-5580")
        val pkg = "com.example.stale"
        val ops = FakeDeviceOperations()
        ops.installedPaths[0 to pkg] = listOf("/data/app/base.apk")
        ops.nextIdentityOnStart = { uid, p ->
            AndroidDebugHandles.ProcessInstanceIdentity(
                pid = 5234,
                userId = uid,
                uid = 10243,
                packageName = p,
                processName = p,
                startSeq = 79L,
                amsRecord = "a368399 5234:$p/u0a243",
            )
        }

        val deployment = AndroidDeployment(
            service = service,
            apkInspector = AndroidApkManifestInspector(
                FakeAapt2Runner(debugBadging(pkg, debuggable = false), manifestXml(pkg, debuggable = false))
            ),
            deviceOps = ops,
        )

        val owner = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        try {
            val handle = deployment.launch(
                launchConfig(userId = 0, target = AndroidLaunchTarget.Installed(pkg), noDebug = true),
                owner,
            )

            // Simulate external restart reusing even the same PID with incremented startSeq=80
            synchronized(ops.amsByKey) {
                ops.amsByKey[0 to pkg] = mutableListOf(
                    AndroidDebugHandles.ProcessInstanceIdentity(
                        pid = 5234,
                        userId = 0,
                        uid = 10243,
                        packageName = pkg,
                        processName = pkg,
                        startSeq = 80L,
                        amsRecord = "b869cb4 5234:$pkg/u0a243",
                    )
                )
            }

            handle.close(terminateApplication = true)
            assertTrue("Stale handle must preserve externally restarted instance", ops.forceStopped.isEmpty())
            assertFalse(handles.isDeploymentReserved(AndroidDebugHandles.DeploymentKey("emulator-5580", 0, pkg)))
            assertEquals(80L, ops.amsByKey[0 to pkg]!![0].startSeq)

            // Now test close(false) followed by close(true) does not stop new launch or old app
            ops.nextIdentityOnStart = { uid, p ->
                AndroidDebugHandles.ProcessInstanceIdentity(
                    pid = 5400,
                    userId = uid,
                    uid = 10243,
                    packageName = p,
                    processName = p,
                    startSeq = 85L,
                )
            }
            val handle2 = deployment.launch(
                launchConfig(
                    userId = 0,
                    target = AndroidLaunchTarget.Installed(pkg),
                    noDebug = true,
                    restartApp = true
                ),
                owner,
            )
            handle2.close(terminateApplication = false)
            ops.forceStopped.clear()
            handle2.close(terminateApplication = true)
            assertTrue("Already-kept handle must stay idempotent on subsequent close(true)", ops.forceStopped.isEmpty())

            // Test force-stop failure retention
            ops.nextIdentityOnStart = { uid, p ->
                AndroidDebugHandles.ProcessInstanceIdentity(
                    pid = 5500,
                    userId = uid,
                    uid = 10243,
                    packageName = p,
                    processName = p,
                    startSeq = 90L,
                )
            }
            val handle3 = deployment.launch(
                launchConfig(
                    userId = 0,
                    target = AndroidLaunchTarget.Installed(pkg),
                    noDebug = true,
                    restartApp = true
                ),
                owner,
            )
            ops.forceStopFailure = RuntimeException("force-stop failure")
            try {
                handle3.close(terminateApplication = true)
                fail("Expected CLEANUP_FAILED when force-stop fails")
            } catch (e: AndroidRunException) {
                assertEquals(AndroidRunErrorCode.CLEANUP_FAILED, e.error.code)
                assertTrue(e.error.detail.contains("force-stop failure"))
            }
            assertFalse(
                "ApplicationHandle must still be released despite force-stop error",
                handles.isDeploymentReserved(AndroidDebugHandles.DeploymentKey("emulator-5580", 0, pkg))
            )
        } finally {
            owner.cancel()
        }
    }

    @Test
    fun testOwnerScopeCancellationMidAttachStopsStartedAppAndFreesReservation() = runBlocking {
        registerOnlineDevice("emulator-5580")
        val pkg = "com.example.cancelattach"
        val ops = FakeDeviceOperations()
        ops.installedPaths[0 to pkg] = listOf("/data/app/base.apk")
        ops.nextIdentityOnStart = { uid, p ->
            AndroidDebugHandles.ProcessInstanceIdentity(
                pid = 7777,
                userId = uid,
                uid = 10243,
                packageName = p,
                processName = p,
                startSeq = 77L,
            )
        }

        val enteredPrepare = CompletableDeferred<Unit>()
        val neverCompletes = CompletableDeferred<Unit>()
        service.prepareGate = { _, _ ->
            enteredPrepare.complete(Unit)
            neverCompletes.await()
        }

        val deployment = AndroidDeployment(
            service = service,
            apkInspector = AndroidApkManifestInspector(
                FakeAapt2Runner(debugBadging(pkg, debuggable = true), manifestXml(pkg, debuggable = true))
            ),
            deviceOps = ops,
        )

        val owner = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val launchJob = async {
            deployment.launch(
                launchConfig(userId = 0, target = AndroidLaunchTarget.Installed(pkg), noDebug = false),
                owner,
            )
        }

        enteredPrepare.await()
        owner.cancel()

        try {
            launchJob.await()
            fail("Expected CancellationException")
        } catch (_: CancellationException) {
        }

        assertEquals(
            "Started app must be force-stopped when cancelled during ATTACHING",
            listOf(0 to pkg),
            ops.forceStopped.toList()
        )
        assertFalse(
            "Deployment reservation must be released after cancellation",
            handles.isDeploymentReserved(AndroidDebugHandles.DeploymentKey("emulator-5580", 0, pkg)),
        )
    }

    @Test
    fun testAwaitExitReportsProcessExitDeviceOfflineAndCloseUnblock() = runBlocking {
        registerOnlineDevice("emulator-5580")
        val pkg = "com.example.exitmon"
        val ops = FakeDeviceOperations()
        ops.installedPaths[0 to pkg] = listOf("/data/app/base.apk")
        ops.nextIdentityOnStart = { uid, p ->
            AndroidDebugHandles.ProcessInstanceIdentity(
                pid = 9200,
                userId = uid,
                packageName = p,
                processName = p,
                startSeq = 92L,
            )
        }
        val exitSignal = CompletableDeferred<AndroidProcessExit>()
        ops.nextExitResult = exitSignal

        val deployment = AndroidDeployment(
            service = service,
            apkInspector = AndroidApkManifestInspector(
                FakeAapt2Runner(debugBadging(pkg, debuggable = false), manifestXml(pkg, debuggable = false))
            ),
            deviceOps = ops,
        )

        val owner = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        try {
            val handle = deployment.launch(
                launchConfig(userId = 0, target = AndroidLaunchTarget.Installed(pkg), noDebug = true),
                owner,
            )
            val exitDeferred = async { handle.awaitExit() }
            exitSignal.complete(AndroidProcessExit(exitCode = null, deviceOffline = false, reason = "process_exited"))
            val res = exitDeferred.await()
            assertNull(res.exitCode)
            assertFalse(res.deviceOffline)
            assertEquals("process_exited", res.reason)
            handle.close(false)

            // Also verify handle.close unblocks awaitExit when no process exit happened yet
            ops.nextExitResult = null
            ops.nextIdentityOnStart = { uid, p ->
                AndroidDebugHandles.ProcessInstanceIdentity(
                    pid = 9201,
                    userId = uid,
                    packageName = p,
                    processName = p,
                    startSeq = 93L,
                )
            }
            val handle2 = deployment.launch(
                launchConfig(
                    userId = 0,
                    target = AndroidLaunchTarget.Installed(pkg),
                    noDebug = true,
                    restartApp = true
                ),
                owner,
            )
            val exitDeferred2 = async { handle2.awaitExit() }
            delay(20)
            handle2.close(false)
            val res2 = exitDeferred2.await()
            assertEquals("closed", res2.reason)
        } finally {
            owner.cancel()
        }
    }

    @Test
    fun testGradleTargetValidatesApplicationIdMismatchAndRunsDeployment() = runBlocking {
        registerOnlineDevice("emulator-5580")
        val apk = createApkFile("gradle-app.apk")
        configureFakeInstallCommands("emulator-5580", Files.size(apk), userId = 0, apkName = apk.fileName.toString())
        val pkg = "com.example.gradleapp"
        val ops = FakeDeviceOperations()
        ops.nextIdentityOnStart = { uid, p ->
            AndroidDebugHandles.ProcessInstanceIdentity(
                pid = 8888,
                userId = uid,
                packageName = p,
                processName = p,
                startSeq = 88L,
            )
        }

        val fakeGradle = object : AndroidGradleProject() {
            var reportedId: String? = "com.example.different"
            override suspend fun resolveAndBuild(
                target: AndroidLaunchTarget.Gradle,
                deviceAbis: List<String>,
                onStage: (AndroidRunStage) -> Unit,
                onOutput: (String) -> Unit,
            ): GradleResolvedArtifacts {
                onStage(AndroidRunStage.CONFIGURING)
                onStage(AndroidRunStage.BUILDING)
                onOutput("Built ${target.module}:${target.variant}")
                return GradleResolvedArtifacts(
                    buildRoot = target.buildRoot,
                    module = target.module,
                    variant = target.variant,
                    applicationId = reportedId,
                    abiFilters = null,
                    listingFile = tempFolder.root.toPath().resolve("redirect.txt"),
                    resolvedPaths = listOf(apk),
                )
            }
        }

        val deployment = AndroidDeployment(
            service = service,
            gradleProject = fakeGradle,
            apkInspector = AndroidApkManifestInspector(
                FakeAapt2Runner(debugBadging(pkg), manifestXml(pkg))
            ),
            deviceOps = ops,
        )

        val owner = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        try {
            val gradleTarget = AndroidLaunchTarget.Gradle(
                buildRoot = tempFolder.root.toPath(),
                module = ":app",
                variant = "debug",
                build = true,
            )
            try {
                deployment.launch(launchConfig(userId = 0, target = gradleTarget), owner)
                fail("Expected ARTIFACT_INVALID for applicationId mismatch")
            } catch (e: AndroidRunException) {
                assertEquals(AndroidRunErrorCode.ARTIFACT_INVALID, e.error.code)
            }

            fakeGradle.reportedId = pkg
            val stages = CopyOnWriteArrayList<AndroidRunStage>()
            val outputs = CopyOnWriteArrayList<String>()
            val handle = deployment.launch(
                launchConfig(userId = 0, target = gradleTarget),
                owner,
                onStage = { stages.add(it) },
                onOutput = { outputs.add(it) },
            )
            assertEquals(8888, handle.pid)
            assertEquals(pkg, handle.packageName)
            assertTrue(stages.contains(AndroidRunStage.BUILDING))
            assertTrue(stages.contains(AndroidRunStage.INSTALLING))
            assertTrue(stages.contains(AndroidRunStage.STARTING))
            assertTrue(stages.contains(AndroidRunStage.ATTACHING))
            assertTrue(outputs.any { it.contains(":app:debug") })
            handle.close(terminateApplication = true)
        } finally {
            owner.cancel()
        }
    }
}
