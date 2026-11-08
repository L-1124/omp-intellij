package org.jetbrains.android.debug;

import com.jetbrains.lsp.implementation.LspResponseErrorException;
import kotlinx.serialization.json.JsonElement;
import kotlinx.serialization.json.JsonElementKt;
import kotlinx.serialization.json.JsonObject;

import java.util.LinkedHashMap;
import java.util.Map;

public final class AndroidDebugException extends RuntimeException {
    public static final int LSP_ERROR_CODE_FAILED = -32803;

    private final String reason;
    private final JsonElement candidates;

    public AndroidDebugException(String reason, String message) {
        this(reason, message, null, null);
    }

    public AndroidDebugException(String reason, String message, Throwable cause) {
        this(reason, message, null, cause);
    }

    public AndroidDebugException(String reason, String message, JsonElement candidates) {
        this(reason, message, candidates, null);
    }

    public AndroidDebugException(String reason, String message, JsonElement candidates, Throwable cause) {
        super(message, cause);
        this.reason = reason;
        this.candidates = candidates;
    }

    public String getReason() {
        return reason;
    }

    public JsonElement getCandidates() {
        return candidates;
    }

    public JsonObject toErrorData() {
        Map<String, JsonElement> map = new LinkedHashMap<>();
        map.put("reason", JsonElementKt.JsonPrimitive(reason));
        map.put("message", JsonElementKt.JsonPrimitive(getMessage() != null ? getMessage() : ""));
        if (candidates != null) {
            map.put("candidates", candidates);
        }
        return new JsonObject(map);
    }

    public LspResponseErrorException toLspResponseErrorException() {
        return new LspResponseErrorException(getMessage(), LSP_ERROR_CODE_FAILED, toErrorData(), this);
    }
}
