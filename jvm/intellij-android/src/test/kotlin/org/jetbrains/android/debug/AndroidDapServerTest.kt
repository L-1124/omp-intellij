package org.jetbrains.android.debug

import com.intellij.debugger.engine.FieldVisibilityProvider
import com.intellij.mock.MockApplication
import com.intellij.openapi.Disposable
import com.intellij.openapi.extensions.ExtensionPoint
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.util.messages.MessageBus
import com.intellij.util.messages.MessageBusConnection
import com.intellij.util.messages.Topic
import com.intellij.xdebugger.XDebuggerManager
import com.jetbrains.dap.protocol.Capabilities
import com.jetbrains.dap.protocol.DapClient
import com.jetbrains.dap.protocol.DapServer
import com.jetbrains.dap.protocol.ExitedEventArguments
import com.jetbrains.dap.protocol.InitializedEventArguments
import com.jetbrains.dap.protocol.InitializeRequestArguments
import com.jetbrains.ls.api.core.DapContext
import com.jetbrains.ls.api.core.LSServer
import com.jetbrains.ls.api.features.LSConfiguration
import com.jetbrains.ls.api.features.language.LSConfigurationPiece
import com.jetbrains.ls.api.features.commands.LSCommandDescriptor
import com.jetbrains.ls.api.features.commands.LSCommandDescriptorProvider
import com.jetbrains.ls.api.features.commands.LSCommandExecutor
import com.jetbrains.lsp.implementation.LspClient
import com.jetbrains.lsp.implementation.LspHandlerContext
import com.jetbrains.lsp.implementation.LspResponseErrorException
import com.jetbrains.lsp.protocol.ErrorCodes
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.Json
import org.jetbrains.android.run.AndroidAttachConfig
import org.jetbrains.android.run.AndroidGradleContext
import org.jetbrains.android.run.AndroidGradleRootContext
import org.jetbrains.android.run.AndroidLaunchConfig
import org.jetbrains.android.run.AndroidProcessExit
import org.jetbrains.android.run.AndroidRunStage
import org.jetbrains.annotations.ApiStatus
import org.junit.After
import org.junit.Before
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.lang.reflect.Proxy
import java.net.ConnectException
import java.net.InetSocketAddress
import java.net.Socket
import java.nio.charset.StandardCharsets
import java.nio.file.Path
import java.util.concurrent.TimeUnit
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlin.coroutines.Continuation

class AndroidDapServerTest {

    private val testProjectDir: Path = Path.of("F:/tmp/android-dap-server-test").toAbsolutePath().normalize()
    private lateinit var applicationDisposable: Disposable

    @ApiStatus.Internal
    @Suppress("UnstableApiUsage")
    @Before
    fun setUpApplication() {
        applicationDisposable = Disposer.newDisposable()
        val application = MockApplication.setUp(applicationDisposable)
        application.extensionArea.registerExtensionPoint(
            "com.intellij.debugger.fieldVisibilityProvider",
            FieldVisibilityProvider::class.java.name,
            ExtensionPoint.Kind.INTERFACE,
            true
        )
    }

    @After
    fun tearDownApplication() {
        Disposer.dispose(applicationDisposable)
    }

    @Test
    fun testDescriptorNameAndRejectsInvalidArgumentsBeforeHighWatermark() = runBlocking(Dispatchers.IO) {
        val highWatermarkCalls = AtomicInteger(0)
        val server = AndroidDapServer(
            workspaceDirectoryResolver = { testProjectDir }
        )
        val descriptor = server.commandDescriptors.single()
        assertEquals(AndroidDapServer.COMMAND_START_SERVER, descriptor.name)

        val lsConfig = configurationWithHighWatermark {
            highWatermarkCalls.incrementAndGet()
            JsonNull
        }
        val lsServer = fakeLsServer(fakeProject(MessageBusTracker()))
        val lspScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        try {
            val handlerContext = LspHandlerContext(noOpLspClient(), lspScope)
            val invalidCases = listOf<List<kotlinx.serialization.json.JsonElement>?>(
                null,
                emptyList(),
                listOf(JsonObject(emptyMap()), JsonObject(emptyMap())),
                listOf(JsonPrimitive("not-an-object")),
                listOf(buildJsonObject { put("nativePort", 1234) }),
                listOf(buildJsonObject { put("host", "127.0.0.1") }),
                listOf(buildJsonObject { put("unknown", true) })
            )
            for (args in invalidCases) {
                try {
                    withContext(lsConfig) {
                        with(lsServer) { with(handlerContext) { descriptor.executor.execute(args ?: emptyList()) } }
                    }
                    fail("Expected InvalidParams for args=$args")
                } catch (e: LspResponseErrorException) {
                    assertEquals(ErrorCodes.InvalidParams, e.errorCode)
                }
            }
            assertEquals(0, highWatermarkCalls.get())
        } finally {
            lspScope.cancel()
        }
    }

