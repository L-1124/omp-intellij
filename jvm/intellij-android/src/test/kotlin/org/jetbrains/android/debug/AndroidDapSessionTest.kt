package org.jetbrains.android.debug

import com.jetbrains.dap.impl.runDapServerOverChannels
import com.jetbrains.dap.protocol.AttachRequestArguments
import com.jetbrains.dap.protocol.BreakpointEventReason
import com.jetbrains.dap.protocol.Breakpoint
import com.jetbrains.dap.protocol.BreakpointEventArguments
import com.jetbrains.dap.protocol.BreakpointLocationsArguments
import com.jetbrains.dap.protocol.BreakpointLocationsResponse
import com.jetbrains.dap.protocol.CancelArguments
import com.jetbrains.dap.protocol.Capabilities
import com.jetbrains.dap.protocol.CompletionsArguments
import com.jetbrains.dap.protocol.CompletionsResponse
import com.jetbrains.dap.protocol.ConfigurationDoneArguments
import com.jetbrains.dap.protocol.ContinueArguments
import com.jetbrains.dap.protocol.ContinueResponse
import com.jetbrains.dap.protocol.DapClient
import com.jetbrains.dap.protocol.DapColumn
import com.jetbrains.dap.protocol.DapLine
import com.jetbrains.dap.protocol.DapRequestFailedException
import com.jetbrains.dap.protocol.DapServer
import com.jetbrains.dap.protocol.DataBreakpointInfoArguments
import com.jetbrains.dap.protocol.DataBreakpointInfoResponse
import com.jetbrains.dap.protocol.DisassembleArguments
import com.jetbrains.dap.protocol.DisassembleResponse
import com.jetbrains.dap.protocol.DisassembledInstruction
import com.jetbrains.dap.protocol.DisconnectArguments
import com.jetbrains.dap.protocol.EvaluateArguments
import com.jetbrains.dap.protocol.EvaluateResponse
import com.jetbrains.dap.protocol.ExceptionBreakpointsFilter
import com.jetbrains.dap.protocol.ExceptionInfoArguments
import com.jetbrains.dap.protocol.ExceptionInfoResponse
import com.jetbrains.dap.protocol.ExitedEventArguments
import com.jetbrains.dap.protocol.FrameId
import com.jetbrains.dap.protocol.GotoArguments
import com.jetbrains.dap.protocol.GotoTargetId
import com.jetbrains.dap.protocol.GotoTargetsArguments
import com.jetbrains.dap.protocol.GotoTargetsResponse
import com.jetbrains.dap.protocol.InitializeRequestArguments
import com.jetbrains.dap.protocol.InitializedEventArguments
import com.jetbrains.dap.protocol.LaunchRequestArguments
import com.jetbrains.dap.protocol.LoadedSourceEventArguments
import com.jetbrains.dap.protocol.LoadedSourceEventReason
import com.jetbrains.dap.protocol.LoadedSourcesArguments
import com.jetbrains.dap.protocol.LoadedSourcesResponse
import com.jetbrains.dap.protocol.LocationsArguments
import com.jetbrains.dap.protocol.LocationsResponse
import com.jetbrains.dap.protocol.ModulesArguments
import com.jetbrains.dap.protocol.ModulesResponse
import com.jetbrains.dap.protocol.NextArguments
import com.jetbrains.dap.protocol.OutputCategory
import com.jetbrains.dap.protocol.OutputEventArguments
import com.jetbrains.dap.protocol.PauseArguments
import com.jetbrains.dap.protocol.ProcessEventArguments
import com.jetbrains.dap.protocol.ProcessStartMethod
import com.jetbrains.dap.protocol.ReadMemoryArguments
import com.jetbrains.dap.protocol.ReadMemoryResponse
import com.jetbrains.dap.protocol.RestartArguments
import com.jetbrains.dap.protocol.RestartFrameArguments
import com.jetbrains.dap.protocol.ReverseContinueArguments
import com.jetbrains.dap.protocol.Scope
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
import com.jetbrains.dap.protocol.Source
import com.jetbrains.dap.protocol.SourceArguments
import com.jetbrains.dap.protocol.SourceBreakpoint
import com.jetbrains.dap.protocol.SourceReference
import com.jetbrains.dap.protocol.SourceResponse
import com.jetbrains.dap.protocol.StackFrame
import com.jetbrains.dap.protocol.StackTraceArguments
import com.jetbrains.dap.protocol.StackTraceResponse
import com.jetbrains.dap.protocol.StepBackArguments
import com.jetbrains.dap.protocol.StepInArguments
import com.jetbrains.dap.protocol.StepInTargetsArguments
import com.jetbrains.dap.protocol.StepInTargetsResponse
import com.jetbrains.dap.protocol.StepOutArguments
import com.jetbrains.dap.protocol.TerminateArguments
import com.jetbrains.dap.protocol.TerminateThreadsArguments
import com.jetbrains.dap.protocol.TerminatedEventArguments
import com.jetbrains.dap.protocol.ThreadDumpArguments
import com.jetbrains.dap.protocol.ThreadDumpResponse
import com.jetbrains.dap.protocol.VariablesReference
import com.jetbrains.dap.protocol.ThreadId
import com.jetbrains.dap.protocol.ThreadsResponse
import com.jetbrains.dap.protocol.VariablesArguments
import com.jetbrains.dap.protocol.VariablesResponse
import com.jetbrains.dap.protocol.WriteMemoryArguments
import com.jetbrains.dap.protocol.WriteMemoryResponse
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.jetbrains.android.run.AndroidAttachConfig
import org.jetbrains.android.run.AndroidLaunchConfig
import org.jetbrains.android.run.AndroidProcessExit
import org.jetbrains.android.run.AndroidRunError
import org.jetbrains.android.run.AndroidRunErrorCode
import org.jetbrains.android.run.AndroidRunException
import org.jetbrains.android.run.AndroidRunStage
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.lang.reflect.Proxy
import java.nio.file.Path
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import kotlin.time.Duration.Companion.milliseconds

@Suppress("UnstableApiUsage")
class AndroidDapSessionTest {

    private val testProjectDir: Path = Path.of("F:/tmp/android-dap-session-test").toAbsolutePath().normalize()
    private val testSourceFile: Path = testProjectDir.resolve("app/src/main/java/com/example/MainActivity.java")

    @Test
    fun testInitializeRewritesAdapterIdAndOverridesLifecycleCapabilitiesViaChannels() = runBlocking {
        val delegate = RecordingNativeDapServer()
        runWithChannels(delegate) { send, awaitResponse ->
            val initResp = send(
                "initialize",
                buildJsonObject {
                    put("clientID", "generic-client")
                    put("adapterID", "android")
                    put("linesStartAt1", false)
                    put("columnsStartAt1", false)
                    put("pathFormat", "uri")
                    put("supportsProgressReporting", true)
                }
            )
            val response = awaitResponse(initResp)
            assertTrue(response["success"]!!.jsonPrimitive.boolean)
            val body = response["body"]!!.jsonObject
            assertFalse(body["supportsTerminateRequest"]!!.jsonPrimitive.boolean)
            assertTrue(body["supportsCancelRequest"]!!.jsonPrimitive.boolean)
            assertFalse(body["supportSuspendDebuggee"]!!.jsonPrimitive.boolean)
            assertFalse(body["supportTerminateDebuggee"]!!.jsonPrimitive.boolean)
            assertTrue(body["supportsConfigurationDoneRequest"]!!.jsonPrimitive.boolean)
            assertTrue(body["supportsFunctionBreakpoints"]!!.jsonPrimitive.boolean)

            val seenInit = delegate.lastInitializeArgs
            assertNotNull(seenInit)
            assertEquals(AndroidDapSession.NATIVE_ADAPTER_ID, seenInit!!.adapterID)
            assertEquals(false, seenInit.linesStartAt1)
            assertEquals(false, seenInit.columnsStartAt1)
            assertEquals(true, seenInit.supportsProgressReporting)
        }
    }

    @Test
    fun testInvalidLaunchAndAttachFailBeforeSideEffectsAndAllowDisconnectViaChannels() = runBlocking {
        val invalidBodies = listOf(
            JsonObject(emptyMap()),
            buildJsonObject { put("android", JsonNull) },
            buildJsonObject { put("android", JsonArray(emptyList())) },
            buildJsonObject { put("android", JsonObject(emptyMap())) }
        )

        for (command in listOf("launch", "attach")) {
            for ((index, arguments) in invalidBodies.withIndex()) {
                val delegate = RecordingNativeDapServer()
                val backend = FakeAndroidRunBackend()
                val emittedEvents = CopyOnWriteArrayList<JsonObject>()
                runWithChannels(delegate, backend, onEvent = { emittedEvents.add(it) }) { send, awaitResponse ->
                    assertTrue(awaitResponse(send("initialize", defaultInitArgs()))["success"]!!.jsonPrimitive.boolean)

                    val startResponse = awaitResponse(send(command, arguments))
                    assertFalse(
                        "Expected failure for $command case #$index",
                        startResponse["success"]!!.jsonPrimitive.boolean
                    )
                    val message = startResponse["message"]!!.jsonPrimitive.content
                    assertTrue(
                        "Expected [invalid_params] configuring: in '$message'",
                        message.startsWith("[invalid_params] configuring:")
                    )
                    if (index == 3) {
                        assertEquals("[invalid_params] configuring: android.deviceId is required", message)
                    }

                    assertEquals(0, backend.launchCalls.get())
                    assertEquals(0, backend.attachCalls.get())
                    assertEquals(0, delegate.attachCalls)
                    assertFalse(
                        emittedEvents.any { event ->
                            val eventName = event["event"]?.jsonPrimitive?.content
                            eventName == "progressStart" || eventName == "progressUpdate"
                        }
                    )

                    val discResponse =
                        awaitResponse(send("disconnect", buildJsonObject { put("terminateDebuggee", false) }))
                    assertTrue(discResponse["success"]!!.jsonPrimitive.boolean)
                    assertEquals(1, delegate.disconnectCalls.size)
                    assertEquals(false, delegate.disconnectCalls.single().terminateDebuggee)
                }
            }
        }
    }

