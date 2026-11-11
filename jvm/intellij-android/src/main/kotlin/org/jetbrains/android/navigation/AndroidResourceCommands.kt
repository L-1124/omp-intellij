package org.jetbrains.android.navigation

import com.intellij.openapi.application.readAction
import com.intellij.openapi.progress.ProgressManager
import com.jetbrains.ls.api.core.LSAnalysisContext
import com.jetbrains.ls.api.core.LSServer
import com.jetbrains.ls.api.features.commands.LSCommandDescriptor
import com.jetbrains.ls.api.features.commands.LSCommandDescriptorProvider
import com.jetbrains.ls.api.features.commands.LSCommandExecutor
import com.jetbrains.lsp.implementation.throwLspError
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull
import org.jetbrains.android.context.AndroidQueryException
import org.jetbrains.android.resource.AndroidSources
import java.net.URI
import java.nio.file.Path

class AndroidResourceCommands : LSCommandDescriptorProvider {

    override val commandDescriptors: List<LSCommandDescriptor>
        get() = listOf(
            LSCommandDescriptor(
                "Find Resource Field References",
                COMMAND_FIND_RESOURCE_FIELD_REFERENCES,
                createFindResourceFieldReferencesExecutor()
            )
        )

    private fun createFindResourceFieldReferencesExecutor(): LSCommandExecutor {
        return LSCommandExecutor { arguments ->
            val server = contextOf<LSServer>()
            val parsed = parseArguments(arguments)
            server.withAnalysisContext {
                readAction {
                    ProgressManager.checkCanceled()
                    val currentProject = contextOf<LSAnalysisContext>().project
                    AndroidSources.Scope(server, null).use { sources ->
                        val response = try {
                            AndroidNavigationService.getInstance().findResourceFieldReferencesCommand(
                                currentProject,
                                parsed.moduleName,
                                parsed.namespace,
                                parsed.type,
                                parsed.name,
                                parsed.classOrigins
                            )
                        } catch (error: AndroidQueryException) {
                            error.throwAsLspError()
                        }
                        sources.verify()
                        response
                    }
                }
            }
        }
    }

    private data class ParsedArgs(
        val moduleName: String,
        val namespace: String,
        val type: String,
        val name: String,
        val classOrigins: List<Path>
    )

    private fun parseArguments(arguments: List<JsonElement>?): ParsedArgs {
        if (arguments == null || arguments.size != 1) {
            throwLspError(
                "Expected single JsonObject argument",
                JsonNull,
                LSP_ERROR_CODE_INVALID_PARAMS
            )
        }
        val args = arguments[0] as? JsonObject
            ?: throwLspError(
                "Expected single JsonObject argument",
                JsonNull,
                LSP_ERROR_CODE_INVALID_PARAMS
            )

        val pvEl = args["protocolVersion"]
            ?: throwLspError(
                "Missing protocolVersion parameter",
                JsonNull,
                LSP_ERROR_CODE_INVALID_PARAMS
            )
        if (pvEl !is JsonPrimitive || pvEl.isString) {
            throwLspError(
                "protocolVersion must be a JSON number",
                JsonNull,
                LSP_ERROR_CODE_INVALID_PARAMS
            )
        }
        val pv = pvEl.intOrNull
            ?: throwLspError(
                "protocolVersion must be an integer",
                JsonNull,
                LSP_ERROR_CODE_INVALID_PARAMS
            )
        if (pv != 1) {
            throwLspError(
                "protocol_mismatch: protocolVersion must be 1",
                JsonNull,
                LSP_ERROR_CODE_REQUEST_FAILED
            )
        }

        val moduleName = getStringParam(args, "moduleName")
        val namespace = getStringParam(args, "namespace")
        val type = getStringParam(args, "type")
        val name = getStringParam(args, "name")

        val coEl = args["classOrigins"]
        if (coEl !is JsonArray || coEl.isEmpty()) {
            throwLspError(
                "classOrigins must be a non-empty array of file URIs",
                JsonNull,
                LSP_ERROR_CODE_INVALID_PARAMS
            )
        }
        val classOrigins = ArrayList<Path>()
        for (item in coEl) {
            if (item is JsonPrimitive && item.isString) {
                val uriStr = item.content
                try {
                    val uri = URI.create(uriStr)
                    if (!"file".equals(uri.scheme, ignoreCase = true)) {
                        throwLspError(
                            "classOrigins entries must be file URIs: $uriStr",
                            JsonNull,
                            LSP_ERROR_CODE_INVALID_PARAMS
                        )
                    }
                    classOrigins.add(Path.of(uri).toAbsolutePath().normalize())
                } catch (e: IllegalArgumentException) {
                    throwLspError(
                        "Invalid file URI in classOrigins: $uriStr",
                        JsonNull,
                        LSP_ERROR_CODE_INVALID_PARAMS,
                        e
                    )
                }
            } else {
                throwLspError(
                    "classOrigins entries must be string file URIs",
                    JsonNull,
                    LSP_ERROR_CODE_INVALID_PARAMS
                )
            }
        }

        return ParsedArgs(moduleName, namespace, type, name, classOrigins)
    }

    private fun getStringParam(args: JsonObject, key: String): String {
        val el = args[key]
        if (el is JsonPrimitive && el.isString && el.content.isNotBlank()) {
            return el.content
        }
        throwLspError(
            "Missing or invalid string parameter: $key",
            JsonNull,
            LSP_ERROR_CODE_INVALID_PARAMS
        )
    }

    companion object {
        const val COMMAND_FIND_RESOURCE_FIELD_REFERENCES = "omp.findResourceFieldReferences"

        const val LSP_ERROR_CODE_INVALID_PARAMS = -32602
        const val LSP_ERROR_CODE_REQUEST_FAILED = -32803
    }
}
