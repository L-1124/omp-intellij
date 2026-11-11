package org.jetbrains.android.debug

import com.intellij.execution.CantRunException
import com.intellij.execution.JavaExecutionUtil
import com.intellij.execution.configurations.JavaParameters
import com.intellij.java.workspace.entities.javaSettings
import com.intellij.openapi.application.readAction
import com.intellij.openapi.externalSystem.ExternalSystemModulePropertyManager
import com.intellij.openapi.externalSystem.util.ExternalSystemApiUtil
import com.intellij.openapi.module.Module
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.projectRoots.JavaSdk
import com.intellij.openapi.projectRoots.JavaSdkType
import com.intellij.openapi.projectRoots.JavaSdkVersion
import com.intellij.openapi.projectRoots.JavaSdkVersionUtil
import com.intellij.openapi.projectRoots.Sdk
import com.intellij.openapi.roots.LibraryOrSdkOrderEntry
import com.intellij.openapi.roots.ModuleRootManager
import com.intellij.openapi.roots.ModuleOrderEntry
import com.intellij.openapi.roots.ModuleSourceOrderEntry
import com.intellij.openapi.roots.OrderEnumerator
import com.intellij.openapi.roots.ProjectFileIndex
import com.intellij.openapi.util.SystemInfo
import com.intellij.openapi.vfs.VfsUtilCore
import com.intellij.openapi.vfs.VirtualFileManager
import com.intellij.platform.backend.workspace.WorkspaceModel
import com.intellij.platform.workspace.jps.entities.ModuleId
import com.jetbrains.ls.api.core.LSAnalysisContext
import com.jetbrains.ls.api.core.LSServer
import com.jetbrains.ls.api.features.commands.LSCommandDescriptor
import com.jetbrains.ls.api.features.commands.LSCommandDescriptorProvider
import com.jetbrains.ls.api.features.commands.LSCommandExecutor
import com.jetbrains.lsp.implementation.throwLspError
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import java.io.File
import java.net.URI
import java.nio.file.Files
import java.nio.file.Path

// Keep target identity consistent with the pinned ILS Gradle/Maven module mappers.
class JvmLaunchCommands : LSCommandDescriptorProvider {

    companion object {
        const val COMMAND_RESOLVE_LAUNCH = "omp.jvm.resolveLaunch"
        const val COMMAND_RESOLVE_BUILD = "omp.jvm.resolveBuildCommand"

        private const val LSP_ERROR_CODE_INVALID_PARAMS = -32602
        private const val LSP_ERROR_CODE_INTERNAL_ERROR = -32603
    }

    override val commandDescriptors: List<LSCommandDescriptor>
        get() = listOf(
            LSCommandDescriptor(
                "Resolve JVM Launch",
                COMMAND_RESOLVE_LAUNCH,
                createResolveLaunchExecutor()
            ),
            LSCommandDescriptor(
                "Resolve JVM Build Command",
                COMMAND_RESOLVE_BUILD,
                createResolveBuildCommandExecutor()
            )
        )

    private fun createResolveLaunchExecutor(): LSCommandExecutor {
        return LSCommandExecutor { arguments ->
            val server = contextOf<LSServer>()
            val path = parseUriArgument(arguments)
            server.withAnalysisContext {
                readAction {
                    ProgressManager.checkCanceled()
                    val project = contextOf<LSAnalysisContext>().project
                    resolveLaunchInternal(project, path)
                }
            }
        }
    }

    private fun createResolveBuildCommandExecutor(): LSCommandExecutor {
        return LSCommandExecutor { arguments ->
            val server = contextOf<LSServer>()
            val path = parseUriArgument(arguments)
            server.withAnalysisContext {
                readAction {
                    ProgressManager.checkCanceled()
                    val project = contextOf<LSAnalysisContext>().project
                    resolveBuildCommandInternal(project, path)
                }
            }
        }
    }

