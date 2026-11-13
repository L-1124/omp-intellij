package org.jetbrains.android.run

import com.android.builder.model.v2.ide.AndroidArtifact
import com.android.builder.model.v2.ide.ProjectType
import com.android.builder.model.v2.ide.Variant
import com.android.builder.model.v2.models.AndroidProject
import com.android.builder.model.v2.models.BasicAndroidProject
import com.android.builder.model.v2.models.Versions
import com.intellij.platform.workspace.jps.entities.ExternalSystemModuleOptionsEntity
import com.intellij.platform.workspace.jps.entities.ModuleCustomImlDataEntity
import com.intellij.platform.workspace.jps.entities.ModuleEntity
import com.intellij.platform.workspace.jps.entities.customImlData
import com.intellij.platform.workspace.jps.entities.exModuleOptions
import com.intellij.platform.workspace.storage.EntitySource
import com.intellij.platform.workspace.storage.MutableEntityStorage
import com.jetbrains.ls.api.core.LSServer
import com.jetbrains.ls.snapshot.api.impl.core.ConfiguredProject
import com.jetbrains.ls.snapshot.api.impl.core.InitializeOptions
import com.jetbrains.lsp.protocol.URI as LspUri
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.gradle.tooling.BuildAction
import org.gradle.tooling.BuildActionExecuter
import org.gradle.tooling.BuildCancelledException
import org.gradle.tooling.BuildController
import org.gradle.tooling.BuildLauncher
import org.gradle.tooling.CancellationToken
import org.gradle.tooling.GradleConnector
import org.gradle.tooling.ProjectConnection
import org.gradle.tooling.ResultHandler
import org.gradle.tooling.model.DomainObjectSet
import org.jetbrains.annotations.ApiStatus
import org.gradle.tooling.model.gradle.BasicGradleProject
import org.gradle.tooling.model.gradle.GradleBuild
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.ObjectInputStream
import java.io.ObjectOutputStream
import java.io.OutputStream
import java.lang.reflect.Proxy
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

class AndroidGradleProjectTest {

    @Rule
    @JvmField
    val tempFolder = TemporaryFolder()

    @Suppress("UnstableApiUsage")
    @Test
    @ApiStatus.Internal
    fun `AndroidGradleContext capture extracts exact-root ConfiguredProject and EntityStorage JDK while staying null-safe`() {
        val rootA = tempFolder.newFolder("root-a").toPath().toAbsolutePath().normalize()
        val rootB = tempFolder.newFolder("root-b").toPath().toAbsolutePath().normalize()
        val rootC = tempFolder.newFolder("root-c").toPath().toAbsolutePath().normalize()
        val jdkA = createFakeJdk("jdk-a", withJlink = true)
        val jdkC = createFakeJdk("jdk-c", withJlink = true)
        val defaultSdk = createFakeJdk("default-sdk", withJlink = true)

        val storage = MutableEntityStorage.create().apply {
            val source = object : EntitySource {}
            addEntity(ModuleEntity("rootC.app", emptyList(), source) {
                exModuleOptions = ExternalSystemModuleOptionsEntity(source) {
                    externalSystem = "GRADLE"
                    rootProjectPath = rootC.toString()
                }
                customImlData = ModuleCustomImlDataEntity(
                    mapOf("lsp.import.java.home" to jdkC.toString()),
                    source
                )
            })
        }.toSnapshot()

        val initOptions = InitializeOptions(
            defaultSdk = defaultSdk,
            projects = listOf(
                ConfiguredProject(
                    type = "gradle",
                    path = LspUri(rootA.toUri().toString()),
                    env = mapOf("ANDROID_HOME" to "C:/sdk-a", "GRADLE_USER_HOME" to "C:/g-a"),
                    systemProperties = mapOf("org.gradle.caching" to "true"),
                    javaHome = jdkA,
                    offline = true,
                ),
                ConfiguredProject(
                    type = "gradle",
                    path = LspUri(rootB.toUri().toString()),
                    env = mapOf("ANDROID_HOME" to "C:/sdk-b"),
                    javaHome = null,
                    offline = false,
                ),
            ),
        )

        val captured = AndroidGradleContext.capture(
            workspaceFolders = listOf(rootA),
            rootUri = null,
            importOptions = initOptions,
            entityStorage = storage,
        )
        assertEquals(rootA, captured.workspaceDirectory)
        assertEquals(defaultSdk, captured.defaultSdk)
        assertEquals(jdkA, captured.importedRoots[rootA]?.javaHome)
        assertEquals(true, captured.importedRoots[rootA]?.offline)
        assertEquals("C:/sdk-a", captured.importedRoots[rootA]?.env?.get("ANDROID_HOME"))
        assertEquals("true", captured.importedRoots[rootA]?.systemProperties?.get("org.gradle.caching"))
        assertNull(captured.importedRoots[rootB]?.javaHome)
        assertEquals("C:/sdk-b", captured.importedRoots[rootB]?.env?.get("ANDROID_HOME"))
        assertEquals(jdkC, captured.importedRoots[rootC]?.javaHome)

        // Exact-root isolation: rootB must not inherit rootA's JDK, env, or offline flag.
        val project = AndroidGradleProject(captured, processEnvProvider = { emptyMap() })
        val specA = project.resolveExecutionSpec(rootA)
        val specB = project.resolveExecutionSpec(rootB)
        assertEquals(jdkA, specA.javaHome)
        assertTrue(specA.offline)
        assertEquals("C:/sdk-a", specA.environment["ANDROID_HOME"])
        assertEquals(defaultSdk, specB.javaHome)
        assertFalse(specB.offline)
        assertEquals("C:/sdk-b", specB.environment["ANDROID_HOME"])

        // Stubbed LSServer proxy returning nulls must not throw.
        val stubServer = Proxy.newProxyInstance(
            LSServer::class.java.classLoader,
            arrayOf(LSServer::class.java)
        ) { proxy, method, args ->
            handleStandardObjectMethod(proxy, method, args)
        } as LSServer
        val emptyContext = AndroidGradleContext.capture(stubServer)
        assertNull(emptyContext.workspaceDirectory)
        assertTrue(emptyContext.importedRoots.isEmpty())
    }

