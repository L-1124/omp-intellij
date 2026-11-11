package org.jetbrains.android.debug

import com.jetbrains.ls.api.core.LSServer
import com.jetbrains.ls.api.features.commands.LSCommandDescriptor
import com.jetbrains.ls.api.features.commands.LSCommandDescriptorProvider
import com.jetbrains.ls.api.features.commands.LSCommandExecutor
import com.jetbrains.lsp.implementation.LspHandlerContext
import com.jetbrains.lsp.implementation.LspResponseErrorException
import com.jetbrains.lsp.implementation.throwLspError
import kotlinx.coroutines.Job
import kotlinx.coroutines.job
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull
import java.util.UUID
import java.util.concurrent.CancellationException
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

class AndroidDebugCommands : LSCommandDescriptorProvider {

    fun interface CommandHandler {
        @Throws(Exception::class)
        fun handle(args: JsonObject, context: LspHandlerContext?): JsonElement
    }

    override val commandDescriptors: List<LSCommandDescriptor>
        get() = listOf(
            LSCommandDescriptor(
                "Prepare Android Debug",
                COMMAND_PREPARE,
                createExecutor { args, context -> handlePrepare(args, context) }),
            LSCommandDescriptor(
                "Claim Android Debug",
                COMMAND_CLAIM,
                createExecutor { args, context -> handleClaim(args, context) }),
            LSCommandDescriptor(
                "Release Android Debug",
                COMMAND_RELEASE,
                createExecutor { args, context -> handleRelease(args, context) })
        )

    private fun createExecutor(handler: CommandHandler): LSCommandExecutor {
        return LSCommandExecutor { arguments ->
            val context = contextOf<LspHandlerContext>()
            suspendCancellableCoroutine { cancellable ->
                val argsObj = try {
                    parseArguments(arguments)
                } catch (e: LspResponseErrorException) {
                    cancellable.resumeWithException(e)
                    return@suspendCancellableCoroutine
                }
                val worker = Thread.ofVirtual().name("omp-android-debug-worker-", 0).start {
                    try {
                        val result = handler.handle(argsObj, context)

                        var onCancellationCallback: ((Throwable) -> Unit)? = null
                        if (result is JsonObject && result.containsKey("cleanupKey")) {
                            val keyEl = result["cleanupKey"]
                            if (keyEl is JsonPrimitive && keyEl.isString) {
                                val key = keyEl.content
                                onCancellationCallback = {
                                    try {
                                        AndroidDebugService.getInstance().release(key)
                                    } catch (_: Throwable) {
                                    }
                                }
                            }
                        }

                        if (onCancellationCallback != null) {
                            cancellable.resume(result, onCancellationCallback)
                        } else {
                            cancellable.resume(result)
                        }
                    } catch (e: AndroidDebugException) {
                        val lspEx = try {
                            if (e.reason == "invalid_params") {
                                throwLspError(
                                    message = e.message ?: "",
                                    data = JsonNull,
                                    code = LSP_ERROR_CODE_INVALID_PARAMS,
                                    cause = e
                                )
                            } else {
                                e.throwAsLspError()
                            }
                        } catch (ex: LspResponseErrorException) {
                            ex
                        }
                        cancellable.resumeWithException(lspEx)
                    } catch (e: LspResponseErrorException) {
                        cancellable.resumeWithException(e)
                    } catch (e: Exception) {
                        when (e) {
                            is CancellationException, is InterruptedException -> {
                                val lspEx = try {
                                    throwLspError(
                                        message = "Request cancelled",
                                        data = JsonNull,
                                        code = LSP_ERROR_CODE_REQUEST_CANCELLED,
                                        cause = e
                                    )
                                } catch (ex: LspResponseErrorException) {
                                    ex
                                }
                                cancellable.resumeWithException(lspEx)
                            }

                            else -> {
                                val cause = e.cause
                                if (cause is CancellationException || cause is InterruptedException) {
                                    val lspEx = try {
                                        throwLspError(
                                            message = "Request cancelled",
                                            data = JsonNull,
                                            code = LSP_ERROR_CODE_REQUEST_CANCELLED,
                                            cause = e
                                        )
                                    } catch (ex: LspResponseErrorException) {
                                        ex
                                    }
                                    cancellable.resumeWithException(lspEx)
                                } else {
                                    cancellable.resumeWithException(e)
                                }
                            }
                        }
                    } catch (t: Throwable) {
                        cancellable.resumeWithException(t)
                    }
                }

                cancellable.invokeOnCancellation {
                    worker.interrupt()
                }
            }
        }
    }