    @Test
    fun testDirectParseFailureProducesStructuredDapMessage3001() = runBlocking {
        val delegate = RecordingNativeDapServer()
        val client = noOpDapClient()
        val session = AndroidDapSession(
            native = delegate,
            client = client,
            projectDirectory = testProjectDir,
            scope = this,
            backend = FakeAndroidRunBackend(),
        )
        session.initialize(
            InitializeRequestArguments(
                adapterID = "android",
                linesStartAt1 = true,
                columnsStartAt1 = true
            )
        )

        try {
            session.launch(
                LaunchRequestArguments(
                    adapterArguments = buildJsonObject {
                        put("android", JsonObject(emptyMap()))
                    }
                )
            )
            fail("Expected DapRequestFailedException")
        } catch (ex: DapRequestFailedException) {
            assertEquals("[invalid_params] configuring: android.deviceId is required", ex.message)
            val err = ex.error
            assertNotNull(err)
            assertEquals(3001, err!!.id)
            assertEquals("{code}: {detail}", err.format)
            assertEquals("invalid_params", err.variables?.get("code"))
            assertEquals("configuring", err.variables?.get("stage"))
            assertEquals("android.deviceId is required", err.variables?.get("detail"))
            assertEquals(false, err.sendTelemetry)
        }
    }

    @Test
    fun testLaunchDebugChainEmitsProgressCapabilitiesNativeAttachAndDisconnectDecisions() = runBlocking {
        for (terminateArg in listOf(null, true, false)) {
            val delegate = RecordingNativeDapServer()
            val handle = FakeAndroidRunHandle(
                pid = 4321,
                deviceId = "emulator-5580",
                userId = 0,
                packageName = "com.example.ompattachfixture",
                processName = "com.example.ompattachfixture",
                port = 50555,
                isApplication = true,
            )
            val backend = FakeAndroidRunBackend(
                launchBehavior = { _, _, onStage, onOutput ->
                    onStage(AndroidRunStage.CONFIGURING)
                    onStage(AndroidRunStage.BUILDING)
                    onOutput("Built debug APK")
                    onStage(AndroidRunStage.INSTALLING)
                    onStage(AndroidRunStage.STARTING)
                    onStage(AndroidRunStage.ATTACHING)
                    handle
                }
            )
            val events = CopyOnWriteArrayList<JsonObject>()
            runWithChannels(delegate, backend, onEvent = { events.add(it) }) { send, awaitResponse ->
                assertTrue(
                    awaitResponse(
                        send(
                            "initialize",
                            defaultInitArgs(supportsProgress = true)
                        )
                    )["success"]!!.jsonPrimitive.boolean
                )

                val launchSeq = send("launch", validInstalledLaunchJson(noDebug = false))
                val initEvent = waitForEvent(events, "initialized")
                assertNotNull(initEvent)

                // Launch response must NOT arrive before configurationDone completes.
                assertEquals(1, delegate.attachCalls)
                assertEquals(50555, delegate.lastAttachArgs?.port)
                assertEquals(
                    "emulator-5580",
                    delegate.lastAttachArgs?.adapterArguments?.get("android")?.jsonObject?.get("deviceId")?.jsonPrimitive?.content
                )

                // Duplicate launch while active must fail without disrupting first session.
                val dupLaunch = awaitResponse(send("launch", validInstalledLaunchJson(noDebug = false)))
                assertFalse(dupLaunch["success"]!!.jsonPrimitive.boolean)
                assertTrue(dupLaunch["message"]!!.jsonPrimitive.content.startsWith("[invalid_params] configuring:"))

                assertTrue(
                    awaitResponse(
                        send(
                            "configurationDone",
                            JsonObject(emptyMap())
                        )
                    )["success"]!!.jsonPrimitive.boolean
                )
                val launchResp = awaitResponse(launchSeq)
                assertTrue(launchResp["success"]!!.jsonPrimitive.boolean)

                // Capabilities event updated supportTerminateDebuggee = true.
                val capEvents = events.filter { it["event"]?.jsonPrimitive?.content == "capabilities" }
                assertTrue(capEvents.isNotEmpty())
                assertEquals(
                    true,
                    capEvents.last()["body"]!!.jsonObject["capabilities"]!!.jsonObject["supportTerminateDebuggee"]!!.jsonPrimitive.boolean
                )

                // Process event has Android identity and isLocalProcess = false.
                val processEvent = waitForEvent(events, "process")
                val procBody = processEvent["body"]!!.jsonObject
                assertEquals("com.example.ompattachfixture", procBody["name"]!!.jsonPrimitive.content)
                assertEquals(4321, procBody["systemProcessId"]!!.jsonPrimitive.int)
                assertEquals(false, procBody["isLocalProcess"]!!.jsonPrimitive.boolean)
                assertEquals("launch", procBody["startMethod"]!!.jsonPrimitive.content)

                // Progress start / stages / end emitted once.
                waitForEvent(events, "progressEnd")
                val progressStarts = events.filter { it["event"]?.jsonPrimitive?.content == "progressStart" }
                val progressUpdates = events.filter { it["event"]?.jsonPrimitive?.content == "progressUpdate" }
                val progressEnds = events.filter { it["event"]?.jsonPrimitive?.content == "progressEnd" }
                assertEquals(1, progressStarts.size)
                assertEquals(1, progressEnds.size)
                assertEquals(
                    listOf("building", "installing", "starting", "attaching"),
                    progressUpdates.map { it["body"]!!.jsonObject["message"]!!.jsonPrimitive.content }
                )

                val discArgs = buildJsonObject {
                    if (terminateArg != null) put("terminateDebuggee", terminateArg)
                }
                val discResp = awaitResponse(send("disconnect", discArgs))
                assertTrue(discResp["success"]!!.jsonPrimitive.boolean)
                assertEquals(listOf(false), delegate.disconnectCalls.map { it.terminateDebuggee })
                assertEquals(listOf(terminateArg ?: true), handle.closeCalls)
                waitForEvent(events, "terminated")
                assertEquals(1, events.count { it["event"]?.jsonPrimitive?.content == "terminated" })
                assertEquals(0, events.count { it["event"]?.jsonPrimitive?.content == "exited" })
            }
        }
    }

    @Test
    fun testExternalAttachAndDisconnectTrueCleansAndRejectsWithExactMessage() = runBlocking {
        val delegate = RecordingNativeDapServer()
        val handle = FakeAndroidRunHandle(
            pid = 9001,
            deviceId = "emulator-5580",
            userId = 0,
            packageName = "com.example.ompattachfixture",
            processName = "com.example.ompattachfixture:worker",
            port = 50666,
            isApplication = false,
        )
        val backend = FakeAndroidRunBackend(
            attachBehavior = { _, _, onStage, _ ->
                onStage(AndroidRunStage.CONFIGURING)
                onStage(AndroidRunStage.ATTACHING)
                handle
            }
        )
        val events = CopyOnWriteArrayList<JsonObject>()
        runWithChannels(delegate, backend, onEvent = { events.add(it) }) { send, awaitResponse ->
            val initResp = awaitResponse(send("initialize", defaultInitArgs()))
            assertEquals(false, initResp["body"]!!.jsonObject["supportTerminateDebuggee"]!!.jsonPrimitive.boolean)

            val attachSeq = send("attach", validAttachJson())
            waitForEvent(events, "initialized")
            assertEquals(50666, delegate.lastAttachArgs?.port)
            assertTrue(
                awaitResponse(
                    send(
                        "configurationDone",
                        JsonObject(emptyMap())
                    )
                )["success"]!!.jsonPrimitive.boolean
            )
            assertTrue(awaitResponse(attachSeq)["success"]!!.jsonPrimitive.boolean)

            // supportTerminateDebuggee must remain false for external attach.
            assertFalse(events.any {
                it["event"]?.jsonPrimitive?.content == "capabilities" &&
                        it["body"]!!.jsonObject["capabilities"]!!.jsonObject["supportTerminateDebuggee"]?.jsonPrimitive?.boolean == true
            })

            val procEvent = waitForEvent(events, "process")
            assertEquals(
                "com.example.ompattachfixture:worker",
                procEvent["body"]!!.jsonObject["name"]!!.jsonPrimitive.content
            )
            assertEquals(9001, procEvent["body"]!!.jsonObject["systemProcessId"]!!.jsonPrimitive.int)
            assertEquals(false, procEvent["body"]!!.jsonObject["isLocalProcess"]!!.jsonPrimitive.boolean)
            assertEquals("attach", procEvent["body"]!!.jsonObject["startMethod"]!!.jsonPrimitive.content)

            // External attach disconnect(terminateDebuggee=true) cleans local JDWP + emits terminated once + fails.
            val discResp = awaitResponse(send("disconnect", buildJsonObject { put("terminateDebuggee", true) }))
            assertFalse(discResp["success"]!!.jsonPrimitive.boolean)
            assertEquals(
                "[invalid_params] cleanup: terminateDebuggee=true is not permitted for external attach",
                discResp["message"]!!.jsonPrimitive.content
            )
            assertEquals(listOf(false), delegate.disconnectCalls.map { it.terminateDebuggee })
            assertEquals(listOf(true), handle.closeCalls)
            waitForEvent(events, "terminated")
            assertEquals(1, events.count { it["event"]?.jsonPrimitive?.content == "terminated" })

            // Repeated disconnect must be idempotent without duplicating failure or terminated event.
            val secondDisc = awaitResponse(send("disconnect", buildJsonObject { put("terminateDebuggee", true) }))
            assertTrue(secondDisc["success"]!!.jsonPrimitive.boolean)
            assertEquals(1, events.count { it["event"]?.jsonPrimitive?.content == "terminated" })
        }
    }

