package org.jetbrains.android.debug

import com.jetbrains.ls.api.core.LSServer
import com.jetbrains.ls.api.features.commands.LSCommandDescriptor
import com.jetbrains.lsp.implementation.LspHandlerContext
import com.jetbrains.lsp.implementation.LspResponseErrorException
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import java.lang.reflect.Proxy

class AndroidDebugCommandsTest {
    private lateinit var commands: AndroidDebugCommands

    @Before
    fun setUp() {
        commands = AndroidDebugCommands()
    }

    private fun findDescriptor(name: String): LSCommandDescriptor? {
        for (desc in commands.commandDescriptors) {
            if (name == desc.name) {
                return desc
            }
        }
        return null
    }

    private val dummyServer: LSServer by lazy {
        Proxy.newProxyInstance(
            LSServer::class.java.classLoader,
            arrayOf(LSServer::class.java)
        ) { _, _, _ -> null } as LSServer
    }

    private val dummyClient: com.jetbrains.lsp.implementation.LspClient by lazy {
        Proxy.newProxyInstance(
            com.jetbrains.lsp.implementation.LspClient::class.java.classLoader,
            arrayOf(com.jetbrains.lsp.implementation.LspClient::class.java)
        ) { _, method, _ -> throw AssertionError("Unexpected client call: ${method.name}") } as com.jetbrains.lsp.implementation.LspClient
    }

    private fun executeCommand(descriptor: LSCommandDescriptor, args: List<JsonElement>): JsonElement {
        return runBlocking {
            with(dummyServer) {
                with(LspHandlerContext(dummyClient, this@runBlocking)) {
                    descriptor.executor.execute(args)
                }
            }
        }
    }

    @Test
    fun testInvalidArgumentsCountThrows32602() {
        val prepare = findDescriptor("omp.android.debug.prepare")
        assertNotNull(prepare)

        // Empty args list
        try {
            executeCommand(prepare!!, emptyList())
            fail("Expected -32602 for empty args")
        } catch (t: Throwable) {
            assertTrue(t is LspResponseErrorException)
            assertEquals(-32602, (t as LspResponseErrorException).errorCode)
        }

        // Multiple args
        try {
            executeCommand(prepare!!, listOf(JsonObject(emptyMap()), JsonObject(emptyMap())))
            fail("Expected -32602 for multiple args")
        } catch (t: Throwable) {
            assertTrue(t is LspResponseErrorException)
            assertEquals(-32602, (t as LspResponseErrorException).errorCode)
        }

        // Arg not JsonObject
        try {
            executeCommand(prepare!!, listOf(JsonPrimitive("not an object")))
            fail("Expected -32602 for non-object arg")
        } catch (t: Throwable) {
            assertTrue(t is LspResponseErrorException)
            assertEquals(-32602, (t as LspResponseErrorException).errorCode)
        }
    }

