package org.jetbrains.android.run

import com.jetbrains.dap.protocol.AttachRequestArguments
import com.jetbrains.dap.protocol.DAP
import com.jetbrains.dap.protocol.DapRequestFailedException
import com.jetbrains.dap.protocol.LaunchRequestArguments
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.nio.file.Files
import java.nio.file.Path
import org.jetbrains.annotations.ApiStatus

@Suppress("UnstableApiUsage")
@ApiStatus.Experimental
class AndroidLaunchArgumentsTest {
    @Rule
    @JvmField
    val tempFolder = TemporaryFolder()

    private fun projectDir(): Path = tempFolder.root.toPath().toAbsolutePath().normalize()

    private fun expectRunFailure(
        expectedCode: AndroidRunErrorCode,
        expectedStage: AndroidRunStage = AndroidRunStage.CONFIGURING,
        expectedDetail: String? = null,
        block: () -> Unit,
    ): DapRequestFailedException {
        try {
            block()
            fail("Expected DapRequestFailedException with code=${expectedCode.wireName}")
        } catch (e: DapRequestFailedException) {
            val error = e.error
            assertNotNull("DapRequestFailedException.error must be populated", error)
            assertEquals(AndroidRunError.DAP_ERROR_MESSAGE_ID, error!!.id)
            assertEquals(AndroidRunError.DAP_ERROR_MESSAGE_FORMAT, error.format)
            assertEquals(false, error.sendTelemetry)
            assertEquals(expectedCode.wireName, error.variables?.get("code"))
            assertEquals(expectedStage.wireName, error.variables?.get("stage"))
            val detail = error.variables?.get("detail")
            assertNotNull(detail)
            assertEquals("[${expectedCode.wireName}] ${expectedStage.wireName}: $detail", e.message)
            assertEquals("${expectedCode.wireName}: $detail", error.formattedText)
            if (expectedDetail != null) {
                assertEquals(expectedDetail, detail)
            }
            return e
        }
        throw AssertionError("Unreachable")
    }

    @Test
    fun `AndroidRunError builds standardized Message 3001 and preserves original error on cleanup failure`() {
        val longTail = "x".repeat(3000) + "TAIL_END"
        val original = AndroidRunError(
            code = AndroidRunErrorCode.INSTALL_FAILED,
            stage = AndroidRunStage.INSTALLING,
            detail = "PM commit failed",
            module = ":app",
            variant = "debug",
            device = "emulator-5580",
            exitCode = 1,
            outputTail = longTail,
            outcomeUnknown = true,
        )
        val combined = original.withCleanupError("abandon timed out")
        val dapEx = combined.toDapException()

        assertEquals(
            "[install_failed] installing: PM commit failed (cleanup_failed: abandon timed out)",
            dapEx.message,
        )
        val msg = dapEx.error!!
        assertEquals(3001, msg.id)
        assertEquals("{code}: {detail}", msg.format)
        assertEquals(false, msg.sendTelemetry)
        assertEquals("install_failed", msg.variables?.get("code"))
        assertEquals("installing", msg.variables?.get("stage"))
        assertEquals("PM commit failed", msg.variables?.get("detail"))
        assertEquals(":app", msg.variables?.get("module"))
        assertEquals("debug", msg.variables?.get("variant"))
        assertEquals("emulator-5580", msg.variables?.get("device"))
        assertEquals("1", msg.variables?.get("exitCode"))
        assertEquals("true", msg.variables?.get("outcomeUnknown"))
        assertEquals("abandon timed out", msg.variables?.get("cleanupError"))
        val boundedTail = msg.variables?.get("outputTail")!!
        assertTrue(boundedTail.length <= AndroidRunError.MAX_OUTPUT_TAIL_LENGTH)
        assertTrue(boundedTail.startsWith("..."))
        assertTrue(boundedTail.endsWith("TAIL_END"))
    }

