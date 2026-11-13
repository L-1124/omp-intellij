package org.jetbrains.android.debug

import com.intellij.debugger.engine.FieldVisibilityProvider
import com.intellij.debugger.engine.JavaDebugProcess
import com.intellij.debugger.impl.DebuggerSession
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.extensions.ExtensionPointName
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.xdebugger.XDebugProcess
import com.intellij.xdebugger.XDebuggerManager
import com.intellij.xdebugger.XDebuggerManagerListener
import com.jetbrains.dap.impl.runDapServer
import com.jetbrains.dap.platform.DapServer as newNativeDapServer
import com.jetbrains.dap.protocol.DapClient
import com.jetbrains.dap.protocol.DapServer
import com.jetbrains.ls.api.core.DapContext
import com.jetbrains.ls.api.core.LSServer
import com.jetbrains.ls.api.features.LSConfiguration
import com.jetbrains.ls.api.features.commands.LSCommandDescriptor
import com.jetbrains.ls.api.features.commands.LSCommandDescriptorProvider
import com.jetbrains.ls.api.features.commands.LSCommandExecutor
import com.jetbrains.lsp.implementation.LspConnection
import com.jetbrains.lsp.implementation.LspHandlerContext
import com.jetbrains.lsp.implementation.throwLspError
import com.jetbrains.lsp.protocol.ErrorCodes
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.isActive
import kotlinx.coroutines.job
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import org.jetbrains.android.run.AndroidGradleContext
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.IOException
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketTimeoutException
import java.net.URI
import java.nio.file.Path
import java.util.Collections
import kotlin.coroutines.EmptyCoroutineContext
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import org.jetbrains.annotations.TestOnly
import org.jetbrains.annotations.ApiStatus
import java.util.IdentityHashMap

