package org.jetbrains.android.run

import com.jetbrains.ls.api.core.LSServer
import com.jetbrains.lsp.implementation.LspClient
import com.jetbrains.lsp.implementation.LspHandlerContext
import com.jetbrains.lsp.implementation.LspResponseErrorException
import com.jetbrains.lsp.protocol.ErrorCodes
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.jetbrains.android.debug.AndroidDebugException
import org.jetbrains.android.debug.AndroidEnumeratedDevice
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.lang.reflect.Proxy
import java.nio.file.Files
import java.nio.file.Path

class AndroidRunCommandsTest {

    @Rule
    @JvmField
    val tempFolder = TemporaryFolder()

    @Test
    fun `targets descriptor is registered and validates strict single-object arguments`() =
        runBlocking(Dispatchers.IO) {
            val workspaceDir = tempFolder.newFolder("ws").toPath().toAbsolutePath().normalize()
            val commands = AndroidRunCommands(
                deviceEnumerator = { _, _ -> emptyList() },
                gradleProjectFactory = { ctx -> AndroidGradleProject(ctx) },
                contextCapturer = { AndroidGradleContext(workspaceDirectory = workspaceDir) },
            )

            val descriptor = commands.commandDescriptors.single()
            assertEquals(AndroidRunCommands.COMMAND_TARGETS, descriptor.name)

            // Verify META-INF/services lists AndroidDapExtension which registers AndroidRunCommands.
            val servicesUrls = AndroidRunCommands::class.java.classLoader
                .getResources("META-INF/services/com.jetbrains.ls.api.features.LanguageServerExtension")
                .toList()
            assertTrue(servicesUrls.isNotEmpty())
            val serviceEntries = servicesUrls.flatMap { url ->
                url.openStream().bufferedReader().useLines { lines ->
                    lines.map { it.trim() }.filter { it.isNotEmpty() && !it.startsWith("#") }.toList()
                }
            }
            assertTrue(serviceEntries.contains("org.jetbrains.android.dap.AndroidDapExtension"))

            val invalidInputs = listOf(
                null,
                emptyList(),
                listOf(JsonNull),
                listOf(JsonObject(emptyMap()), JsonObject(emptyMap())),
                listOf(JsonPrimitive("not-an-object")),
                listOf(buildJsonObject { put("unknown", "x") }),
                listOf(buildJsonObject { put("buildRoot", "") }),
                listOf(buildJsonObject { put("buildRoot", JsonNull) }),
                listOf(buildJsonObject { put("buildRoot", 123) }),
                listOf(buildJsonObject { put("deviceId", "  ") }),
                listOf(buildJsonObject { put("deviceId", JsonNull) }),
                listOf(buildJsonObject { put("deviceId", false) }),
                listOf(buildJsonObject { put("buildRoot", "missing-build-root") }),
            )

            for (args in invalidInputs) {
                try {
                    executeCommand(commands, args)
                    fail("Expected InvalidParams for $args")
                } catch (e: LspResponseErrorException) {
                    assertEquals(ErrorCodes.InvalidParams, e.errorCode)
                    assertTrue(e.message?.contains("[invalid_params]") == true)
                }
            }
        }