    @Test
    fun testTerminateIsUnsupportedAndPreservesSessionAndCancelDelegates() = runBlocking {
        val delegate = RecordingNativeDapServer()
        runWithChannels(delegate) { send, awaitResponse ->
            assertTrue(awaitResponse(send("initialize", defaultInitArgs()))["success"]!!.jsonPrimitive.boolean)

            val termResp = awaitResponse(send("terminate", JsonObject(emptyMap())))
            assertFalse(termResp["success"]!!.jsonPrimitive.boolean)
            assertTrue(termResp["message"]!!.jsonPrimitive.content.contains("terminate"))
            assertEquals(0, delegate.terminateCalls)

            val threadsResp = awaitResponse(send("threads", JsonObject(emptyMap())))
            assertTrue(threadsResp["success"]!!.jsonPrimitive.boolean)
            assertEquals(1, delegate.threadsCalls)

            val cancelResp = awaitResponse(send("cancel", buildJsonObject { put("requestId", 42) }))
            assertTrue(cancelResp["success"]!!.jsonPrimitive.boolean)
            assertEquals(listOf(42L), delegate.cancelCalls.mapNotNull { it.requestId?.id })
        }
    }

    @Test
    fun testCancelByRequestIdDuringDeploymentCleansBeforeStartupResponse() = runBlocking {
        val deploymentEntered = CompletableDeferred<Unit>()
        val deploymentCleaned = AtomicInteger(0)
        val nextStageReached = AtomicInteger(0)
        val backend = FakeAndroidRunBackend(
            launchBehavior = { _, _, onStage, _ ->
                onStage(AndroidRunStage.BUILDING)
                deploymentEntered.complete(Unit)
                try {
                    delay(30_000.milliseconds)
                    nextStageReached.incrementAndGet()
                    error("unreachable")
                } finally {
                    withContext(NonCancellable) {
                        delay(50.milliseconds)
                        deploymentCleaned.incrementAndGet()
                    }
                }
            }
        )
        val delegate = RecordingNativeDapServer()
        val events = CopyOnWriteArrayList<JsonObject>()
        runWithChannels(delegate, backend, onEvent = { events.add(it) }) { send, awaitResponse ->
            assertTrue(
                awaitResponse(
                    send(
                        "initialize",
                        defaultInitArgs(supportsProgress = true)
                    )
                )["success"]!!.jsonPrimitive.boolean
            )

            val launchSeq = send("launch", validInstalledLaunchJson(noDebug = false))
            withTimeout(5_000.milliseconds) { deploymentEntered.await() }

            val cancelResp = awaitResponse(send("cancel", buildJsonObject { put("requestId", launchSeq) }))
            assertTrue(cancelResp["success"]!!.jsonPrimitive.boolean)

            val launchResp = awaitResponse(launchSeq)
            assertFalse(launchResp["success"]!!.jsonPrimitive.boolean)
            assertTrue(
                "Expected [cancelled] in '${launchResp["message"]?.jsonPrimitive?.content}'",
                launchResp["message"]!!.jsonPrimitive.content.startsWith("[cancelled]")
            )
            assertEquals(1, deploymentCleaned.get())
            assertEquals(0, nextStageReached.get())
            assertEquals(0, delegate.attachCalls)
            waitForEvent(events, "progressEnd")
            assertEquals(1, events.count { it["event"]?.jsonPrimitive?.content == "progressEnd" })
        }
    }

    @Test
    fun testCancelByProgressIdDuringNativeAttachClosesOwnedHandleBeforeStartupResponse() = runBlocking {
        val handle = FakeAndroidRunHandle(
            pid = 7777,
            deviceId = "emulator-5580",
            userId = 0,
            packageName = "com.example.ompattachfixture",
            processName = "com.example.ompattachfixture",
            port = 50777,
            isApplication = true,
        )
        val backend = FakeAndroidRunBackend(
            launchBehavior = { _, _, onStage, _ ->
                onStage(AndroidRunStage.STARTING)
                handle
            }
        )
        val attachBlocked = CompletableDeferred<Unit>()
        val delegate = RecordingNativeDapServer(
            attachHook = { _, _ ->
                attachBlocked.complete(Unit)
                delay(30_000.milliseconds)
            }
        )
        val events = CopyOnWriteArrayList<JsonObject>()
        runWithChannels(delegate, backend, onEvent = { events.add(it) }) { send, awaitResponse ->
            assertTrue(
                awaitResponse(
                    send(
                        "initialize",
                        defaultInitArgs(supportsProgress = true)
                    )
                )["success"]!!.jsonPrimitive.boolean
            )

            val launchSeq = send("launch", validInstalledLaunchJson(noDebug = false))
            withTimeout(5_000.milliseconds) { attachBlocked.await() }

            val cancelResp = awaitResponse(
                send("cancel", buildJsonObject { put("progressId", AndroidDapSession.PROGRESS_ID) })
            )
            assertTrue(cancelResp["success"]!!.jsonPrimitive.boolean)

            val launchResp = awaitResponse(launchSeq)
            assertFalse(launchResp["success"]!!.jsonPrimitive.boolean)
            assertTrue(launchResp["message"]!!.jsonPrimitive.content.startsWith("[cancelled]"))
            // Owned handle must already be closed with terminateApplication=true before startup result returns.
            assertEquals(listOf(true), handle.closeCalls)
            waitForEvent(events, "progressEnd")
            assertEquals(1, events.count { it["event"]?.jsonPrimitive?.content == "progressEnd" })
        }
    }

    @Test
    fun testCancelPendingAttachByRequestIdAfterInitializedEmitsSingleProgressEndAndPreservesExternalProcess() =
        runBlocking {
            val handle = FakeAndroidRunHandle(
                pid = 7788,
                deviceId = "emulator-5580",
                userId = 0,
                packageName = "com.example.ompattachfixture",
                processName = "com.example.ompattachfixture",
                port = 50788,
                isApplication = false,
            )
            val backend = FakeAndroidRunBackend(
                attachBehavior = { _, _, onStage, _ ->
                    onStage(AndroidRunStage.STARTING)
                    handle
                }
            )
            val attachSuspended = CompletableDeferred<Unit>()
            val delegate = RecordingNativeDapServer(
                attachHook = { _, client ->
                    client?.initialized(InitializedEventArguments())
                    attachSuspended.complete(Unit)
                    delay(30_000.milliseconds)
                }
            )
            val events = CopyOnWriteArrayList<JsonObject>()
            runWithChannels(delegate, backend, onEvent = { events.add(it) }) { send, awaitResponse ->
                assertTrue(
                    awaitResponse(
                        send("initialize", defaultInitArgs(supportsProgress = true))
                    )["success"]!!.jsonPrimitive.boolean
                )

                val attachSeq = send("attach", validAttachJson())
                waitForEvent(events, "initialized")
                withTimeout(5_000.milliseconds) { attachSuspended.await() }

                val cancelResp = awaitResponse(send("cancel", buildJsonObject { put("requestId", attachSeq) }))
                assertTrue(cancelResp["success"]!!.jsonPrimitive.boolean)
                assertEquals(0, delegate.cancelCalls.size)

                val attachResp = awaitResponse(attachSeq)
                assertFalse(attachResp["success"]!!.jsonPrimitive.boolean)
                assertTrue(attachResp["message"]!!.jsonPrimitive.content.startsWith("[cancelled]"))
                assertEquals(listOf(false), handle.closeCalls)

                val progressEnd = waitForEvent(events, "progressEnd")
                assertEquals(
                    AndroidDapSession.PROGRESS_ID,
                    progressEnd["body"]!!.jsonObject["progressId"]!!.jsonPrimitive.content
                )
                assertEquals("cancelled", progressEnd["body"]!!.jsonObject["message"]!!.jsonPrimitive.content)
                assertEquals(1, events.count { it["event"]?.jsonPrimitive?.content == "progressStart" })
                assertEquals(1, events.count { it["event"]?.jsonPrimitive?.content == "progressEnd" })

                val progressNames = events
                    .mapNotNull { it["event"]?.jsonPrimitive?.content }
                    .filter { it == "progressStart" || it == "progressUpdate" || it == "progressEnd" }
                assertEquals("progressStart", progressNames.first())
                assertEquals("progressEnd", progressNames.last())
            }
        }

