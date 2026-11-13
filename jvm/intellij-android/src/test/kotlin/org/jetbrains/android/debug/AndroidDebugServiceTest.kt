package org.jetbrains.android.debug

import com.android.adblib.AdbSessionHost
import com.android.adblib.tools.debugging.JdwpProcess
import com.android.adblib.tools.debugging.JdwpProcessProperties
import com.android.adblib.tools.debugging.OptionalValue
import kotlinx.serialization.json.*
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import java.lang.reflect.Proxy
import java.nio.file.Files
import com.android.adblib.DeviceInfo
import com.android.adblib.DeviceList
import com.android.adblib.DeviceSelector
import com.android.adblib.DeviceState
import com.android.adblib.testing.FakeAdbSession
import kotlinx.coroutines.Job
import kotlinx.coroutines.runBlocking

class AndroidDebugServiceTest {
    private lateinit var host: AdbSessionHost
    private lateinit var handles: AndroidDebugHandles
    private lateinit var service: AndroidDebugService

    @Before
    fun setUp() {
        host = AdbSessionHost()
        handles = AndroidDebugHandles()
        service = AndroidDebugService(host, handles)
    }

    @After
    fun tearDown() {
        service.dispose()
    }

    @Test
    fun testExplicitNonExistentAdbPathThrowsAdbNotFound() {
        try {
            service.resolveAdbPath("Z:/non_existent_path_to_adb_binary")
            fail("Expected adb_not_found for non-existent adb binary")
        } catch (e: AndroidDebugException) {
            assertEquals("adb_not_found", e.reason)
        }
    }

    @Test
    fun testExplicitEmptyOrBlankAdbPathThrowsInvalidParams() {
        try {
            service.resolveAdbPath("")
            fail("Expected invalid_params for empty adbPath")
        } catch (e: AndroidDebugException) {
            assertEquals("invalid_params", e.reason)
        }

        try {
            service.resolveAdbPath("   ")
            fail("Expected invalid_params for blank adbPath")
        } catch (e: AndroidDebugException) {
            assertEquals("invalid_params", e.reason)
        }
    }

    @Test
    fun testExplicitExistingAdbPathAccepted() {
        val tempFile = Files.createTempFile("fake_adb", ".exe")
        try {
            val resolved = service.resolveAdbPath(tempFile.toAbsolutePath().toString())
            assertEquals(tempFile.toAbsolutePath(), resolved)
        } finally {
            Files.deleteIfExists(tempFile)
        }
    }

    @Test
    fun testPrepareValidationBothOrNeitherPackageAndPid() {
        // Neither
        try {
            service.prepare(null, null, "dev1", null, 5000)
            fail("Expected invalid_params when neither packageName nor pid given")
        } catch (e: AndroidDebugException) {
            assertEquals("invalid_params", e.reason)
        }

        // Both
        try {
            service.prepare("com.example.app", 1234, "dev1", null, 5000)
            fail("Expected invalid_params when both packageName and pid given")
        } catch (e: AndroidDebugException) {
            assertEquals("invalid_params", e.reason)
        }

        // Blank packageName
        try {
            service.prepare("   ", null, "dev1", null, 5000)
            fail("Expected invalid_params for blank packageName")
        } catch (e: AndroidDebugException) {
            assertEquals("invalid_params", e.reason)
        }

        // Blank deviceId
        try {
            service.prepare("com.example.app", null, "   ", null, 5000)
            fail("Expected invalid_params for blank deviceId")
        } catch (e: AndroidDebugException) {
            assertEquals("invalid_params", e.reason)
        }

        // Negative pid
        try {
            service.prepare(null, -10, "dev1", null, 5000)
            fail("Expected invalid_params for negative pid")
        } catch (e: AndroidDebugException) {
            assertEquals("invalid_params", e.reason)
        }

        // Invalid timeout (< 1)
        try {
            service.prepare("com.example.app", null, "dev1", null, 0)
            fail("Expected invalid_params for timeoutMs < 1")
        } catch (e: AndroidDebugException) {
            assertEquals("invalid_params", e.reason)
        }

        // Invalid timeout (> 300000)
        try {
            service.prepare("com.example.app", null, "dev1", null, 500000)
            fail("Expected invalid_params for timeoutMs > 300000")
        } catch (e: AndroidDebugException) {
            assertEquals("invalid_params", e.reason)
        }
    }