    @ApiStatus.Experimental
    @Suppress("UnstableApiUsage")
    @Test
    fun testMissingHighWatermarkFailsAndCancellationDuringBarrierPropagates() = runBlocking(Dispatchers.IO) {
        val server = AndroidDapServer(
            workspaceDirectoryResolver = { testProjectDir }
        )
        val descriptor = server.commandDescriptors.single()
        val lsServer = fakeLsServer(fakeProject(MessageBusTracker()))
        val lspScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        try {
            val handlerContext = LspHandlerContext(noOpLspClient(), lspScope)

            // Missing LSConfiguration in coroutineContext
            try {
                with(lsServer) { with(handlerContext) { descriptor.executor.execute(listOf(JsonObject(emptyMap()))) } }
                fail("Expected InternalError without LSConfiguration")
            } catch (e: LspResponseErrorException) {
                assertEquals(ErrorCodes.InternalError, e.errorCode)
            }

            // Missing wait-for-highwatermark command
            try {
                withContext(LSConfiguration(configurations = emptyList())) {
                    with(lsServer) { with(handlerContext) { descriptor.executor.execute(listOf(JsonObject(emptyMap()))) } }
                }
                fail("Expected InternalError without wait-for-highwatermark")
            } catch (e: LspResponseErrorException) {
                assertEquals(ErrorCodes.InternalError, e.errorCode)
            }

            // Cancellation during wait-for-highwatermark
            val enteredBarrier = CompletableDeferred<Unit>()
            val barrierCancelled = CompletableDeferred<Unit>()
            val lsConfig = configurationWithHighWatermark {
                enteredBarrier.complete(Unit)
                try {
                    awaitCancellation()
                } catch (c: CancellationException) {
                    barrierCancelled.complete(Unit)
                    throw c
                }
            }
            val startDeferred = async {
                withContext(lsConfig) {
                    with(lsServer) { with(handlerContext) { descriptor.executor.execute(listOf(JsonObject(emptyMap()))) } }
                }
            }
            withTimeout(5_000) { enteredBarrier.await() }
            startDeferred.cancel()
            withTimeout(5_000) { barrierCancelled.await() }
            assertTrue(startDeferred.isCancelled)
        } finally {
            lspScope.cancel()
        }
    }