    @Test
    fun `validateFullJdk rejects trimmed JBR missing jlink before creating Gradle connection`() = runBlocking {
        val projectDir = tempFolder.newFolder("app-root").toPath().toAbsolutePath().normalize()
        val trimmedJbr = createFakeJdk("trimmed-jbr", withJlink = false)
        val connectorCalls = AtomicInteger(0)

        val context = AndroidGradleContext(
            workspaceDirectory = projectDir,
            importedRoots = mapOf(
                projectDir to AndroidGradleRootContext(
                    buildRoot = projectDir,
                    javaHome = trimmedJbr,
                )
            ),
        )
        val gradleProject = AndroidGradleProject(
            context = context,
            connectorFactory = { _ ->
                connectorCalls.incrementAndGet()
                error("Should not connect when jlink is missing")
            },
        )

        try {
            gradleProject.queryModels(projectDir)
            fail("Expected PREREQUISITE_MISSING for trimmed JBR without jlink")
        } catch (e: AndroidRunException) {
            assertEquals(AndroidRunErrorCode.PREREQUISITE_MISSING, e.error.code)
            assertEquals(AndroidRunStage.CONFIGURING, e.error.stage)
            assertTrue(e.error.detail.contains("jlink"))
        }
        assertEquals(0, connectorCalls.get())
    }