    @Test
    fun testReservationLifecycleBlocksDuplicateTargetsAndFreesOnCancel() {
        val targetId = AndroidDebugHandles.TargetId("device-1", 1234)

        // First reserve succeeds
        val reserved = handles.tryReserveTarget(targetId)
        assertTrue("Initial reservation must succeed", reserved)

        // Second reserve for same target fails immediately
        val reservedAgain = handles.tryReserveTarget(targetId)
        assertFalse("Second concurrent reservation must fail", reservedAgain)

        // Cancel reservation frees it
        handles.cancelReservation(targetId)
        val reReserved = handles.tryReserveTarget(targetId)
        assertTrue("Reservation after cancellation must succeed", reReserved)
        handles.cancelReservation(targetId)
    }

    @Test
    fun testClaimValidationHostAndPort() {
        // Non-loopback host
        try {
            service.claim("192.168.1.100", 50000, null)
            fail("Expected invalid_params for non-loopback host")
        } catch (e: AndroidDebugException) {
            assertEquals("invalid_params", e.reason)
        }

        // Bracketed IPv4 must not be treated as loopback by prefix matching
        try {
            service.claim("[127.0.0.1]", 50000, null)
            fail("Expected invalid_params for bracketed IPv4 host")
        } catch (e: AndroidDebugException) {
            assertEquals("invalid_params", e.reason)
        }

        for (invalid in listOf("[::2]", "[::1:8080]")) {
            val error = assertThrows(AndroidDebugException::class.java) {
                service.claim(invalid, 50000, null)
            }
            assertEquals("invalid_params", error.reason)
        }

        // Null host
        try {
            service.claim(null, 50000, null)
            fail("Expected invalid_params for null host")
        } catch (e: AndroidDebugException) {
            assertEquals("invalid_params", e.reason)
        }

        // Port out of bounds
        try {
            service.claim("127.0.0.1", 0, null)
            fail("Expected invalid_params for port 0")
        } catch (e: AndroidDebugException) {
            assertEquals("invalid_params", e.reason)
        }

        try {
            service.claim("127.0.0.1", 70000, null)
            fail("Expected invalid_params for port > 65535")
        } catch (e: AndroidDebugException) {
            assertEquals("invalid_params", e.reason)
        }

        // Valid loopback hosts that don't match any port return claimed: false
        val c1 = service.claim("127.0.0.1", 50001, null)
        assertFalse(c1["claimed"]!!.jsonPrimitive.boolean)

        val c2 = service.claim("localhost", 50001, null)
        assertFalse(c2["claimed"]!!.jsonPrimitive.boolean)

        val c3 = service.claim("::1", 50001, null)
        assertFalse(c3["claimed"]!!.jsonPrimitive.boolean)

        val bracketed = service.claim("[::1]", 50001, null)
        assertFalse(bracketed["claimed"]!!.jsonPrimitive.boolean)

        val c4 = service.claim("[0:0:0:0:0:0:0:1]", 50001, null)
        assertFalse(c4["claimed"]!!.jsonPrimitive.boolean)
    }