    @Test
    fun testSingleLoopbackEndpointBindsTopicBeforeNativeFactoryAndCleansUpOnEof() = runBlocking(Dispatchers.IO) {
        val busTracker = MessageBusTracker()
        val highWatermarkDone = AtomicBoolean(false)
        val subscribedBeforeFactory = AtomicBoolean(false)
        val nativeFactoryCalled = CompletableDeferred<Unit>()

        val server = AndroidDapServer(
            acceptTimeoutMs = 5_000,
            readerJoinTimeoutMs = 3_000,
            nativeServerFactory = { _, _, _, _ ->
                subscribedBeforeFactory.set(busTracker.subscribedTopics.contains(XDebuggerManager.TOPIC))
                nativeFactoryCalled.complete(Unit)
                minimalNativeDelegate()
            },
            workspaceDirectoryResolver = { testProjectDir }
        )
        val descriptor = server.commandDescriptors.single()
        val lsConfig = configurationWithHighWatermark {
            highWatermarkDone.set(true)
            JsonNull
        }
        val lsServer = fakeLsServer(fakeProject(busTracker))
        val lspScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

        try {
            val handlerContext = LspHandlerContext(noOpLspClient(), lspScope)
            val result = withContext(lsConfig) {
                with(lsServer) { with(handlerContext) { descriptor.executor.execute(listOf(JsonObject(emptyMap()))) } }
            }
            assertTrue(highWatermarkDone.get())
            val port = result.jsonObject["port"]!!.jsonPrimitive.int
            assertTrue(port in 1..65535)

            val socket = Socket()
            socket.connect(InetSocketAddress("127.0.0.1", port), 5_000)
            socket.soTimeout = 5_000
            socket.use { client ->
                withTimeout(5_000) { nativeFactoryCalled.await() }
                assertTrue(
                    "XDebuggerManager.TOPIC must be subscribed before native factory",
                    subscribedBeforeFactory.get()
                )

                // Second connection must be rejected because listener closes after accepting one client.
                var secondRejected = false
                try {
                    Socket().use { extra ->
                        extra.connect(InetSocketAddress("127.0.0.1", port), 1_000)
                    }
                } catch (_: ConnectException) {
                    secondRejected = true
                }
                assertTrue("Second client connection must be rejected", secondRejected)

                // Send initialize + invalid launch + disconnect over real DAP TCP framing.
                val out = client.getOutputStream()
                val input = client.getInputStream()

                writeDapFrame(
                    out,
                    buildJsonObject {
                        put("seq", 1)
                        put("type", "request")
                        put("command", "initialize")
                        put(
                            "arguments",
                            buildJsonObject {
                                put("clientID", "test-tcp-client")
                                put("adapterID", "android")
                                put("linesStartAt1", true)
                                put("columnsStartAt1", true)
                            }
                        )
                    }
                )
                val initResp = readDapResponse(input, 1)
                assertEquals(true, initResp["success"]?.jsonPrimitive?.content?.toBooleanStrictOrNull())

                writeDapFrame(
                    out,
                    buildJsonObject {
                        put("seq", 2)
                        put("type", "request")
                        put("command", "launch")
                        put("arguments", buildJsonObject { put("android", JsonObject(emptyMap())) })
                    }
                )
                val launchResp = readDapResponse(input, 2)
                assertEquals(false, launchResp["success"]?.jsonPrimitive?.content?.toBooleanStrictOrNull())
                assertEquals(
                    "[invalid_params] configuring: android.deviceId is required",
                    launchResp["message"]?.jsonPrimitive?.content
                )

                writeDapFrame(
                    out,
                    buildJsonObject {
                        put("seq", 3)
                        put("type", "request")
                        put("command", "disconnect")
                        put("arguments", buildJsonObject { put("terminateDebuggee", false) })
                    }
                )
                val discResp = readDapResponse(input, 3)
                assertEquals(true, discResp["success"]?.jsonPrimitive?.content?.toBooleanStrictOrNull())
            }

            // Wait for server child job cleanup after EOF
            val childJobs = lspScope.coroutineContext[Job]!!.children.toList()
            withTimeout(5_000) {
                childJobs.forEach { it.join() }
            }
            assertTrue("MessageBusConnection must disconnect on EOF", busTracker.disconnected.get())
            awaitReaderThreadExit("android-dap-reader-$port")
        } finally {
            lspScope.cancel()
        }
    }

    @Test
    fun testAcceptTimeoutClosesListenerWithoutClient() = runBlocking(Dispatchers.IO) {
        val server = AndroidDapServer(
            acceptTimeoutMs = 150,
            workspaceDirectoryResolver = { testProjectDir }
        )
        val descriptor = server.commandDescriptors.single()
        val lsConfig = configurationWithHighWatermark { JsonNull }
        val lsServer = fakeLsServer(fakeProject(MessageBusTracker()))
        val lspScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

        try {
            val handlerContext = LspHandlerContext(noOpLspClient(), lspScope)
            val result = withContext(lsConfig) {
                with(lsServer) { with(handlerContext) { descriptor.executor.execute(listOf(JsonObject(emptyMap()))) } }
            }
            val port = result.jsonObject["port"]!!.jsonPrimitive.int
            val childJobs = lspScope.coroutineContext[Job]!!.children.toList()
            withTimeout(5_000) {
                childJobs.forEach { it.join() }
            }
            var refused = false
            try {
                Socket().use { s ->
                    s.connect(InetSocketAddress("127.0.0.1", port), 1_000)
                }
            } catch (_: ConnectException) {
                refused = true
            }
            assertTrue("Listener must be closed after accept timeout", refused)
        } finally {
            lspScope.cancel()
        }
    }

