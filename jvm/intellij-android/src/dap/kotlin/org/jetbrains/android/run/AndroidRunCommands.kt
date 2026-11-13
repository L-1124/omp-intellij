package org.jetbrains.android.run

import com.jetbrains.ls.api.core.LSServer
import com.jetbrains.ls.api.features.commands.LSCommandDescriptor
import com.jetbrains.ls.api.features.commands.LSCommandDescriptorProvider
import com.jetbrains.ls.api.features.commands.LSCommandExecutor
import com.jetbrains.lsp.implementation.LspHandlerContext
import com.jetbrains.lsp.implementation.throwLspError
import com.jetbrains.lsp.protocol.ErrorCodes
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.isActive
import kotlinx.coroutines.job
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.jetbrains.android.debug.AndroidDebugException
import org.jetbrains.android.debug.AndroidDebugService
import org.jetbrains.android.debug.AndroidEnumeratedDevice
import org.jetbrains.annotations.TestOnly
import java.nio.file.InvalidPathException
import java.nio.file.Path

class AndroidRunCommands @TestOnly constructor(
    private val deviceEnumerator: suspend (ownerJob: Job, requestedDeviceId: String?) -> List<AndroidEnumeratedDevice> = { ownerJob, requestedDeviceId ->
        AndroidDebugService.getInstance(ownerJob).listOnlineDevices(requestedDeviceId = requestedDeviceId)
    },
    private val gradleProjectFactory: (AndroidGradleContext) -> AndroidGradleProject = { context ->
        AndroidGradleProject(context)
    },
    private val contextCapturer: (LSServer) -> AndroidGradleContext = { server ->
        AndroidGradleContext.capture(server)
    },
) : LSCommandDescriptorProvider {

    constructor() : this(
        deviceEnumerator = { ownerJob, requestedDeviceId ->
            AndroidDebugService.getInstance(ownerJob).listOnlineDevices(requestedDeviceId = requestedDeviceId)
        }
    )

    override val commandDescriptors: List<LSCommandDescriptor>
        get() = listOf(
            LSCommandDescriptor(
                "List Android Run Targets",
                COMMAND_TARGETS,
                createTargetsExecutor(),
            )
        )

    private fun createTargetsExecutor(): LSCommandExecutor {
        return LSCommandExecutor { arguments ->
            val server = contextOf<LSServer>()
            val parsed = parseTargetsArguments(arguments)
            val gradleContext = contextCapturer(server)

            val effectiveBuildRoot = resolveBuildRoot(
                requestedBuildRoot = parsed.buildRoot,
                workspaceDirectory = gradleContext.workspaceDirectory,
            )

            val devices = try {
                deviceEnumerator(contextOf<LspHandlerContext>().lspScope.coroutineContext.job, parsed.deviceId)
            } catch (e: CancellationException) {
                throw e
            } catch (e: AndroidDebugException) {
                throwDebugAsLspError(e, parsed.deviceId)
            }

            val modelResult = try {
                gradleProjectFactory(gradleContext).queryModels(effectiveBuildRoot)
            } catch (e: CancellationException) {
                throw e
            } catch (e: AndroidRunException) {
                if (e.error.code == AndroidRunErrorCode.CANCELLED && !currentCoroutineContext().isActive) {
                    throw CancellationException("Android targets query cancelled", e)
                }
                throwRunErrorAsLspError(e)
            }

            buildTargetsResponse(devices, modelResult)
        }
    }

    private data class ParsedTargetsArgs(
        val buildRoot: Path?,
        val deviceId: String?,
    )

    private fun parseTargetsArguments(arguments: List<JsonElement>?): ParsedTargetsArgs {
        if (arguments == null || arguments.size != 1) {
            throwInvalidParams("Expected single JSON object argument")
        }
        val argObj = arguments[0] as? JsonObject
            ?: throwInvalidParams("Expected single JSON object argument")

        for (key in argObj.keys) {
            if (key !in TARGETS_KEYS) {
                throwInvalidParams("Unsupported parameter for $COMMAND_TARGETS: $key")
            }
        }

        val buildRoot = argObj["buildRoot"]?.let { rawEl ->
            val raw = requireNonBlankString(rawEl, "buildRoot")
            try {
                Path.of(raw.trim())
            } catch (e: InvalidPathException) {
                throwInvalidParams("buildRoot is not a valid path: $raw", e)
            }
        }

        val deviceId = argObj["deviceId"]?.let { rawEl ->
            requireNonBlankString(rawEl, "deviceId").trim()
        }

        return ParsedTargetsArgs(
            buildRoot = buildRoot,
            deviceId = deviceId,
        )
    }

    private fun resolveBuildRoot(requestedBuildRoot: Path?, workspaceDirectory: Path?): Path {
        if (requestedBuildRoot == null) {
            return workspaceDirectory
                ?: throwInvalidParams("buildRoot is required when workspace directory is unavailable")
        }
        if (requestedBuildRoot.isAbsolute) {
            return requestedBuildRoot.normalize()
        }
        val base = workspaceDirectory
            ?: throwInvalidParams("Relative buildRoot requires an open workspace directory")
        return base.resolve(requestedBuildRoot).normalize()
    }

    private fun requireNonBlankString(element: JsonElement, fieldName: String): String {
        if (element is JsonNull || element !is JsonPrimitive || !element.isString) {
            throwInvalidParams("$fieldName must be a string")
        }
        if (element.content.isBlank()) {
            throwInvalidParams("$fieldName must not be blank")
        }
        return element.content
    }

    private fun buildTargetsResponse(
        devices: List<AndroidEnumeratedDevice>,
        modelResult: AndroidRunModelResultDto,
    ): JsonObject = buildJsonObject {
        put(
            "devices",
            buildJsonArray {
                for (device in devices) {
                    add(
                        buildJsonObject {
                            put("deviceId", device.deviceId)
                            put("state", device.state)
                            put(
                                "abis",
                                JsonArray(device.abis.map { JsonPrimitive(it) }),
                            )
                        }
                    )
                }
            }
        )
        put(
            "modules",
            buildJsonArray {
                for (project in modelResult.projects) {
                    if (!project.isApplication) {
                        continue
                    }
                    add(
                        buildJsonObject {
                            put("buildRoot", project.buildRoot.toPath().toAbsolutePath().normalize().toString())
                            put("module", project.module)
                            put(
                                "variants",
                                buildJsonArray {
                                    for (variant in project.variants) {
                                        add(
                                            buildJsonObject {
                                                put("name", variant.name)
                                                put(
                                                    "assembleTask",
                                                    variant.assembleTask?.let(::JsonPrimitive) ?: JsonNull,
                                                )
                                                put(
                                                    "listingFile",
                                                    variant.listingFile?.toPath()?.toAbsolutePath()?.normalize()
                                                        ?.toString()
                                                        ?.let(::JsonPrimitive) ?: JsonNull,
                                                )
                                                put(
                                                    "abiFilters",
                                                    variant.abiFilters?.let { filters ->
                                                        JsonArray(filters.sorted().map(::JsonPrimitive))
                                                    } ?: JsonNull,
                                                )
                                            }
                                        )
                                    }
                                }
                            )
                        }
                    )
                }
            }
        )
        put(
            "includedBuilds",
            JsonArray(
                modelResult.includedBuildRoots.map {
                    JsonPrimitive(it.toPath().toAbsolutePath().normalize().toString())
                }
            )
        )
    }

    private fun throwInvalidParams(detail: String, cause: Throwable? = null): Nothing {
        val err = AndroidRunError(
            code = AndroidRunErrorCode.INVALID_PARAMS,
            stage = AndroidRunStage.CONFIGURING,
            detail = detail,
        )
        throwLspError(err.formattedWireMessage(), JsonNull, ErrorCodes.InvalidParams, cause)
    }

    private fun throwDebugAsLspError(e: AndroidDebugException, deviceId: String?): Nothing {
        val code = when (e.reason) {
            "device_offline", "no_device", "unauthorized_device" -> AndroidRunErrorCode.DEVICE_OFFLINE
            "adb_unavailable" -> AndroidRunErrorCode.PREREQUISITE_MISSING
            "invalid_params" -> AndroidRunErrorCode.INVALID_PARAMS
            else -> AndroidRunErrorCode.START_FAILED
        }
        val err = AndroidRunError(
            code = code,
            stage = AndroidRunStage.CONFIGURING,
            detail = e.message ?: "ADB device query failed (${e.reason})",
            device = deviceId,
        )
        val lspCode = if (code == AndroidRunErrorCode.INVALID_PARAMS) {
            ErrorCodes.InvalidParams
        } else {
            ErrorCodes.RequestFailed
        }
        throwLspError(err.formattedWireMessage(), JsonNull, lspCode, e)
    }

    private fun throwRunErrorAsLspError(e: AndroidRunException): Nothing {
        val lspCode = when (e.error.code) {
            AndroidRunErrorCode.INVALID_PARAMS -> ErrorCodes.InvalidParams
            AndroidRunErrorCode.CANCELLED -> ErrorCodes.RequestCancelled
            else -> ErrorCodes.RequestFailed
        }
        throwLspError(e.error.formattedWireMessage(), JsonNull, lspCode, e)
    }

    companion object {
        const val COMMAND_TARGETS = "org.intellij.android.run.targets"
        private val TARGETS_KEYS = setOf("buildRoot", "deviceId")
    }
}
