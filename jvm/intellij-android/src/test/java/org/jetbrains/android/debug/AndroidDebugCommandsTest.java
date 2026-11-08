package org.jetbrains.android.debug;

import com.jetbrains.ls.api.features.commands.LSCommandDescriptor;
import com.jetbrains.ls.api.features.commands.LSCommandExecutor;
import com.jetbrains.lsp.implementation.LspResponseErrorException;
import kotlin.Unit;
import kotlin.coroutines.Continuation;
import kotlin.coroutines.CoroutineContext;
import kotlin.coroutines.EmptyCoroutineContext;
import kotlinx.serialization.json.*;
import org.junit.Before;
import org.junit.Test;

import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;

import static org.junit.Assert.*;

public class AndroidDebugCommandsTest {
    private AndroidDebugCommands commands;

    @Before
    public void setUp() {
        commands = new AndroidDebugCommands();
    }

    private LSCommandDescriptor findDescriptor(String name) {
        for (LSCommandDescriptor desc : commands.getCommandDescriptors()) {
            if (name.equals(desc.getName())) {
                return desc;
            }
        }
        return null;
    }

    private JsonElement executeCommand(LSCommandDescriptor descriptor, List<? extends JsonElement> args) throws Throwable {
        CompletableFuture<JsonElement> future = new CompletableFuture<>();
        Continuation<JsonElement> cont = new Continuation<>() {
            @Override
            public CoroutineContext getContext() {
                return EmptyCoroutineContext.INSTANCE;
            }

            @Override
            public void resumeWith(Object result) {
                if (result instanceof kotlin.Result.Failure failure) {
                    future.completeExceptionally(failure.exception);
                } else {
                    future.complete((JsonElement) result);
                }
            }
        };

        LSCommandExecutor executor = descriptor.getExecutor();
        Object immediate = executor.execute(null, null, args, cont);
        if (immediate != kotlin.coroutines.intrinsics.IntrinsicsKt.getCOROUTINE_SUSPENDED()) {
            return (JsonElement) immediate;
        }
        try {
            return future.get();
        } catch (ExecutionException e) {
            throw e.getCause();
        }
    }

    @Test
    public void testInvalidArgumentsCountThrows32602() {
        LSCommandDescriptor prepare = findDescriptor("omp.android.debug.prepare");
        assertNotNull(prepare);

        // Empty args list
        try {
            executeCommand(prepare, List.of());
            fail("Expected -32602 for empty args");
        } catch (Throwable t) {
            assertTrue(t instanceof LspResponseErrorException);
            assertEquals(-32602, ((LspResponseErrorException) t).getErrorCode());
        }

        // Multiple args
        try {
            executeCommand(prepare, List.of(new JsonObject(Map.of()), new JsonObject(Map.of())));
            fail("Expected -32602 for multiple args");
        } catch (Throwable t) {
            assertTrue(t instanceof LspResponseErrorException);
            assertEquals(-32602, ((LspResponseErrorException) t).getErrorCode());
        }

        // Arg not JsonObject
        try {
            executeCommand(prepare, List.of(JsonElementKt.JsonPrimitive("not an object")));
            fail("Expected -32602 for non-object arg");
        } catch (Throwable t) {
            assertTrue(t instanceof LspResponseErrorException);
            assertEquals(-32602, ((LspResponseErrorException) t).getErrorCode());
        }
    }