    @Test
    fun testLspScopeCancellationUnblocksAcceptAndCleansUpConnectedClient() = runBlocking(Dispatchers.IO) {
        // Case 1: cancel lspScope while waiting in accept()
        val server1 = AndroidDapServer(
            acceptTimeoutMs = 30_000,
            workspaceDirectoryResolver = { testProjectDir }
        )
        val desc1 = server1.commandDescriptors.single()
        val lsConfig = configurationWithHighWatermark { JsonNull }
        val lsServer1 = fakeLsServer(fakeProject(MessageBusTracker()))
        val lspScope1 = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        val handlerContext1 = LspHandlerContext(noOpLspClient(), lspScope1)
        val res1 = withContext(lsConfig) {
            with(lsServer1) { with(handlerContext1) { desc1.executor.execute(listOf(JsonObject(emptyMap()))) } }
        }
        val port1 = res1.jsonObject["port"]!!.jsonPrimitive.int
        val jobs1 = lspScope1.coroutineContext[Job]!!.children.toList()
        lspScope1.cancel()
        withTimeout(3_000) {
            jobs1.forEach { it.join() }
        }
        var refused = false
        try {
            Socket().use { s -> s.connect(InetSocketAddress("127.0.0.1", port1), 1_000) }
        } catch (_: ConnectException) {
            refused = true
        }
        assertTrue("Listener must close immediately on lspScope cancellation", refused)

        // Case 2: cancel lspScope while client socket is connected and idle
        val busTracker2 = MessageBusTracker()
        val enteredRunner = CompletableDeferred<Unit>()
        val server2 = AndroidDapServer(
            acceptTimeoutMs = 5_000,
            readerJoinTimeoutMs = 3_000,
            nativeServerFactory = { _, _, _, _ ->
                enteredRunner.complete(Unit)
                minimalNativeDelegate()
            },
            workspaceDirectoryResolver = { testProjectDir }
        )
        val desc2 = server2.commandDescriptors.single()
        val lsServer2 = fakeLsServer(fakeProject(busTracker2))
        val lspScope2 = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        val handlerContext2 = LspHandlerContext(noOpLspClient(), lspScope2)
        val res2 = withContext(lsConfig) {
            with(lsServer2) { with(handlerContext2) { desc2.executor.execute(listOf(JsonObject(emptyMap()))) } }
        }
        val port2 = res2.jsonObject["port"]!!.jsonPrimitive.int
        val jobs2 = lspScope2.coroutineContext[Job]!!.children.toList()

        Socket().use { client ->
            client.connect(InetSocketAddress("127.0.0.1", port2), 5_000)
            client.soTimeout = 5_000
            writeDapFrame(
                client.getOutputStream(),
                buildJsonObject {
                    put("seq", 1)
                    put("type", "request")
                    put("command", "initialize")
                    put(
                        "arguments",
                        buildJsonObject {
                            put("adapterID", "android")
                            put("linesStartAt1", true)
                            put("columnsStartAt1", true)
                        }
                    )
                }
            )
            withTimeout(5_000) { enteredRunner.await() }
            val initResp = readDapResponse(client.getInputStream(), 1)
            assertEquals(true, initResp["success"]?.jsonPrimitive?.content?.toBooleanStrictOrNull())

            // Cancel LSP scope while client keeps socket open with no further data
            lspScope2.cancel()
            withTimeout(5_000) {
                jobs2.forEach { it.join() }
            }
            assertTrue("MessageBusConnection must disconnect on lspScope cancellation", busTracker2.disconnected.get())
            awaitReaderThreadExit("android-dap-reader-$port2")
        }
    }

