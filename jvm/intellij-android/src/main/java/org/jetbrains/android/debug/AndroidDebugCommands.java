package org.jetbrains.android.debug;

import com.jetbrains.ls.api.core.LSServer;
import com.jetbrains.ls.api.features.commands.LSCommandDescriptor;
import com.jetbrains.ls.api.features.commands.LSCommandDescriptorProvider;
import com.jetbrains.ls.api.features.commands.LSCommandExecutor;
import com.jetbrains.lsp.implementation.LspHandlerContext;
import com.jetbrains.lsp.implementation.LspResponseErrorException;
import kotlin.ResultKt;
import kotlin.Unit;
import kotlin.coroutines.Continuation;
import kotlin.coroutines.intrinsics.IntrinsicsKt;
import kotlin.jvm.functions.Function1;
import kotlinx.coroutines.CancellableContinuationImpl;
import kotlinx.coroutines.Job;
import kotlinx.coroutines.JobKt;
import kotlinx.serialization.json.JsonElement;
import kotlinx.serialization.json.JsonElementKt;
import kotlinx.serialization.json.JsonObject;
import kotlinx.serialization.json.JsonPrimitive;

import java.util.List;
import java.util.UUID;
import java.util.concurrent.CancellationException;

public final class AndroidDebugCommands implements LSCommandDescriptorProvider {
    public static final String COMMAND_PREPARE = "omp.android.debug.prepare";
    public static final String COMMAND_CLAIM = "omp.android.debug.claim";
    public static final String COMMAND_RELEASE = "omp.android.debug.release";

    public static final int LSP_ERROR_CODE_INVALID_PARAMS = -32602;
    public static final int LSP_ERROR_CODE_REQUEST_CANCELLED = -32800;

    @FunctionalInterface
    public interface CommandHandler {
        JsonElement handle(JsonObject args, LspHandlerContext context) throws Exception;
    }

    @Override
    public List<LSCommandDescriptor> getCommandDescriptors() {
        return List.of(
                new LSCommandDescriptor("Prepare Android Debug", COMMAND_PREPARE, createExecutor(this::handlePrepare)),
                new LSCommandDescriptor("Claim Android Debug", COMMAND_CLAIM, createExecutor(this::handleClaim)),
                new LSCommandDescriptor("Release Android Debug", COMMAND_RELEASE, createExecutor(this::handleRelease))
        );
    }

    private LSCommandExecutor createExecutor(CommandHandler handler) {
        return (LSServer server, LspHandlerContext context, List<? extends JsonElement> arguments, Continuation<? super JsonElement> continuation) -> {
            JsonObject argsObj;
            try {
                argsObj = parseArguments(arguments);
            } catch (LspResponseErrorException e) {
                Continuation<? super JsonElement> intercepted = IntrinsicsKt.intercepted(continuation);
                CancellableContinuationImpl<JsonElement> cancellable = new CancellableContinuationImpl<>(intercepted, 1);
                cancellable.initCancellability();
                cancellable.resumeWith(ResultKt.createFailure(e));
                return cancellable.getResult();
            }

            Continuation<? super JsonElement> intercepted = IntrinsicsKt.intercepted(continuation);
            CancellableContinuationImpl<JsonElement> cancellable = new CancellableContinuationImpl<>(intercepted, 1);
            cancellable.initCancellability();

            Thread worker = Thread.ofVirtual().name("omp-android-debug-worker-", 0).start(() -> {
                try {
                    JsonElement result = handler.handle(argsObj, context);

                    // If delivery is cancelled (e.g. client disconnects while response in transit),
                    // release the prepared debug handle so it does not leak until TTL!
                    Function1<Throwable, Unit> onCancellationCallback = null;
                    if (result instanceof JsonObject obj && obj.containsKey("cleanupKey")) {
                        JsonElement keyEl = obj.get("cleanupKey");
                        if (keyEl instanceof JsonPrimitive prim && prim.isString()) {
                            String key = prim.getContent();
                            onCancellationCallback = cause -> {
                                try {
                                    AndroidDebugService.getInstance().release(key);
                                } catch (Throwable ignored) {
                                }
                                return Unit.INSTANCE;
                            };
                        }
                    }

                    cancellable.resume(result, onCancellationCallback);
                } catch (AndroidDebugException e) {
                    if ("invalid_params".equals(e.getReason())) {
                        cancellable.resumeWith(ResultKt.createFailure(new LspResponseErrorException(
                                e.getMessage(), LSP_ERROR_CODE_INVALID_PARAMS, null, e)));
                    } else {
                        cancellable.resumeWith(ResultKt.createFailure(e.toLspResponseErrorException()));
                    }
                } catch (LspResponseErrorException e) {
                    cancellable.resumeWith(ResultKt.createFailure(e));
                } catch (CancellationException | InterruptedException e) {
                    cancellable.resumeWith(ResultKt.createFailure(new LspResponseErrorException(
                            "Request cancelled", LSP_ERROR_CODE_REQUEST_CANCELLED, null, e)));
                } catch (Throwable t) {
                    if (t.getCause() instanceof CancellationException || t.getCause() instanceof InterruptedException) {
                        cancellable.resumeWith(ResultKt.createFailure(new LspResponseErrorException(
                                "Request cancelled", LSP_ERROR_CODE_REQUEST_CANCELLED, null, t)));
                    } else {
                        cancellable.resumeWith(ResultKt.createFailure(t));
                    }
                }
            });

            cancellable.invokeOnCancellation(cause -> {
                worker.interrupt();
                return Unit.INSTANCE;
            });

            return cancellable.getResult();
        };
    }