    @Test
    fun testLateOnStageCallbackAfterCancellationCannotEmitProgressUpdateAfterProgressEnd() = runBlocking {
        val stageCallback = CompletableDeferred<(AndroidRunStage) -> Unit>()
        val backend = FakeAndroidRunBackend(
            launchBehavior = { _, _, onStage, _ ->
                onStage(AndroidRunStage.INSTALLING)
                stageCallback.complete(onStage)
                delay(30_000.milliseconds)
                error("unreachable")
            }
        )
        val delegate = RecordingNativeDapServer()
        val events = CopyOnWriteArrayList<JsonObject>()
        runWithChannels(delegate, backend, onEvent = { events.add(it) }) { send, awaitResponse ->
            assertTrue(
                awaitResponse(
                    send("initialize", defaultInitArgs(supportsProgress = true))
                )["success"]!!.jsonPrimitive.boolean
            )

            val launchSeq = send("launch", validInstalledLaunchJson(noDebug = false))
            val capturedOnStage = withTimeout(5_000.milliseconds) { stageCallback.await() }
            waitForEvent(events, "progressUpdate")

            val cancelResp = awaitResponse(
                send("cancel", buildJsonObject { put("progressId", AndroidDapSession.PROGRESS_ID) })
            )
            assertTrue(cancelResp["success"]!!.jsonPrimitive.boolean)

            val launchResp = awaitResponse(launchSeq)
            assertFalse(launchResp["success"]!!.jsonPrimitive.boolean)
            assertTrue(launchResp["message"]!!.jsonPrimitive.content.startsWith("[cancelled]"))

            waitForEvent(events, "progressEnd")
            capturedOnStage(AndroidRunStage.STARTING)

            val discResp = awaitResponse(send("disconnect", buildJsonObject { put("terminateDebuggee", false) }))
            assertTrue(discResp["success"]!!.jsonPrimitive.boolean)
            waitForEvent(events, "terminated")

            val progressNames = events
                .mapNotNull { it["event"]?.jsonPrimitive?.content }
                .filter { it == "progressStart" || it == "progressUpdate" || it == "progressEnd" }
            assertEquals(1, progressNames.count { it == "progressStart" })
            assertEquals(1, progressNames.count { it == "progressEnd" })
            assertEquals("progressEnd", progressNames.last())
            assertFalse(
                events.any {
                    it["event"]?.jsonPrimitive?.content == "progressUpdate" &&
                            it["body"]?.jsonObject?.get("message")?.jsonPrimitive?.content == "starting"
                }
            )
        }
    }

    @Test
    fun testStartupTimeoutCleansUpAndReportsCancelled() = runBlocking {
        val deploymentCleaned = AtomicInteger(0)
        val backend = FakeAndroidRunBackend(
            launchBehavior = { _, _, onStage, _ ->
                onStage(AndroidRunStage.BUILDING)
                try {
                    delay(10_000.milliseconds)
                    error("unreachable")
                } finally {
                    withContext(NonCancellable) {
                        deploymentCleaned.incrementAndGet()
                    }
                }
            }
        )
        val delegate = RecordingNativeDapServer()
        runWithChannels(delegate, backend) { send, awaitResponse ->
            assertTrue(awaitResponse(send("initialize", defaultInitArgs()))["success"]!!.jsonPrimitive.boolean)
            val launchResp = awaitResponse(
                send(
                    "launch",
                    validInstalledLaunchJson(noDebug = false, timeoutMs = 80)
                )
            )
            assertFalse(launchResp["success"]!!.jsonPrimitive.boolean)
            assertTrue(launchResp["message"]!!.jsonPrimitive.content.startsWith("[cancelled]"))
            assertEquals(1, deploymentCleaned.get())
        }
    }

    @Test
    fun testNoDebugWhitelistCapabilitiesEarlyBreakpointsConfigAndExitObservation() = runBlocking {
        val handle = FakeAndroidRunHandle(
            pid = 8888,
            deviceId = "emulator-5580",
            userId = 0,
            packageName = "com.example.ompattachfixture",
            processName = "com.example.ompattachfixture",
            port = null,
            isApplication = true,
        )
        val launchGate = CompletableDeferred<Unit>()
        val backend = FakeAndroidRunBackend(
            launchBehavior = { cfg, _, onStage, _ ->
                assertTrue(cfg.noDebug)
                onStage(AndroidRunStage.INSTALLING)
                onStage(AndroidRunStage.STARTING)
                launchGate.await()
                handle
            }
        )
        val delegate = RecordingNativeDapServer()
        val events = CopyOnWriteArrayList<JsonObject>()
        runWithChannels(delegate, backend, onEvent = { events.add(it) }) { send, awaitResponse ->
            assertTrue(
                awaitResponse(
                    send(
                        "initialize",
                        buildJsonObject {
                            put("clientID", "test-client")
                            put("adapterID", "android")
                            put("linesStartAt1", false)
                            put("columnsStartAt1", false)
                            put("pathFormat", "uri")
                        }
                    )
                )["success"]!!.jsonPrimitive.boolean
            )

            val launchSeq = send("launch", validInstalledLaunchJson(noDebug = true))

            // Early breakpoint before initialized must succeed with unverified client 0-based coords and URI pathFormat.
            val earlyBpResp = awaitResponse(
                send(
                    "setBreakpoints",
                    buildJsonObject {
                        put("source", buildJsonObject { put("path", testSourceFile.toUri().toString()) })
                        put(
                            "breakpoints",
                            JsonArray(
                                listOf(
                                    buildJsonObject {
                                        put("line", 0)
                                        put("column", 4)
                                    }
                                )
                            )
                        )
                    }
                )
            )
            assertTrue(earlyBpResp["success"]!!.jsonPrimitive.boolean)
            val earlyBp = earlyBpResp["body"]!!.jsonObject["breakpoints"]!!.jsonArray.single().jsonObject
            assertEquals(false, earlyBp["verified"]!!.jsonPrimitive.boolean)
            assertEquals(0, earlyBp["line"]!!.jsonPrimitive.int)
            assertEquals(4, earlyBp["column"]!!.jsonPrimitive.int)
            assertEquals(
                testSourceFile.toUri().toString(),
                earlyBp["source"]!!.jsonObject["path"]!!.jsonPrimitive.content
            )
            assertTrue(earlyBp["message"]!!.jsonPrimitive.content.contains("noDebug"))

            // Early disallowed debug call must be rejected without touching unattached native.
            val earlyThreads = awaitResponse(send("threads", JsonObject(emptyMap())))
            assertFalse(earlyThreads["success"]!!.jsonPrimitive.boolean)
            assertTrue(earlyThreads["message"]!!.jsonPrimitive.content.startsWith("[invalid_params]"))
            assertEquals(0, delegate.threadsCalls)

            launchGate.complete(Unit)

            // Capabilities event disabling debug flags must arrive BEFORE initialized.
            waitForEvent(events, "initialized")
            val capIdx = events.indexOfLast { it["event"]?.jsonPrimitive?.content == "capabilities" }
            val initIdx = events.indexOfFirst { it["event"]?.jsonPrimitive?.content == "initialized" }
            assertTrue("capabilities event must precede initialized", capIdx in 0 until initIdx)
            val capObj = events[capIdx]["body"]!!.jsonObject["capabilities"]!!.jsonObject
            assertEquals(false, capObj["supportsFunctionBreakpoints"]!!.jsonPrimitive.boolean)
            assertEquals(false, capObj["supportsDataBreakpoints"]!!.jsonPrimitive.boolean)
            assertEquals(false, capObj["supportsInstructionBreakpoints"]!!.jsonPrimitive.boolean)
            assertEquals(false, capObj["supportsStepBack"]!!.jsonPrimitive.boolean)
            assertEquals(false, capObj["supportsSetVariable"]!!.jsonPrimitive.boolean)
            assertEquals(true, capObj["supportTerminateDebuggee"]!!.jsonPrimitive.boolean)

            // Whitelisted config requests work in noDebug without calling native.
            assertTrue(
                awaitResponse(
                    send(
                        "setFunctionBreakpoints",
                        buildJsonObject { put("breakpoints", JsonArray(emptyList())) })
                )["success"]!!.jsonPrimitive.boolean
            )
            assertTrue(
                awaitResponse(
                    send(
                        "setDataBreakpoints",
                        buildJsonObject { put("breakpoints", JsonArray(emptyList())) })
                )["success"]!!.jsonPrimitive.boolean
            )
            assertTrue(
                awaitResponse(
                    send(
                        "setExceptionBreakpoints",
                        buildJsonObject { put("filters", JsonArray(emptyList())) })
                )["success"]!!.jsonPrimitive.boolean
            )
            assertTrue(
                awaitResponse(
                    send(
                        "setInstructionBreakpoints",
                        buildJsonObject { put("breakpoints", JsonArray(emptyList())) })
                )["success"]!!.jsonPrimitive.boolean
            )

            assertTrue(
                awaitResponse(
                    send(
                        "configurationDone",
                        JsonObject(emptyMap())
                    )
                )["success"]!!.jsonPrimitive.boolean
            )
            assertTrue(awaitResponse(launchSeq)["success"]!!.jsonPrimitive.boolean)
            assertEquals(0, delegate.attachCalls)
            assertEquals(1, events.count { it["event"]?.jsonPrimitive?.content == "initialized" })
            val procEvent = waitForEvent(events, "process")
            assertEquals(8888, procEvent["body"]!!.jsonObject["systemProcessId"]!!.jsonPrimitive.int)

            // Simulate natural process exit with null exitCode: no fake exited(0), terminated emitted once.
            handle.completeExit(AndroidProcessExit(exitCode = null, deviceOffline = false, reason = "process_exited"))
            waitForEvent(events, "terminated")
            assertEquals(0, events.count { it["event"]?.jsonPrimitive?.content == "exited" })
            assertEquals(1, events.count { it["event"]?.jsonPrimitive?.content == "terminated" })
        }
    }