    @Test
    fun `parseLaunch rejects missing null non-object and empty android`() {
        val project = projectDir()

        expectRunFailure(AndroidRunErrorCode.INVALID_PARAMS) {
            AndroidLaunchArguments.parseLaunch(LaunchRequestArguments(), project)
        }
        expectRunFailure(AndroidRunErrorCode.INVALID_PARAMS) {
            AndroidLaunchArguments.parseLaunch(
                LaunchRequestArguments(adapterArguments = buildJsonObject { put("android", JsonNull) }),
                project,
            )
        }
        expectRunFailure(AndroidRunErrorCode.INVALID_PARAMS) {
            AndroidLaunchArguments.parseLaunch(
                LaunchRequestArguments(adapterArguments = buildJsonObject { put("android", buildJsonArray {}) }),
                project,
            )
        }
        expectRunFailure(
            AndroidRunErrorCode.INVALID_PARAMS,
            expectedDetail = "android.deviceId is required",
        ) {
            AndroidLaunchArguments.parseLaunch(
                LaunchRequestArguments(adapterArguments = buildJsonObject { put("android", buildJsonObject {}) }),
                project,
            )
        }
    }

    @Test
    fun `LaunchRequestArguments official serializer routes android and cwd into adapterArguments`() {
        val project = projectDir()
        val wire = """{"android":{},"noDebug":true,"cwd":"sub"}"""
        val decoded = DAP.json.decodeFromString(LaunchRequestArguments.serializer(), wire)
        assertEquals(true, decoded.noDebug)

        expectRunFailure(
            AndroidRunErrorCode.INVALID_PARAMS,
            expectedDetail = "android.deviceId is required",
        ) {
            AndroidLaunchArguments.parseLaunch(decoded, project)
        }
    }

    @Test
    fun `parseLaunch parses gradle target with defaults relative cwd and relative buildRoot`() {
        val project = projectDir()
        val wire = """
            {
              "cwd": "workspace-sub",
              "noDebug": true,
              "args": [],
              "android": {
                "deviceId": "emulator-5580",
                "target": {
                  "kind": "gradle",
                  "buildRoot": "included-build",
                  "module": ":app",
                  "variant": "debug"
                }
              }
            }
        """.trimIndent()
        val decoded = DAP.json.decodeFromString(LaunchRequestArguments.serializer(), wire)
        val config = AndroidLaunchArguments.parseLaunch(decoded, project)

        assertEquals(project, config.project)
        assertEquals(project.resolve("workspace-sub").normalize(), config.cwd)
        assertNull(config.program)
        assertTrue(config.noDebug)
        assertEquals("emulator-5580", config.deviceId)
        assertNull(config.userId)
        assertNull(config.activity)
        assertFalse(config.restartApp)
        assertEquals(120_000, config.timeoutMs)
        assertEquals(
            AndroidLaunchTarget.Gradle(
                buildRoot = project.resolve("workspace-sub/included-build").normalize(),
                module = ":app",
                variant = "debug",
                build = true,
            ),
            config.target,
        )
    }

    @Test
    fun `parseLaunch parses installed target and defaults cwd and buildRoot`() {
        val project = projectDir()
        val args = LaunchRequestArguments(
            adapterArguments = buildJsonObject {
                put("android", buildJsonObject {
                    put("deviceId", "dev-1")
                    put("userId", 10)
                    put("activity", ".MainActivity")
                    put("restartApp", true)
                    put("timeoutMs", 300_000)
                    put("target", buildJsonObject {
                        put("kind", "installed")
                        put("packageName", "com.example.ompattachfixture")
                    })
                })
            },
        )
        val config = AndroidLaunchArguments.parseLaunch(args, project)
        assertEquals(project, config.cwd)
        assertFalse(config.noDebug)
        assertEquals(10, config.userId)
        assertEquals(".MainActivity", config.activity)
        assertTrue(config.restartApp)
        assertEquals(300_000, config.timeoutMs)
        assertEquals(AndroidLaunchTarget.Installed("com.example.ompattachfixture"), config.target)
    }