    @Test
    fun testPrepareValidationThrows32602() {
        val prepare = findDescriptor("omp.android.debug.prepare")!!

        // Missing both packageName and pid
        try {
            executeCommand(prepare, listOf(JsonObject(emptyMap())))
            fail("Expected -32602 when both packageName and pid are missing")
        } catch (t: Throwable) {
            assertTrue(t is LspResponseErrorException)
            assertEquals(-32602, (t as LspResponseErrorException).errorCode)
        }

        // Both packageName and pid provided
        try {
            executeCommand(
                prepare, listOf(
                    JsonObject(
                        mapOf(
                            "packageName" to JsonPrimitive("com.example.app"),
                            "pid" to JsonPrimitive(1234)
                        )
                    )
                )
            )
            fail("Expected -32602 when both packageName and pid are provided")
        } catch (t: Throwable) {
            assertTrue(t is LspResponseErrorException)
            assertEquals(-32602, (t as LspResponseErrorException).errorCode)
        }

        // Empty string packageName
        try {
            executeCommand(
                prepare, listOf(
                    JsonObject(mapOf("packageName" to JsonPrimitive("")))
                )
            )
            fail("Expected -32602 for empty string packageName")
        } catch (t: Throwable) {
            assertTrue(t is LspResponseErrorException)
            assertEquals(-32602, (t as LspResponseErrorException).errorCode)
        }

        // String-typed pid
        try {
            executeCommand(
                prepare, listOf(
                    JsonObject(mapOf("pid" to JsonPrimitive("1234")))
                )
            )
            fail("Expected -32602 for string-typed pid")
        } catch (t: Throwable) {
            assertTrue(t is LspResponseErrorException)
            assertEquals(-32602, (t as LspResponseErrorException).errorCode)
        }

        // Negative pid
        try {
            executeCommand(
                prepare, listOf(
                    JsonObject(mapOf("pid" to JsonPrimitive(-5)))
                )
            )
            fail("Expected -32602 for negative pid")
        } catch (t: Throwable) {
            assertTrue(t is LspResponseErrorException)
            assertEquals(-32602, (t as LspResponseErrorException).errorCode)
        }

        // String-typed timeoutMs
        try {
            executeCommand(
                prepare, listOf(
                    JsonObject(
                        mapOf(
                            "packageName" to JsonPrimitive("com.example.app"),
                            "timeoutMs" to JsonPrimitive("5000")
                        )
                    )
                )
            )
            fail("Expected -32602 for string-typed timeoutMs")
        } catch (t: Throwable) {
            assertTrue(t is LspResponseErrorException)
            assertEquals(-32602, (t as LspResponseErrorException).errorCode)
        }

        // Empty string deviceId
        try {
            executeCommand(
                prepare, listOf(
                    JsonObject(
                        mapOf(
                            "packageName" to JsonPrimitive("com.example.app"),
                            "deviceId" to JsonPrimitive("")
                        )
                    )
                )
            )
            fail("Expected -32602 for empty string deviceId")
        } catch (t: Throwable) {
            assertTrue(t is LspResponseErrorException)
            assertEquals(-32602, (t as LspResponseErrorException).errorCode)
        }

        // Empty string adbPath
        try {
            executeCommand(
                prepare, listOf(
                    JsonObject(
                        mapOf(
                            "packageName" to JsonPrimitive("com.example.app"),
                            "adbPath" to JsonPrimitive("")
                        )
                    )
                )
            )
            fail("Expected -32602 for empty string adbPath")
        } catch (t: Throwable) {
            assertTrue(t is LspResponseErrorException)
            assertEquals(-32602, (t as LspResponseErrorException).errorCode)
        }

        // Invalid timeoutMs (< 1)
        try {
            executeCommand(
                prepare, listOf(
                    JsonObject(
                        mapOf(
                            "packageName" to JsonPrimitive("com.example.app"),
                            "timeoutMs" to JsonPrimitive(0)
                        )
                    )
                )
            )
            fail("Expected -32602 for timeoutMs < 1")
        } catch (t: Throwable) {
            assertTrue(t is LspResponseErrorException)
            assertEquals(-32602, (t as LspResponseErrorException).errorCode)
        }
    }

