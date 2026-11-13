package org.jetbrains.android.run

import com.jetbrains.dap.protocol.AttachRequestArguments
import com.jetbrains.dap.protocol.LaunchRequestArguments
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import java.nio.file.Files
import java.nio.file.InvalidPathException
import java.nio.file.Path
import java.util.Locale
import org.jetbrains.annotations.ApiStatus

sealed interface AndroidLaunchTarget {
    data class Gradle(
        val buildRoot: Path,
        val module: String,
        val variant: String,
        val build: Boolean = true,
    ) : AndroidLaunchTarget

    data class Apks(
        val files: List<Path>,
    ) : AndroidLaunchTarget

    data class Installed(
        val packageName: String,
    ) : AndroidLaunchTarget
}

data class AndroidLaunchConfig(
    val project: Path,
    val cwd: Path,
    val program: String?,
    val noDebug: Boolean,
    val deviceId: String,
    val userId: Int?,
    val target: AndroidLaunchTarget,
    val activity: String?,
    val restartApp: Boolean,
    val timeoutMs: Int,
)

data class AndroidAttachConfig(
    val project: Path,
    val cwd: Path,
    val deviceId: String,
    val userId: Int?,
    val packageName: String,
    val pid: Int?,
    val processName: String?,
)

@Suppress("UnstableApiUsage")
@ApiStatus.Experimental
object AndroidLaunchArguments {
    const val DEFAULT_TIMEOUT_MS: Int = 120_000
    const val MIN_TIMEOUT_MS: Int = 1
    const val MAX_TIMEOUT_MS: Int = 300_000

    private val LAUNCH_ADAPTER_KEYS = setOf("android", "cwd", "program", "args")
    private val ATTACH_ADAPTER_KEYS = setOf("android", "cwd")
    private val LAUNCH_ANDROID_KEYS = setOf("deviceId", "userId", "target", "activity", "restartApp", "timeoutMs")
    private val ATTACH_ANDROID_KEYS = setOf("deviceId", "userId", "packageName", "pid", "processName")
    private val GRADLE_TARGET_KEYS = setOf("kind", "buildRoot", "module", "variant", "build")
    private val APKS_TARGET_KEYS = setOf("kind", "files")
    private val INSTALLED_TARGET_KEYS = setOf("kind", "packageName")
    private val UNSUPPORTED_TARGET_KINDS = setOf("aab", "bundle", "app-bundle", "dynamic-feature", "dynamic_feature")
    private val PACKAGE_NAME_REGEX = Regex("^[A-Za-z_][A-Za-z0-9_]*(\\.[A-Za-z_][A-Za-z0-9_]*)+$")

    fun parseLaunch(args: LaunchRequestArguments, projectDirectory: Path): AndroidLaunchConfig {
        val normalizedProject = projectDirectory.toAbsolutePath().normalize()
        val adapter = args.adapterArguments

        for (key in adapter.keys) {
            if (key !in LAUNCH_ADAPTER_KEYS) {
                throw invalidParams("Unsupported launch argument: $key")
            }
        }

        val effectiveCwd = parseOptionalCwd(adapter["cwd"], normalizedProject)
        val program = parseOptionalNonBlankString(adapter, "program")
        parseOptionalEmptyArgs(adapter["args"])

        val androidObj = requireAndroidObject(adapter)
        for (key in androidObj.keys) {
            if (key !in LAUNCH_ANDROID_KEYS) {
                if (key == "noDebug") {
                    throw invalidParams("android.noDebug is not supported; use top-level DAP noDebug")
                }
                throw invalidParams("Unsupported android launch field: $key")
            }
        }

        val deviceId = requireNonBlankString(androidObj, "deviceId", "android.deviceId")
        val userId = parseOptionalUserId(androidObj, deviceId)
        val activity = parseOptionalNonBlankString(androidObj, "activity", "android.activity", deviceId)
        val restartApp = parseOptionalBoolean(androidObj, "restartApp", "android.restartApp", deviceId) ?: false
        val timeoutMs = parseOptionalTimeoutMs(androidObj, deviceId)
        val target = parseLaunchTarget(androidObj["target"], effectiveCwd, program, deviceId)

        return AndroidLaunchConfig(
            project = normalizedProject,
            cwd = effectiveCwd,
            program = program,
            noDebug = args.noDebug ?: false,
            deviceId = deviceId,
            userId = userId,
            target = target,
            activity = activity,
            restartApp = restartApp,
            timeoutMs = timeoutMs,
        )
    }