    @Test
    public void testPrepareValidationThrows32602() {
        LSCommandDescriptor prepare = findDescriptor("omp.android.debug.prepare");

        // Missing both packageName and pid
        try {
            executeCommand(prepare, List.of(new JsonObject(Map.of())));
            fail("Expected -32602 when both packageName and pid are missing");
        } catch (Throwable t) {
            assertTrue(t instanceof LspResponseErrorException);
            assertEquals(-32602, ((LspResponseErrorException) t).getErrorCode());
        }

        // Both packageName and pid provided
        try {
            executeCommand(prepare, List.of(new JsonObject(Map.of(
                    "packageName", JsonElementKt.JsonPrimitive("com.example.app"),
                    "pid", JsonElementKt.JsonPrimitive(1234)
            ))));
            fail("Expected -32602 when both packageName and pid are provided");
        } catch (Throwable t) {
            assertTrue(t instanceof LspResponseErrorException);
            assertEquals(-32602, ((LspResponseErrorException) t).getErrorCode());
        }

        // Empty string packageName
        try {
            executeCommand(prepare, List.of(new JsonObject(Map.of(
                    "packageName", JsonElementKt.JsonPrimitive("")
            ))));
            fail("Expected -32602 for empty string packageName");
        } catch (Throwable t) {
            assertTrue(t instanceof LspResponseErrorException);
            assertEquals(-32602, ((LspResponseErrorException) t).getErrorCode());
        }

        // String-typed pid
        try {
            executeCommand(prepare, List.of(new JsonObject(Map.of(
                    "pid", JsonElementKt.JsonPrimitive("1234")
            ))));
            fail("Expected -32602 for string-typed pid");
        } catch (Throwable t) {
            assertTrue(t instanceof LspResponseErrorException);
            assertEquals(-32602, ((LspResponseErrorException) t).getErrorCode());
        }

        // Negative pid
        try {
            executeCommand(prepare, List.of(new JsonObject(Map.of(
                    "pid", JsonElementKt.JsonPrimitive(-5)
            ))));
            fail("Expected -32602 for negative pid");
        } catch (Throwable t) {
            assertTrue(t instanceof LspResponseErrorException);
            assertEquals(-32602, ((LspResponseErrorException) t).getErrorCode());
        }

        // String-typed timeoutMs
        try {
            executeCommand(prepare, List.of(new JsonObject(Map.of(
                    "packageName", JsonElementKt.JsonPrimitive("com.example.app"),
                    "timeoutMs", JsonElementKt.JsonPrimitive("5000")
            ))));
            fail("Expected -32602 for string-typed timeoutMs");
        } catch (Throwable t) {
            assertTrue(t instanceof LspResponseErrorException);
            assertEquals(-32602, ((LspResponseErrorException) t).getErrorCode());
        }

        // Empty string deviceId
        try {
            executeCommand(prepare, List.of(new JsonObject(Map.of(
                    "packageName", JsonElementKt.JsonPrimitive("com.example.app"),
                    "deviceId", JsonElementKt.JsonPrimitive("")
            ))));
            fail("Expected -32602 for empty string deviceId");
        } catch (Throwable t) {
            assertTrue(t instanceof LspResponseErrorException);
            assertEquals(-32602, ((LspResponseErrorException) t).getErrorCode());
        }

        // Empty string adbPath
        try {
            executeCommand(prepare, List.of(new JsonObject(Map.of(
                    "packageName", JsonElementKt.JsonPrimitive("com.example.app"),
                    "adbPath", JsonElementKt.JsonPrimitive("")
            ))));
            fail("Expected -32602 for empty string adbPath");
        } catch (Throwable t) {
            assertTrue(t instanceof LspResponseErrorException);
            assertEquals(-32602, ((LspResponseErrorException) t).getErrorCode());
        }

        // Invalid timeoutMs (< 1)
        try {
            executeCommand(prepare, List.of(new JsonObject(Map.of(
                    "packageName", JsonElementKt.JsonPrimitive("com.example.app"),
                    "timeoutMs", JsonElementKt.JsonPrimitive(0)
            ))));
            fail("Expected -32602 for timeoutMs < 1");
        } catch (Throwable t) {
            assertTrue(t instanceof LspResponseErrorException);
            assertEquals(-32602, ((LspResponseErrorException) t).getErrorCode());
        }
    }