    @Test
    fun `targets enumerates online devices and application modules only without swallowing errors`() =
        runBlocking(Dispatchers.IO) {
            val workspaceDir = tempFolder.newFolder("ws-targets").toPath().toAbsolutePath().normalize()
            val includedDir = workspaceDir.resolve("included-app").also { Files.createDirectories(it) }
            val fullJdk = createFakeJdk("jdk21", withJlink = true)
            val listingFile =
                includedDir.resolve("app/build/intermediates/apk_ide_redirect_file/debug/redirect.txt").toFile()

            var queriedRoot: Path? = null
            val stubProject = object : AndroidGradleProject(
                AndroidGradleContext(workspaceDirectory = workspaceDir)
            ) {
                override suspend fun queryModels(
                    buildRoot: Path,
                    onOutput: (String) -> Unit
                ): AndroidRunModelResultDto {
                    queriedRoot = buildRoot
                    return AndroidRunModelResultDto(
                        buildRoot = buildRoot.toFile(),
                        projects = listOf(
                            AndroidProjectModelDto(
                                buildRoot = buildRoot.toFile(),
                                module = ":app",
                                projectDir = buildRoot.resolve("app").toFile(),
                                agpVersion = "9.4.1",
                                projectType = "APPLICATION",
                                isApplication = true,
                                variants = listOf(
                                    AndroidVariantModelDto(
                                        "debug",
                                        ":app:assembleDebug",
                                        listingFile,
                                        null,
                                        "com.example.app"
                                    ),
                                    AndroidVariantModelDto(
                                        "release",
                                        ":app:assembleRelease",
                                        null,
                                        setOf("arm64-v8a"),
                                        "com.example.app"
                                    ),
                                ),
                            ),
                            AndroidProjectModelDto(
                                buildRoot = buildRoot.toFile(),
                                module = ":lib",
                                projectDir = buildRoot.resolve("lib").toFile(),
                                agpVersion = "9.4.1",
                                projectType = "LIBRARY",
                                isApplication = false,
                                variants = listOf(
                                    AndroidVariantModelDto("debug", ":lib:assembleDebug", null, emptySet(), null)
                                ),
                            ),
                        ),
                        includedBuildRoots = listOf(workspaceDir.resolve("other-included").toFile()),
                        nonAndroidProjectPaths = listOf(":"),
                        versionFailureDiagnostics = emptyList(),
                    )
                }
            }

            val commands = AndroidRunCommands(
                deviceEnumerator = { _, requestedDeviceId ->
                    assertEquals(null, requestedDeviceId)
                    listOf(AndroidEnumeratedDevice("emulator-5580", "online", listOf("arm64-v8a", "x86_64")))
                },
                gradleProjectFactory = { stubProject },
                contextCapturer = {
                    AndroidGradleContext(
                        workspaceDirectory = workspaceDir,
                        importedRoots = mapOf(
                            includedDir to AndroidGradleRootContext(includedDir, javaHome = fullJdk)
                        ),
                    )
                },
            )

            // Relative buildRoot resolves against workspaceDir.
            val result = executeCommand(
                commands,
                listOf(buildJsonObject { put("buildRoot", "included-app") })
            ) as JsonObject

            assertEquals(includedDir, queriedRoot)
            val devices = result["devices"]!!.jsonArray
            assertEquals(1, devices.size)
            val dev = devices[0].jsonObject
            assertEquals("emulator-5580", dev["deviceId"]!!.jsonPrimitive.content)
            assertEquals("online", dev["state"]!!.jsonPrimitive.content)
            assertEquals(listOf("arm64-v8a", "x86_64"), dev["abis"]!!.jsonArray.map { it.jsonPrimitive.content })

            val modules = result["modules"]!!.jsonArray
            assertEquals(1, modules.size)
            val appMod = modules[0].jsonObject
            assertEquals(includedDir.toString(), appMod["buildRoot"]!!.jsonPrimitive.content)
            assertEquals(":app", appMod["module"]!!.jsonPrimitive.content)

            val variants = appMod["variants"]!!.jsonArray
            assertEquals(2, variants.size)
            assertEquals("debug", variants[0].jsonObject["name"]!!.jsonPrimitive.content)
            assertEquals(":app:assembleDebug", variants[0].jsonObject["assembleTask"]!!.jsonPrimitive.content)
            assertEquals(JsonNull, variants[0].jsonObject["abiFilters"])
            assertEquals(
                listOf("arm64-v8a"),
                variants[1].jsonObject["abiFilters"]!!.jsonArray.map { it.jsonPrimitive.content })

            val included = result["includedBuilds"]!!.jsonArray
            assertEquals(1, included.size)
        }