    @Test
    fun testNoDebugExplicitlyRejectsAll33DisallowedMethodsWithoutNativeFallthrough() = runBlocking {
        val handle = FakeAndroidRunHandle(
            pid = 8899,
            deviceId = "emulator-5580",
            userId = 0,
            packageName = "com.example.ompattachfixture",
            processName = "com.example.ompattachfixture",
            port = null,
            isApplication = true,
        )
        val initializedReceived = CompletableDeferred<Unit>()
        val client = Proxy.newProxyInstance(
            DapClient::class.java.classLoader,
            arrayOf(DapClient::class.java)
        ) { _, method, _ ->
            if (method.name == "initialized") {
                initializedReceived.complete(Unit)
            }
            null
        } as DapClient
        val backend = FakeAndroidRunBackend(launchBehavior = { _, _, _, _ -> handle })
        val native = RecordingNativeDapServer()
        val session = AndroidDapSession(
            projectDirectory = testProjectDir,
            scope = this,
            backend = backend,
            nativeStoppedSignal = CompletableDeferred(Unit),
            downstreamClient = client,
            nativeFactory = { native },
        )
        session.initialize(InitializeRequestArguments(adapterID = "android"))
        val launchJob = launch {
            session.launch(
                LaunchRequestArguments(
                    noDebug = true,
                    adapterArguments = buildJsonObject {
                        put("android", validInstalledLaunchJson(noDebug = true)["android"]!!)
                    },
                )
            )
        }
        withTimeout(5_000.milliseconds) { initializedReceived.await() }
        session.configurationDone(ConfigurationDoneArguments())
        launchJob.join()
        val source = Source(path = testSourceFile.toString())
        val threadId = ThreadId(1)
        val frameId = FrameId(1)
        val varsRef = VariablesReference(1)

        val deniedCalls: List<Pair<String, suspend () -> Unit>> = listOf(
            "attach" to { session.attach(AttachRequestArguments()) },
            "restart" to { session.restart(RestartArguments()) },
            "breakpointLocations" to {
                session.breakpointLocations(
                    BreakpointLocationsArguments(
                        source = source,
                        line = DapLine(1)
                    )
                )
            },
            "dataBreakpointInfo" to {
                session.dataBreakpointInfo(
                    DataBreakpointInfoArguments(
                        variablesReference = varsRef,
                        name = "x"
                    )
                )
            },
            "threads" to { session.threads() },
            "stackTrace" to { session.stackTrace(StackTraceArguments(threadId = threadId)) },
            "scopes" to { session.scopes(ScopesArguments(frameId = frameId)) },
            "variables" to { session.variables(VariablesArguments(variablesReference = varsRef)) },
            "continue" to { session.continueExecution(ContinueArguments(threadId = threadId)) },
            "next" to { session.next(NextArguments(threadId = threadId)) },
            "stepIn" to { session.stepIn(StepInArguments(threadId = threadId)) },
            "stepOut" to { session.stepOut(StepOutArguments(threadId = threadId)) },
            "pause" to { session.pause(PauseArguments(threadId = threadId)) },
            "stepBack" to { session.stepBack(StepBackArguments(threadId = threadId)) },
            "reverseContinue" to { session.reverseContinue(ReverseContinueArguments(threadId = threadId)) },
            "goto" to { session.goto(GotoArguments(threadId = threadId, targetId = GotoTargetId(1))) },
            "restartFrame" to { session.restartFrame(RestartFrameArguments(frameId = frameId)) },
            "terminateThreads" to { session.terminateThreads(TerminateThreadsArguments()) },
            "setVariable" to {
                session.setVariable(
                    SetVariableArguments(
                        variablesReference = varsRef,
                        name = "x",
                        value = "1"
                    )
                )
            },
            "evaluate" to { session.evaluate(EvaluateArguments(expression = "1+1")) },
            "setExpression" to { session.setExpression(SetExpressionArguments(expression = "x", value = "1")) },
            "source" to { session.source(SourceArguments(source = source, sourceReference = SourceReference(0))) },
            "loadedSources" to { session.loadedSources(LoadedSourcesArguments()) },
            "gotoTargets" to { session.gotoTargets(GotoTargetsArguments(source = source, line = DapLine(1))) },
            "stepInTargets" to { session.stepInTargets(StepInTargetsArguments(frameId = frameId)) },
            "readMemory" to { session.readMemory(ReadMemoryArguments(memoryReference = "0x0", count = 4)) },
            "locations" to { session.locations(LocationsArguments(memoryReference = "loc")) },
            "writeMemory" to { session.writeMemory(WriteMemoryArguments(memoryReference = "0x0", data = "AA==")) },
            "disassemble" to {
                session.disassemble(
                    DisassembleArguments(
                        memoryReference = "0x0",
                        instructionCount = 1
                    )
                )
            },
            "modules" to { session.modules(ModulesArguments()) },
            "completions" to { session.completions(CompletionsArguments(text = "a", column = DapColumn(1))) },
            "exceptionInfo" to { session.exceptionInfo(ExceptionInfoArguments(threadId = threadId)) },
            "threadDump" to { session.threadDump(ThreadDumpArguments()) },
        )
        assertEquals(33, deniedCalls.size)

        for ((name, call) in deniedCalls) {
            try {
                call()
                fail("Expected rejection for $name in noDebug mode")
            } catch (ex: DapRequestFailedException) {
                assertTrue(
                    "Expected [invalid_params] for $name, got ${ex.message}",
                    ex.message.startsWith("[invalid_params]")
                )
            }
        }
        assertEquals(0, native.unexpectedCalls.get())
        session.disconnect(DisconnectArguments(terminateDebuggee = true))
    }

    @Test
    fun testEventFilterSuppressesExitedAndDoesNotRecurseOnNativeTerminated() = runBlocking {
        val handle = FakeAndroidRunHandle(
            pid = 5555,
            deviceId = "emulator-5580",
            userId = 0,
            packageName = "com.example.ompattachfixture",
            processName = "com.example.ompattachfixture",
            port = 50558,
            isApplication = true,
        )
        val backend = FakeAndroidRunBackend(launchBehavior = { _, _, _, _ -> handle })
        val delegate = RecordingNativeDapServer()
        val events = CopyOnWriteArrayList<JsonObject>()

        runWithChannels(delegate, backend, onEvent = { events.add(it) }) { send, awaitResponse ->
            assertTrue(awaitResponse(send("initialize", defaultInitArgs()))["success"]!!.jsonPrimitive.boolean)
            val launchSeq = send("launch", validInstalledLaunchJson(noDebug = false))
            waitForEvent(events, "initialized")
            assertTrue(
                awaitResponse(
                    send(
                        "configurationDone",
                        JsonObject(emptyMap())
                    )
                )["success"]!!.jsonPrimitive.boolean
            )
            assertTrue(awaitResponse(launchSeq)["success"]!!.jsonPrimitive.boolean)

            // Native emits synthetic exited(0) and terminated from callback -> exited must be suppressed,
            // terminated must NOT recursively call native.disconnect, and handle must close before terminated forwards.
            delegate.client?.exited(ExitedEventArguments(exitCode = 0))
            delegate.client?.terminated(TerminatedEventArguments())

            waitForEvent(events, "terminated")
            assertEquals(0, events.count { it["event"]?.jsonPrimitive?.content == "exited" })
            assertEquals(1, events.count { it["event"]?.jsonPrimitive?.content == "terminated" })
            assertEquals(0, delegate.disconnectCalls.size)
            assertEquals(listOf(false), handle.closeCalls)
        }
    }

