package org.omp.intellij.android;

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
}