    @Test
    fun `parseLaunch parses apks target from explicit files and from program fallback`() {
        val project = projectDir()
        val outDir = project.resolve("build/apks").also { Files.createDirectories(it) }
        val baseApk = Files.write(outDir.resolve("base.apk"), byteArrayOf(1, 2))
        val splitApk = Files.write(outDir.resolve("split-arm64.apk"), byteArrayOf(3, 4))

        val fromFiles = AndroidLaunchArguments.parseLaunch(
            LaunchRequestArguments(
                adapterArguments = buildJsonObject {
                    put("cwd", "build")
                    put("program", "apks/base.apk")
                    put("android", buildJsonObject {
                        put("deviceId", "emulator-5580")
                        put("target", buildJsonObject {
                            put("kind", "apks")
                            put("files", buildJsonArray {
                                add(JsonPrimitive("apks/base.apk"))
                                add(JsonPrimitive(splitApk.toString()))
                            })
                        })
                    })
                },
            ),
            project,
        )
        assertEquals(
            AndroidLaunchTarget.Apks(listOf(baseApk, splitApk)),
            fromFiles.target,
        )

        val fromProgram = AndroidLaunchArguments.parseLaunch(
            LaunchRequestArguments(
                adapterArguments = buildJsonObject {
                    put("program", "build/apks/base.apk")
                    put("android", buildJsonObject {
                        put("deviceId", "emulator-5580")
                        put("target", buildJsonObject {
                            put("kind", "apks")
                        })
                    })
                },
            ),
            project,
        )
        assertEquals(AndroidLaunchTarget.Apks(listOf(baseApk)), fromProgram.target)

        // Source file as program with explicit APK files does not conflict
        val withSourceProgram = AndroidLaunchArguments.parseLaunch(
            LaunchRequestArguments(
                adapterArguments = buildJsonObject {
                    put("program", "src/main/java/MainActivity.java")
                    put("android", buildJsonObject {
                        put("deviceId", "emulator-5580")
                        put("target", buildJsonObject {
                            put("kind", "apks")
                            put("files", buildJsonArray {
                                add(JsonPrimitive("build/apks/base.apk"))
                            })
                        })
                    })
                },
            ),
            project,
        )
        assertEquals(AndroidLaunchTarget.Apks(listOf(baseApk)), withSourceProgram.target)
    }

    @Test
    fun `parseLaunch rejects apks conflicts duplicates missing files and AAB`() {
        val project = projectDir()
        val apksDir = project.resolve("apks").also { Files.createDirectories(it) }
        val baseApk = Files.write(apksDir.resolve("base.apk"), byteArrayOf(1))
        val otherApk = Files.write(apksDir.resolve("other.apk"), byteArrayOf(2))
        val aabFile = Files.write(apksDir.resolve("app.aab"), byteArrayOf(3))

        // Empty files array
        expectRunFailure(AndroidRunErrorCode.INVALID_PARAMS) {
            AndroidLaunchArguments.parseLaunch(
                launchWithTarget("apks") { put("files", JsonArray(emptyList())) },
                project,
            )
        }
        // Missing both files and program
        expectRunFailure(AndroidRunErrorCode.INVALID_PARAMS) {
            AndroidLaunchArguments.parseLaunch(launchWithTarget("apks") {}, project)
        }
        // Duplicate files (via relative normalization)
        expectRunFailure(AndroidRunErrorCode.INVALID_PARAMS) {
            AndroidLaunchArguments.parseLaunch(
                launchWithTarget("apks") {
                    put("files", buildJsonArray {
                        add(JsonPrimitive("apks/base.apk"))
                        add(JsonPrimitive("apks/../apks/base.apk"))
                    })
                },
                project,
            )
        }
        // Non-existent APK file
        expectRunFailure(AndroidRunErrorCode.ARTIFACT_INVALID) {
            AndroidLaunchArguments.parseLaunch(
                launchWithTarget("apks") {
                    put("files", buildJsonArray { add(JsonPrimitive("apks/missing.apk")) })
                },
                project,
            )
        }
        // Directory instead of APK file
        expectRunFailure(AndroidRunErrorCode.ARTIFACT_INVALID) {
            AndroidLaunchArguments.parseLaunch(
                launchWithTarget("apks") {
                    put("files", buildJsonArray { add(JsonPrimitive("apks")) })
                },
                project,
            )
        }
        // AAB file in apks.files
        expectRunFailure(AndroidRunErrorCode.UNSUPPORTED_ARTIFACT) {
            AndroidLaunchArguments.parseLaunch(
                launchWithTarget("apks") {
                    put("files", buildJsonArray { add(JsonPrimitive(aabFile.toString())) })
                },
                project,
            )
        }
        // AAB target kind
        expectRunFailure(AndroidRunErrorCode.UNSUPPORTED_ARTIFACT) {
            AndroidLaunchArguments.parseLaunch(launchWithTarget("aab") {}, project)
        }
        // Conflicting program APK not in files
        expectRunFailure(AndroidRunErrorCode.INVALID_PARAMS) {
            AndroidLaunchArguments.parseLaunch(
                LaunchRequestArguments(
                    adapterArguments = buildJsonObject {
                        put("program", otherApk.toString())
                        put("android", buildJsonObject {
                            put("deviceId", "emulator-5580")
                            put("target", buildJsonObject {
                                put("kind", "apks")
                                put("files", buildJsonArray { add(JsonPrimitive(baseApk.toString())) })
                            })
                        })
                    },
                ),
                project,
            )
        }
    }