    fun parseAttach(args: AttachRequestArguments, projectDirectory: Path): AndroidAttachConfig {
        val normalizedProject = projectDirectory.toAbsolutePath().normalize()
        if (args.port != null) {
            throw invalidParams("port is not supported for Android attach; JDWP port is resolved from deviceId and packageName")
        }

        val adapter = args.adapterArguments
        for (key in adapter.keys) {
            if (key !in ATTACH_ADAPTER_KEYS) {
                if (key == "noDebug") {
                    throw invalidParams("noDebug is not supported for Android attach")
                }
                if (key == "target" || key == "activity" || key == "restartApp") {
                    throw invalidParams("$key is not supported for Android attach")
                }
                throw invalidParams("Unsupported attach argument: $key")
            }
        }

        val effectiveCwd = parseOptionalCwd(adapter["cwd"], normalizedProject)
        val androidObj = requireAndroidObject(adapter)

        for (key in androidObj.keys) {
            if (key !in ATTACH_ANDROID_KEYS) {
                if (key == "target" || key == "activity" || key == "restartApp" || key == "noDebug") {
                    throw invalidParams("android.$key is not supported for Android attach")
                }
                throw invalidParams("Unsupported android attach field: $key")
            }
        }

        val deviceId = requireNonBlankString(androidObj, "deviceId", "android.deviceId")
        val userId = parseOptionalUserId(androidObj, deviceId)
        val packageName = requirePackageName(androidObj, "packageName", "android.packageName", deviceId)
        val pid = parseOptionalPositiveInt(androidObj, "pid", "android.pid", deviceId)
        val processName = parseOptionalNonBlankString(androidObj, "processName", "android.processName", deviceId)
        if (processName != null && processName.any { it.isWhitespace() }) {
            throw invalidParams("android.processName must not contain whitespace", device = deviceId)
        }
        if (pid != null && processName != null) {
            throw invalidParams("android.pid and android.processName are mutually exclusive", device = deviceId)
        }

        return AndroidAttachConfig(
            project = normalizedProject,
            cwd = effectiveCwd,
            deviceId = deviceId,
            userId = userId,
            packageName = packageName,
            pid = pid,
            processName = processName,
        )
    }

    private fun requireAndroidObject(adapter: JsonObject): JsonObject {
        val raw = adapter["android"]
            ?: throw invalidParams("android configuration is required")
        if (raw is JsonNull || raw !is JsonObject) {
            throw invalidParams("android must be a JSON object")
        }
        return raw
    }

    private fun parseOptionalCwd(element: JsonElement?, projectDirectory: Path): Path {
        if (element == null) return projectDirectory
        val raw = requireStringElement(element, "cwd")
        if (raw.isBlank()) {
            throw invalidParams("cwd must not be blank")
        }
        val parsed = parsePath(raw.trim(), "cwd")
        return if (parsed.isAbsolute) {
            parsed.normalize()
        } else {
            projectDirectory.resolve(parsed).normalize()
        }
    }

    private fun parseOptionalEmptyArgs(element: JsonElement?) {
        if (element == null) return
        if (element !is JsonArray) {
            throw invalidParams("args must be an array")
        }
        if (element.isNotEmpty()) {
            throw invalidParams("DAP args are not supported for Android launch")
        }
    }