    private fun parseUriArgument(arguments: List<JsonElement>?): Path {
        if (arguments == null || arguments.size != 1) {
            throwLspError(
                "Expected single JsonObject argument",
                JsonNull,
                LSP_ERROR_CODE_INVALID_PARAMS
            )
        }
        val args = arguments[0] as? JsonObject
            ?: throwLspError(
                "Expected single JsonObject argument",
                JsonNull,
                LSP_ERROR_CODE_INVALID_PARAMS
            )
        val uriEl = args["uri"]
            ?: throwLspError(
                "Missing 'uri' parameter",
                JsonNull,
                LSP_ERROR_CODE_INVALID_PARAMS
            )
        val uriStr = (uriEl as? JsonPrimitive)?.takeIf { it.isString }?.content
        if (uriStr.isNullOrBlank()) {
            throwLspError(
                "'uri' parameter must be a non-empty string",
                JsonNull,
                LSP_ERROR_CODE_INVALID_PARAMS
            )
        }
        val path = try {
            val uri = URI(uriStr)
            require(uri.scheme.equals("file", ignoreCase = true) && uri.authority.isNullOrEmpty())
            Path.of(uri).toAbsolutePath().normalize()
        } catch (e: IllegalArgumentException) {
            throwLspError("Invalid local file URI: $uriStr", JsonNull, LSP_ERROR_CODE_INVALID_PARAMS, e)
        } catch (e: java.net.URISyntaxException) {
            throwLspError("Invalid local file URI: $uriStr", JsonNull, LSP_ERROR_CODE_INVALID_PARAMS, e)
        }
        if (!Files.isRegularFile(path)) {
            throwLspError("Source file not found: $path", JsonNull, LSP_ERROR_CODE_INVALID_PARAMS)
        }
        return path
    }

    private data class TargetContext(val module: Module, val isTest: Boolean)

    private fun resolveTargetContext(project: Project, path: Path): TargetContext {
        val url = VfsUtilCore.pathToUrl(path.toString())
        val virtualFile = VirtualFileManager.getInstance().findFileByUrl(url)
            ?: throwLspError("Virtual file not found: $path", JsonNull, LSP_ERROR_CODE_INVALID_PARAMS)
        val fileIndex = ProjectFileIndex.getInstance(project)
        val module = fileIndex.getModuleForFile(virtualFile)
            ?: throwLspError(
                "File does not belong to any module in project: $path",
                JsonNull,
                LSP_ERROR_CODE_INVALID_PARAMS
            )

        return TargetContext(module, fileIndex.isInTestSourceContent(virtualFile))
    }

    private fun resolveLaunchInternal(project: Project, path: Path): JsonElement {
        val target = resolveTargetContext(project, path)
        val module = target.module
        val javaParams = JavaParameters()
        try {
            // ILS SDK homes may lack VFS nodes; the selected SDK executable is validated below.
            javaParams.configureByModule(
                module,
                JavaParameters.JDK_ONLY,
                JavaParameters.getJdkToRunModule(module, !target.isTest)
            )
        } catch (e: CantRunException) {
            throwLspError(
                "Failed to configure Java parameters for module ${module.name}: ${e.message}",
                JsonNull,
                LSP_ERROR_CODE_INTERNAL_ERROR,
                e
            )
        }

        val jdk = javaParams.jdk
            ?: throwLspError(
                "No valid JDK configured for module: ${module.name}",
                JsonNull,
                LSP_ERROR_CODE_INTERNAL_ERROR
            )

        val javaExec = resolveJavaExecutable(jdk)
            ?: throwLspError(
                "No valid java executable found for SDK '${jdk.name}' on module ${module.name}",
                JsonNull,
                LSP_ERROR_CODE_INTERNAL_ERROR
            )

        // Keep native contribution ordering and scopes without relying on absent IDE compiler extensions.
        val storage = WorkspaceModel.getInstance(project).currentSnapshot
        // The selected source module must win over dependencies defining the same main class.
        val ownOutputs = storage.resolve(ModuleId(module.name))?.javaSettings
        if (target.isTest) ownOutputs?.compilerOutputForTests?.url?.let {
            javaParams.classPath.add(VfsUtilCore.urlToPath(it))
        }
        ownOutputs?.compilerOutput?.url?.let {
            javaParams.classPath.add(VfsUtilCore.urlToPath(it))
        }
        var entries = OrderEnumerator.orderEntries(module).recursively().runtimeOnly().withoutSdk()
        if (!target.isTest) entries = entries.productionOnly()
        for (contribution in entries.classes().enumeratedEntries) {
            val entry = contribution.orderEntry()
            val dependencyModule = when (entry) {
                is ModuleSourceOrderEntry -> entry.ownerModule
                is ModuleOrderEntry -> entry.module
                else -> null
            }
            if (dependencyModule == module) continue
            if (dependencyModule != null) {
                val outputs = storage.resolve(ModuleId(dependencyModule.name))?.javaSettings
                if (contribution.includeTests()) {
                    outputs?.compilerOutputForTests?.url?.let {
                        javaParams.classPath.add(VfsUtilCore.urlToPath(it))
                    }
                }
                if (contribution.includeProduction()) {
                    outputs?.compilerOutput?.url?.let {
                        javaParams.classPath.add(VfsUtilCore.urlToPath(it))
                    }
                }
            } else if (entry is LibraryOrSdkOrderEntry) {
                for (url in entry.getRootUrls(contribution.rootType())) {
                    javaParams.classPath.add(VfsUtilCore.urlToPath(url).removeSuffix("!/"))
                }
            }
        }
        if (JavaSdkVersionUtil.isAtLeast(jdk, JavaSdkVersion.JDK_11) &&
            JavaExecutionUtil.compilesPreviewFeatures(module)
        ) {
            javaParams.vmParametersList.add(JavaParameters.JAVA_ENABLE_PREVIEW_PROPERTY)
        }

        val classpath = javaParams.classPath.pathList
        if (classpath.isEmpty()) {
            throwLspError(
                "No runtime classpath was imported for module ${module.name}",
                JsonNull,
                LSP_ERROR_CODE_INTERNAL_ERROR
            )
        }
        val modulePath = javaParams.modulePath.pathList.takeIf { it.isNotEmpty() }
        val vmArgs = javaParams.vmParametersList.parameters.takeIf { it.isNotEmpty() }

        val rootManager = ModuleRootManager.getInstance(module)
        val contentRoots = rootManager.contentRoots.map { it.path }

        val extPropManager = ExternalSystemModulePropertyManager.getInstance(module)
        val workingDir = javaParams.workingDirectory
            ?: extPropManager.getLinkedProjectPath()
            ?: contentRoots.firstOrNull()
            ?: project.basePath
            ?: ""

        val moduleContentPaths =
            if (contentRoots.isNotEmpty()) contentRoots else if (workingDir.isNotBlank()) listOf(workingDir) else emptyList()
        val moduleName = module.name

        return buildJsonObject {
            put("javaExec", JsonPrimitive(javaExec))
            put("classpath", JsonArray(classpath.map { JsonPrimitive(it) }))
            if (modulePath != null) {
                put("modulePath", JsonArray(modulePath.map { JsonPrimitive(it) }))
            }
            put("moduleName", JsonPrimitive(moduleName))
            put("moduleContentPaths", JsonArray(moduleContentPaths.map { JsonPrimitive(it) }))
            put("workingDirectory", JsonPrimitive(workingDir))
            if (vmArgs != null) {
                put("vmArgs", JsonArray(vmArgs.map { JsonPrimitive(it) }))
            }
        }
    }