    @Test
    fun `parseLaunch enforces strict field types ranges and non-empty args rejection`() {
        val project = projectDir()

        // Non-empty DAP args rejected
        expectRunFailure(AndroidRunErrorCode.INVALID_PARAMS) {
            AndroidLaunchArguments.parseLaunch(
                LaunchRequestArguments(
                    adapterArguments = buildJsonObject {
                        put("args", buildJsonArray { add(JsonPrimitive("--help")) })
                        put("android", buildJsonObject {
                            put("deviceId", "dev")
                            put("target", buildJsonObject {
                                put("kind", "installed")
                                put("packageName", "com.example.app")
                            })
                        })
                    },
                ),
                project,
            )
        }
        // android.noDebug forbidden
        expectRunFailure(AndroidRunErrorCode.INVALID_PARAMS) {
            AndroidLaunchArguments.parseLaunch(
                LaunchRequestArguments(
                    adapterArguments = buildJsonObject {
                        put("android", buildJsonObject {
                            put("deviceId", "dev")
                            put("noDebug", true)
                            put("target", buildJsonObject {
                                put("kind", "installed")
                                put("packageName", "com.example.app")
                            })
                        })
                    },
                ),
                project,
            )
        }
        // String "true" rejected for restartApp
        expectRunFailure(AndroidRunErrorCode.INVALID_PARAMS) {
            AndroidLaunchArguments.parseLaunch(
                LaunchRequestArguments(
                    adapterArguments = buildJsonObject {
                        put("android", buildJsonObject {
                            put("deviceId", "dev")
                            put("restartApp", "true")
                            put("target", buildJsonObject {
                                put("kind", "installed")
                                put("packageName", "com.example.app")
                            })
                        })
                    },
                ),
                project,
            )
        }
        // timeoutMs bounds and non-integer
        for (badTimeout in listOf<Any>(0, -5, 300_001, 12.5, "1000")) {
            expectRunFailure(AndroidRunErrorCode.INVALID_PARAMS) {
                AndroidLaunchArguments.parseLaunch(
                    LaunchRequestArguments(
                        adapterArguments = buildJsonObject {
                            put("android", buildJsonObject {
                                put("deviceId", "dev")
                                when (badTimeout) {
                                    is Int -> put("timeoutMs", badTimeout)
                                    is Double -> put("timeoutMs", badTimeout)
                                    is String -> put("timeoutMs", badTimeout)
                                }
                                put("target", buildJsonObject {
                                    put("kind", "installed")
                                    put("packageName", "com.example.app")
                                })
                            })
                        },
                    ),
                    project,
                )
            }
        }
        // userId negative rejected
        expectRunFailure(AndroidRunErrorCode.INVALID_PARAMS) {
            AndroidLaunchArguments.parseLaunch(
                LaunchRequestArguments(
                    adapterArguments = buildJsonObject {
                        put("android", buildJsonObject {
                            put("deviceId", "dev")
                            put("userId", -1)
                            put("target", buildJsonObject {
                                put("kind", "installed")
                                put("packageName", "com.example.app")
                            })
                        })
                    },
                ),
                project,
            )
        }
        // gradle module without leading colon rejected
        expectRunFailure(AndroidRunErrorCode.INVALID_PARAMS) {
            AndroidLaunchArguments.parseLaunch(
                launchWithTarget("gradle") {
                    put("module", "app")
                    put("variant", "debug")
                },
                project,
            )
        }
        // invalid installed packageName rejected
        expectRunFailure(AndroidRunErrorCode.INVALID_PARAMS) {
            AndroidLaunchArguments.parseLaunch(
                launchWithTarget("installed") {
                    put("packageName", "single_segment")
                },
                project,
            )
        }
        // unknown top-level key rejected
        expectRunFailure(AndroidRunErrorCode.INVALID_PARAMS) {
            AndroidLaunchArguments.parseLaunch(
                LaunchRequestArguments(
                    adapterArguments = buildJsonObject {
                        put("unknownTop", 1)
                        put("android", buildJsonObject {
                            put("deviceId", "dev")
                            put("target", buildJsonObject {
                                put("kind", "installed")
                                put("packageName", "com.example.app")
                            })
                        })
                    },
                ),
                project,
            )
        }
    }

