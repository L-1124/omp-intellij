package org.jetbrains.android.debug

import com.jetbrains.ls.api.core.LSServer
import com.jetbrains.ls.api.features.commands.LSCommandDescriptor
import com.jetbrains.lsp.implementation.LspHandlerContext
import com.jetbrains.lsp.implementation.LspResponseErrorException
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import java.lang.reflect.Proxy

class JvmLaunchCommandsTest {
    private lateinit var commands: JvmLaunchCommands

    @Before
    fun setUp() {
        commands = JvmLaunchCommands()
    }

    private fun findDescriptor(name: String): LSCommandDescriptor? {
        return commands.commandDescriptors.firstOrNull { it.name == name }
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
    fun invalidArgumentsAreRejectedBeforeAnalysis() {
        val descriptor = findDescriptor(JvmLaunchCommands.COMMAND_RESOLVE_LAUNCH)!!
        val cases = listOf(
            emptyList(),
            listOf(JsonObject(emptyMap()), JsonObject(emptyMap())),
            listOf(JsonPrimitive("invalid")),
            listOf(JsonObject(emptyMap())),
            listOf(JsonObject(mapOf("uri" to JsonPrimitive(123)))),
            listOf(JsonObject(mapOf("uri" to JsonPrimitive("   ")))),
            listOf(JsonObject(mapOf("uri" to JsonPrimitive("https://example.com/App.java")))),
            listOf(JsonObject(mapOf("uri" to JsonPrimitive("file://remote/share/App.java")))),
            listOf(JsonObject(mapOf("uri" to JsonPrimitive("file:///non/existent/path/App.java"))))
        )
        for (arguments in cases) {
            val error = assertThrows(LspResponseErrorException::class.java) {
                executeCommand(descriptor, arguments)
            }
            assertEquals(-32602, error.errorCode)
        }
    }
}
