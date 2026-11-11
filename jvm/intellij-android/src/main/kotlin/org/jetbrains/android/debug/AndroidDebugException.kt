package org.jetbrains.android.debug

import com.jetbrains.lsp.implementation.throwLspError
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

class AndroidDebugException @JvmOverloads constructor(
    val reason: String,
    message: String? = null,
    val candidates: JsonElement? = null,
    cause: Throwable? = null
) : RuntimeException(message, cause) {

    constructor(reason: String, message: String?, cause: Throwable?) : this(reason, message, null, cause)

    fun toErrorData(): JsonObject {
        val map = linkedMapOf<String, JsonElement>()
        map["reason"] = JsonPrimitive(reason)
        map["message"] = JsonPrimitive(message ?: "")
        if (candidates != null) {
            map["candidates"] = candidates
        }
        return JsonObject(map)
    }

    fun throwAsLspError(): Nothing {
        throwLspError(
            message = message ?: "",
            data = toErrorData(),
            code = LSP_ERROR_CODE_FAILED,
            cause = this
        )
    }

    companion object {
        const val LSP_ERROR_CODE_FAILED: Int = -32803
    }
}