    private fun resolveBuildCommandInternal(project: Project, path: Path): JsonElement {
        val target = resolveTargetContext(project, path)
        val module = target.module
        val isTest = target.isTest

        val extPropManager = ExternalSystemModulePropertyManager.getInstance(module)
        val extSystemId = extPropManager.getExternalSystemId()
        val isMaven = extPropManager.isMavenized() || extSystemId?.equals("Maven", ignoreCase = true) == true
        val isGradle = extSystemId?.equals(
            "GRADLE",
            ignoreCase = true
        ) == true

        if (isGradle) {
            val rootProjectPath = extPropManager.getRootProjectPath()
                ?: ExternalSystemApiUtil.getExternalRootProjectPath(module)
                ?: project.basePath
                ?: ""
            if (rootProjectPath.isBlank()) {
                return buildUnsupportedResult("Cannot determine Gradle root project path for module ${module.name}")
            }
            val rootDir = Path.of(rootProjectPath).toAbsolutePath().normalize()

            // Resolve real host JVM from module SDK
            val javaParams = JavaParameters()
            try {
                javaParams.configureByModule(
                    module,
                    JavaParameters.JDK_ONLY,
                    JavaParameters.getJdkToRunModule(module, true)
                )
            } catch (e: CantRunException) {
                return buildUnsupportedResult("Failed to configure JDK for Gradle module ${module.name}: ${e.message}")
            }
            val jdk = javaParams.jdk
                ?: return buildUnsupportedResult("No JDK configured for Gradle module ${module.name}")
            val javaExe = resolveJavaExecutable(jdk)
                ?: return buildUnsupportedResult("No valid java executable for SDK '${jdk.name}' on module ${module.name}")

            // Determine Gradle project path and source-set from imported external model
            // Adheres to GradleRunCommandsKt.gradleProjectPath and gradleSourceSetName
            val linkedProjectPath = extPropManager.getLinkedProjectPath()?.takeIf { it.isNotBlank() }
                ?: rootProjectPath
            val projectDir = Path.of(linkedProjectPath).toAbsolutePath().normalize()

            val projectPath = gradleProjectPath(extPropManager.getLinkedProjectId())
                ?: return buildUnsupportedResult("Missing Gradle project identity for module ${module.name}")
            val sourceSet = gradleSourceSetName(module, projectDir) ?: if (isTest) "test" else "main"
            val classesTask = gradleClassesTask(sourceSet)

            val taskPath = if (projectPath.isNotEmpty()) {
                gradleTaskPath(projectPath, classesTask)
            } else {
                ":$classesTask"
            }

            val wrapperJar = rootDir.resolve("gradle").resolve("wrapper").resolve("gradle-wrapper.jar")
            val command = if (Files.isRegularFile(wrapperJar)) {
                listOf(
                    javaExe,
                    "-Dorg.gradle.appname=gradlew",
                    "-classpath",
                    wrapperJar.toString(),
                    "org.gradle.wrapper.GradleWrapperMain",
                    taskPath
                )
            } else {
                if (SystemInfo.isWindows) {
                    return buildUnsupportedResult("Direct spawn of gradlew.bat requires a shell on Windows; gradle-wrapper.jar not found at $wrapperJar")
                }
                val gradlewSh = rootDir.resolve("gradlew")
                if (Files.isRegularFile(gradlewSh) && Files.isExecutable(gradlewSh)) {
                    listOf(gradlewSh.toString(), taskPath)
                } else {
                    return buildUnsupportedResult("Gradle wrapper executable not found at $gradlewSh and gradle-wrapper.jar absent")
                }
            }

            return buildJsonObject {
                put("supported", JsonPrimitive(true))
                put("command", JsonArray(command.map { JsonPrimitive(it) }))
                put("cwd", JsonPrimitive(rootDir.toString()))
                put("tool", JsonPrimitive("gradle"))
            }
        }

        if (isMaven) {
            val rootManager = ModuleRootManager.getInstance(module)
            val moduleDir = (extPropManager.getLinkedProjectPath()?.let { Path.of(it) }
                ?: rootManager.contentRoots.firstOrNull()?.let { Path.of(it.path) }
                ?: project.basePath?.let { Path.of(it) })?.toAbsolutePath()?.normalize()
                ?: return buildUnsupportedResult("Cannot determine module directory for Maven module ${module.name}")

            val rootPomOrDir = extPropManager.getRootProjectPath()?.let { Path.of(it) }
            val reactorRoot = when {
                rootPomOrDir != null && Files.isRegularFile(rootPomOrDir) -> rootPomOrDir.parent.toAbsolutePath()
                    .normalize()

                rootPomOrDir != null && Files.isDirectory(rootPomOrDir) -> rootPomOrDir.toAbsolutePath().normalize()
                !project.basePath.isNullOrBlank() -> Path.of(project.basePath!!).toAbsolutePath().normalize()
                else -> moduleDir
            }

            val javaParams = JavaParameters()
            try {
                javaParams.configureByModule(
                    module,
                    JavaParameters.JDK_ONLY,
                    JavaParameters.getJdkToRunModule(module, true)
                )
            } catch (e: CantRunException) {
                return buildUnsupportedResult("Failed to configure JDK for Maven module ${module.name}: ${e.message}")
            }
            val jdk = javaParams.jdk
                ?: return buildUnsupportedResult("No JDK configured for Maven module ${module.name}")
            val javaExe = resolveJavaExecutable(jdk)
                ?: return buildUnsupportedResult("No valid java executable for SDK '${jdk.name}' on module ${module.name}")

            val mavenHome = findMavenHome()
                ?: return buildUnsupportedResult("Maven installation not found in MAVEN_HOME, M2_HOME, or PATH")

            val bootDir = mavenHome.resolve("boot")
            val plexusJar = if (Files.isDirectory(bootDir)) {
                Files.list(bootDir).use { stream ->
                    stream.filter {
                        val name = it.fileName.toString()
                        name.startsWith("plexus-classworlds") && name.endsWith(".jar")
                    }.findFirst().orElse(null)
                }
            } else null

            if (plexusJar == null) {
                return buildUnsupportedResult("plexus-classworlds jar not found in Maven boot directory at $bootDir")
            }

            val m2Conf = mavenHome.resolve("bin").resolve("m2.conf")
            val isReactor = reactorRoot != moduleDir && Files.isRegularFile(reactorRoot.resolve("pom.xml"))

            // Adheres to MavenRunCommandsKt.mavenArgs
            val projectPath = if (isReactor) {
                reactorRoot.relativize(moduleDir).toString().replace('\\', '/')
            } else {
                null
            }

            val goals = mutableListOf<String>()
            if (projectPath != null) {
                goals.add("-pl")
                goals.add(projectPath)
                goals.add("-am")
            }
            goals.add(if (isTest) "test-compile" else if (projectPath != null) "compile" else "test-compile")

            val workingDir = if (isReactor) reactorRoot else moduleDir
            val command = mutableListOf(
                javaExe,
                "-Dclassworlds.conf=$m2Conf",
                "-Dmaven.home=$mavenHome",
                "-Dmaven.multiModuleProjectDirectory=$workingDir",
                "-classpath",
                plexusJar.toString(),
                "org.codehaus.plexus.classworlds.launcher.Launcher"
            )
            command.addAll(goals)

            return buildJsonObject {
                put("supported", JsonPrimitive(true))
                put("command", JsonArray(command.map { JsonPrimitive(it) }))
                put("cwd", JsonPrimitive(workingDir.toString()))
                put("tool", JsonPrimitive("maven"))
            }
        }

        return buildUnsupportedResult("Unsupported build tool for module ${module.name}")
    }