    @Test
    fun testReleaseValidationAndUnknownKey() {
        // Null or blank cleanupKey
        try {
            service.release(null)
            fail("Expected invalid_params for null cleanupKey")
        } catch (e: AndroidDebugException) {
            assertEquals("invalid_params", e.reason)
        }

        try {
            service.release("   ")
            fail("Expected invalid_params for blank cleanupKey")
        } catch (e: AndroidDebugException) {
            assertEquals("invalid_params", e.reason)
        }

        // Malformed UUID string
        try {
            service.release("invalid-uuid-format")
            fail("Expected invalid_params for non-UUID string")
        } catch (e: AndroidDebugException) {
            assertEquals("invalid_params", e.reason)
        }

        // Valid UUID that doesn't exist returns already_cleaned
        val result = service.release("11111111-2222-3333-4444-555555555555")
        assertTrue(result["success"]!!.jsonPrimitive.boolean)
        assertFalse(result["cleaned"]!!.jsonPrimitive.boolean)
        assertEquals("already_cleaned", result["reason"]!!.jsonPrimitive.content)
    }

    @Test
    fun testDisposeClosesResources() {
        service.dispose()

        // Calling prepare after dispose fails immediately
        try {
            service.prepare("com.example.app", null, null, null, 1000)
            fail("Expected cleanup_failed after dispose")
        } catch (e: AndroidDebugException) {
            assertEquals("cleanup_failed", e.reason)
        }
    }

    private fun fakeProcess(pid: Int): JdwpProcess {
        return Proxy.newProxyInstance(
            JdwpProcess::class.java.classLoader,
            arrayOf(JdwpProcess::class.java)
        ) { proxy, method, args ->
            when (method.name) {
                "getPid" -> pid
                "equals" -> proxy === args?.get(0)
                "hashCode" -> System.identityHashCode(proxy)
                else -> null
            }
        } as JdwpProcess
    }

    private fun props(
        pid: Int,
        name: OptionalValue<String>,
        packages: OptionalValue<List<String>>
    ): JdwpProcessProperties {
        val empty = OptionalValue.Companion
        return JdwpProcessProperties(
            pid,
            name,
            packages,
            empty.empty(),
            empty.empty(),
            empty.empty(),
            empty.empty(),
            empty.empty(),
            empty.empty(),
            empty.empty()
        )
    }

    @Test
    fun testPackageSelectionWaitsForLoadingRejectsAmbiguousAndDetectsUnsupportedAndSamePidReplacement() {
        val opt = OptionalValue.Companion
        val first = fakeProcess(4100)
        val loading = fakeProcess(4200)
        assertNull(
            AndroidDebugService.selectPackageMatch(
                listOf(first, loading),
                { p ->
                    if (p === first) props(4100, opt.of("com.example.app"), opt.of(listOf("com.example.app")))
                    else props(4200, opt.empty(), opt.empty())
                },
                "com.example.app",
                false
            )
        )
        try {
            AndroidDebugService.selectPackageMatch(
                listOf(loading, first),
                { p -> props(p.pid, opt.of("com.example.app:${p.pid}"), opt.of(listOf("com.example.app"))) },
                "com.example.app",
                false
            )
            fail("Expected ambiguous_process")
        } catch (error: AndroidDebugException) {
            assertEquals("ambiguous_process", error.reason)
            val candidates = error.candidates as JsonArray
            assertEquals(4100, (candidates[0] as JsonObject)["pid"]!!.jsonPrimitive.int)
            assertEquals(4200, (candidates[1] as JsonObject)["pid"]!!.jsonPrimitive.int)
        }
        try {
            AndroidDebugService.selectPackageMatch(
                listOf(first),
                { props(4100, opt.ofError("unsupported"), opt.ofError("unsupported")) },
                "com.example.app",
                true
            )
            fail("Expected unsupported metadata failure")
        } catch (error: AndroidDebugException) {
            assertEquals("process_not_found", error.reason)
        }
        val replacementSamePid = fakeProcess(4100)
        assertSame(
            replacementSamePid,
            AndroidDebugService.selectPackageMatch(
                listOf(replacementSamePid),
                { props(4100, opt.of("com.example.app:child"), opt.empty()) },
                "com.example.app",
                false
            )
        )
    }