class AndroidDapServer @TestOnly constructor(
    private val acceptTimeoutMs: Int = DEFAULT_ACCEPT_TIMEOUT_MS,
    private val readerJoinTimeoutMs: Long = AndroidDapConnection.DEFAULT_READER_JOIN_TIMEOUT_MS,
    @param:Suppress("UnstableApiUsage")
    private val dapServerRunner: suspend (
        connection: LspConnection,
        factory: (CoroutineScope, DapClient, CompletableDeferred<Unit>) -> DapServer
    ) -> Unit = { connection, factory -> runDapServer(connection, factory) },
    @param:Suppress("UnstableApiUsage")
    private val nativeServerFactory: (
        scope: CoroutineScope,
        project: Project,
        client: DapClient,
        stopped: CompletableDeferred<Unit>
    ) -> DapServer = { scope, project, client, stopped ->
        newNativeDapServer(scope, project, client, stopped)
    },
    private val workspaceDirectoryResolver: (LSServer) -> Path? = { server ->
        defaultResolveWorkspaceProjectDirectory(server)
    },
    private val gradleContextCapturer: (LSServer) -> AndroidGradleContext = { server ->
        AndroidGradleContext.capture(server)
    },
    private val runBackendFactory: (AndroidGradleContext, Job) -> AndroidRunBackend = { context, ownerJob ->
        DefaultAndroidRunBackend(context, AndroidDebugService.getInstance(ownerJob))
    }
) : LSCommandDescriptorProvider {

    constructor() : this(acceptTimeoutMs = DEFAULT_ACCEPT_TIMEOUT_MS)

    override val commandDescriptors: List<LSCommandDescriptor>
        get() = listOf(
            LSCommandDescriptor(
                "Start Android DAP Server",
                COMMAND_START_SERVER,
                createStartServerExecutor()
            )
        )

    private fun createStartServerExecutor(): LSCommandExecutor {
        return LSCommandExecutor { arguments ->
            val server = contextOf<LSServer>()
            val handler = contextOf<LspHandlerContext>()

            validateStartServerArguments(arguments)

            val configuration = currentCoroutineContext()[LSConfiguration.Key]
                ?: throwLspError(
                    "LSConfiguration is unavailable",
                    JsonNull,
                    ErrorCodes.InternalError
                )
            val highWatermark = configuration.commandDescriptorByCommandName(WAIT_FOR_HIGH_WATERMARK_COMMAND)
                ?: throwLspError(
                    "$WAIT_FOR_HIGH_WATERMARK_COMMAND command is unavailable",
                    JsonNull,
                    ErrorCodes.InternalError
                )
            highWatermark.executor.execute(emptyList())

            val workspaceProjectDirectory = workspaceDirectoryResolver(server)
            val gradleContext = gradleContextCapturer(server)
            val runBackend = runBackendFactory(gradleContext, handler.lspScope.coroutineContext.job)

            val listener = withContext(Dispatchers.IO) {
                ServerSocket(0, 1, InetAddress.getLoopbackAddress()).apply {
                    soTimeout = acceptTimeoutMs
                }
            }
            val port = listener.localPort

            try {
                val ownerJob = handler.lspScope.launch(Dispatchers.IO) {
                    serveSingleClient(
                        listener = listener,
                        port = port,
                        server = server,
                        workspaceProjectDirectory = workspaceProjectDirectory,
                        runBackend = runBackend
                    )
                }
                ownerJob.invokeOnCompletion {
                    closeQuietly(listener)
                }
                if (!handler.lspScope.isActive) {
                    closeQuietly(listener)
                    throw CancellationException("LSP connection closed before Android DAP server started")
                }
            } catch (t: Throwable) {
                closeQuietly(listener)
                throw t
            }

            buildJsonObject {
                put("port", port)
            }
        }
    }

    @ApiStatus.Experimental
    @Suppress("UnstableApiUsage")
    private suspend fun serveSingleClient(
        listener: ServerSocket,
        port: Int,
        server: LSServer,
        workspaceProjectDirectory: Path?,
        runBackend: AndroidRunBackend
    ) {
        val ownerJob = currentCoroutineContext().job
        try {
            val socket = try {
                acceptSingleClient(listener)
            } catch (_: SocketTimeoutException) {
                LOG.info("Android DAP server timed out waiting for client on $LOOPBACK_HOST:$port")
                return
            } catch (e: IOException) {
                if (ownerJob.isActive) {
                    LOG.warn("Android DAP listener closed before accepting client on $LOOPBACK_HOST:$port", e)
                }
                return
            }

            socket.use { clientSocket ->
                val connection = AndroidDapConnection(clientSocket, "android-dap-reader-$port")
                try {
                    coroutineScope {
                        val cancelWatcher = launch(start = CoroutineStart.UNDISPATCHED) {
                            try {
                                awaitCancellation()
                            } finally {
                                connection.output.cancel(CancellationException("LSP connection closed"))
                            }
                        }
                        try {
                            server.withDebugContext {
                                val project = contextOf<DapContext>().project
                                val projectDirectory = workspaceProjectDirectory
                                    ?: project.basePath?.let { Path.of(it).toAbsolutePath().normalize() }

                                val androidHooks = AndroidDebuggerListener()
                                val activeSessions =
                                    Collections.newSetFromMap(IdentityHashMap<DebuggerSession, Boolean>())
                                val debugBus = project.messageBus.connect()
                                debugBus.subscribe(XDebuggerManager.TOPIC, object : XDebuggerManagerListener {
                                    override fun processStarted(process: XDebugProcess) {
                                        if (process is JavaDebugProcess) {
                                            process.debuggerSession?.let { dbgSession ->
                                                synchronized(activeSessions) {
                                                    activeSessions.add(dbgSession)
                                                }
                                            }
                                        }
                                        androidHooks.processStarted(process)
                                    }

                                    override fun processStopped(process: XDebugProcess) {
                                        if (process is JavaDebugProcess) {
                                            process.debuggerSession?.let { dbgSession ->
                                                synchronized(activeSessions) {
                                                    activeSessions.remove(dbgSession)
                                                }
                                                androidHooks.sessionDetached(dbgSession)
                                            }
                                        }
                                    }
                                })

                                var session: AndroidDapSession? = null
                                try {
                                    // The scoped DAP application does not load the XML field visibility extension.
                                    ExtensionPointName.create<FieldVisibilityProvider>(
                                        "com.intellij.debugger.fieldVisibilityProvider"
                                    ).point.registerExtension(AndroidFieldVisibilityProvider(), debugBus)
                                    dapServerRunner(connection) { scope, client, stopped ->
                                        val nativeStopped = CompletableDeferred<Unit>()
                                        AndroidDapSession(
                                            projectDirectory = projectDirectory,
                                            scope = scope,
                                            serverStoppedSignal = stopped,
                                            nativeStoppedSignal = nativeStopped,
                                            backend = runBackend,
                                            downstreamClient = client,
                                            nativeFactory = { filteredClient ->
                                                // Native shutdown must not close the wire before cleanup and response delivery.
                                                nativeServerFactory(
                                                    scope,
                                                    project,
                                                    filteredClient,
                                                    nativeStopped
                                                )
                                            }
                                        ).also { created ->
                                            session = created
                                        }
                                    }
                                } finally {
                                    withContext(NonCancellable) {
                                        try {
                                            session?.closeAndCleanupOnConnectionClose()
                                        } catch (t: Throwable) {
                                            if (t is CancellationException) throw t
                                            LOG.warn(
                                                "Failed to clean up Android DAP session on $LOOPBACK_HOST:$port",
                                                t
                                            )
                                        }
                                        val remaining = synchronized(activeSessions) {
                                            val copy = activeSessions.toList()
                                            activeSessions.clear()
                                            copy
                                        }
                                        for (dbgSession in remaining) {
                                            try {
                                                androidHooks.sessionDetached(dbgSession)
                                            } catch (t: Throwable) {
                                                LOG.warn("Failed to detach Android debugger session on cleanup", t)
                                            }
                                        }
                                        try {
                                            Disposer.dispose(debugBus)
                                        } catch (t: Throwable) {
                                            LOG.warn("Failed to disconnect Android debugger message bus", t)
                                        }
                                    }
                                }
                            }
                        } finally {
                            cancelWatcher.cancel()
                        }
                    }
                } finally {
                    withContext(NonCancellable) {
                        try {
                            connection.closeAndJoin(readerJoinTimeoutMs)
                        } catch (t: Throwable) {
                            if (t is CancellationException) throw t
                            LOG.warn("Failed to close Android DAP connection on $LOOPBACK_HOST:$port", t)
                        }
                    }
                }
            }
        } finally {
            closeQuietly(listener)
        }
    }

    private suspend fun acceptSingleClient(listener: ServerSocket): Socket {
        return suspendCancellableCoroutine { continuation ->
            continuation.invokeOnCancellation {
                closeQuietly(listener)
            }
            Dispatchers.IO.dispatch(EmptyCoroutineContext) {
                try {
                    val accepted = listener.accept()
                    closeQuietly(listener)
                    if (continuation.isActive) {
                        continuation.resume(accepted)
                    } else {
                        closeQuietly(accepted)
                    }
                } catch (t: Throwable) {
                    closeQuietly(listener)
                    if (continuation.isActive) {
                        continuation.resumeWithException(t)
                    }
                }
            }
        }
    }

    private fun closeQuietly(socket: Socket) {
        try {
            if (!socket.isClosed) {
                socket.close()
            }
        } catch (_: Throwable) {
        }
    }

    private fun validateStartServerArguments(arguments: List<JsonElement>?) {
        if (arguments == null || arguments.size != 1) {
            throwLspError(
                "Expected single empty JSON object argument",
                JsonNull,
                ErrorCodes.InvalidParams
            )
        }
        val argObj = arguments[0] as? JsonObject
            ?: throwLspError(
                "Expected single empty JSON object argument",
                JsonNull,
                ErrorCodes.InvalidParams
            )
        if (argObj.isNotEmpty()) {
            throwLspError(
                "Unexpected parameters for $COMMAND_START_SERVER: ${argObj.keys.joinToString(", ")}",
                JsonNull,
                ErrorCodes.InvalidParams
            )
        }
    }

    private fun closeQuietly(listener: ServerSocket) {
        try {
            if (!listener.isClosed) {
                listener.close()
            }
        } catch (_: Throwable) {
        }
    }

    companion object {
        const val COMMAND_START_SERVER = "org.intellij.android.debug.startServer"
        const val WAIT_FOR_HIGH_WATERMARK_COMMAND = "wait-for-highwatermark"
        const val LOOPBACK_HOST = "127.0.0.1"
        const val DEFAULT_ACCEPT_TIMEOUT_MS = 30_000

        private val LOG = Logger.getInstance(AndroidDapServer::class.java)

        private fun defaultResolveWorkspaceProjectDirectory(server: LSServer): Path? {
            server.workspaceConfig.workspaceFolders.firstOrNull()?.let {
                return it.toAbsolutePath().normalize()
            }
            val rootUri = server.workspaceConfig.rootUri ?: return null
            return runCatching {
                val uri = URI.create(rootUri.uri)
                if ("file".equals(uri.scheme, ignoreCase = true)) {
                    Path.of(uri).toAbsolutePath().normalize()
                } else {
                    null
                }
            }.getOrNull()
        }
    }
}