    private fun buildUnsupportedResult(reason: String): JsonObject {
        return buildJsonObject {
            put("supported", JsonPrimitive(false))
            put("command", JsonArray(emptyList()))
            put("cwd", JsonPrimitive(""))
            put("tool", JsonPrimitive("unknown"))
            put("reason", JsonPrimitive(reason))
        }
    }

    private fun gradleProjectPath(path: String?): String? {
        if (path.isNullOrBlank() || !path.startsWith(":")) return null
        return if (path == ":") "" else path
    }

    // ILS source-set modules have distinct content roots; project modules retain the project root.
    private fun gradleSourceSetName(module: Module, projectDir: Path?): String? {
        if (projectDir == null) return null
        val sourceSetName = module.name.substringAfterLast('.', "")
        if (sourceSetName.isEmpty()) return null

        val normalizedProjectDir = projectDir.toAbsolutePath().normalize()
        val isProjectModule = ModuleRootManager.getInstance(module).contentRoots.any {
            Path.of(it.path).toAbsolutePath().normalize() == normalizedProjectDir
        }
        return if (isProjectModule) null else sourceSetName
    }

    /**
     * Port of GradleRunCommandsKt.gradleClassesTask (com.jetbrains.ls.imports.gradle.GradleRunCommandsKt:164-167).
     */
    private fun gradleClassesTask(sourceSet: String): String {
        return if (sourceSet != "main") "${sourceSet}Classes" else "classes"
    }