    private fun parseLaunchTarget(
        element: JsonElement?,
        effectiveCwd: Path,
        program: String?,
        deviceId: String,
    ): AndroidLaunchTarget {
        if (element == null) {
            throw invalidParams("android.target is required", device = deviceId)
        }
        if (element is JsonNull || element !is JsonObject) {
            throw invalidParams("android.target must be a JSON object", device = deviceId)
        }
        val kind = requireNonBlankString(element, "kind", "android.target.kind", deviceId)
        if (kind in UNSUPPORTED_TARGET_KINDS) {
            throw configuringError(
                AndroidRunErrorCode.UNSUPPORTED_ARTIFACT,
                "AAB and dynamic feature targets are not supported; provide APK files or a Gradle application target",
                device = deviceId,
            )
        }
        return when (kind) {
            "gradle" -> parseGradleTarget(element, effectiveCwd, deviceId)
            "apks" -> parseApksTarget(element, effectiveCwd, program, deviceId)
            "installed" -> parseInstalledTarget(element, deviceId)
            else -> throw invalidParams(
                "Unsupported android.target.kind: $kind (expected gradle, apks, or installed)",
                device = deviceId,
            )
        }
    }

    private fun parseGradleTarget(
        targetObj: JsonObject,
        effectiveCwd: Path,
        deviceId: String,
    ): AndroidLaunchTarget.Gradle {
        for (key in targetObj.keys) {
            if (key !in GRADLE_TARGET_KEYS) {
                throw invalidParams("Unsupported field for gradle target: $key", device = deviceId)
            }
        }
        val buildRootRaw = parseOptionalNonBlankString(targetObj, "buildRoot", "android.target.buildRoot", deviceId)
        val buildRoot = if (buildRootRaw == null) {
            effectiveCwd
        } else {
            val parsed = parsePath(buildRootRaw, "android.target.buildRoot", deviceId)
            if (parsed.isAbsolute) parsed.normalize() else effectiveCwd.resolve(parsed).normalize()
        }
        val module = requireNonBlankString(targetObj, "module", "android.target.module", deviceId)
        if (!isValidGradleProjectPath(module)) {
            throw invalidParams(
                "android.target.module must be a full Gradle project path (e.g. :app)",
                device = deviceId,
                module = module,
            )
        }
        val variant = requireNonBlankString(targetObj, "variant", "android.target.variant", deviceId)
        val build = parseOptionalBoolean(targetObj, "build", "android.target.build", deviceId) ?: true
        return AndroidLaunchTarget.Gradle(
            buildRoot = buildRoot,
            module = module,
            variant = variant,
            build = build,
        )
    }

    private fun parseApksTarget(
        targetObj: JsonObject,
        effectiveCwd: Path,
        program: String?,
        deviceId: String,
    ): AndroidLaunchTarget.Apks {
        for (key in targetObj.keys) {
            if (key !in APKS_TARGET_KEYS) {
                throw invalidParams("Unsupported field for apks target: $key", device = deviceId)
            }
        }
        val filesElement = targetObj["files"]
        if (filesElement == null) {
            if (program == null) {
                throw invalidParams(
                    "android.target.files or program APK is required for apks target",
                    device = deviceId,
                )
            }
            val resolvedProgram = resolvePath(program, effectiveCwd, "program", deviceId)
            validateArtifactPath(
                resolvedProgram,
                requireApkExtension = true,
                nonApkIsInvalidParams = true,
                deviceId = deviceId
            )
            return AndroidLaunchTarget.Apks(files = listOf(resolvedProgram))
        }

        if (filesElement is JsonNull || filesElement !is JsonArray) {
            throw invalidParams("android.target.files must be an array of file paths", device = deviceId)
        }
        if (filesElement.isEmpty()) {
            throw invalidParams("android.target.files must not be empty", device = deviceId)
        }

        val resolvedFiles = ArrayList<Path>(filesElement.size)
        val seenNormalized = HashSet<Path>(filesElement.size)
        val seenReal = HashSet<Path>(filesElement.size)

        for ((index, item) in filesElement.withIndex()) {
            val fieldName = "android.target.files[$index]"
            val raw = requireStringElement(item, fieldName, deviceId)
            if (raw.isBlank()) {
                throw invalidParams("$fieldName must not be blank", device = deviceId)
            }
            val resolved = resolvePath(raw.trim(), effectiveCwd, fieldName, deviceId)
            validateArtifactPath(
                resolved,
                requireApkExtension = true,
                nonApkIsInvalidParams = false,
                deviceId = deviceId
            )
            val real = resolved.toRealPath()
            if (!seenNormalized.add(resolved) || !seenReal.add(real)) {
                throw invalidParams("android.target.files contains duplicate path: $resolved", device = deviceId)
            }
            resolvedFiles.add(resolved)
        }

        if (program != null) {
            val lowerProgram = program.lowercase(Locale.ROOT)
            if (lowerProgram.endsWith(".aab")) {
                throw configuringError(
                    AndroidRunErrorCode.UNSUPPORTED_ARTIFACT,
                    "AAB artifacts are not supported: $program",
                    device = deviceId,
                )
            }
            if (lowerProgram.endsWith(".apk")) {
                val resolvedProgram = resolvePath(program, effectiveCwd, "program", deviceId)
                val matchesNormalized = resolvedProgram in seenNormalized
                val matchesReal = Files.exists(resolvedProgram) && resolvedProgram.toRealPath() in seenReal
                if (!matchesNormalized && !matchesReal) {
                    throw invalidParams(
                        "Conflicting APK target: program ($resolvedProgram) is not in android.target.files",
                        device = deviceId,
                    )
                }
            }
        }

        return AndroidLaunchTarget.Apks(files = resolvedFiles)
    }