    @Test
    @Suppress("UnstableApiUsage")
    fun testCapturesGradleContextPassesFilteredClientAndClosesHandleOnEof() = runBlocking(Dispatchers.IO) {
        val busTracker = MessageBusTracker()
        val capturedContext = CompletableDeferred<AndroidGradleContext>()
        val handleClosedOnEof = CompletableDeferred<Boolean>()
        val nativeClientRef = CompletableDeferred<DapClient>()
        val nativeAttachCalled = CompletableDeferred<Int?>()

        val configuredJdk = Path.of("F:/toolchains/jdk21").toAbsolutePath().normalize()
        val configuredRoot = testProjectDir.resolve("app-root").toAbsolutePath().normalize()
        val expectedContext = AndroidGradleContext(
            workspaceDirectory = testProjectDir,
            defaultSdk = configuredJdk,
            importedRoots = mapOf(
                configuredRoot to AndroidGradleRootContext(
                    buildRoot = configuredRoot,
                    javaHome = configuredJdk,
                    env = mapOf("CUSTOM_GRADLE_ENV" to "yes"),
                    offline = true,
                )
            ),
        )
        val lsServer = fakeLsServer(fakeProject(busTracker))
        val capturedServer = CompletableDeferred<LSServer>()
        val lspScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

        val fakeBackend = object : AndroidRunBackend {
            override suspend fun launch(
                config: AndroidLaunchConfig,
                ownerScope: CoroutineScope,
                onStage: (AndroidRunStage) -> Unit,
                onOutput: (String) -> Unit,
            ): AndroidRunHandle {
                onStage(AndroidRunStage.STARTING)
                return object : AndroidRunHandle {
                    override val pid: Int = 3131
                    override val deviceId: String = config.deviceId
                    override val userId: Int = 0
                    override val packageName: String = "com.example.ompattachfixture"
                    override val processName: String = "com.example.ompattachfixture"
                    override val port: Int = 51313
                    override val isApplication: Boolean = true
                    override suspend fun close(terminateApplication: Boolean) {
                        handleClosedOnEof.complete(terminateApplication)
                    }

                    override suspend fun awaitExit(): AndroidProcessExit =
                        CompletableDeferred<AndroidProcessExit>().await()
                }
            }

            override suspend fun attach(
                config: AndroidAttachConfig,
                ownerScope: CoroutineScope,
                onStage: (AndroidRunStage) -> Unit,
                onOutput: (String) -> Unit,
            ): AndroidRunHandle = error("unused")
        }

        val server = AndroidDapServer(
            acceptTimeoutMs = 5_000,
            readerJoinTimeoutMs = 3_000,
            nativeServerFactory = { scope, _, client, stopped ->
                scope.coroutineContext[Job]!!.invokeOnCompletion {
                    stopped.complete(Unit)
                }
                nativeClientRef.complete(client)
                val configDone = CompletableDeferred<Unit>()
                object : DapServer by minimalNativeDelegate() {
                    override suspend fun attach(args: com.jetbrains.dap.protocol.AttachRequestArguments) {
                        nativeAttachCalled.complete(args.port)
                        client.initialized(InitializedEventArguments())
                        // Synthetic native exited(0) must be filtered out by AndroidDapEventFilter.
                        client.exited(ExitedEventArguments(0))
                        configDone.await()
                    }

                    override suspend fun configurationDone(args: com.jetbrains.dap.protocol.ConfigurationDoneArguments) {
                        configDone.complete(Unit)
                    }
                }
            },
            workspaceDirectoryResolver = { testProjectDir },
            gradleContextCapturer = { server ->
                capturedServer.complete(server)
                expectedContext
            },
            runBackendFactory = { ctx, _ ->
                capturedContext.complete(ctx)
                fakeBackend
            },
        )
        val descriptor = server.commandDescriptors.single()
        val lsConfig = configurationWithHighWatermark { JsonNull }

        try {
            val handlerContext = LspHandlerContext(noOpLspClient(), lspScope)
            val result = withContext(lsConfig) {
                with(lsServer) { with(handlerContext) { descriptor.executor.execute(listOf(JsonObject(emptyMap()))) } }
            }
            assertSame(lsServer, withTimeout(5_000) { capturedServer.await() })
            val ctx = withTimeout(5_000) { capturedContext.await() }
            assertEquals(configuredJdk, ctx.defaultSdk)
            assertEquals(configuredJdk, ctx.importedRoots[configuredRoot]?.javaHome)
            assertEquals("yes", ctx.importedRoots[configuredRoot]?.env?.get("CUSTOM_GRADLE_ENV"))
            assertEquals(true, ctx.importedRoots[configuredRoot]?.offline)

            val port = result.jsonObject["port"]!!.jsonPrimitive.int
            Socket().use { client ->
                client.connect(InetSocketAddress("127.0.0.1", port), 5_000)
                client.soTimeout = 5_000
                val out = client.getOutputStream()
                val input = client.getInputStream()
                val seenEvents = CopyOnWriteArrayList<JsonObject>()

                writeDapFrame(
                    out,
                    buildJsonObject {
                        put("seq", 1)
                        put("type", "request")
                        put("command", "initialize")
                        put("arguments", buildJsonObject { put("adapterID", "android") })
                    }
                )
                assertEquals(
                    true,
                    readDapResponse(input, 1)["success"]?.jsonPrimitive?.content?.toBooleanStrictOrNull()
                )

                writeDapFrame(
                    out,
                    buildJsonObject {
                        put("seq", 2)
                        put("type", "request")
                        put("command", "launch")
                        put(
                            "arguments",
                            buildJsonObject {
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
                                    }
                                )
                            }
                        )
                    }
                )
                assertEquals(51313, withTimeout(5_000) { nativeAttachCalled.await() })

                // Read frames until initialized arrives; confirm exited(0) was suppressed.
                while (true) {
                    val frame = readDapFrame(input) ?: error("Unexpected EOF")
                    if (frame["type"]?.jsonPrimitive?.content == "event") {
                        seenEvents.add(frame)
                        if (frame["event"]?.jsonPrimitive?.content == "initialized") break
                    }
                }
                assertFalse(seenEvents.any { it["event"]?.jsonPrimitive?.content == "exited" })

                writeDapFrame(
                    out,
                    buildJsonObject {
                        put("seq", 3)
                        put("type", "request")
                        put("command", "configurationDone")
                        put("arguments", JsonObject(emptyMap()))
                    }
                )
                assertEquals(
                    true,
                    readDapResponse(input, 3)["success"]?.jsonPrimitive?.content?.toBooleanStrictOrNull()
                )
                assertEquals(
                    true,
                    readDapResponse(input, 2)["success"]?.jsonPrimitive?.content?.toBooleanStrictOrNull()
                )
                // Drop TCP socket without disconnect -> EOF must close owned application handle with true.
            }