    @Test
    fun `parseAttach parses valid configs and enforces all attach restrictions`() {
        val project = projectDir()

        val minimalWire = """{"android":{"deviceId":"emulator-5580","packageName":"com.example.app"}}"""
        val minimalDecoded = DAP.json.decodeFromString(AttachRequestArguments.serializer(), minimalWire)
        val minimal = AndroidLaunchArguments.parseAttach(minimalDecoded, project)
        assertEquals(project, minimal.project)
        assertEquals(project, minimal.cwd)
        assertEquals("emulator-5580", minimal.deviceId)
        assertNull(minimal.userId)
        assertEquals("com.example.app", minimal.packageName)
        assertNull(minimal.pid)
        assertNull(minimal.processName)

        val withProcess = AndroidLaunchArguments.parseAttach(
            AttachRequestArguments(
                adapterArguments = buildJsonObject {
                    put("cwd", "sub")
                    put("android", buildJsonObject {
                        put("deviceId", "emulator-5580")
                        put("userId", 0)
                        put("packageName", "com.example.app")
                        put("processName", "com.example.app:remote")
                    })
                },
            ),
            project,
        )
        assertEquals(project.resolve("sub").normalize(), withProcess.cwd)
        assertEquals(0, withProcess.userId)
        assertEquals("com.example.app:remote", withProcess.processName)
        assertNull(withProcess.pid)

        // Empty android -> android.deviceId is required
        expectRunFailure(
            AndroidRunErrorCode.INVALID_PARAMS,
            expectedDetail = "android.deviceId is required",
        ) {
            AndroidLaunchArguments.parseAttach(
                DAP.json.decodeFromString(AttachRequestArguments.serializer(), """{"android":{}}"""),
                project,
            )
        }
        // pid + processName mutually exclusive
        expectRunFailure(AndroidRunErrorCode.INVALID_PARAMS) {
            AndroidLaunchArguments.parseAttach(
                AttachRequestArguments(
                    adapterArguments = buildJsonObject {
                        put("android", buildJsonObject {
                            put("deviceId", "emulator-5580")
                            put("packageName", "com.example.app")
                            put("pid", 1234)
                            put("processName", "com.example.app")
                        })
                    },
                ),
                project,
            )
        }
        // port rejected on Android attach
        expectRunFailure(AndroidRunErrorCode.INVALID_PARAMS) {
            AndroidLaunchArguments.parseAttach(
                AttachRequestArguments(
                    port = 5005,
                    adapterArguments = buildJsonObject {
                        put("android", buildJsonObject {
                            put("deviceId", "emulator-5580")
                            put("packageName", "com.example.app")
                        })
                    },
                ),
                project,
            )
        }
        // noDebug, target, activity, restartApp rejected on attach
        for (forbiddenKey in listOf("noDebug", "target", "activity", "restartApp")) {
            expectRunFailure(AndroidRunErrorCode.INVALID_PARAMS) {
                AndroidLaunchArguments.parseAttach(
                    AttachRequestArguments(
                        adapterArguments = buildJsonObject {
                            if (forbiddenKey == "noDebug") {
                                put("noDebug", true)
                            }
                            put("android", buildJsonObject {
                                put("deviceId", "emulator-5580")
                                put("packageName", "com.example.app")
                                if (forbiddenKey != "noDebug") {
                                    put(forbiddenKey, JsonPrimitive("x"))
                                }
                            })
                        },
                    ),
                    project,
                )
            }
        }
    }

    private fun launchWithTarget(
        kind: String,
        configureTarget: kotlinx.serialization.json.JsonObjectBuilder.() -> Unit,
    ): LaunchRequestArguments = LaunchRequestArguments(
        adapterArguments = buildJsonObject {
            put("android", buildJsonObject {
                put("deviceId", "emulator-5580")
                put("target", buildJsonObject {
                    put("kind", kind)
                    configureTarget()
                })
            })
        },
    )
}
