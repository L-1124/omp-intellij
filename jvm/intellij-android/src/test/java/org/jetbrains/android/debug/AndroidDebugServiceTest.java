package org.jetbrains.android.debug;

import com.android.adblib.AdbSessionHost;
import kotlinx.serialization.json.JsonElementKt;
import kotlinx.serialization.json.JsonObject;
import kotlinx.serialization.json.JsonPrimitive;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.Assert.*;

public class AndroidDebugServiceTest {
    private AdbSessionHost host;
    private AndroidDebugHandles handles;
    private AndroidDebugService service;

    @Before
    public void setUp() {
        host = new AdbSessionHost();
        handles = new AndroidDebugHandles();
        service = new AndroidDebugService(host, handles);
    }

    @After
    public void tearDown() {
        if (service != null) {
            service.dispose();
        }
    }

    @Test
    public void testExplicitNonExistentAdbPathThrowsAdbNotFound() {
        try {
            service.resolveAdbPath("Z:/non_existent_path_to_adb_binary");
            fail("Expected adb_not_found for non-existent adb binary");
        } catch (AndroidDebugException e) {
            assertEquals("adb_not_found", e.getReason());
        }
    }

    @Test
    public void testExplicitEmptyOrBlankAdbPathThrowsInvalidParams() {
        try {
            service.resolveAdbPath("");
            fail("Expected invalid_params for empty adbPath");
        } catch (AndroidDebugException e) {
            assertEquals("invalid_params", e.getReason());
        }

        try {
            service.resolveAdbPath("   ");
            fail("Expected invalid_params for blank adbPath");
        } catch (AndroidDebugException e) {
            assertEquals("invalid_params", e.getReason());
        }
    }

    @Test
    public void testExplicitExistingAdbPathAccepted() throws Exception {
        Path tempFile = Files.createTempFile("fake_adb", ".exe");
        try {
            Path resolved = service.resolveAdbPath(tempFile.toAbsolutePath().toString());
            assertEquals(tempFile.toAbsolutePath(), resolved);
        } finally {
            Files.deleteIfExists(tempFile);
        }
    }

    @Test
    public void testPrepareValidationBothOrNeitherPackageAndPid() {
        // Neither
        try {
            service.prepare(null, null, "dev1", null, 5000);
            fail("Expected invalid_params when neither packageName nor pid given");
        } catch (AndroidDebugException e) {
            assertEquals("invalid_params", e.getReason());
        }

        // Both
        try {
            service.prepare("com.example.app", 1234, "dev1", null, 5000);
            fail("Expected invalid_params when both packageName and pid given");
        } catch (AndroidDebugException e) {
            assertEquals("invalid_params", e.getReason());
        }

        // Blank packageName
        try {
            service.prepare("   ", null, "dev1", null, 5000);
            fail("Expected invalid_params for blank packageName");
        } catch (AndroidDebugException e) {
            assertEquals("invalid_params", e.getReason());
        }

        // Blank deviceId
        try {
            service.prepare("com.example.app", null, "   ", null, 5000);
            fail("Expected invalid_params for blank deviceId");
        } catch (AndroidDebugException e) {
            assertEquals("invalid_params", e.getReason());
        }

        // Negative pid
        try {
            service.prepare(null, -10, "dev1", null, 5000);
            fail("Expected invalid_params for negative pid");
        } catch (AndroidDebugException e) {
            assertEquals("invalid_params", e.getReason());
        }

        // Invalid timeout (< 1)
        try {
            service.prepare("com.example.app", null, "dev1", null, 0);
            fail("Expected invalid_params for timeoutMs < 1");
        } catch (AndroidDebugException e) {
            assertEquals("invalid_params", e.getReason());
        }

        // Invalid timeout (> 300000)
        try {
            service.prepare("com.example.app", null, "dev1", null, 500000);
            fail("Expected invalid_params for timeoutMs > 300000");
        } catch (AndroidDebugException e) {
            assertEquals("invalid_params", e.getReason());
        }
    }