    @Test
    fun testDeviceOfflineEmitsBoundedOutputAndExitsWithoutFakeExit0() = runBlocking {
        val handle = FakeAndroidRunHandle(
            pid = 6666,
            deviceId = "emulator-5580",
            userId = 0,
            packageName = "com.example.ompattachfixture",
            processName = "com.example.ompattachfixture",
            port = null,
            isApplication = true,
        )
        val backend = FakeAndroidRunBackend(launchBehavior = { _, _, _, _ -> handle })
        val delegate = RecordingNativeDapServer()
        val events = CopyOnWriteArrayList<JsonObject>()

        runWithChannels(delegate, backend, onEvent = { events.add(it) }) { send, awaitResponse ->
            assertTrue(awaitResponse(send("initialize", defaultInitArgs()))["success"]!!.jsonPrimitive.boolean)
            val launchSeq = send("launch", validInstalledLaunchJson(noDebug = true))
            waitForEvent(events, "initialized")
            assertTrue(
                awaitResponse(
                    send(
                        "configurationDone",
                        JsonObject(emptyMap())
                    )
                )["success"]!!.jsonPrimitive.boolean
            )
            assertTrue(awaitResponse(launchSeq)["success"]!!.jsonPrimitive.boolean)

            handle.completeExit(AndroidProcessExit(exitCode = null, deviceOffline = true, reason = "device_offline"))
            waitForEvent(events, "terminated")
            assertEquals(0, events.count { it["event"]?.jsonPrimitive?.content == "exited" })
            assertTrue(
                events.any {
                    it["event"]?.jsonPrimitive?.content == "output" &&
                            it["body"]!!.jsonObject["output"]!!.jsonPrimitive.content.contains("offline")
                }
            )
            assertEquals(listOf(false), handle.closeCalls)
        }
    }

    @Test
    fun testSourceUriConversionAcrossAllRequestsResponsesAndEventsViaChannels() = runBlocking {
        val handle = FakeAndroidRunHandle(
            pid = 7070,
            deviceId = "emulator-5580",
            userId = 0,
            packageName = "com.example.ompattachfixture",
            processName = "com.example.ompattachfixture",
            port = 50707,
            isApplication = true,
        )
        val backend = FakeAndroidRunBackend(launchBehavior = { _, _, _, _ -> handle })
        val delegate = RecordingNativeDapServer(localSourcePath = testSourceFile.toString())
        val events = CopyOnWriteArrayList<JsonObject>()
        val sourceUri = testSourceFile.toUri().toString()

        runWithChannels(delegate, backend, onEvent = { events.add(it) }) { send, awaitResponse ->
            assertTrue(
                awaitResponse(
                    send(
                        "initialize",
                        buildJsonObject {
                            put("clientID", "uri-client")
                            put("adapterID", "android")
                            put("linesStartAt1", true)
                            put("columnsStartAt1", true)
                            put("pathFormat", "uri")
                        }
                    )
                )["success"]!!.jsonPrimitive.boolean
            )

            val launchSeq = send("launch", validInstalledLaunchJson(noDebug = false))
            waitForEvent(events, "initialized")

            val bpResp = awaitResponse(
                send(
                    "setBreakpoints",
                    buildJsonObject {
                        put(
                            "source",
                            buildJsonObject {
                                put("path", sourceUri)
                                put("adapterData", "keep-me")
                            }
                        )
                        put("breakpoints", JsonArray(listOf(buildJsonObject { put("line", 13) })))
                    }
                )
            )
            assertTrue(bpResp["success"]!!.jsonPrimitive.boolean)
            assertEquals(testSourceFile.toString(), delegate.lastSetBreakpointsSource?.path)
            assertEquals(JsonPrimitive("keep-me"), delegate.lastSetBreakpointsSource?.adapterData)
            val respBpSource =
                bpResp["body"]!!.jsonObject["breakpoints"]!!.jsonArray.single().jsonObject["source"]!!.jsonObject
            assertEquals(sourceUri, respBpSource["path"]!!.jsonPrimitive.content)
            assertEquals(JsonPrimitive("keep-me"), respBpSource["adapterData"])

            assertTrue(
                awaitResponse(
                    send(
                        "configurationDone",
                        JsonObject(emptyMap())
                    )
                )["success"]!!.jsonPrimitive.boolean
            )
            assertTrue(awaitResponse(launchSeq)["success"]!!.jsonPrimitive.boolean)

            // Unsupported scheme rejected on inbound requests.
            val badBp = awaitResponse(
                send(
                    "setBreakpoints",
                    buildJsonObject {
                        put("source", buildJsonObject { put("path", "http://example.com/Main.java") })
                    }
                )
            )
            assertFalse(badBp["success"]!!.jsonPrimitive.boolean)
            assertTrue(badBp["message"]!!.jsonPrimitive.content.startsWith("[invalid_params]"))

            val bpLoc = awaitResponse(
                send(
                    "breakpointLocations",
                    buildJsonObject {
                        put("source", buildJsonObject { put("path", sourceUri) })
                        put("line", 13)
                    }
                )
            )
            assertTrue(bpLoc["success"]!!.jsonPrimitive.boolean)
            assertEquals(testSourceFile.toString(), delegate.lastBreakpointLocationsSource?.path)

            val srcResp = awaitResponse(
                send(
                    "source",
                    buildJsonObject {
                        put("source", buildJsonObject { put("path", sourceUri) })
                        put("sourceReference", 0)
                    }
                )
            )
            assertTrue(srcResp["success"]!!.jsonPrimitive.boolean)
            assertEquals(testSourceFile.toString(), delegate.lastSourceArgsSource?.path)

            val gotoResp = awaitResponse(
                send(
                    "gotoTargets",
                    buildJsonObject {
                        put("source", buildJsonObject { put("path", sourceUri) })
                        put("line", 13)
                    }
                )
            )
            assertTrue(gotoResp["success"]!!.jsonPrimitive.boolean)
            assertEquals(testSourceFile.toString(), delegate.lastGotoTargetsSource?.path)

            // Outbound responses convert local path -> file:/// URI and preserve virtual sourceReference + adapterData.
            val stackResp = awaitResponse(send("stackTrace", buildJsonObject { put("threadId", 1) }))
            val frames = stackResp["body"]!!.jsonObject["stackFrames"]!!.jsonArray
            assertEquals(sourceUri, frames[0].jsonObject["source"]!!.jsonObject["path"]!!.jsonPrimitive.content)
            assertEquals(99, frames[1].jsonObject["source"]!!.jsonObject["sourceReference"]!!.jsonPrimitive.int)
            assertNull(frames[1].jsonObject["source"]!!.jsonObject["path"])

            val scopesResp = awaitResponse(send("scopes", buildJsonObject { put("frameId", 1) }))
            assertEquals(
                sourceUri,
                scopesResp["body"]!!.jsonObject["scopes"]!!.jsonArray.single().jsonObject["source"]!!.jsonObject["path"]!!.jsonPrimitive.content
            )

            val loadedResp = awaitResponse(send("loadedSources", JsonObject(emptyMap())))
            assertEquals(
                sourceUri,
                loadedResp["body"]!!.jsonObject["sources"]!!.jsonArray.single().jsonObject["path"]!!.jsonPrimitive.content
            )

            val locResp = awaitResponse(send("locations", buildJsonObject { put("memoryReference", "loc1") }))
            assertEquals(sourceUri, locResp["body"]!!.jsonObject["source"]!!.jsonObject["path"]!!.jsonPrimitive.content)

            val disasmResp = awaitResponse(
                send(
                    "disassemble",
                    buildJsonObject {
                        put("memoryReference", "0x10")
                        put("instructionCount", 1)
                    }
                )
            )
            assertEquals(
                sourceUri,
                disasmResp["body"]!!.jsonObject["instructions"]!!.jsonArray.single().jsonObject["location"]!!.jsonObject["path"]!!.jsonPrimitive.content
            )

            // Outbound events convert Source path -> URI.
            delegate.client?.output(
                OutputEventArguments(
                    category = OutputCategory.Console,
                    output = "hi\n",
                    source = Source(path = testSourceFile.toString())
                )
            )
            delegate.client?.breakpoint(
                BreakpointEventArguments(
                    reason = BreakpointEventReason.Changed,
                    breakpoint = Breakpoint(verified = true, source = Source(path = testSourceFile.toString()))
                )
            )
            delegate.client?.loadedSource(
                LoadedSourceEventArguments(
                    reason = LoadedSourceEventReason.New,
                    source = Source(path = testSourceFile.toString())
                )
            )

            val outEv = waitForEvent(events, "output")
            assertEquals(sourceUri, outEv["body"]!!.jsonObject["source"]!!.jsonObject["path"]!!.jsonPrimitive.content)
            val bpEv = waitForEvent(events, "breakpoint")
            assertEquals(
                sourceUri,
                bpEv["body"]!!.jsonObject["breakpoint"]!!.jsonObject["source"]!!.jsonObject["path"]!!.jsonPrimitive.content
            )
            val loadedEv = waitForEvent(events, "loadedSource")
            assertEquals(
                sourceUri,
                loadedEv["body"]!!.jsonObject["source"]!!.jsonObject["path"]!!.jsonPrimitive.content
            )

            assertTrue(
                awaitResponse(
                    send(
                        "disconnect",
                        buildJsonObject { put("terminateDebuggee", false) })
                )["success"]!!.jsonPrimitive.boolean
            )
        }
    }