    private fun parseArguments(arguments: List<JsonElement>?): JsonObject {
        if (arguments == null || arguments.size != 1) {
            throwLspError(
                message = "Invalid params: arguments must contain exactly one JSON object",
                data = JsonNull,
                code = LSP_ERROR_CODE_INVALID_PARAMS
            )
        }
        val first = arguments[0]
        if (first !is JsonObject) {
            throwLspError(
                message = "Invalid params: argument must be a JSON object",
                data = JsonNull,
                code = LSP_ERROR_CODE_INVALID_PARAMS
            )
        }
        return first
    }

    private fun handlePrepare(args: JsonObject, context: LspHandlerContext?): JsonElement {
        var packageName: String? = null
        var pid: Int? = null
        var deviceId: String? = null
        var adbPath: String? = null
        var timeoutMs: Int? = null

        if (args.containsKey("packageName")) {
            val el = args["packageName"]
            if (el is JsonPrimitive && el.isString) {
                val value = el.content
                if (value.isEmpty()) {
                    throwLspError("packageName must not be empty", JsonNull, LSP_ERROR_CODE_INVALID_PARAMS)
                }
                packageName = value
            } else {
                throwLspError("packageName must be a string", JsonNull, LSP_ERROR_CODE_INVALID_PARAMS)
            }
        }

        if (args.containsKey("pid")) {
            val el = args["pid"]
            if (el is JsonPrimitive) {
                if (el.isString) {
                    throwLspError("pid must be a JSON number, not a string", JsonNull, LSP_ERROR_CODE_INVALID_PARAMS)
                }
                val parsed = el.intOrNull
                if (parsed == null || parsed <= 0) {
                    throwLspError("pid must be a positive integer", JsonNull, LSP_ERROR_CODE_INVALID_PARAMS)
                }
                pid = parsed
            } else {
                throwLspError("pid must be a number", JsonNull, LSP_ERROR_CODE_INVALID_PARAMS)
            }
        }

        if ((packageName == null && pid == null) || (packageName != null && pid != null)) {
            throwLspError("Must provide either packageName or pid, not both", JsonNull, LSP_ERROR_CODE_INVALID_PARAMS)
        }

        if (args.containsKey("deviceId")) {
            val el = args["deviceId"]
            if (el is JsonPrimitive && el.isString) {
                val value = el.content
                if (value.isEmpty()) {
                    throwLspError("deviceId must not be empty", JsonNull, LSP_ERROR_CODE_INVALID_PARAMS)
                }
                deviceId = value
            } else {
                throwLspError("deviceId must be a string", JsonNull, LSP_ERROR_CODE_INVALID_PARAMS)
            }
        }

        if (args.containsKey("adbPath")) {
            val el = args["adbPath"]
            if (el is JsonPrimitive && el.isString) {
                val value = el.content
                if (value.isEmpty()) {
                    throwLspError("adbPath must not be empty", JsonNull, LSP_ERROR_CODE_INVALID_PARAMS)
                }
                adbPath = value
            } else {
                throwLspError("adbPath must be a string", JsonNull, LSP_ERROR_CODE_INVALID_PARAMS)
            }
        }

        if (args.containsKey("timeoutMs")) {
            val el = args["timeoutMs"]
            if (el is JsonPrimitive) {
                if (el.isString) {
                    throwLspError(
                        "timeoutMs must be a JSON number, not a string",
                        JsonNull,
                        LSP_ERROR_CODE_INVALID_PARAMS
                    )
                }
                val parsed = el.intOrNull
                if (parsed == null || parsed < 1 || parsed > 300000) {
                    throwLspError(
                        "timeoutMs must be an integer between 1 and 300000",
                        JsonNull,
                        LSP_ERROR_CODE_INVALID_PARAMS
                    )
                }
                timeoutMs = parsed
            } else {
                throwLspError("timeoutMs must be an integer", JsonNull, LSP_ERROR_CODE_INVALID_PARAMS)
            }
        }

        val service = AndroidDebugService.getInstance()
        return service.prepare(packageName, pid, deviceId, adbPath, timeoutMs)
    }