    @Test
    public void testTwoPhaseAtomicReservationProtectsConcurrentPrepare() {
        AndroidDebugHandles.TargetId targetId = new AndroidDebugHandles.TargetId("device-1", 1234);

        // First reserve succeeds
        boolean reserved = handles.tryReserveTarget(targetId);
        assertTrue("Initial reservation must succeed", reserved);

        // Second reserve for same target fails immediately
        boolean reservedAgain = handles.tryReserveTarget(targetId);
        assertFalse("Second concurrent reservation must fail", reservedAgain);

        // Cancel reservation frees it
        handles.cancelReservation(targetId);
        boolean reReserved = handles.tryReserveTarget(targetId);
        assertTrue("Reservation after cancellation must succeed", reReserved);
        handles.cancelReservation(targetId);
    }

    @Test
    public void testClaimValidationHostAndPort() {
        // Non-loopback host
        try {
            service.claim("192.168.1.100", 50000, null);
            fail("Expected invalid_params for non-loopback host");
        } catch (AndroidDebugException e) {
            assertEquals("invalid_params", e.getReason());
        }

        // Non-loopback IPv6 host
        try {
            service.claim("[::2]", 50000, null);
            fail("Expected invalid_params for non-loopback IPv6 host");
        } catch (AndroidDebugException e) {
            assertEquals("invalid_params", e.getReason());
        }

        // Malformed bracketed host
        try {
            service.claim("[127.0.0.1]", 50000, null);
            fail("Expected invalid_params for bracketed IPv4 host");
        } catch (AndroidDebugException e) {
            assertEquals("invalid_params", e.getReason());
        }

        try {
            service.claim("[::1:8080]", 50000, null);
            fail("Expected invalid_params for non-loopback IPv6 host");
        } catch (AndroidDebugException e) {
            assertEquals("invalid_params", e.getReason());
        }

        // Null host
        try {
            service.claim(null, 50000, null);
            fail("Expected invalid_params for null host");
        } catch (AndroidDebugException e) {
            assertEquals("invalid_params", e.getReason());
        }

        // Port out of bounds
        try {
            service.claim("127.0.0.1", 0, null);
            fail("Expected invalid_params for port 0");
        } catch (AndroidDebugException e) {
            assertEquals("invalid_params", e.getReason());
        }

        try {
            service.claim("127.0.0.1", 70000, null);
            fail("Expected invalid_params for port > 65535");
        } catch (AndroidDebugException e) {
            assertEquals("invalid_params", e.getReason());
        }

        // Valid loopback hosts that don't match any port return claimed: false
        JsonObject c1 = service.claim("127.0.0.1", 50001, null);
        assertFalse(JsonElementKt.getBoolean((JsonPrimitive) c1.get("claimed")));

        JsonObject c2 = service.claim("localhost", 50001, null);
        assertFalse(JsonElementKt.getBoolean((JsonPrimitive) c2.get("claimed")));

        JsonObject c3 = service.claim("::1", 50001, null);
        assertFalse(JsonElementKt.getBoolean((JsonPrimitive) c3.get("claimed")));

        JsonObject c4 = service.claim("[::1]", 50001, null);
        assertFalse(JsonElementKt.getBoolean((JsonPrimitive) c4.get("claimed")));

        JsonObject c5 = service.claim("[0:0:0:0:0:0:0:1]", 50001, null);
        assertFalse(JsonElementKt.getBoolean((JsonPrimitive) c5.get("claimed")));
    }

    @Test
    public void testReleaseValidationAndUnknownKey() {
        // Null or blank cleanupKey
        try {
            service.release(null);
            fail("Expected invalid_params for null cleanupKey");
        } catch (AndroidDebugException e) {
            assertEquals("invalid_params", e.getReason());
        }

        try {
            service.release("   ");
            fail("Expected invalid_params for blank cleanupKey");
        } catch (AndroidDebugException e) {
            assertEquals("invalid_params", e.getReason());
        }

        // Malformed UUID string
        try {
            service.release("invalid-uuid-format");
            fail("Expected invalid_params for non-UUID string");
        } catch (AndroidDebugException e) {
            assertEquals("invalid_params", e.getReason());
        }

        // Valid UUID that doesn't exist returns already_cleaned
        JsonObject result = service.release("11111111-2222-3333-4444-555555555555");
        assertTrue(JsonElementKt.getBoolean((JsonPrimitive) result.get("success")));
        assertFalse(JsonElementKt.getBoolean((JsonPrimitive) result.get("cleaned")));
        assertEquals("already_cleaned", ((JsonPrimitive) result.get("reason")).getContent());
    }

