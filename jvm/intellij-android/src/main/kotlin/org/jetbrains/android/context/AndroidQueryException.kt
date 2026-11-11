package org.jetbrains.android.context

import com.jetbrains.lsp.implementation.throwLspError
import kotlinx.serialization.json.JsonNull

open class AndroidQueryException @JvmOverloads constructor(
    val reason: String,
    val errorCode: Int = REQUEST_FAILED,
    cause: Throwable? = null
) : RuntimeException(reason, cause) {
    fun throwAsLspError(): Nothing = throwLspError(reason, JsonNull, errorCode, this)

    companion object {
        const val REQUEST_FAILED = -32803
        const val REASON_MODEL_UNAVAILABLE = "model_unavailable"
        const val REASON_TARGET_UNRESOLVED = "target_unresolved"
        const val REASON_AMBIGUOUS_TARGET = "ambiguous_target"
        const val REASON_TIMEOUT = "timeout"
        const val REASON_MISSING_SNAPSHOT = "missing_snapshot"
        const val REASON_STALE_SNAPSHOT = "stale_snapshot"
        const val REASON_AMBIGUOUS_VARIANT = "ambiguous_variant"
        const val REASON_CLASS_NOT_FOUND = "class_not_found"
        const val REASON_FIELD_NOT_FOUND = "field_not_found"
        const val REASON_OWNER_UNRESOLVED = "owner_unresolved"
        const val REASON_PROTOCOL_MISMATCH = "protocol_mismatch"

        @JvmStatic
        fun modelUnavailable(message: String?) = AndroidQueryException(
            if (message == null) REASON_MODEL_UNAVAILABLE else "$REASON_MODEL_UNAVAILABLE: $message"
        )

        @JvmStatic
        fun targetUnresolved(fqcn: String?) = AndroidQueryException(
            if (fqcn == null) REASON_TARGET_UNRESOLVED else "$REASON_TARGET_UNRESOLVED: $fqcn"
        )

        @JvmStatic
        fun ambiguousTarget(fqcn: String?) = AndroidQueryException(
            if (fqcn == null) REASON_AMBIGUOUS_TARGET else "$REASON_AMBIGUOUS_TARGET: $fqcn"
        )

        @JvmStatic
        fun missingSnapshot(message: String?) = AndroidQueryException(
            if (message == null) REASON_MISSING_SNAPSHOT else "$REASON_MISSING_SNAPSHOT: $message"
        )

        @JvmStatic
        fun staleSnapshot(message: String?) = AndroidQueryException(
            if (message == null) REASON_STALE_SNAPSHOT else "$REASON_STALE_SNAPSHOT: $message"
        )

        @JvmStatic
        fun ambiguousVariant(message: String?) = AndroidQueryException(
            if (message == null) REASON_AMBIGUOUS_VARIANT else "$REASON_AMBIGUOUS_VARIANT: $message"
        )

        @JvmStatic
        fun classNotFound(fqcn: String?) = AndroidQueryException(
            if (fqcn == null) REASON_CLASS_NOT_FOUND else "$REASON_CLASS_NOT_FOUND: $fqcn"
        )

        @JvmStatic
        fun fieldNotFound(field: String?) = AndroidQueryException(
            if (field == null) REASON_FIELD_NOT_FOUND else "$REASON_FIELD_NOT_FOUND: $field"
        )

        @JvmStatic
        fun ownerUnresolved(message: String?) = AndroidQueryException(
            if (message == null) REASON_OWNER_UNRESOLVED else "$REASON_OWNER_UNRESOLVED: $message"
        )

        @JvmStatic
        fun protocolMismatch(message: String?) = AndroidQueryException(
            if (message == null) REASON_PROTOCOL_MISMATCH else "$REASON_PROTOCOL_MISMATCH: $message"
        )
    }
}
