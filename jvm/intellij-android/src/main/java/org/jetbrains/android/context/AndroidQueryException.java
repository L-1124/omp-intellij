package org.jetbrains.android.context;

/**
 * Runtime exception representing recognized Android LSP semantic query failures
 * with protocol-compliant error codes and reasons (-32803 RequestFailed).
 * <p>
 * Allows provider wrappers to map cleanly to LspResponseErrorException
 * without collapsing into internal server error (-32603).
 */
public class AndroidQueryException extends RuntimeException {
    public static final int REQUEST_FAILED = -32803;

    public static final String REASON_MODEL_UNAVAILABLE = "model_unavailable";
    public static final String REASON_TARGET_UNRESOLVED = "target_unresolved";
    public static final String REASON_AMBIGUOUS_TARGET = "ambiguous_target";
    public static final String REASON_TIMEOUT = "timeout";
    public static final String REASON_MISSING_SNAPSHOT = "missing_snapshot";
    public static final String REASON_STALE_SNAPSHOT = "stale_snapshot";
    public static final String REASON_AMBIGUOUS_VARIANT = "ambiguous_variant";
    public static final String REASON_CLASS_NOT_FOUND = "class_not_found";
    public static final String REASON_FIELD_NOT_FOUND = "field_not_found";
    public static final String REASON_OWNER_UNRESOLVED = "owner_unresolved";
    public static final String REASON_PROTOCOL_MISMATCH = "protocol_mismatch";

    private final String reason;
    private final int errorCode;

    public AndroidQueryException(String reason) {
        this(reason, REQUEST_FAILED, null);
    }

    public AndroidQueryException(String reason, int errorCode) {
        this(reason, errorCode, null);
    }

    public AndroidQueryException(String reason, int errorCode, Throwable cause) {
        super(reason, cause);
        this.reason = reason;
        this.errorCode = errorCode;
    }

    public String getReason() {
        return reason;
    }

    public int getErrorCode() {
        return errorCode;
    }

    public static AndroidQueryException modelUnavailable(String message) {
        return new AndroidQueryException(message != null ? REASON_MODEL_UNAVAILABLE + ": " + message : REASON_MODEL_UNAVAILABLE);
    }

    public static AndroidQueryException targetUnresolved(String fqcn) {
        return new AndroidQueryException(fqcn != null ? REASON_TARGET_UNRESOLVED + ": " + fqcn : REASON_TARGET_UNRESOLVED);
    }

    public static AndroidQueryException ambiguousTarget(String fqcn) {
        return new AndroidQueryException(fqcn != null ? REASON_AMBIGUOUS_TARGET + ": " + fqcn : REASON_AMBIGUOUS_TARGET);
    }

    public static AndroidQueryException missingSnapshot(String message) {
        return new AndroidQueryException(message != null ? REASON_MISSING_SNAPSHOT + ": " + message : REASON_MISSING_SNAPSHOT);
    }

    public static AndroidQueryException staleSnapshot(String message) {
        return new AndroidQueryException(message != null ? REASON_STALE_SNAPSHOT + ": " + message : REASON_STALE_SNAPSHOT);
    }

    public static AndroidQueryException ambiguousVariant(String message) {
        return new AndroidQueryException(message != null ? REASON_AMBIGUOUS_VARIANT + ": " + message : REASON_AMBIGUOUS_VARIANT);
    }

    public static AndroidQueryException classNotFound(String fqcn) {
        return new AndroidQueryException(fqcn != null ? REASON_CLASS_NOT_FOUND + ": " + fqcn : REASON_CLASS_NOT_FOUND);
    }

    public static AndroidQueryException fieldNotFound(String field) {
        return new AndroidQueryException(field != null ? REASON_FIELD_NOT_FOUND + ": " + field : REASON_FIELD_NOT_FOUND);
    }

    public static AndroidQueryException ownerUnresolved(String message) {
        return new AndroidQueryException(message != null ? REASON_OWNER_UNRESOLVED + ": " + message : REASON_OWNER_UNRESOLVED);
    }

    public static AndroidQueryException protocolMismatch(String message) {
        return new AndroidQueryException(message != null ? REASON_PROTOCOL_MISMATCH + ": " + message : REASON_PROTOCOL_MISMATCH);
    }

    public com.jetbrains.lsp.implementation.LspResponseErrorException toLspResponseErrorException() {
        return new com.jetbrains.lsp.implementation.LspResponseErrorException(getMessage(), errorCode, null, this);
    }
}