    @Test
    fun `AndroidRunModelAction executes AGP v2 models and DTO round-trips via Java serialization`() {
        val buildRoot = tempFolder.newFolder("agp-root")
        val appDir = File(buildRoot, "app").apply { mkdirs() }
        val libDir = File(buildRoot, "lib").apply { mkdirs() }
        val includedDir = File(buildRoot, "included-lib")
        includedDir.mkdirs()
        val debugListing = File(appDir, "build/intermediates/apk_ide_redirect_file/debug/redirect.txt")
        val releaseListing = File(appDir, "build/intermediates/apk_ide_redirect_file/release/redirect.txt")

        val controller = fakeBuildController(
            rootDir = buildRoot,
            projects = listOf(
                FakeGradleProjectSpec(":", buildRoot, versions = null, basic = null, android = null),
                FakeGradleProjectSpec(
                    path = ":app",
                    dir = appDir,
                    versions = fakeVersions("9.4.1"),
                    basic = fakeBasicAndroidProject(":app", ProjectType.APPLICATION),
                    android = fakeAndroidProject(
                        listOf(
                            FakeVariantSpec("debug", "assembleDebug", debugListing, null, "com.example.app"),
                            FakeVariantSpec(
                                "release",
                                ":app:assembleRelease",
                                releaseListing,
                                setOf("arm64-v8a"),
                                "com.example.app"
                            ),
                        )
                    ),
                ),
                FakeGradleProjectSpec(
                    path = ":lib",
                    dir = libDir,
                    versions = fakeVersions("9.4.1"),
                    basic = fakeBasicAndroidProject(":lib", ProjectType.LIBRARY),
                    android = fakeAndroidProject(
                        listOf(FakeVariantSpec("debug", "assembleDebug", null, emptySet(), null))
                    ),
                ),
            ),
            includedRoots = listOf(includedDir),
        )

        val action = AndroidRunModelAction()
        val rawResult = action.execute(controller)

        // Verify both action and result serialize cleanly with standard ObjectOutputStream.
        val roundTrippedAction = javaRoundTrip(action)
        assertNotNull(roundTrippedAction)
        val result = javaRoundTrip(rawResult)

        assertEquals(buildRoot, result.buildRoot)
        assertEquals(listOf(":"), result.nonAndroidProjectPaths)
        assertEquals(listOf(includedDir), result.includedBuildRoots)
        assertTrue(result.versionFailureDiagnostics.isEmpty())
        assertEquals(2, result.projects.size)

        val app = result.projects[0]
        assertTrue(app.isApplication)
        assertEquals("APPLICATION", app.projectType)
        assertEquals("9.4.1", app.agpVersion)
        assertEquals(2, app.variants.size)
        assertEquals(":app:assembleDebug", app.variants[0].assembleTask)
        assertNull(app.variants[0].abiFilters)
        assertEquals(debugListing, app.variants[0].listingFile)
        assertEquals(":app:assembleRelease", app.variants[1].assembleTask)
        assertEquals(setOf("arm64-v8a"), app.variants[1].abiFilters)

        val lib = result.projects[1]
        assertFalse(lib.isApplication)
        assertEquals("LIBRARY", lib.projectType)
    }

