package org.jetbrains.android.run

import com.jetbrains.dap.protocol.DapRequestFailedException
import com.jetbrains.dap.protocol.Message
import org.jetbrains.annotations.ApiStatus

enum class AndroidRunErrorCode(val wireName: String) {
    INVALID_PARAMS("invalid_params"),
    PREREQUISITE_MISSING("prerequisite_missing"),
    UNSUPPORTED_ARTIFACT("unsupported_artifact"),
    UNSUPPORTED_AGP("unsupported_agp"),
    ARTIFACT_INVALID("artifact_invalid"),
    ABI_MISMATCH("abi_mismatch"),
    DEVICE_OFFLINE("device_offline"),
    TARGET_BUSY("target_busy"),
    TARGET_RUNNING("target_running"),
    AMBIGUOUS_PROCESS("ambiguous_process"),
    NOT_DEBUGGABLE("not_debuggable"),
    BUILD_FAILED("build_failed"),
    INSTALL_FAILED("install_failed"),
    START_FAILED("start_failed"),
    CANCELLED("cancelled"),
    CLEANUP_FAILED("cleanup_failed"),
}

enum class AndroidRunStage(val wireName: String) {
    CONFIGURING("configuring"),
    BUILDING("building"),
    INSTALLING("installing"),
    STARTING("starting"),
    ATTACHING("attaching"),
    CLEANUP("cleanup"),
}

data class AndroidRunError(
    val code: AndroidRunErrorCode,
    val stage: AndroidRunStage,
    val detail: String,
    val module: String? = null,
    val variant: String? = null,
    val device: String? = null,
    val exitCode: Int? = null,
    val outputTail: String? = null,
    val outcomeUnknown: Boolean = false,
    val cleanupError: String? = null,
) {
    fun withCleanupError(cleanupDetail: String): AndroidRunError {
        val normalized = cleanupDetail.trim().ifEmpty { "cleanup failed" }
        val combined = if (cleanupError.isNullOrBlank()) normalized else "$cleanupError; $normalized"
        return copy(cleanupError = boundHead(combined, MAX_CLEANUP_ERROR_LENGTH))
    }

    fun withCleanupError(failure: Throwable): AndroidRunError {
        val message = failure.message?.takeIf { it.isNotBlank() } ?: failure::class.java.simpleName
        return withCleanupError(message)
    }

    fun formattedWireMessage(): String {
        val boundedDetail = boundHead(detail, MAX_DETAIL_LENGTH)
        val base = "[${code.wireName}] ${stage.wireName}: $boundedDetail"
        val cleanup = cleanupError?.takeIf { it.isNotBlank() }
        return if (cleanup != null) {
            "$base (cleanup_failed: ${boundHead(cleanup, MAX_CLEANUP_ERROR_LENGTH)})"
        } else {
            base
        }
    }

    fun toVariables(): Map<String, String> {
        val vars = LinkedHashMap<String, String>()
        vars["code"] = code.wireName
        vars["stage"] = stage.wireName
        vars["detail"] = boundHead(detail, MAX_DETAIL_LENGTH)
        module?.takeIf { it.isNotBlank() }?.let { vars["module"] = it }
        variant?.takeIf { it.isNotBlank() }?.let { vars["variant"] = it }
        device?.takeIf { it.isNotBlank() }?.let { vars["device"] = it }
        exitCode?.let { vars["exitCode"] = it.toString() }
        outputTail?.takeIf { it.isNotBlank() }?.let { vars["outputTail"] = boundTail(it, MAX_OUTPUT_TAIL_LENGTH) }
        if (outcomeUnknown) {
            vars["outcomeUnknown"] = "true"
        }
        cleanupError?.takeIf { it.isNotBlank() }?.let {
            vars["cleanupError"] = boundHead(it, MAX_CLEANUP_ERROR_LENGTH)
        }
        return vars
    }

    @Suppress("UnstableApiUsage")
    @ApiStatus.Experimental
    fun toDapMessage(): Message = Message(
        id = DAP_ERROR_MESSAGE_ID,
        format = DAP_ERROR_MESSAGE_FORMAT,
        variables = toVariables(),
        sendTelemetry = false,
    )

    @Suppress("UnstableApiUsage")
    @ApiStatus.Experimental
    fun toDapException(cause: Throwable? = null): DapRequestFailedException {
        val ex = DapRequestFailedException(formattedWireMessage(), toDapMessage())
        if (cause != null && cause !== ex) {
            ex.initCause(cause)
        }
        return ex
    }

    fun toException(cause: Throwable? = null): AndroidRunException = AndroidRunException(this, cause)

    companion object {
        const val DAP_ERROR_MESSAGE_ID: Int = 3001
        const val DAP_ERROR_MESSAGE_FORMAT: String = "{code}: {detail}"
        const val MAX_DETAIL_LENGTH: Int = 1024
        const val MAX_OUTPUT_TAIL_LENGTH: Int = 2048
        const val MAX_CLEANUP_ERROR_LENGTH: Int = 512

        private fun boundHead(text: String, maxLength: Int): String {
            if (text.length <= maxLength) return text
            if (maxLength <= 3) return text.take(maxLength)
            return text.take(maxLength - 3) + "..."
        }

        private fun boundTail(text: String, maxLength: Int): String {
            if (text.length <= maxLength) return text
            if (maxLength <= 3) return text.takeLast(maxLength)
            return "..." + text.takeLast(maxLength - 3)
        }
    }
}

class AndroidRunException(
    val error: AndroidRunError,
    cause: Throwable? = null,
) : RuntimeException(error.formattedWireMessage(), cause) {
    fun withCleanupError(failure: Throwable): AndroidRunException {
        val updated = AndroidRunException(error.withCleanupError(failure), cause)
        if (failure !== this) {
            updated.addSuppressed(failure)
        }
        return updated
    }

    fun withCleanupError(cleanupDetail: String): AndroidRunException =
        AndroidRunException(error.withCleanupError(cleanupDetail), cause)

    @Suppress("UnstableApiUsage")
    @ApiStatus.Experimental
    fun toDapException(): DapRequestFailedException = error.toDapException(this)
}