    @Test
    fun testThrowAsLspErrorThrowsLspResponseErrorException() {
        val ex = AndroidDebugException("test_reason", "test message")
        try {
            ex.throwAsLspError()
            fail("Expected LspResponseErrorException")
        } catch (error: com.jetbrains.lsp.implementation.LspResponseErrorException) {
            assertEquals(-32803, error.errorCode)
            assertEquals("test message", error.message)
            assertTrue(error.payload is JsonObject)
            val data = error.payload as JsonObject
            assertEquals("test_reason", data["reason"]!!.jsonPrimitive.content)
        }
    }

    @Test
    fun testListOnlineDevicesAndReadAbisAndApiLevelUsingFakeAdbSession() = runBlocking {
        val fakeSession = FakeAdbSession()
        try {
            fakeSession.hostServices.devices = DeviceList(
                listOf(
                    DeviceInfo("emulator-5580", DeviceState.ONLINE),
                    DeviceInfo("offline-1", DeviceState.OFFLINE)
                ),
                emptyList()
            )
            fakeSession.deviceServices.configureDeviceProperties(
                DeviceSelector.fromSerialNumber("emulator-5580"),
                mapOf(
                    "ro.build.version.sdk" to "35",
                    "ro.product.cpu.abilist" to "arm64-v8a,armeabi-v7a,armeabi"
                )
            )
            service.setParentSessionForTesting(fakeSession)

            val allOnline = service.listOnlineDevices()
            assertEquals(1, allOnline.size)
            assertEquals("emulator-5580", allOnline[0].deviceId)
            assertEquals("online", allOnline[0].state)
            assertEquals(listOf("arm64-v8a", "armeabi-v7a", "armeabi"), allOnline[0].abis)

            val device = service.resolveOnlineDevice("emulator-5580")
            assertEquals(35, service.readDeviceApiLevel(device))
            assertEquals(listOf("arm64-v8a", "armeabi-v7a", "armeabi"), service.readDeviceAbis(device))

            try {
                service.listOnlineDevices("offline-1")
                fail("Expected device_offline for offline device")
            } catch (e: AndroidDebugException) {
                assertEquals("device_offline", e.reason)
            }

            try {
                service.resolveOnlineDevice("missing-device")
                fail("Expected device_offline for missing device")
            } catch (e: AndroidDebugException) {
                assertEquals("device_offline", e.reason)
            }
        } finally {
            service.setParentSessionForTesting(null)
            fakeSession.close()
        }
    }

    @Test
    fun testPrepareByPidRejectsCancelledOwnerAndDuplicateTargetReservation() = runBlocking {
        val fakeSession = FakeAdbSession()
        try {
            fakeSession.hostServices.devices = DeviceList(
                listOf(DeviceInfo("emulator-5580", DeviceState.ONLINE)),
                emptyList()
            )
            service.setParentSessionForTesting(fakeSession)
            val device = service.resolveOnlineDevice("emulator-5580")

            val cancelledOwner = Job().apply { cancel() }
            try {
                service.prepareByPid(device, 1234, cancelledOwner)
                fail("Expected lease_conflict for cancelled ownerJob")
            } catch (e: AndroidDebugException) {
                assertEquals("lease_conflict", e.reason)
            }

            val targetId = AndroidDebugHandles.TargetId("emulator-5580", 1234)
            assertTrue(handles.tryReserveTarget(targetId))
            val activeOwner = Job()
            try {
                service.prepareByPid(device, 1234, activeOwner)
                fail("Expected target_busy when target PID is already reserved")
            } catch (e: AndroidDebugException) {
                assertEquals("target_busy", e.reason)
            } finally {
                handles.cancelReservation(targetId)
                activeOwner.cancel()
            }
        } finally {
            service.setParentSessionForTesting(null)
            fakeSession.close()
        }
    }
}