    @Test
    fun `resolveAndBuild executes qualified task follows redirect selects split APK and handles build=false`() =
        runBlocking {
            val buildRoot = tempFolder.newFolder("build-root").toPath().toAbsolutePath().normalize()
            val fullJdk = createFakeJdk("jdk21", withJlink = true)

            val redirectDir = buildRoot.resolve("app/build/intermediates/apk_ide_redirect_file/debug")
            val metadataDir = buildRoot.resolve("app/build/outputs/apk/debug")
            Files.createDirectories(redirectDir)
            Files.createDirectories(metadataDir)

            val arm64Apk = metadataDir.resolve("app-arm64-v8a-debug.apk")
            val x86Apk = metadataDir.resolve("app-x86_64-debug.apk")
            Files.writeString(arm64Apk, "arm64-apk")
            Files.writeString(x86Apk, "x86-apk")

            val metadataFile = metadataDir.resolve("output-metadata.json")
            Files.writeString(
                metadataFile,
                """
            {
              "version": 3,
              "artifactType": { "type": "APK", "kind": "Directory" },
              "applicationId": "com.example.ompattachfixture",
              "variantName": "debug",
              "elements": [
                {
                  "type": "ONE_OF_MANY",
                  "filters": [{ "filterType": "ABI", "value": "arm64-v8a" }],
                  "attributes": [],
                  "versionCode": 1,
                  "versionName": "1.0",
                  "outputFile": "app-arm64-v8a-debug.apk"
                },
                {
                  "type": "ONE_OF_MANY",
                  "filters": [{ "filterType": "ABI", "value": "x86_64" }],
                  "attributes": [],
                  "versionCode": 1,
                  "versionName": "1.0",
                  "outputFile": "app-x86_64-debug.apk"
                }
              ],
              "elementType": "File"
            }
            """.trimIndent(),
                StandardCharsets.UTF_8,
            )

            val relativeRedirectTarget = redirectDir.relativize(metadataFile).toString().replace('\\', '/')
            val redirectFile = redirectDir.resolve("redirect.txt")
            Files.writeString(
                redirectFile,
                "#- File Locator -\nlistingFile=$relativeRedirectTarget\n",
                StandardCharsets.UTF_8,
            )

            val modelDto = AndroidRunModelResultDto(
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
                                name = "debug",
                                assembleTask = ":app:assembleDebug",
                                listingFile = redirectFile.toFile(),
                                abiFilters = null,
                                applicationId = "com.example.ompattachfixture",
                            ),
                            AndroidVariantModelDto(
                                name = "armOnly",
                                assembleTask = ":app:assembleArmOnly",
                                listingFile = redirectFile.toFile(),
                                abiFilters = setOf("armeabi-v7a"),
                                applicationId = "com.example.ompattachfixture",
                            ),
                        ),
                    )
                ),
                includedBuildRoots = emptyList(),
                nonAndroidProjectPaths = listOf(":"),
                versionFailureDiagnostics = emptyList(),
            )

            val recordedTasks = CopyOnWriteArrayList<List<String>>()
            val recordedJavaHomes = CopyOnWriteArrayList<File?>()
            val connectionsClosed = AtomicInteger(0)
            val stages = CopyOnWriteArrayList<AndroidRunStage>()
            val outputs = CopyOnWriteArrayList<String>()

            val gradleProject = AndroidGradleProject(
                context = AndroidGradleContext(
                    workspaceDirectory = buildRoot,
                    importedRoots = mapOf(
                        buildRoot to AndroidGradleRootContext(
                            buildRoot = buildRoot,
                            javaHome = fullJdk,
                        )
                    ),
                ),
                connectorFactory = { _ ->
                    fakeGradleConnector(
                        onModelAction = { _, _, handler -> handler.onComplete(modelDto) },
                        onBuild = { tasks, javaHome, _, stdout, _, handler ->
                            recordedTasks.add(tasks)
                            recordedJavaHomes.add(javaHome)
                            stdout.write("Building :app:assembleDebug\n".toByteArray(StandardCharsets.UTF_8))
                            stdout.write(("x".repeat(1500) + "\n").toByteArray(StandardCharsets.UTF_8))
                            handler.onComplete(null)
                        },
                        onConnectionClosed = { connectionsClosed.incrementAndGet() },
                    )
                },
            )

            val built = gradleProject.resolveAndBuild(
                target = AndroidLaunchTarget.Gradle(buildRoot, ":app", "debug", build = true),
                deviceAbis = listOf("x86_64", "arm64-v8a"),
                onStage = stages::add,
                onOutput = outputs::add,
            )

            assertEquals(listOf(AndroidRunStage.CONFIGURING, AndroidRunStage.BUILDING), stages)
            assertEquals(listOf(listOf(":app:assembleDebug")), recordedTasks)
            assertEquals(listOf(fullJdk.toFile()), recordedJavaHomes)
            assertEquals(2, connectionsClosed.get())
            assertEquals(listOf(x86Apk), built.resolvedPaths)
            assertEquals("com.example.ompattachfixture", built.applicationId)
            assertEquals(2, outputs.size)
            assertEquals("Building :app:assembleDebug", outputs[0])
            assertTrue(outputs[1].length <= 1024 && outputs[1].endsWith("..."))

            // build=false must skip Gradle build and resolve from existing listing/redirect.
            recordedTasks.clear()
            val noBuild = gradleProject.resolveAndBuild(
                target = AndroidLaunchTarget.Gradle(buildRoot, ":app", "debug", build = false),
                deviceAbis = listOf("arm64-v8a"),
                onStage = {},
                onOutput = {},
            )
            assertTrue(recordedTasks.isEmpty())
            assertEquals(listOf(arm64Apk), noBuild.resolvedPaths)

            // Missing listing with build=false fails with ARTIFACT_INVALID.
            Files.delete(redirectFile)
            try {
                gradleProject.resolveAndBuild(
                    target = AndroidLaunchTarget.Gradle(buildRoot, ":app", "debug", build = false),
                    deviceAbis = listOf("arm64-v8a"),
                    onStage = {},
                    onOutput = {},
                )
                fail("Expected ARTIFACT_INVALID when build=false listing is missing")
            } catch (e: AndroidRunException) {
                assertEquals(AndroidRunErrorCode.ARTIFACT_INVALID, e.error.code)
            }
        }

    @Test
    fun `resolveAndBuild reports ABI_MISMATCH UNSUPPORTED_AGP and non-application errors cleanly`() = runBlocking {
        val buildRoot = tempFolder.newFolder("errors-root").toPath().toAbsolutePath().normalize()
        val fullJdk = createFakeJdk("jdk21", withJlink = true)
        val listingDir = buildRoot.resolve("app/build/outputs/apk/debug")
        Files.createDirectories(listingDir)
        val universalApk = listingDir.resolve("app-universal.apk").also { Files.writeString(it, "apk") }
        val metadataFile = listingDir.resolve("output-metadata.json")
        Files.writeString(
            metadataFile,
            """
            {
              "version": 3,
              "artifactType": { "type": "APK", "kind": "Directory" },
              "applicationId": "com.example.app",
              "variantName": "debug",
              "elements": [{
                "type": "SINGLE",
                "filters": [],
                "attributes": [],
                "versionCode": 1,
                "versionName": "1.0",
                "outputFile": "${universalApk.fileName}"
              }],
              "elementType": "File"
            }
            """.trimIndent(),
        )

        val dto = AndroidRunModelResultDto(
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
                            name = "debug",
                            assembleTask = ":app:assembleDebug",
                            listingFile = metadataFile.toFile(),
                            abiFilters = setOf("armeabi-v7a"),
                            applicationId = "com.example.app",
                        )
                    ),
                ),
                AndroidProjectModelDto(
                    buildRoot = buildRoot.toFile(),
                    module = ":feature",
                    projectDir = buildRoot.resolve("feature").toFile(),
                    agpVersion = "9.4.1",
                    projectType = "DYNAMIC_FEATURE",
                    isApplication = false,
                    variants = emptyList(),
                ),
                AndroidProjectModelDto(
                    buildRoot = buildRoot.toFile(),
                    module = ":oldagp",
                    projectDir = buildRoot.resolve("oldagp").toFile(),
                    agpVersion = "8.7.0",
                    projectType = "APPLICATION",
                    isApplication = true,
                    variants = emptyList(),
                ),
            ),
            includedBuildRoots = emptyList(),
            nonAndroidProjectPaths = emptyList(),
            versionFailureDiagnostics = emptyList(),
        )

        val gradleProject = AndroidGradleProject(
            context = AndroidGradleContext(
                importedRoots = mapOf(buildRoot to AndroidGradleRootContext(buildRoot, javaHome = fullJdk))
            ),
            connectorFactory = { _ ->
                fakeGradleConnector(
                    onModelAction = { _, _, handler -> handler.onComplete(dto) },
                    onBuild = { _, _, _, _, _, handler -> handler.onComplete(null) },
                )
            },
        )

        // ABI mismatch when universal APK has abiFilters=["armeabi-v7a"] and device only supports arm64-v8a
        try {
            gradleProject.resolveAndBuild(
                target = AndroidLaunchTarget.Gradle(buildRoot, ":app", "debug", build = false),
                deviceAbis = listOf("arm64-v8a"),
                onStage = {},
                onOutput = {},
            )
            fail("Expected ABI_MISMATCH")
        } catch (e: AndroidRunException) {
            assertEquals(AndroidRunErrorCode.ABI_MISMATCH, e.error.code)
        }

        // Dynamic feature rejected with UNSUPPORTED_ARTIFACT
        try {
            gradleProject.resolveAndBuild(
                target = AndroidLaunchTarget.Gradle(buildRoot, ":feature", "debug", build = false),
                deviceAbis = listOf("arm64-v8a"),
                onStage = {},
                onOutput = {},
            )
            fail("Expected UNSUPPORTED_ARTIFACT")
        } catch (e: AndroidRunException) {
            assertEquals(AndroidRunErrorCode.UNSUPPORTED_ARTIFACT, e.error.code)
        }

        // AGP 8.7.0 rejected with UNSUPPORTED_AGP
        try {
            gradleProject.resolveAndBuild(
                target = AndroidLaunchTarget.Gradle(buildRoot, ":oldagp", "debug", build = false),
                deviceAbis = listOf("arm64-v8a"),
                onStage = {},
                onOutput = {},
            )
            fail("Expected UNSUPPORTED_AGP")
        } catch (e: AndroidRunException) {
            assertEquals(AndroidRunErrorCode.UNSUPPORTED_AGP, e.error.code)
        }
    }

    @Test
    fun `cancellation triggers CancellationTokenSource waits for operation completion then closes ProjectConnection`() =
        runBlocking {
            val buildRoot = tempFolder.newFolder("cancel-root").toPath().toAbsolutePath().normalize()
            val fullJdk = createFakeJdk("jdk21", withJlink = true)
            val listingFile = buildRoot.resolve("app/build/outputs/apk/debug/output-metadata.json").toFile()

            val dto = AndroidRunModelResultDto(
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
                            AndroidVariantModelDto("debug", ":app:assembleDebug", listingFile, null, "com.example.app")
                        ),
                    )
                ),
                includedBuildRoots = emptyList(),
                nonAndroidProjectPaths = emptyList(),
                versionFailureDiagnostics = emptyList(),
            )

            val buildStarted = CompletableDeferred<Pair<CancellationToken, ResultHandler<Void?>>>()
            val buildConnectionClosed = AtomicBoolean(false)

            val gradleProject = AndroidGradleProject(
                context = AndroidGradleContext(
                    importedRoots = mapOf(buildRoot to AndroidGradleRootContext(buildRoot, javaHome = fullJdk))
                ),
                connectorFactory = { _ ->
                    fakeGradleConnector(
                        onModelAction = { _, _, handler -> handler.onComplete(dto) },
                        onBuild = { _, _, token, _, _, handler ->
                            buildStarted.complete(token to handler)
                        },
                        onConnectionClosed = {
                            if (buildStarted.isCompleted) {
                                buildConnectionClosed.set(true)
                            }
                        },
                    )
                },
                cancelCompletionWaitMs = 5_000L,
            )
            val operationFailure = CompletableDeferred<AndroidRunException>()

            val job = async {
                try {
                    gradleProject.resolveAndBuild(
                        target = AndroidLaunchTarget.Gradle(buildRoot, ":app", "debug", build = true),
                        deviceAbis = listOf("arm64-v8a"),
                        onStage = {},
                        onOutput = {},
                    )
                } catch (failure: AndroidRunException) {
                    operationFailure.complete(failure)
                }
            }

            val (token, handler) = withTimeout(5_000L) { buildStarted.await() }
            assertFalse(token.isCancellationRequested)

            // Cancel caller coroutine and wait until token cancellation is requested.
            job.cancel(CancellationException("User cancelled build"))
            val deadline = System.nanoTime() + 2_000_000_000L
            while (!token.isCancellationRequested && System.nanoTime() < deadline) {
                delay(10)
            }
            assertTrue("CancellationToken must be cancelled", token.isCancellationRequested)

            // Connection must remain open until Gradle ResultHandler completes!
            delay(50)
            assertFalse("ProjectConnection must not close before ResultHandler finishes", buildConnectionClosed.get())

            handler.onFailure(BuildCancelledException("Build cancelled by token"))

            try {
                job.await()
                fail("Expected coroutine cancellation")
            } catch (_: CancellationException) {
                assertTrue(job.isCancelled)
            }
            val failure = withTimeout(5_000L) { operationFailure.await() }
            assertEquals(AndroidRunErrorCode.CANCELLED, failure.error.code)
            assertEquals(AndroidRunStage.BUILDING, failure.error.stage)
            assertNull(failure.error.cleanupError)
            assertTrue("ProjectConnection must close after ResultHandler finishes", buildConnectionClosed.get())
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

    @Suppress("UNCHECKED_CAST")
    private fun <T> javaRoundTrip(value: T): T {
        val bytes = ByteArrayOutputStream()
        ObjectOutputStream(bytes).use { it.writeObject(value) }
        return ObjectInputStream(ByteArrayInputStream(bytes.toByteArray())).use { it.readObject() as T }
    }

    private data class FakeVariantSpec(
        val name: String,
        val assembleTask: String?,
        val listingFile: File?,
        val abiFilters: Set<String>?,
        val applicationId: String?,
    )

    private data class FakeGradleProjectSpec(
        val path: String,
        val dir: File,
        val versions: Versions?,
        val basic: BasicAndroidProject?,
        val android: AndroidProject?,
    )

    private fun fakeVersions(agp: String): Versions = Proxy.newProxyInstance(
        Versions::class.java.classLoader,
        arrayOf(Versions::class.java)
    ) { proxy, method, args ->
        when (method.name) {
            "getAgp" -> agp
            "getVersions" -> emptyMap<String, Versions.Version>()
            else -> handleStandardObjectMethod(proxy, method, args)
        }
    } as Versions

    private fun fakeBasicAndroidProject(path: String, projectType: ProjectType): BasicAndroidProject =
        Proxy.newProxyInstance(
            BasicAndroidProject::class.java.classLoader,
            arrayOf(BasicAndroidProject::class.java)
        ) { proxy, method, args ->
            when (method.name) {
                "getPath" -> path
                "getProjectType" -> projectType
                else -> handleStandardObjectMethod(proxy, method, args)
            }
        } as BasicAndroidProject

    private fun fakeAndroidProject(variants: List<FakeVariantSpec>): AndroidProject {
        val variantProxies = variants.map { spec ->
            val artifact = Proxy.newProxyInstance(
                AndroidArtifact::class.java.classLoader,
                arrayOf(AndroidArtifact::class.java)
            ) { proxy, method, args ->
                when (method.name) {
                    "getAssembleTaskName" -> spec.assembleTask
                    "getAssembleTaskOutputListingFile" -> spec.listingFile
                    "getAbiFilters" -> spec.abiFilters
                    "getApplicationId" -> spec.applicationId
                    else -> handleStandardObjectMethod(proxy, method, args)
                }
            } as AndroidArtifact

            Proxy.newProxyInstance(
                Variant::class.java.classLoader,
                arrayOf(Variant::class.java)
            ) { proxy, method, args ->
                when (method.name) {
                    "getName" -> spec.name
                    "getMainArtifact" -> artifact
                    else -> handleStandardObjectMethod(proxy, method, args)
                }
            } as Variant
        }

        return Proxy.newProxyInstance(
            AndroidProject::class.java.classLoader,
            arrayOf(AndroidProject::class.java)
        ) { proxy, method, args ->
            when (method.name) {
                "getVariants" -> variantProxies
                else -> handleStandardObjectMethod(proxy, method, args)
            }
        } as AndroidProject
    }

    @Suppress("UNCHECKED_CAST")
    private fun <T> fakeDomainObjectSet(items: List<T>): DomainObjectSet<T> = Proxy.newProxyInstance(
        DomainObjectSet::class.java.classLoader,
        arrayOf(DomainObjectSet::class.java)
    ) { proxy, method, args ->
        when (method.name) {
            "iterator" -> items.iterator()
            "size" -> items.size
            "isEmpty" -> items.isEmpty()
            "getAll" -> items
            "getAt" -> items[args!![0] as Int]
            else -> handleStandardObjectMethod(proxy, method, args)
        }
    } as DomainObjectSet<T>

    private fun fakeBuildController(
        rootDir: File,
        projects: List<FakeGradleProjectSpec>,
        includedRoots: List<File>,
    ): BuildController {
        val projectMap = LinkedHashMap<BasicGradleProject, FakeGradleProjectSpec>()
        val basicProjects = projects.map { spec ->
            val proxy = Proxy.newProxyInstance(
                BasicGradleProject::class.java.classLoader,
                arrayOf(BasicGradleProject::class.java)
            ) { p, method, args ->
                when (method.name) {
                    "getPath" -> spec.path
                    "getProjectDirectory" -> spec.dir
                    else -> handleStandardObjectMethod(p, method, args)
                }
            } as BasicGradleProject
            projectMap[proxy] = spec
            proxy
        }

        val rootBasic = basicProjects.first()
        val includedBuilds = includedRoots.map { incDir ->
            val incRoot = Proxy.newProxyInstance(
                BasicGradleProject::class.java.classLoader,
                arrayOf(BasicGradleProject::class.java)
            ) { p, method, args ->
                when (method.name) {
                    "getProjectDirectory" -> incDir
                    "getPath" -> ":"
                    else -> handleStandardObjectMethod(p, method, args)
                }
            } as BasicGradleProject

            Proxy.newProxyInstance(
                GradleBuild::class.java.classLoader,
                arrayOf(GradleBuild::class.java)
            ) { p, method, args ->
                when (method.name) {
                    "getRootProject" -> incRoot
                    else -> handleStandardObjectMethod(p, method, args)
                }
            } as GradleBuild
        }

        val gradleBuild = Proxy.newProxyInstance(
            GradleBuild::class.java.classLoader,
            arrayOf(GradleBuild::class.java)
        ) { p, method, args ->
            when (method.name) {
                "getRootProject" -> rootBasic
                "getProjects" -> fakeDomainObjectSet(basicProjects)
                "getIncludedBuilds" -> fakeDomainObjectSet(includedBuilds)
                else -> handleStandardObjectMethod(p, method, args)
            }
        } as GradleBuild

        return Proxy.newProxyInstance(
            BuildController::class.java.classLoader,
            arrayOf(BuildController::class.java)
        ) { p, method, args ->
            when (method.name) {
                "getBuildModel" -> gradleBuild
                "findModel" -> {
                    val target = args!![0] as? BasicGradleProject
                    val modelType = args[1] as Class<*>
                    val spec = projectMap[target]
                    when (modelType) {
                        Versions::class.java -> spec?.versions
                        BasicAndroidProject::class.java -> spec?.basic
                        AndroidProject::class.java -> spec?.android
                        else -> null
                    }
                }

                else -> handleStandardObjectMethod(p, method, args)
            }
        } as BuildController
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

    private fun fakeGradleConnector(
        onModelAction: (File?, CancellationToken, ResultHandler<AndroidRunModelResultDto>) -> Unit,
        onBuild: (List<String>, File?, CancellationToken, OutputStream, OutputStream, ResultHandler<Void?>) -> Unit,
        onConnectionClosed: () -> Unit = {},
    ): GradleConnector {
        return object : GradleConnector() {
            override fun useInstallation(gradleHome: File?): GradleConnector = this
            override fun useGradleVersion(gradleVersion: String?): GradleConnector = this
            override fun useDistribution(gradleDistribution: java.net.URI?): GradleConnector = this
            override fun useBuildDistribution(): GradleConnector = this
            override fun forProjectDirectory(projectDir: File?): GradleConnector = this
            override fun useGradleUserHomeDir(gradleUserHomeDir: File?): GradleConnector = this
            override fun disconnect() {}
            override fun connect(): ProjectConnection {
                return Proxy.newProxyInstance(
                    ProjectConnection::class.java.classLoader,
                    arrayOf(ProjectConnection::class.java)
                ) { proxy, method, args ->
                    when (method.name) {
                        "action" -> createFakeActionExecuter(onModelAction)
                        "newBuild" -> createFakeBuildLauncher(onBuild)
                        "close" -> {
                            onConnectionClosed()
                            null
                        }

                        else -> handleStandardObjectMethod(proxy, method, args)
                    }
                } as ProjectConnection
            }
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun createFakeActionExecuter(
        onRun: (File?, CancellationToken, ResultHandler<AndroidRunModelResultDto>) -> Unit,
    ): BuildActionExecuter<AndroidRunModelResultDto> {
        var javaHome: File? = null
        var token: CancellationToken = object : CancellationToken {
            override fun isCancellationRequested(): Boolean = false
        }
        lateinit var proxy: BuildActionExecuter<AndroidRunModelResultDto>
        proxy = Proxy.newProxyInstance(
            BuildActionExecuter::class.java.classLoader,
            arrayOf(BuildActionExecuter::class.java)
        ) { _, method, args ->
            when (method.name) {
                "setJavaHome" -> {
                    javaHome = args!![0] as? File
                    proxy
                }

                "withCancellationToken" -> {
                    token = args!![0] as CancellationToken
                    proxy
                }

                "setEnvironmentVariables", "withSystemProperties", "withArguments",
                "addArguments", "setStandardOutput", "setStandardError" -> proxy

                "run" -> {
                    val handler = args!![0] as ResultHandler<AndroidRunModelResultDto>
                    onRun(javaHome, token, handler)
                    null
                }

                else -> handleStandardObjectMethod(proxy, method, args) ?: proxy
            }
        } as BuildActionExecuter<AndroidRunModelResultDto>
        return proxy
    }

    @Suppress("UNCHECKED_CAST")
    private fun createFakeBuildLauncher(
        onRun: (List<String>, File?, CancellationToken, OutputStream, OutputStream, ResultHandler<Void?>) -> Unit,
    ): BuildLauncher {
        val tasks = ArrayList<String>()
        var javaHome: File? = null
        var stdout: OutputStream = OutputStream.nullOutputStream()
        var stderr: OutputStream = OutputStream.nullOutputStream()
        var token: CancellationToken = object : CancellationToken {
            override fun isCancellationRequested(): Boolean = false
        }
        lateinit var proxy: BuildLauncher
        proxy = Proxy.newProxyInstance(
            BuildLauncher::class.java.classLoader,
            arrayOf(BuildLauncher::class.java)
        ) { _, method, args ->
            when (method.name) {
                "forTasks" -> {
                    val first = args?.getOrNull(0)
                    if (first is Array<*>) {
                        first.filterIsInstance<String>().forEach(tasks::add)
                    } else if (first is Iterable<*>) {
                        first.filterIsInstance<String>().forEach(tasks::add)
                    }
                    proxy
                }

                "setJavaHome" -> {
                    javaHome = args!![0] as? File
                    proxy
                }

                "setStandardOutput" -> {
                    stdout = args!![0] as OutputStream
                    proxy
                }

                "setStandardError" -> {
                    stderr = args!![0] as OutputStream
                    proxy
                }

                "withCancellationToken" -> {
                    token = args!![0] as CancellationToken
                    proxy
                }

                "setEnvironmentVariables", "withSystemProperties", "withArguments", "addArguments" -> proxy
                "run" -> {
                    val handler = args!![0] as ResultHandler<Void?>
                    onRun(tasks.toList(), javaHome, token, stdout, stderr, handler)
                    null
                }

                else -> handleStandardObjectMethod(proxy, method, args) ?: proxy
            }
        } as BuildLauncher
        return proxy
    }
}