    /**
     * Port of GradleRunCommandsKt.gradleTaskPath (com.jetbrains.ls.imports.gradle.GradleRunCommandsKt:170-174).
     */
    private fun gradleTaskPath(projectPath: String, task: String): String {
        return "$projectPath:$task"
    }

    private fun resolveJavaExecutable(sdk: Sdk): String? {
        val type = sdk.sdkType as? JavaSdkType
        val vmExe = type?.getVMExecutablePath(sdk)
            ?: JavaSdk.getInstance()?.getVMExecutablePath(sdk)
        if (!vmExe.isNullOrBlank()) {
            val p = Path.of(vmExe)
            if (Files.isRegularFile(p)) return p.toString()
        }
        val home = sdk.homeDirectory?.toNioPath() ?: sdk.homePath?.let { Path.of(it) }
        if (home != null) {
            val exeName = if (SystemInfo.isWindows) "java.exe" else "java"
            val bin = home.resolve("bin").resolve(exeName)
            if (Files.isRegularFile(bin)) return bin.toString()
        }
        return null
    }

    private fun findMavenHome(): Path? {
        val envM2 = System.getenv("M2_HOME")?.takeIf { it.isNotBlank() }
            ?: System.getenv("MAVEN_HOME")?.takeIf { it.isNotBlank() }
        if (envM2 != null) {
            val p = Path.of(envM2)
            if (Files.isDirectory(p)) return p
        }
        val pathEnv = System.getenv("PATH") ?: ""
        for (entry in pathEnv.split(File.pathSeparator)) {
            if (entry.isBlank()) continue
            try {
                val dir = Path.of(entry)
                val mvnFile = if (SystemInfo.isWindows) dir.resolve("mvn.cmd") else dir.resolve("mvn")
                if (Files.isRegularFile(mvnFile)) {
                    val parent = dir.parent
                    if (parent != null && Files.isDirectory(parent.resolve("boot"))) {
                        return parent
                    }
                }
            } catch (_: Exception) {
            }
        }
        return null
    }
}