    private fun handleClaim(args: JsonObject, context: LspHandlerContext?): JsonElement {
        val host: String
        val port: Int

        if (args.containsKey("host")) {
            val el = args["host"]
            if (el is JsonPrimitive && el.isString) {
                val value = el.content
                if (value.isEmpty()) {
                    throwLspError("host must not be empty", JsonNull, LSP_ERROR_CODE_INVALID_PARAMS)
                }
                host = value
            } else {
                throwLspError("host must be a string", JsonNull, LSP_ERROR_CODE_INVALID_PARAMS)
            }
        } else {
            throwLspError("Missing host argument", JsonNull, LSP_ERROR_CODE_INVALID_PARAMS)
        }

        if (args.containsKey("port")) {
            val el = args["port"]
            if (el is JsonPrimitive) {
                if (el.isString) {
                    throwLspError("port must be a JSON number, not a string", JsonNull, LSP_ERROR_CODE_INVALID_PARAMS)
                }
                val parsed = el.intOrNull
                if (parsed == null || parsed < 1 || parsed > 65535) {
                    throwLspError(
                        "port must be an integer between 1 and 65535",
                        JsonNull,
                        LSP_ERROR_CODE_INVALID_PARAMS
                    )
                }
                port = parsed
            } else {
                throwLspError("port must be an integer", JsonNull, LSP_ERROR_CODE_INVALID_PARAMS)
            }
        } else {
            throwLspError("Missing port argument", JsonNull, LSP_ERROR_CODE_INVALID_PARAMS)
        }

        val ownerJob: Job? = context?.lspScope?.coroutineContext?.job

        val service = AndroidDebugService.getInstance()
        return service.claim(host, port, ownerJob)
    }

    private fun handleRelease(args: JsonObject, context: LspHandlerContext?): JsonElement {
        val cleanupKey: String

        if (args.containsKey("cleanupKey")) {
            val el = args["cleanupKey"]
            if (el is JsonPrimitive && el.isString) {
                val value = el.content
                if (value.isEmpty()) {
                    throwLspError("cleanupKey must not be empty", JsonNull, LSP_ERROR_CODE_INVALID_PARAMS)
                }
                cleanupKey = value
            } else {
                throwLspError("cleanupKey must be a string", JsonNull, LSP_ERROR_CODE_INVALID_PARAMS)
            }
        } else {
            throwLspError("Missing cleanupKey argument", JsonNull, LSP_ERROR_CODE_INVALID_PARAMS)
        }

        try {
            UUID.fromString(cleanupKey)
        } catch (_: IllegalArgumentException) {
            throwLspError(
                "cleanupKey must be a valid UUID string: $cleanupKey",
                JsonNull,
                LSP_ERROR_CODE_INVALID_PARAMS
            )
        }

        val service = AndroidDebugService.getInstance()
        return service.release(cleanupKey)
    }

    companion object {
        const val COMMAND_PREPARE: String = "omp.android.debug.prepare"
        const val COMMAND_CLAIM: String = "omp.android.debug.claim"
        const val COMMAND_RELEASE: String = "omp.android.debug.release"

        const val LSP_ERROR_CODE_INVALID_PARAMS: Int = -32602
        const val LSP_ERROR_CODE_REQUEST_CANCELLED: Int = -32800
    }
}