    @Test
    fun testClaimValidationThrows32602() {
        val claim = findDescriptor("omp.android.debug.claim")!!

        // Missing port
        try {
            executeCommand(
                claim, listOf(
                    JsonObject(mapOf("host" to JsonPrimitive("127.0.0.1")))
                )
            )
            fail("Expected -32602 when port is missing")
        } catch (t: Throwable) {
            assertTrue(t is LspResponseErrorException)
            assertEquals(-32602, (t as LspResponseErrorException).errorCode)
        }

        // Missing host
        try {
            executeCommand(
                claim, listOf(
                    JsonObject(mapOf("port" to JsonPrimitive(50000)))
                )
            )
            fail("Expected -32602 when host is missing")
        } catch (t: Throwable) {
            assertTrue(t is LspResponseErrorException)
            assertEquals(-32602, (t as LspResponseErrorException).errorCode)
        }

        // Empty string host
        try {
            executeCommand(
                claim, listOf(
                    JsonObject(
                        mapOf(
                            "host" to JsonPrimitive(""),
                            "port" to JsonPrimitive(50000)
                        )
                    )
                )
            )
            fail("Expected -32602 for empty string host")
        } catch (t: Throwable) {
            assertTrue(t is LspResponseErrorException)
            assertEquals(-32602, (t as LspResponseErrorException).errorCode)
        }

        // String-typed port
        try {
            executeCommand(
                claim, listOf(
                    JsonObject(
                        mapOf(
                            "host" to JsonPrimitive("127.0.0.1"),
                            "port" to JsonPrimitive("50000")
                        )
                    )
                )
            )
            fail("Expected -32602 for string-typed port")
        } catch (t: Throwable) {
            assertTrue(t is LspResponseErrorException)
            assertEquals(-32602, (t as LspResponseErrorException).errorCode)
        }

        // Out of range port
        try {
            executeCommand(
                claim, listOf(
                    JsonObject(
                        mapOf(
                            "host" to JsonPrimitive("127.0.0.1"),
                            "port" to JsonPrimitive(70000)
                        )
                    )
                )
            )
            fail("Expected -32602 for port > 65535")
        } catch (t: Throwable) {
            assertTrue(t is LspResponseErrorException)
            assertEquals(-32602, (t as LspResponseErrorException).errorCode)
        }
    }

    @Test
    fun testReleaseValidationThrows32602() {
        val release = findDescriptor("omp.android.debug.release")!!

        // Missing cleanupKey
        try {
            executeCommand(release, listOf(JsonObject(emptyMap())))
            fail("Expected -32602 when cleanupKey is missing")
        } catch (t: Throwable) {
            assertTrue(t is LspResponseErrorException)
            assertEquals(-32602, (t as LspResponseErrorException).errorCode)
        }

        // Empty string cleanupKey
        try {
            executeCommand(
                release, listOf(
                    JsonObject(mapOf("cleanupKey" to JsonPrimitive("")))
                )
            )
            fail("Expected -32602 for empty string cleanupKey")
        } catch (t: Throwable) {
            assertTrue(t is LspResponseErrorException)
            assertEquals(-32602, (t as LspResponseErrorException).errorCode)
        }

        // Invalid UUID string
        try {
            executeCommand(
                release, listOf(
                    JsonObject(mapOf("cleanupKey" to JsonPrimitive("not-a-uuid")))
                )
            )
            fail("Expected -32602 for invalid UUID string")
        } catch (t: Throwable) {
            assertTrue(t is LspResponseErrorException)
            assertEquals(-32602, (t as LspResponseErrorException).errorCode)
        }
    }

    @Test
    fun testClaimReturnsUnclaimedForUnknownPort() {
        val claim = findDescriptor("omp.android.debug.claim")!!

        val res = executeCommand(
            claim, listOf(
                JsonObject(
                    mapOf(
                        "host" to JsonPrimitive("127.0.0.1"),
                        "port" to JsonPrimitive(59999)
                    )
                )
            )
        )

        assertTrue(res is JsonObject)
        val obj = res as JsonObject
        assertTrue(obj.containsKey("claimed"))
        assertFalse(obj["claimed"]!!.jsonPrimitive.boolean)
    }

    @Test
    fun testReleaseReturnsAlreadyCleanedForUnknownKey() {
        val release = findDescriptor("omp.android.debug.release")!!

        val res = executeCommand(
            release, listOf(
                JsonObject(
                    mapOf(
                        "cleanupKey" to JsonPrimitive("00000000-0000-0000-0000-000000000000")
                    )
                )
            )
        )

        assertTrue(res is JsonObject)
        val obj = res as JsonObject
        assertTrue(obj.containsKey("success"))
        assertTrue(obj["success"]!!.jsonPrimitive.boolean)
        assertTrue(obj.containsKey("cleaned"))
        assertFalse(obj["cleaned"]!!.jsonPrimitive.boolean)
        assertEquals("already_cleaned", obj["reason"]!!.jsonPrimitive.content)
    }
}