    @Test
    public void testDisposeClosesResources() {
        service.dispose();

        // Calling prepare after dispose fails immediately
        try {
            service.prepare("com.example.app", null, null, null, 1000);
            fail("Expected cleanup_failed after dispose");
        } catch (AndroidDebugException e) {
            assertEquals("cleanup_failed", e.getReason());
        }
    }

    private static com.android.adblib.tools.debugging.JdwpProcess fakeProcess(int pid) {
        return (com.android.adblib.tools.debugging.JdwpProcess) java.lang.reflect.Proxy.newProxyInstance(
                com.android.adblib.tools.debugging.JdwpProcess.class.getClassLoader(),
                new Class<?>[]{com.android.adblib.tools.debugging.JdwpProcess.class},
                (proxy, method, args) -> switch (method.getName()) {
                    case "getPid" -> pid;
                    case "equals" -> proxy == args[0];
                    case "hashCode" -> System.identityHashCode(proxy);
                    default -> null;
                });
    }

    private static com.android.adblib.tools.debugging.JdwpProcessProperties props(
            int pid,
            com.android.adblib.tools.debugging.OptionalValue<String> name,
            com.android.adblib.tools.debugging.OptionalValue<java.util.List<String>> packages) {
        var empty = com.android.adblib.tools.debugging.OptionalValue.Companion;
        return new com.android.adblib.tools.debugging.JdwpProcessProperties(
                pid, name, packages, empty.empty(), empty.empty(), empty.empty(), empty.empty(), empty.empty(), empty.empty(), empty.empty());
    }

    @Test
    public void testPackageSelectionWaitsForLoadingRejectsAmbiguousAndDetectsUnsupportedAndSamePidReplacement() {
        var opt = com.android.adblib.tools.debugging.OptionalValue.Companion;
        var first = fakeProcess(4100);
        var loading = fakeProcess(4200);
        assertNull(AndroidDebugService.selectPackageMatch(
                java.util.List.of(first, loading),
                p -> p == first ? props(4100, opt.of("com.example.app"), opt.of(java.util.List.of("com.example.app")))
                        : props(4200, opt.empty(), opt.empty()),
                "com.example.app", false));
        try {
            AndroidDebugService.selectPackageMatch(
                    java.util.List.of(loading, first),
                    p -> props(p.getPid(), opt.of("com.example.app:" + p.getPid()), opt.of(java.util.List.of("com.example.app"))),
                    "com.example.app", false);
            fail("Expected ambiguous_process");
        } catch (AndroidDebugException error) {
            assertEquals("ambiguous_process", error.getReason());
            var candidates = (kotlinx.serialization.json.JsonArray) error.getCandidates();
            assertEquals(4100, JsonElementKt.getInt(JsonElementKt.getJsonPrimitive(((JsonObject) candidates.get(0)).get("pid"))));
            assertEquals(4200, JsonElementKt.getInt(JsonElementKt.getJsonPrimitive(((JsonObject) candidates.get(1)).get("pid"))));
        }
        try {
            AndroidDebugService.selectPackageMatch(
                    java.util.List.of(first),
                    p -> props(4100, opt.ofError("unsupported"), opt.ofError("unsupported")),
                    "com.example.app", true);
            fail("Expected unsupported metadata failure");
        } catch (AndroidDebugException error) {
            assertEquals("process_not_found", error.getReason());
        }
        var replacementSamePid = fakeProcess(4100);
        assertNotSame(first, replacementSamePid);
        assertSame(replacementSamePid, AndroidDebugService.selectPackageMatch(
                java.util.List.of(replacementSamePid),
                p -> props(4100, opt.of("com.example.app:child"), opt.empty()),
                "com.example.app", false));
    }
}