    private JsonObject parseArguments(List<? extends JsonElement> arguments) throws LspResponseErrorException {
        if (arguments == null || arguments.size() != 1) {
            throw new LspResponseErrorException(
                    "Invalid params: arguments must contain exactly one JSON object",
                    LSP_ERROR_CODE_INVALID_PARAMS,
                    null,
                    null
            );
        }
        JsonElement first = arguments.get(0);
        if (!(first instanceof JsonObject obj)) {
            throw new LspResponseErrorException(
                    "Invalid params: argument must be a JSON object",
                    LSP_ERROR_CODE_INVALID_PARAMS,
                    null,
                    null
            );
        }
        return obj;
    }

    private JsonElement handlePrepare(JsonObject args, LspHandlerContext context) throws LspResponseErrorException {
        String packageName = null;
        Integer pid = null;
        String deviceId = null;
        String adbPath = null;
        Integer timeoutMs = null;

        if (args.containsKey("packageName")) {
            JsonElement el = args.get("packageName");
            if (el instanceof JsonPrimitive prim && prim.isString()) {
                String val = prim.getContent();
                if (val.isEmpty()) {
                    throw new LspResponseErrorException("packageName must not be empty", LSP_ERROR_CODE_INVALID_PARAMS, null, null);
                }
                packageName = val;
            } else {
                throw new LspResponseErrorException("packageName must be a string", LSP_ERROR_CODE_INVALID_PARAMS, null, null);
            }
        }

        if (args.containsKey("pid")) {
            JsonElement el = args.get("pid");
            if (el instanceof JsonPrimitive prim) {
                // Must be a numeric literal, not a string representation of a number!
                if (prim.isString()) {
                    throw new LspResponseErrorException("pid must be a JSON number, not a string", LSP_ERROR_CODE_INVALID_PARAMS, null, null);
                }
                Integer parsed = JsonElementKt.getIntOrNull(prim);
                if (parsed == null || parsed <= 0) {
                    throw new LspResponseErrorException("pid must be a positive integer", LSP_ERROR_CODE_INVALID_PARAMS, null, null);
                }
                pid = parsed;
            } else {
                throw new LspResponseErrorException("pid must be a number", LSP_ERROR_CODE_INVALID_PARAMS, null, null);
            }
        }

        if ((packageName == null && pid == null) || (packageName != null && pid != null)) {
            throw new LspResponseErrorException("Must provide either packageName or pid, not both", LSP_ERROR_CODE_INVALID_PARAMS, null, null);
        }

        if (args.containsKey("deviceId")) {
            JsonElement el = args.get("deviceId");
            if (el instanceof JsonPrimitive prim && prim.isString()) {
                String val = prim.getContent();
                if (val.isEmpty()) {
                    throw new LspResponseErrorException("deviceId must not be empty", LSP_ERROR_CODE_INVALID_PARAMS, null, null);
                }
                deviceId = val;
            } else {
                throw new LspResponseErrorException("deviceId must be a string", LSP_ERROR_CODE_INVALID_PARAMS, null, null);
            }
        }

        if (args.containsKey("adbPath")) {
            JsonElement el = args.get("adbPath");
            if (el instanceof JsonPrimitive prim && prim.isString()) {
                String val = prim.getContent();
                if (val.isEmpty()) {
                    throw new LspResponseErrorException("adbPath must not be empty", LSP_ERROR_CODE_INVALID_PARAMS, null, null);
                }
                adbPath = val;
            } else {
                throw new LspResponseErrorException("adbPath must be a string", LSP_ERROR_CODE_INVALID_PARAMS, null, null);
            }
        }

        if (args.containsKey("timeoutMs")) {
            JsonElement el = args.get("timeoutMs");
            if (el instanceof JsonPrimitive prim) {
                if (prim.isString()) {
                    throw new LspResponseErrorException("timeoutMs must be a JSON number, not a string", LSP_ERROR_CODE_INVALID_PARAMS, null, null);
                }
                Integer parsed = JsonElementKt.getIntOrNull(prim);
                if (parsed == null || parsed < 1 || parsed > 300000) {
                    throw new LspResponseErrorException("timeoutMs must be an integer between 1 and 300000", LSP_ERROR_CODE_INVALID_PARAMS, null, null);
                }
                timeoutMs = parsed;
            } else {
                throw new LspResponseErrorException("timeoutMs must be an integer", LSP_ERROR_CODE_INVALID_PARAMS, null, null);
            }
        }

        AndroidDebugService service = AndroidDebugService.getInstance();
        return service.prepare(packageName, pid, deviceId, adbPath, timeoutMs);
    }