    private fun parseInstalledTarget(
        targetObj: JsonObject,
        deviceId: String,
    ): AndroidLaunchTarget.Installed {
        for (key in targetObj.keys) {
            if (key !in INSTALLED_TARGET_KEYS) {
                throw invalidParams("Unsupported field for installed target: $key", device = deviceId)
            }
        }
        val packageName = requirePackageName(targetObj, "packageName", "android.target.packageName", deviceId)
        return AndroidLaunchTarget.Installed(packageName = packageName)
    }

    private fun validateArtifactPath(
        path: Path,
        requireApkExtension: Boolean,
        nonApkIsInvalidParams: Boolean,
        deviceId: String,
    ) {
        val fileName = path.fileName?.toString()?.lowercase(Locale.ROOT) ?: ""
        if (fileName.endsWith(".aab")) {
            throw configuringError(
                AndroidRunErrorCode.UNSUPPORTED_ARTIFACT,
                "AAB artifacts are not supported: $path",
                device = deviceId,
            )
        }
        val exists = Files.exists(path)
        if (exists && !Files.isRegularFile(path)) {
            throw configuringError(
                AndroidRunErrorCode.ARTIFACT_INVALID,
                "APK path is not a regular file: $path",
                device = deviceId,
            )
        }
        if (requireApkExtension && !fileName.endsWith(".apk")) {
            val code = if (nonApkIsInvalidParams) {
                AndroidRunErrorCode.INVALID_PARAMS
            } else {
                AndroidRunErrorCode.UNSUPPORTED_ARTIFACT
            }
            throw configuringError(
                code,
                "Expected an .apk file: $path",
                device = deviceId,
            )
        }
        if (!exists) {
            throw configuringError(
                AndroidRunErrorCode.ARTIFACT_INVALID,
                "APK file does not exist: $path",
                device = deviceId,
            )
        }
    }

    private fun resolvePath(raw: String, effectiveCwd: Path, fieldName: String, deviceId: String? = null): Path {
        val parsed = parsePath(raw, fieldName, deviceId)
        return if (parsed.isAbsolute) parsed.normalize() else effectiveCwd.resolve(parsed).normalize()
    }

    private fun parsePath(raw: String, fieldName: String, deviceId: String? = null): Path {
        return try {
            Path.of(raw)
        } catch (e: InvalidPathException) {
            throw invalidParams("$fieldName is not a valid path: $raw", device = deviceId, cause = e)
        }
    }

    private fun isValidGradleProjectPath(module: String): Boolean {
        if (!module.startsWith(":")) return false
        if (module == ":") return true
        return !module.endsWith(":") && !module.contains("::") && module.none { it.isWhitespace() }
    }

    private fun parseOptionalUserId(obj: JsonObject, deviceId: String): Int? {
        val element = obj["userId"] ?: return null
        val value = requireIntElement(element, "android.userId", deviceId)
        if (value < 0) {
            throw invalidParams("android.userId must be >= 0", device = deviceId)
        }
        return value
    }