    @Test
    fun testCleanupErrorDuringFailedStartupPreservesOriginalError() = runBlocking {
        val handle = FakeAndroidRunHandle(
            pid = 9999,
            deviceId = "emulator-5580",
            userId = 0,
            packageName = "com.example.ompattachfixture",
            processName = "com.example.ompattachfixture",
            port = 50999,
            isApplication = true,
            closeFailure = IllegalStateException("adb stop failed"),
        )
        val backend = FakeAndroidRunBackend(launchBehavior = { _, _, _, _ -> handle })
        val delegate = RecordingNativeDapServer(
            attachHook = { _, _ ->
                throw AndroidRunException(
                    AndroidRunError(
                        code = AndroidRunErrorCode.START_FAILED,
                        stage = AndroidRunStage.ATTACHING,
                        detail = "JDWP handshake refused",
                        device = "emulator-5580",
                    )
                )
            }
        )
        runWithChannels(delegate, backend) { send, awaitResponse ->
            assertTrue(awaitResponse(send("initialize", defaultInitArgs()))["success"]!!.jsonPrimitive.boolean)
            val launchResp = awaitResponse(send("launch", validInstalledLaunchJson(noDebug = false)))
            assertFalse(launchResp["success"]!!.jsonPrimitive.boolean)
            val message = launchResp["message"]!!.jsonPrimitive.content
            assertTrue(message.contains("[start_failed] attaching: JDWP handshake refused"))
            assertTrue(message.contains("adb stop failed"))
        }
    }

    @Test
    fun testDisconnectWaitsForNativeTeardownBeforeReleasingJdwpHandle() = runBlocking {
        val nativeStopped = CompletableDeferred<Unit>()
        val handle = FakeAndroidRunHandle(
            pid = 1234,
            deviceId = "emulator-5580",
            userId = 0,
            packageName = "com.example.ompattachfixture",
            processName = "com.example.ompattachfixture:worker",
            port = 50999,
            isApplication = false,
        )
        val session = AndroidDapSession(
            native = RecordingNativeDapServer(attachHook = { _, _ -> }),
            client = noOpDapClient(),
            projectDirectory = testProjectDir,
            scope = this,
            nativeStoppedSignal = nativeStopped,
            backend = FakeAndroidRunBackend(attachBehavior = { _, _, _, _ -> handle }),
        )
        try {
            session.initialize(InitializeRequestArguments(adapterID = "android"))
            session.attach(AttachRequestArguments(adapterArguments = validAttachJson()))
            val disconnect = launch(start = kotlinx.coroutines.CoroutineStart.UNDISPATCHED) {
                session.disconnect(DisconnectArguments(terminateDebuggee = false))
            }
            assertFalse("Disconnect must wait while native VM teardown is pending", disconnect.isCompleted)
            assertTrue("JDWP must remain available for native resume/dispose", handle.closeCalls.isEmpty())

            nativeStopped.complete(Unit)
            disconnect.join()
            assertEquals(listOf(false), handle.closeCalls)
        } finally {
            nativeStopped.complete(Unit)
            session.closeAndCleanupOnConnectionClose()
        }
    }


    private suspend fun runWithChannels(
        delegate: RecordingNativeDapServer,
        backend: FakeAndroidRunBackend = FakeAndroidRunBackend(),
        onEvent: (JsonObject) -> Unit = {},
        block: suspend (
            send: suspend (command: String, arguments: JsonObject) -> Int,
            awaitResponse: suspend (seq: Int) -> JsonObject
        ) -> Unit
    ) = coroutineScope {
        val incoming = Channel<JsonElement>(Channel.UNLIMITED)
        val outgoing = Channel<JsonElement>(Channel.UNLIMITED)
        val responses = Channel<JsonObject>(Channel.UNLIMITED)
        val stashedResponses = ArrayDeque<JsonObject>()
        var nextSeq = 0

        val serverJob = launch(Dispatchers.IO) {
            runDapServerOverChannels(incoming, outgoing, null) { scope, client, stopped ->
                AndroidDapSession(
                    projectDirectory = testProjectDir,
                    scope = scope,
                    serverStoppedSignal = stopped,
                    nativeStoppedSignal = CompletableDeferred(Unit),
                    backend = backend,
                    downstreamClient = client,
                    nativeFactory = { filteredClient ->
                        delegate.client = filteredClient
                        delegate
                    },
                )
            }
        }

        val collectorJob = launch(Dispatchers.IO) {
            for (element in outgoing) {
                val obj = element as? JsonObject ?: continue
                when (obj["type"]?.jsonPrimitive?.content) {
                    "response" -> responses.send(obj)
                    "event" -> onEvent(obj)
                }
            }
        }

        val send: suspend (String, JsonObject) -> Int = { command, arguments ->
            val seq = ++nextSeq
            incoming.send(
                buildJsonObject {
                    put("seq", seq)
                    put("type", "request")
                    put("command", command)
                    put("arguments", arguments)
                }
            )
            seq
        }

        val awaitResponse: suspend (Int) -> JsonObject = { targetSeq ->
            withTimeout(10_000.milliseconds) {
                val idx = stashedResponses.indexOfFirst { it["request_seq"]?.jsonPrimitive?.int == targetSeq }
                if (idx >= 0) {
                    stashedResponses.removeAt(idx)
                } else {
                    while (true) {
                        val next = responses.receive()
                        if (next["request_seq"]?.jsonPrimitive?.int == targetSeq) {
                            return@withTimeout next
                        }
                        stashedResponses.addLast(next)
                    }
                    @Suppress("UNREACHABLE_CODE")
                    error("unreachable")
                }
            }
        }

        try {
            block(send, awaitResponse)
        } finally {
            incoming.close()
            withTimeout(5_000.milliseconds) {
                serverJob.join()
                outgoing.close()
                collectorJob.join()
            }
        }
    }

    private suspend fun waitForEvent(events: CopyOnWriteArrayList<JsonObject>, eventName: String): JsonObject {
        return withTimeout(5_000.milliseconds) {
            while (true) {
                val found = events.firstOrNull { it["event"]?.jsonPrimitive?.content == eventName }
                if (found != null) return@withTimeout found
                delay(15.milliseconds)
            }
            @Suppress("UNREACHABLE_CODE")
            error("unreachable")
        }
    }

    private fun defaultInitArgs(supportsProgress: Boolean = false): JsonObject = buildJsonObject {
        put("clientID", "test-client")
        put("adapterID", "android")
        put("linesStartAt1", true)
        put("columnsStartAt1", true)
        put("pathFormat", "path")
        put("supportsProgressReporting", supportsProgress)
    }

    private fun validInstalledLaunchJson(
        noDebug: Boolean,
        timeoutMs: Int? = null,
    ): JsonObject = buildJsonObject {
        put("noDebug", noDebug)
        put(
            "android",
            buildJsonObject {
                put("deviceId", "emulator-5580")
                put(
                    "target",
                    buildJsonObject {
                        put("kind", "installed")
                        put("packageName", "com.example.ompattachfixture")
                    }
                )
                if (timeoutMs != null) {
                    put("timeoutMs", timeoutMs)
                }
            }
        )
    }

    private fun validAttachJson(): JsonObject = buildJsonObject {
        put(
            "android",
            buildJsonObject {
                put("deviceId", "emulator-5580")
                put("packageName", "com.example.ompattachfixture")
            }
        )
    }

    private fun noOpDapClient(): DapClient = Proxy.newProxyInstance(
        DapClient::class.java.classLoader,
        arrayOf(DapClient::class.java)
    ) { _, _, _ -> null } as DapClient

    private class FakeAndroidRunHandle(
        override val pid: Int,
        override val deviceId: String,
        override val userId: Int,
        override val packageName: String,
        override val processName: String,
        override val port: Int?,
        override val isApplication: Boolean,
        private val closeFailure: Throwable? = null,
    ) : AndroidRunHandle {
        val closeCalls = CopyOnWriteArrayList<Boolean>()
        var exitCallsCount = 0
        private val exitDeferred = CompletableDeferred<AndroidProcessExit>()

        override suspend fun close(terminateApplication: Boolean) {
            closeCalls.add(terminateApplication)
            exitDeferred.complete(AndroidProcessExit(exitCode = null, deviceOffline = false, reason = "closed"))
            if (closeFailure != null) {
                throw closeFailure
            }
            if (!isApplication && terminateApplication) {
                throw AndroidRunException(
                    AndroidRunError(
                        code = AndroidRunErrorCode.INVALID_PARAMS,
                        stage = AndroidRunStage.CLEANUP,
                        detail = AndroidDapSession.EXTERNAL_ATTACH_STOP_DENIED_MESSAGE,
                        device = deviceId,
                    )
                )
            }
        }

        override suspend fun awaitExit(): AndroidProcessExit {
            exitCallsCount++
            return exitDeferred.await()
        }

        fun completeExit(exit: AndroidProcessExit) {
            exitDeferred.complete(exit)
        }
    }