    @Test
    public void testClaimValidationThrows32602() {
        LSCommandDescriptor claim = findDescriptor("omp.android.debug.claim");

        // Missing port
        try {
            executeCommand(claim, List.of(new JsonObject(Map.of(
                    "host", JsonElementKt.JsonPrimitive("127.0.0.1")
            ))));
            fail("Expected -32602 when port is missing");
        } catch (Throwable t) {
            assertTrue(t instanceof LspResponseErrorException);
            assertEquals(-32602, ((LspResponseErrorException) t).getErrorCode());
        }

        // Missing host
        try {
            executeCommand(claim, List.of(new JsonObject(Map.of(
                    "port", JsonElementKt.JsonPrimitive(50000)
            ))));
            fail("Expected -32602 when host is missing");
        } catch (Throwable t) {
            assertTrue(t instanceof LspResponseErrorException);
            assertEquals(-32602, ((LspResponseErrorException) t).getErrorCode());
        }

        // Empty string host
        try {
            executeCommand(claim, List.of(new JsonObject(Map.of(
                    "host", JsonElementKt.JsonPrimitive(""),
                    "port", JsonElementKt.JsonPrimitive(50000)
            ))));
            fail("Expected -32602 for empty string host");
        } catch (Throwable t) {
            assertTrue(t instanceof LspResponseErrorException);
            assertEquals(-32602, ((LspResponseErrorException) t).getErrorCode());
        }

        // String-typed port
        try {
            executeCommand(claim, List.of(new JsonObject(Map.of(
                    "host", JsonElementKt.JsonPrimitive("127.0.0.1"),
                    "port", JsonElementKt.JsonPrimitive("50000")
            ))));
            fail("Expected -32602 for string-typed port");
        } catch (Throwable t) {
            assertTrue(t instanceof LspResponseErrorException);
            assertEquals(-32602, ((LspResponseErrorException) t).getErrorCode());
        }

        // Out of range port
        try {
            executeCommand(claim, List.of(new JsonObject(Map.of(
                    "host", JsonElementKt.JsonPrimitive("127.0.0.1"),
                    "port", JsonElementKt.JsonPrimitive(70000)
            ))));
            fail("Expected -32602 for port > 65535");
        } catch (Throwable t) {
            assertTrue(t instanceof LspResponseErrorException);
            assertEquals(-32602, ((LspResponseErrorException) t).getErrorCode());
        }
    }

    @Test
    public void testReleaseValidationThrows32602() {
        LSCommandDescriptor release = findDescriptor("omp.android.debug.release");

        // Missing cleanupKey
        try {
            executeCommand(release, List.of(new JsonObject(Map.of())));
            fail("Expected -32602 when cleanupKey is missing");
        } catch (Throwable t) {
            assertTrue(t instanceof LspResponseErrorException);
            assertEquals(-32602, ((LspResponseErrorException) t).getErrorCode());
        }

        // Empty string cleanupKey
        try {
            executeCommand(release, List.of(new JsonObject(Map.of(
                    "cleanupKey", JsonElementKt.JsonPrimitive("")
            ))));
            fail("Expected -32602 for empty string cleanupKey");
        } catch (Throwable t) {
            assertTrue(t instanceof LspResponseErrorException);
            assertEquals(-32602, ((LspResponseErrorException) t).getErrorCode());
        }

        // Invalid UUID string
        try {
            executeCommand(release, List.of(new JsonObject(Map.of(
                    "cleanupKey", JsonElementKt.JsonPrimitive("not-a-uuid")
            ))));
            fail("Expected -32602 for invalid UUID string");
        } catch (Throwable t) {
            assertTrue(t instanceof LspResponseErrorException);
            assertEquals(-32602, ((LspResponseErrorException) t).getErrorCode());
        }
    }

    @Test
    public void testClaimReturnsUnclaimedForUnknownPort() throws Throwable {
        LSCommandDescriptor claim = findDescriptor("omp.android.debug.claim");

        JsonElement res = executeCommand(claim, List.of(new JsonObject(Map.of(
                "host", JsonElementKt.JsonPrimitive("127.0.0.1"),
                "port", JsonElementKt.JsonPrimitive(59999)
        ))));

        assertTrue(res instanceof JsonObject);
        JsonObject obj = (JsonObject) res;
        assertTrue(obj.containsKey("claimed"));
        assertFalse(JsonElementKt.getBoolean((JsonPrimitive) obj.get("claimed")));
    }

    @Test
    public void testReleaseReturnsAlreadyCleanedForUnknownKey() throws Throwable {
        LSCommandDescriptor release = findDescriptor("omp.android.debug.release");

        JsonElement res = executeCommand(release, List.of(new JsonObject(Map.of(
                "cleanupKey", JsonElementKt.JsonPrimitive("00000000-0000-0000-0000-000000000000")
        ))));

        assertTrue(res instanceof JsonObject);
        JsonObject obj = (JsonObject) res;
        assertTrue(obj.containsKey("success"));
        assertTrue(JsonElementKt.getBoolean((JsonPrimitive) obj.get("success")));
        assertTrue(obj.containsKey("cleaned"));
        assertFalse(JsonElementKt.getBoolean((JsonPrimitive) obj.get("cleaned")));
        assertEquals("already_cleaned", ((JsonPrimitive) obj.get("reason")).getContent());
    }
}