    private fun parseOptionalTimeoutMs(obj: JsonObject, deviceId: String): Int {
        val element = obj["timeoutMs"] ?: return DEFAULT_TIMEOUT_MS
        val value = requireIntElement(element, "android.timeoutMs", deviceId)
        if (value !in MIN_TIMEOUT_MS..MAX_TIMEOUT_MS) {
            throw invalidParams(
                "android.timeoutMs must be between $MIN_TIMEOUT_MS and $MAX_TIMEOUT_MS",
                device = deviceId,
            )
        }
        return value
    }

    private fun parseOptionalPositiveInt(
        obj: JsonObject,
        key: String,
        fieldName: String,
        deviceId: String? = null,
    ): Int? {
        val element = obj[key] ?: return null
        val value = requireIntElement(element, fieldName, deviceId)
        if (value <= 0) {
            throw invalidParams("$fieldName must be a positive integer", device = deviceId)
        }
        return value
    }

    private fun requirePackageName(
        obj: JsonObject,
        key: String,
        fieldName: String,
        deviceId: String,
    ): String {
        val value = requireNonBlankString(obj, key, fieldName, deviceId)
        if (!PACKAGE_NAME_REGEX.matches(value)) {
            throw invalidParams("$fieldName must be a valid Android package name: $value", device = deviceId)
        }
        return value
    }

    private fun requireNonBlankString(
        obj: JsonObject,
        key: String,
        fieldName: String,
        deviceId: String? = null,
    ): String {
        val element = obj[key] ?: throw invalidParams("$fieldName is required", device = deviceId)
        val raw = requireStringElement(element, fieldName, deviceId)
        val trimmed = raw.trim()
        if (trimmed.isEmpty()) {
            throw invalidParams("$fieldName must not be blank", device = deviceId)
        }
        return trimmed
    }

    private fun parseOptionalNonBlankString(
        obj: JsonObject,
        key: String,
        fieldName: String = key,
        deviceId: String? = null,
    ): String? {
        val element = obj[key] ?: return null
        val raw = requireStringElement(element, fieldName, deviceId)
        val trimmed = raw.trim()
        if (trimmed.isEmpty()) {
            throw invalidParams("$fieldName must not be blank", device = deviceId)
        }
        return trimmed
    }

    private fun parseOptionalBoolean(
        obj: JsonObject,
        key: String,
        fieldName: String,
        deviceId: String? = null,
    ): Boolean? {
        val element = obj[key] ?: return null
        if (element is JsonNull || element !is JsonPrimitive || element.isString) {
            throw invalidParams("$fieldName must be a boolean", device = deviceId)
        }
        return element.booleanOrNull ?: throw invalidParams("$fieldName must be a boolean", device = deviceId)
    }

    private fun requireStringElement(
        element: JsonElement,
        fieldName: String,
        deviceId: String? = null,
    ): String {
        if (element is JsonNull || element !is JsonPrimitive || !element.isString) {
            throw invalidParams("$fieldName must be a string", device = deviceId)
        }
        return element.content
    }

    private fun requireIntElement(
        element: JsonElement,
        fieldName: String,
        deviceId: String? = null,
    ): Int {
        if (element is JsonNull || element !is JsonPrimitive || element.isString) {
            throw invalidParams("$fieldName must be an integer", device = deviceId)
        }
        if (element.booleanOrNull != null) {
            throw invalidParams("$fieldName must be an integer", device = deviceId)
        }
        return element.content.toIntOrNull()
            ?: throw invalidParams("$fieldName must be an integer", device = deviceId)
    }

    private fun invalidParams(
        detail: String,
        device: String? = null,
        module: String? = null,
        cause: Throwable? = null,
    ) = configuringError(AndroidRunErrorCode.INVALID_PARAMS, detail, device = device, module = module, cause = cause)

    private fun configuringError(
        code: AndroidRunErrorCode,
        detail: String,
        device: String? = null,
        module: String? = null,
        cause: Throwable? = null,
    ) = AndroidRunError(
        code = code,
        stage = AndroidRunStage.CONFIGURING,
        detail = detail,
        module = module,
        device = device,
    ).toDapException(cause)
}