    private class FakeAndroidRunBackend(
        private val launchBehavior: suspend (
            AndroidLaunchConfig,
            kotlinx.coroutines.CoroutineScope,
            (AndroidRunStage) -> Unit,
            (String) -> Unit,
        ) -> AndroidRunHandle = { cfg, _, _, _ ->
            FakeAndroidRunHandle(
                pid = 1000,
                deviceId = cfg.deviceId,
                userId = cfg.userId ?: 0,
                packageName = "com.example.ompattachfixture",
                processName = "com.example.ompattachfixture",
                port = if (cfg.noDebug) null else 50100,
                isApplication = true,
            )
        },
        private val attachBehavior: suspend (
            AndroidAttachConfig,
            kotlinx.coroutines.CoroutineScope,
            (AndroidRunStage) -> Unit,
            (String) -> Unit,
        ) -> AndroidRunHandle = { cfg, _, _, _ ->
            FakeAndroidRunHandle(
                pid = 2000,
                deviceId = cfg.deviceId,
                userId = cfg.userId ?: 0,
                packageName = cfg.packageName,
                processName = cfg.packageName,
                port = 50200,
                isApplication = false,
            )
        },
    ) : AndroidRunBackend {
        val launchCalls = AtomicInteger(0)
        val attachCalls = AtomicInteger(0)

        override suspend fun launch(
            config: AndroidLaunchConfig,
            ownerScope: kotlinx.coroutines.CoroutineScope,
            onStage: (AndroidRunStage) -> Unit,
            onOutput: (String) -> Unit,
        ): AndroidRunHandle {
            launchCalls.incrementAndGet()
            return launchBehavior(config, ownerScope, onStage, onOutput)
        }

        override suspend fun attach(
            config: AndroidAttachConfig,
            ownerScope: kotlinx.coroutines.CoroutineScope,
            onStage: (AndroidRunStage) -> Unit,
            onOutput: (String) -> Unit,
        ): AndroidRunHandle {
            attachCalls.incrementAndGet()
            return attachBehavior(config, ownerScope, onStage, onOutput)
        }
    }

    private class RecordingNativeDapServer(
        private val localSourcePath: String = "F:/tmp/MainActivity.java",
        private val attachHook: (suspend (AttachRequestArguments, DapClient?) -> Unit)? = null,
    ) : DapServer {
        @Volatile
        var client: DapClient? = null
        var lastInitializeArgs: InitializeRequestArguments? = null
        var lastAttachArgs: AttachRequestArguments? = null
        var lastSetBreakpointsSource: Source? = null
        var lastBreakpointLocationsSource: Source? = null
        var lastSourceArgsSource: Source? = null
        var lastGotoTargetsSource: Source? = null
        var launchCalls = 0
        var attachCalls = 0
        var terminateCalls = 0
        var threadsCalls = 0
        val disconnectCalls = CopyOnWriteArrayList<DisconnectArguments>()
        val cancelCalls = CopyOnWriteArrayList<CancelArguments>()
        val unexpectedCalls = AtomicInteger(0)
        private val configDone = CompletableDeferred<Unit>()

        override suspend fun initialize(args: InitializeRequestArguments): Capabilities {
            lastInitializeArgs = args
            return Capabilities(
                supportsConfigurationDoneRequest = true,
                supportsFunctionBreakpoints = true,
                supportsConditionalBreakpoints = true,
                supportsHitConditionalBreakpoints = true,
                supportsEvaluateForHovers = true,
                exceptionBreakpointFilters = listOf(ExceptionBreakpointsFilter(filter = "caught", label = "Caught")),
                supportsStepBack = false,
                supportsSetVariable = true,
                supportsTerminateRequest = true,
                supportsCancelRequest = false,
                supportSuspendDebuggee = true,
                supportTerminateDebuggee = true,
            )
        }

        override suspend fun launch(args: LaunchRequestArguments) {
            launchCalls++
        }

        override suspend fun attach(args: AttachRequestArguments) {
            attachCalls++
            lastAttachArgs = args
            if (attachHook != null) {
                attachHook.invoke(args, client)
                return
            }
            client?.initialized(InitializedEventArguments())
            configDone.await()
        }

        override suspend fun configurationDone(args: ConfigurationDoneArguments) {
            configDone.complete(Unit)
        }

        override suspend fun disconnect(args: DisconnectArguments) {
            disconnectCalls.add(args)
            client?.terminated(TerminatedEventArguments())
        }

        override suspend fun terminate(args: TerminateArguments) {
            terminateCalls++
        }

        override suspend fun cancel(args: CancelArguments) {
            cancelCalls.add(args)
        }

        override suspend fun threads(): ThreadsResponse {
            threadsCalls++
            return ThreadsResponse(emptyList())
        }

        override suspend fun setBreakpoints(args: SetBreakpointsArguments): SetBreakpointsResponse {
            lastSetBreakpointsSource = args.source
            val bps = args.breakpoints.orEmpty().map {
                Breakpoint(verified = true, source = args.source, line = it.line)
            }
            return SetBreakpointsResponse(bps)
        }

        override suspend fun breakpointLocations(args: BreakpointLocationsArguments): BreakpointLocationsResponse {
            lastBreakpointLocationsSource = args.source
            return BreakpointLocationsResponse(emptyList())
        }

        override suspend fun source(args: SourceArguments): SourceResponse {
            lastSourceArgsSource = args.source
            return SourceResponse(content = "class MainActivity {}")
        }

        override suspend fun gotoTargets(args: GotoTargetsArguments): GotoTargetsResponse {
            lastGotoTargetsSource = args.source
            return GotoTargetsResponse(emptyList())
        }

        override suspend fun stackTrace(args: StackTraceArguments): StackTraceResponse {
            return StackTraceResponse(
                stackFrames = listOf(
                    StackFrame(
                        id = FrameId(1),
                        name = "tick",
                        source = Source(name = "MainActivity.java", path = localSourcePath),
                        line = DapLine(13),
                        column = DapColumn(1),
                    ),
                    StackFrame(
                        id = FrameId(2),
                        name = "synthetic",
                        source = Source(name = "Synthetic", path = null, sourceReference = SourceReference(99)),
                        line = DapLine(1),
                        column = DapColumn(1),
                    ),
                )
            )
        }

        override suspend fun scopes(args: ScopesArguments): ScopesResponse {
            return ScopesResponse(
                listOf(
                    Scope(
                        name = "Locals",
                        variablesReference = VariablesReference(1),
                        expensive = false,
                        source = Source(path = localSourcePath),
                    )
                )
            )
        }

        override suspend fun loadedSources(args: LoadedSourcesArguments): LoadedSourcesResponse {
            return LoadedSourcesResponse(listOf(Source(path = localSourcePath)))
        }

        override suspend fun locations(args: LocationsArguments): LocationsResponse {
            return LocationsResponse(source = Source(path = localSourcePath))
        }

        override suspend fun disassemble(args: DisassembleArguments): DisassembleResponse {
            return DisassembleResponse(
                listOf(
                    DisassembledInstruction(
                        address = "0x10",
                        instruction = "nop",
                        location = Source(path = localSourcePath),
                    )
                )
            )
        }

        override suspend fun restart(args: RestartArguments) = unexpected()
        override suspend fun setFunctionBreakpoints(args: SetFunctionBreakpointsArguments): SetFunctionBreakpointsResponse =
            SetFunctionBreakpointsResponse(emptyList())

        override suspend fun setDataBreakpoints(args: SetDataBreakpointsArguments): SetDataBreakpointsResponse =
            SetDataBreakpointsResponse(emptyList())

        override suspend fun setExceptionBreakpoints(args: SetExceptionBreakpointsArguments): SetExceptionBreakpointsResponse =
            SetExceptionBreakpointsResponse(emptyList())

        override suspend fun setInstructionBreakpoints(args: SetInstructionBreakpointsArguments): SetInstructionBreakpointsResponse =
            SetInstructionBreakpointsResponse(emptyList())

        override suspend fun dataBreakpointInfo(args: DataBreakpointInfoArguments): DataBreakpointInfoResponse =
            unexpected()

        override suspend fun variables(args: VariablesArguments): VariablesResponse = unexpected()
        override suspend fun continueExecution(args: ContinueArguments): ContinueResponse = unexpected()
        override suspend fun next(args: NextArguments) = unexpected()
        override suspend fun stepIn(args: StepInArguments) = unexpected()
        override suspend fun stepOut(args: StepOutArguments) = unexpected()
        override suspend fun pause(args: PauseArguments) = unexpected()
        override suspend fun stepBack(args: StepBackArguments) = unexpected()
        override suspend fun reverseContinue(args: ReverseContinueArguments) = unexpected()
        override suspend fun goto(args: GotoArguments) = unexpected()
        override suspend fun restartFrame(args: RestartFrameArguments) = unexpected()
        override suspend fun terminateThreads(args: TerminateThreadsArguments) = unexpected()
        override suspend fun setVariable(args: SetVariableArguments): SetVariableResponse = unexpected()
        override suspend fun evaluate(args: EvaluateArguments): EvaluateResponse = unexpected()
        override suspend fun setExpression(args: SetExpressionArguments): SetExpressionResponse = unexpected()
        override suspend fun stepInTargets(args: StepInTargetsArguments): StepInTargetsResponse = unexpected()
        override suspend fun readMemory(args: ReadMemoryArguments): ReadMemoryResponse = unexpected()
        override suspend fun writeMemory(args: WriteMemoryArguments): WriteMemoryResponse = unexpected()
        override suspend fun modules(args: ModulesArguments): ModulesResponse = unexpected()
        override suspend fun completions(args: CompletionsArguments): CompletionsResponse = unexpected()
        override suspend fun exceptionInfo(args: ExceptionInfoArguments): ExceptionInfoResponse = unexpected()
        override suspend fun threadDump(args: ThreadDumpArguments): ThreadDumpResponse = unexpected()

        private fun unexpected(): Nothing {
            unexpectedCalls.incrementAndGet()
            throw UnsupportedOperationException("Unexpected native DAP call")
        }
    }
}