    private JsonElement handleClaim(JsonObject args, LspHandlerContext context) throws LspResponseErrorException {
        String host;
        int port;

        if (args.containsKey("host")) {
            JsonElement el = args.get("host");
            if (el instanceof JsonPrimitive prim && prim.isString()) {
                String val = prim.getContent();
                if (val.isEmpty()) {
                    throw new LspResponseErrorException("host must not be empty", LSP_ERROR_CODE_INVALID_PARAMS, null, null);
                }
                host = val;
            } else {
                throw new LspResponseErrorException("host must be a string", LSP_ERROR_CODE_INVALID_PARAMS, null, null);
            }
        } else {
            throw new LspResponseErrorException("Missing host argument", LSP_ERROR_CODE_INVALID_PARAMS, null, null);
        }

        if (args.containsKey("port")) {
            JsonElement el = args.get("port");
            if (el instanceof JsonPrimitive prim) {
                if (prim.isString()) {
                    throw new LspResponseErrorException("port must be a JSON number, not a string", LSP_ERROR_CODE_INVALID_PARAMS, null, null);
                }
                Integer parsed = JsonElementKt.getIntOrNull(prim);
                if (parsed == null || parsed < 1 || parsed > 65535) {
                    throw new LspResponseErrorException("port must be an integer between 1 and 65535", LSP_ERROR_CODE_INVALID_PARAMS, null, null);
                }
                port = parsed;
            } else {
                throw new LspResponseErrorException("port must be an integer", LSP_ERROR_CODE_INVALID_PARAMS, null, null);
            }
        } else {
            throw new LspResponseErrorException("Missing port argument", LSP_ERROR_CODE_INVALID_PARAMS, null, null);
        }

        Job ownerJob = null;
        if (context != null && context.getLspScope() != null) {
            ownerJob = JobKt.getJob(context.getLspScope().getCoroutineContext());
        }

        AndroidDebugService service = AndroidDebugService.getInstance();
        return service.claim(host, port, ownerJob);
    }

    private JsonElement handleRelease(JsonObject args, LspHandlerContext context) throws LspResponseErrorException {
        String cleanupKey;

        if (args.containsKey("cleanupKey")) {
            JsonElement el = args.get("cleanupKey");
            if (el instanceof JsonPrimitive prim && prim.isString()) {
                String val = prim.getContent();
                if (val.isEmpty()) {
                    throw new LspResponseErrorException("cleanupKey must not be empty", LSP_ERROR_CODE_INVALID_PARAMS, null, null);
                }
                cleanupKey = val;
            } else {
                throw new LspResponseErrorException("cleanupKey must be a string", LSP_ERROR_CODE_INVALID_PARAMS, null, null);
            }
        } else {
            throw new LspResponseErrorException("Missing cleanupKey argument", LSP_ERROR_CODE_INVALID_PARAMS, null, null);
        }

        try {
            UUID.fromString(cleanupKey);
        } catch (IllegalArgumentException e) {
            throw new LspResponseErrorException("cleanupKey must be a valid UUID string: " + cleanupKey, LSP_ERROR_CODE_INVALID_PARAMS, null, null);
        }

        AndroidDebugService service = AndroidDebugService.getInstance();
        return service.release(cleanupKey);
    }
}