            assertEquals(true, withTimeout(5_000) { handleClosedOnEof.await() })
            val childJobs = lspScope.coroutineContext[Job]!!.children.toList()
            withTimeout(5_000) {
                childJobs.forEach { it.join() }
            }
            assertTrue(busTracker.disconnected.get())
            awaitReaderThreadExit("android-dap-reader-$port")
        } finally {
            lspScope.cancel()
        }
    }

    @Suppress("UnstableApiUsage")
    private fun configurationWithHighWatermark(
        executor: suspend () -> kotlinx.serialization.json.JsonElement
    ): LSConfiguration {
        val provider = object : LSCommandDescriptorProvider {
            override val commandDescriptors: List<LSCommandDescriptor> = listOf(
                LSCommandDescriptor(
                    "Wait For High Watermark",
                    AndroidDapServer.WAIT_FOR_HIGH_WATERMARK_COMMAND,
                    LSCommandExecutor { arguments ->
                        assertTrue(arguments.isEmpty())
                        executor()
                    }
                )
            )
        }
        return LSConfiguration(configurations = listOf(LSConfigurationPiece(entries = listOf(provider))))
    }

    private fun fakeLsServer(project: Project): LSServer {
        return Proxy.newProxyInstance(
            LSServer::class.java.classLoader,
            arrayOf(LSServer::class.java)
        ) { _, method, args ->
            when (method.name) {
                "withDebugContext" -> {
                    @Suppress("UNCHECKED_CAST")
                    val action = args!![0] as Function3<DapContext, CoroutineScope, Continuation<Any?>, Any?>

                    @Suppress("UNCHECKED_CAST")
                    val continuation = args[1] as Continuation<Any?>
                    val dapContext = Proxy.newProxyInstance(
                        DapContext::class.java.classLoader,
                        arrayOf(DapContext::class.java)
                    ) { _, m, _ ->
                        if (m.name == "getProject") project else null
                    } as DapContext
                    action.invoke(dapContext, CoroutineScope(continuation.context), continuation)
                }

                else -> null
            }
        } as LSServer
    }

    private class MessageBusTracker {
        val subscribedTopics = mutableListOf<Topic<*>>()
        val disconnected = AtomicBoolean(false)
    }

    private fun fakeProject(tracker: MessageBusTracker): Project {
        val connection = Proxy.newProxyInstance(
            MessageBusConnection::class.java.classLoader,
            arrayOf(MessageBusConnection::class.java)
        ) { proxy, method, args ->
            when (method.name) {
                "equals" -> proxy === args?.getOrNull(0)
                "hashCode" -> System.identityHashCode(proxy)
                "toString" -> "AndroidTestMessageBusConnection"
                "subscribe" -> {
                    val topic = args?.getOrNull(0) as? Topic<*>
                    if (topic != null) {
                        synchronized(tracker.subscribedTopics) {
                            tracker.subscribedTopics.add(topic)
                        }
                    }
                    null
                }

                "disconnect", "dispose" -> {
                    tracker.disconnected.set(true)
                    null
                }

                else -> null
            }
        } as MessageBusConnection

        val messageBus = Proxy.newProxyInstance(
            MessageBus::class.java.classLoader,
            arrayOf(MessageBus::class.java)
        ) { _, method, _ ->
            when (method.name) {
                "connect", "simpleConnect" -> connection
                else -> null
            }
        } as MessageBus

        return Proxy.newProxyInstance(
            Project::class.java.classLoader,
            arrayOf(Project::class.java)
        ) { _, method, _ ->
            when (method.name) {
                "getMessageBus" -> messageBus
                "getBasePath" -> testProjectDir.toString()
                else -> null
            }
        } as Project
    }

    private fun noOpLspClient(): LspClient = Proxy.newProxyInstance(
        LspClient::class.java.classLoader,
        arrayOf(LspClient::class.java)
    ) { _, _, _ -> null } as LspClient

    @Suppress("UnstableApiUsage")
    private fun minimalNativeDelegate(): DapServer {
        val unsupportedHandler = java.lang.reflect.InvocationHandler { proxy, method, args ->
            when (method.name) {
                "initialize" -> Capabilities(
                    supportsConfigurationDoneRequest = true,
                    supportsTerminateRequest = true,
                    supportsCancelRequest = false,
                    supportSuspendDebuggee = true,
                    supportTerminateDebuggee = true
                )

                "disconnect" -> Unit
                "equals" -> proxy === args?.getOrNull(0)
                "hashCode" -> System.identityHashCode(proxy)
                "toString" -> "MinimalNativeDelegate"
                else -> throw UnsupportedOperationException("Unexpected call to ${method.name}")
            }
        }
        return Proxy.newProxyInstance(
            DapServer::class.java.classLoader,
            arrayOf(DapServer::class.java),
            unsupportedHandler
        ) as DapServer
    }

    private fun writeDapFrame(out: java.io.OutputStream, payload: JsonObject) {
        val jsonBytes = payload.toString().toByteArray(StandardCharsets.UTF_8)
        val header = "Content-Length: ${jsonBytes.size}\r\n\r\n".toByteArray(StandardCharsets.US_ASCII)
        out.write(header)
        out.write(jsonBytes)
        out.flush()
    }

    private fun readDapResponse(input: InputStream, requestSeq: Int): JsonObject {
        while (true) {
            val frame = readDapFrame(input)
            assertNotNull("Unexpected EOF waiting for response $requestSeq", frame)
            if (frame!!["type"]?.jsonPrimitive?.content == "response" &&
                frame["request_seq"]?.jsonPrimitive?.int == requestSeq
            ) {
                return frame
            }
        }
    }

    private fun readDapFrame(input: InputStream): JsonObject? {
        val headerBytes = ByteArrayOutputStream()
        var state = 0
        while (true) {
            val b = input.read()
            if (b < 0) return null
            headerBytes.write(b)
            state = when (state) {
                0 -> if (b == '\r'.code) 1 else 0
                1 -> if (b == '\n'.code) 2 else if (b == '\r'.code) 1 else 0
                2 -> if (b == '\r'.code) 3 else 0
                3 -> if (b == '\n'.code) 4 else if (b == '\r'.code) 1 else 0
                else -> 0
            }
            if (state == 4) break
        }
        val headerText = headerBytes.toString(StandardCharsets.US_ASCII.name())
        val contentLength = Regex("""(?im)^Content-Length:\s*(\d+)\r?$""")
            .find(headerText)
            ?.groupValues?.get(1)?.toInt()
            ?: error("Missing Content-Length in DAP header: $headerText")
        val body = ByteArray(contentLength)
        var offset = 0
        while (offset < contentLength) {
            val read = input.read(body, offset, contentLength - offset)
            if (read < 0) return null
            offset += read
        }
        return Json.parseToJsonElement(String(body, StandardCharsets.UTF_8)).jsonObject
    }

    private fun awaitReaderThreadExit(threadName: String) {
        val deadlineNanos = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
        while (System.nanoTime() < deadlineNanos) {
            val stillAlive = Thread.getAllStackTraces().keys.any { it.name == threadName && it.isAlive }
            if (!stillAlive) return
            Thread.sleep(20)
        }
        val alive = Thread.getAllStackTraces().keys.any { it.name == threadName && it.isAlive }
        assertFalse("Reader thread $threadName should exit after server closes", alive)
    }
}