    @Test
    fun `targets returns empty arrays only on genuine absence and surfaces device_offline and jlink prerequisite errors`() =
        runBlocking(Dispatchers.IO) {
            val workspaceDir = tempFolder.newFolder("ws-empty").toPath().toAbsolutePath().normalize()
            val trimmedJbr = createFakeJdk("jbr-no-jlink", withJlink = false)

            // Genuine absence: 0 devices, 0 application modules -> empty arrays.
            val emptyCommands = AndroidRunCommands(
                deviceEnumerator = { _, _ -> emptyList() },
                gradleProjectFactory = { ctx ->
                    object : AndroidGradleProject(ctx) {
                        override suspend fun queryModels(
                            buildRoot: Path,
                            onOutput: (String) -> Unit
                        ): AndroidRunModelResultDto {
                            return AndroidRunModelResultDto(
                                buildRoot = buildRoot.toFile(),
                                projects = emptyList(),
                                includedBuildRoots = emptyList(),
                                nonAndroidProjectPaths = listOf(":"),
                                versionFailureDiagnostics = emptyList(),
                            )
                        }
                    }
                },
                contextCapturer = { AndroidGradleContext(workspaceDirectory = workspaceDir) },
            )

            val emptyResult = executeCommand(emptyCommands, listOf(JsonObject(emptyMap()))) as JsonObject
            assertTrue(emptyResult["devices"]!!.jsonArray.isEmpty())
            assertTrue(emptyResult["modules"]!!.jsonArray.isEmpty())
            assertTrue(emptyResult["includedBuilds"]!!.jsonArray.isEmpty())

            // Offline deviceId must fail with [device_offline], never empty devices array.
            val offlineCommands = AndroidRunCommands(
                deviceEnumerator = { _, _ ->
                    throw AndroidDebugException(
                        "device_offline",
                        "Device emulator-9999 is offline"
                    )
                },
                gradleProjectFactory = { ctx -> AndroidGradleProject(ctx) },
                contextCapturer = { AndroidGradleContext(workspaceDirectory = workspaceDir) },
            )
            try {
                executeCommand(offlineCommands, listOf(buildJsonObject { put("deviceId", "emulator-9999") }))
                fail("Expected device_offline error")
            } catch (e: LspResponseErrorException) {
                assertTrue(e.message?.contains("[device_offline]") == true)
            }

            // Missing jlink on real preflight must fail with [prerequisite_missing].
            val jlinkCommands = AndroidRunCommands(
                deviceEnumerator = { _, _ -> emptyList() },
                gradleProjectFactory = { ctx -> AndroidGradleProject(ctx) },
                contextCapturer = {
                    AndroidGradleContext(
                        workspaceDirectory = workspaceDir,
                        importedRoots = mapOf(
                            workspaceDir to AndroidGradleRootContext(
                                workspaceDir,
                                javaHome = trimmedJbr
                            )
                        ),
                    )
                },
            )
            try {
                executeCommand(jlinkCommands, listOf(JsonObject(emptyMap())))
                fail("Expected prerequisite_missing error for missing jlink")
            } catch (e: LspResponseErrorException) {
                assertTrue(e.message?.contains("[prerequisite_missing]") == true)
                assertTrue(e.message?.contains("jlink") == true)
            }
        }

    private suspend fun executeCommand(
        commands: AndroidRunCommands,
        arguments: List<kotlinx.serialization.json.JsonElement>?,
    ): kotlinx.serialization.json.JsonElement {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        try {
            val server = Proxy.newProxyInstance(
                LSServer::class.java.classLoader,
                arrayOf(LSServer::class.java)
            ) { proxy, method, mArgs ->
                handleStandardObjectMethod(proxy, method, mArgs)
            } as LSServer
            val client = Proxy.newProxyInstance(
                LspClient::class.java.classLoader,
                arrayOf(LspClient::class.java)
            ) { proxy, method, mArgs ->
                handleStandardObjectMethod(proxy, method, mArgs)
            } as LspClient

            val handlerContext = LspHandlerContext(client, scope)
            return with(server) {
                with(handlerContext) {
                    commands.commandDescriptors.single().executor.execute(arguments ?: emptyList())
                }
            }
        } finally {
            scope.cancel()
        }
    }

    private fun createFakeJdk(name: String, withJlink: Boolean): Path {
        val dir = tempFolder.newFolder(name).toPath().toAbsolutePath().normalize()
        val bin = Files.createDirectories(dir.resolve("bin"))
        val isWindows = System.getProperty("os.name").lowercase().contains("win")
        val ext = if (isWindows) ".exe" else ""
        Files.writeString(bin.resolve("java$ext"), "stub")
        if (withJlink) {
            Files.writeString(bin.resolve("jlink$ext"), "stub")
        }
        return dir
    }
}

private fun handleStandardObjectMethod(
    proxy: Any,
    method: java.lang.reflect.Method,
    args: Array<out Any?>?,
): Any? = when {
    method.name == "equals" && method.parameterCount == 1 -> proxy === args?.getOrNull(0)
    method.name == "hashCode" && method.parameterCount == 0 -> System.identityHashCode(proxy)
    method.name == "toString" && method.parameterCount == 0 ->
        "${proxy::class.java.interfaces.firstOrNull()?.simpleName ?: "Proxy"}@${
            Integer.toHexString(System.identityHashCode(proxy))
        }"

    else -> null
}
