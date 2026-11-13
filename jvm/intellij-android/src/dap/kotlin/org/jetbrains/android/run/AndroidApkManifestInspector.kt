package org.jetbrains.android.run

import com.android.ide.common.xml.AndroidManifestParser
import com.android.ide.common.xml.ManifestData
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import java.io.File
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import java.util.Locale
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

interface Aapt2Runner {
    suspend fun dumpBadging(apk: Path): String
    suspend fun dumpXmlTree(apk: Path, entryPath: String = "AndroidManifest.xml"): String
}

class ProcessAapt2Runner(
    private val explicitAapt2Path: Path? = null,
    private val timeoutMs: Long = 30_000L,
) : Aapt2Runner {
    override suspend fun dumpBadging(apk: Path): String =
        runAapt2(listOf("dump", "badging", apk.toAbsolutePath().toString()), apk)

    override suspend fun dumpXmlTree(apk: Path, entryPath: String): String =
        runAapt2(listOf("dump", "xmltree", apk.toAbsolutePath().toString(), "--file", entryPath), apk)

    private suspend fun runAapt2(args: List<String>, apk: Path): String {
        val aapt2 = resolveAapt2Path()
        val command = listOf(aapt2.toAbsolutePath().toString()) + args
        return withContext(Dispatchers.IO) {
            suspendCancellableCoroutine { cont ->
                val process = try {
                    ProcessBuilder(command)
                        .redirectErrorStream(false)
                        .start()
                } catch (t: Throwable) {
                    cont.resumeWithException(
                        AndroidRunException(
                            AndroidRunError(
                                code = AndroidRunErrorCode.PREREQUISITE_MISSING,
                                stage = AndroidRunStage.CONFIGURING,
                                detail = "Failed to execute aapt2 ($aapt2): ${t.message}",
                            ),
                            t,
                        )
                    )
                    return@suspendCancellableCoroutine
                }

                cont.invokeOnCancellation {
                    process.destroyForcibly()
                }

                val readerThread = Thread({
                    try {
                        val stdout = process.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
                        val stderr = process.errorStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
                        val finished = process.waitFor(timeoutMs, TimeUnit.MILLISECONDS)
                        if (!finished) {
                            process.destroyForcibly()
                            if (cont.isActive) {
                                cont.resumeWithException(
                                    AndroidRunException(
                                        AndroidRunError(
                                            code = AndroidRunErrorCode.ARTIFACT_INVALID,
                                            stage = AndroidRunStage.CONFIGURING,
                                            detail = "aapt2 timed out inspecting APK: $apk",
                                            outputTail = stderr.ifBlank { stdout },
                                        )
                                    )
                                )
                            }
                            return@Thread
                        }
                        val exitCode = process.exitValue()
                        if (exitCode != 0) {
                            if (cont.isActive) {
                                val combined =
                                    listOf(stderr.trim(), stdout.trim()).filter { it.isNotEmpty() }.joinToString("\n")
                                cont.resumeWithException(
                                    AndroidRunException(
                                        AndroidRunError(
                                            code = AndroidRunErrorCode.ARTIFACT_INVALID,
                                            stage = AndroidRunStage.CONFIGURING,
                                            detail = "aapt2 failed to inspect APK $apk (exit=$exitCode)",
                                            exitCode = exitCode,
                                            outputTail = combined.ifBlank { null },
                                        )
                                    )
                                )
                            }
                            return@Thread
                        }
                        if (cont.isActive) {
                            cont.resume(stdout)
                        }
                    } catch (t: Throwable) {
                        if (cont.isActive) {
                            cont.resumeWithException(t)
                        }
                    }
                }, "omp-aapt2-runner").apply { isDaemon = true }
                readerThread.start()
            }
        }
    }

    fun resolveAapt2Path(): Path {
        if (explicitAapt2Path != null) {
            if (!Files.isRegularFile(explicitAapt2Path)) {
                throw AndroidRunException(
                    AndroidRunError(
                        code = AndroidRunErrorCode.PREREQUISITE_MISSING,
                        stage = AndroidRunStage.CONFIGURING,
                        detail = "Configured aapt2 executable does not exist: $explicitAapt2Path",
                    )
                )
            }
            return explicitAapt2Path
        }
        return findAapt2InSdk() ?: throw AndroidRunException(
            AndroidRunError(
                code = AndroidRunErrorCode.PREREQUISITE_MISSING,
                stage = AndroidRunStage.CONFIGURING,
                detail = "Android build-tools aapt2 not found under ANDROID_HOME or ANDROID_SDK_ROOT",
            )
        )
    }

    companion object {
        private val IS_WINDOWS = System.getProperty("os.name", "").lowercase(Locale.ROOT).startsWith("win")
        private val AAPT2_NAME = if (IS_WINDOWS) "aapt2.exe" else "aapt2"

        fun findAapt2InSdk(
            androidHome: String? = System.getenv("ANDROID_HOME"),
            androidSdkRoot: String? = System.getenv("ANDROID_SDK_ROOT"),
        ): Path? {
            val roots = listOfNotNull(
                androidHome?.trim()?.takeIf { it.isNotEmpty() }?.let { Paths.get(it) },
                androidSdkRoot?.trim()?.takeIf { it.isNotEmpty() }?.let { Paths.get(it) },
            ).distinct()

            for (sdkRoot in roots) {
                val buildTools = sdkRoot.resolve("build-tools")
                if (!Files.isDirectory(buildTools)) continue
                val candidates = Files.list(buildTools).use { stream ->
                    stream
                        .filter { Files.isDirectory(it) }
                        .map { dir -> dir to parseBuildToolsVersion(dir.fileName.toString()) }
                        .toList()
                        .sortedWith(
                            compareByDescending<Pair<Path, BuildToolsVersion?>> { it.second != null }
                                .thenByDescending { it.second?.isStable == true }
                                .thenByDescending { it.second }
                                .thenByDescending { it.first.fileName.toString() }
                        )
                }
                for ((dir, _) in candidates) {
                    val candidate = dir.resolve(AAPT2_NAME)
                    if (Files.isRegularFile(candidate) && (IS_WINDOWS || Files.isExecutable(candidate))) {
                        return candidate
                    }
                }
            }
            return null
        }

        private data class BuildToolsVersion(
            val major: Int,
            val minor: Int,
            val patch: Int,
            val isStable: Boolean,
        ) : Comparable<BuildToolsVersion> {
            override fun compareTo(other: BuildToolsVersion): Int {
                if (major != other.major) return major.compareTo(other.major)
                if (minor != other.minor) return minor.compareTo(other.minor)
                if (patch != other.patch) return patch.compareTo(other.patch)
                return isStable.compareTo(other.isStable)
            }
        }

        private fun parseBuildToolsVersion(name: String): BuildToolsVersion? {
            val parts = name.split('-', limit = 2)
            val nums = parts[0].split('.')
            if (nums.size < 3) return null
            val major = nums[0].toIntOrNull() ?: return null
            val minor = nums[1].toIntOrNull() ?: return null
            val patch = nums[2].toIntOrNull() ?: return null
            return BuildToolsVersion(major, minor, patch, isStable = parts.size == 1)
        }
    }
}

data class ParsedActivity(
    val name: String,
    val process: String?,
    val enabled: Boolean,
    val exported: Boolean?,
    val isLauncher: Boolean,
)

data class ParsedActivityAlias(
    val name: String,
    val targetActivity: String,
    val enabled: Boolean,
    val exported: Boolean?,
    val isLauncher: Boolean,
)

data class ParsedApkManifest(
    val path: Path,
    val packageName: String,
    val versionCode: Long?,
    val versionName: String?,
    val splitName: String?,
    val debuggable: Boolean,
    val applicationEnabled: Boolean,
    val applicationProcess: String?,
    val nativeAbis: List<String>,
    val activities: List<ParsedActivity>,
    val aliases: List<ParsedActivityAlias>,
    val badgingLaunchableActivities: List<String>,
)

data class ResolvedLaunchComponent(
    val packageName: String,
    val activityName: String,
    val componentName: String,
    val processName: String,
    val debuggable: Boolean,
    val versionCode: Long?,
    val isAlias: Boolean,
)

data class ValidatedApkSet(
    val base: ParsedApkManifest,
    val splits: List<ParsedApkManifest>,
    val launchComponent: ResolvedLaunchComponent,
) {
    val packageName: String get() = base.packageName
    val processName: String get() = launchComponent.processName
    val debuggable: Boolean get() = base.debuggable
}

class AndroidApkManifestInspector(
    private val runner: Aapt2Runner = ProcessAapt2Runner(),
) {
    suspend fun inspectApk(apk: Path): ParsedApkManifest {
        if (!Files.isRegularFile(apk)) {
            throw AndroidRunException(
                AndroidRunError(
                    code = AndroidRunErrorCode.ARTIFACT_INVALID,
                    stage = AndroidRunStage.CONFIGURING,
                    detail = "APK file does not exist or is not a regular file: $apk",
                )
            )
        }
        val badging = runner.dumpBadging(apk)
        val xmlTree = runner.dumpXmlTree(apk, "AndroidManifest.xml")
        return combineBadgingAndXmlTree(apk, badging, xmlTree)
    }

    suspend fun validateAndResolveLaunch(
        apks: List<Path>,
        deviceAbis: List<String>,
        requestedActivity: String?,
        requireDebuggable: Boolean,
        expectedPackageName: String? = null,
        deviceId: String? = null,
    ): ValidatedApkSet {
        if (apks.isEmpty()) {
            throw AndroidRunException(
                AndroidRunError(
                    code = AndroidRunErrorCode.ARTIFACT_INVALID,
                    stage = AndroidRunStage.CONFIGURING,
                    detail = "No APK files provided",
                    device = deviceId,
                )
            )
        }

        val parsed = ArrayList<ParsedApkManifest>(apks.size)
        for (apk in apks) {
            parsed.add(inspectApk(apk))
        }

        val bases = parsed.filter { it.splitName == null }
        if (bases.size != 1) {
            throw AndroidRunException(
                AndroidRunError(
                    code = AndroidRunErrorCode.ARTIFACT_INVALID,
                    stage = AndroidRunStage.CONFIGURING,
                    detail = if (bases.isEmpty()) {
                        "APK set is missing a base APK"
                    } else {
                        "APK set contains multiple base APKs (${bases.joinToString { it.path.fileName.toString() }}); expected exactly one"
                    },
                    device = deviceId,
                )
            )
        }
        val base = bases[0]
        val splits = parsed.filter { it.splitName != null }

        if (expectedPackageName != null && base.packageName != expectedPackageName) {
            throw AndroidRunException(
                AndroidRunError(
                    code = AndroidRunErrorCode.ARTIFACT_INVALID,
                    stage = AndroidRunStage.CONFIGURING,
                    detail = "APK package '${base.packageName}' does not match expected package '$expectedPackageName'",
                    device = deviceId,
                )
            )
        }

        val seenSplits = HashSet<String>()
        for (split in splits) {
            val splitName = split.splitName!!
            if (!seenSplits.add(splitName)) {
                throw AndroidRunException(
                    AndroidRunError(
                        code = AndroidRunErrorCode.ARTIFACT_INVALID,
                        stage = AndroidRunStage.CONFIGURING,
                        detail = "Duplicate split APK name '$splitName' for package ${base.packageName}",
                        device = deviceId,
                    )
                )
            }
            if (split.packageName != base.packageName) {
                throw AndroidRunException(
                    AndroidRunError(
                        code = AndroidRunErrorCode.ARTIFACT_INVALID,
                        stage = AndroidRunStage.CONFIGURING,
                        detail = "Split APK '${split.path.fileName}' package '${split.packageName}' does not match base package '${base.packageName}'",
                        device = deviceId,
                    )
                )
            }
            if (base.versionCode != null && split.versionCode != null && split.versionCode != base.versionCode) {
                throw AndroidRunException(
                    AndroidRunError(
                        code = AndroidRunErrorCode.ARTIFACT_INVALID,
                        stage = AndroidRunStage.CONFIGURING,
                        detail = "Split APK '${split.path.fileName}' versionCode ${split.versionCode} does not match base versionCode ${base.versionCode}",
                        device = deviceId,
                    )
                )
            }
        }

        if (deviceAbis.isNotEmpty()) {
            for (apk in parsed) {
                if (apk.nativeAbis.isNotEmpty() && apk.nativeAbis.none { it in deviceAbis }) {
                    throw AndroidRunException(
                        AndroidRunError(
                            code = AndroidRunErrorCode.ABI_MISMATCH,
                            stage = AndroidRunStage.CONFIGURING,
                            detail = "APK '${apk.path.fileName}' native ABIs ${apk.nativeAbis} are incompatible with device ABIs $deviceAbis",
                            device = deviceId,
                        )
                    )
                }
            }
        }

        if (!base.applicationEnabled) {
            throw AndroidRunException(
                AndroidRunError(
                    code = AndroidRunErrorCode.ARTIFACT_INVALID,
                    stage = AndroidRunStage.CONFIGURING,
                    detail = "Application ${base.packageName} is disabled in manifest (android:enabled=false)",
                    device = deviceId,
                )
            )
        }

        if (requireDebuggable && !base.debuggable) {
            throw AndroidRunException(
                AndroidRunError(
                    code = AndroidRunErrorCode.NOT_DEBUGGABLE,
                    stage = AndroidRunStage.CONFIGURING,
                    detail = "Target application ${base.packageName} is not debuggable (android:debuggable=true is required when noDebug=false)",
                    device = deviceId,
                )
            )
        }

        val component = resolveLaunchComponent(base, requestedActivity, deviceId)
        return ValidatedApkSet(base = base, splits = splits, launchComponent = component)
    }

    fun parseTextManifest(manifestPath: Path): ManifestData {
        if (!Files.isRegularFile(manifestPath)) {
            throw AndroidRunException(
                AndroidRunError(
                    code = AndroidRunErrorCode.ARTIFACT_INVALID,
                    stage = AndroidRunStage.CONFIGURING,
                    detail = "AndroidManifest.xml does not exist: $manifestPath",
                )
            )
        }
        return try {
            AndroidManifestParser.parse(manifestPath)
        } catch (e: CancellationException) {
            throw e
        } catch (t: Throwable) {
            throw AndroidRunException(
                AndroidRunError(
                    code = AndroidRunErrorCode.ARTIFACT_INVALID,
                    stage = AndroidRunStage.CONFIGURING,
                    detail = "Failed to parse AndroidManifest.xml at $manifestPath: ${t.message}",
                ),
                t,
            )
        }
    }

    private fun resolveLaunchComponent(
        manifest: ParsedApkManifest,
        requestedActivity: String?,
        deviceId: String?,
    ): ResolvedLaunchComponent {
        val pkg = manifest.packageName
        val appProcess = expandProcessName(manifest.applicationProcess, pkg, pkg)

        val activitiesByName = LinkedHashMap<String, ParsedActivity>()
        val activityProcessByName = LinkedHashMap<String, String>()
        for (activity in manifest.activities) {
            val normalizedName = normalizeComponentName(activity.name, pkg)
            val resolvedActivity = activity.copy(name = normalizedName)
            activitiesByName[normalizedName] = resolvedActivity
            activityProcessByName[normalizedName] = expandProcessName(activity.process, appProcess, pkg)
        }

        val aliasesByName = LinkedHashMap<String, ParsedActivityAlias>()
        for (alias in manifest.aliases) {
            val normalizedName = normalizeComponentName(alias.name, pkg)
            val normalizedTarget = normalizeComponentName(alias.targetActivity, pkg)
            aliasesByName[normalizedName] = alias.copy(name = normalizedName, targetActivity = normalizedTarget)
        }

        if (requestedActivity != null) {
            val requestedClass = parseRequestedActivityClass(requestedActivity, pkg, deviceId)
            val activity = activitiesByName[requestedClass]
            if (activity != null) {
                if (!activity.enabled) {
                    throw AndroidRunException(
                        AndroidRunError(
                            code = AndroidRunErrorCode.ARTIFACT_INVALID,
                            stage = AndroidRunStage.CONFIGURING,
                            detail = "Activity $requestedClass is disabled in manifest of $pkg",
                            device = deviceId,
                        )
                    )
                }
                if (activity.exported == false) {
                    throw AndroidRunException(
                        AndroidRunError(
                            code = AndroidRunErrorCode.ARTIFACT_INVALID,
                            stage = AndroidRunStage.CONFIGURING,
                            detail = "Activity $requestedClass has android:exported=false and cannot be launched",
                            device = deviceId,
                        )
                    )
                }
                return ResolvedLaunchComponent(
                    packageName = pkg,
                    activityName = requestedClass,
                    componentName = "$pkg/$requestedClass",
                    processName = activityProcessByName.getValue(requestedClass),
                    debuggable = manifest.debuggable,
                    versionCode = manifest.versionCode,
                    isAlias = false,
                )
            }

            val alias = aliasesByName[requestedClass]
            if (alias != null) {
                if (!alias.enabled) {
                    throw AndroidRunException(
                        AndroidRunError(
                            code = AndroidRunErrorCode.ARTIFACT_INVALID,
                            stage = AndroidRunStage.CONFIGURING,
                            detail = "Activity alias $requestedClass is disabled in manifest of $pkg",
                            device = deviceId,
                        )
                    )
                }
                if (alias.exported == false) {
                    throw AndroidRunException(
                        AndroidRunError(
                            code = AndroidRunErrorCode.ARTIFACT_INVALID,
                            stage = AndroidRunStage.CONFIGURING,
                            detail = "Activity alias $requestedClass has android:exported=false and cannot be launched",
                            device = deviceId,
                        )
                    )
                }
                val target = activitiesByName[alias.targetActivity]
                    ?: throw AndroidRunException(
                        AndroidRunError(
                            code = AndroidRunErrorCode.ARTIFACT_INVALID,
                            stage = AndroidRunStage.CONFIGURING,
                            detail = "Activity alias $requestedClass references missing targetActivity ${alias.targetActivity} in $pkg",
                            device = deviceId,
                        )
                    )
                if (!target.enabled) {
                    throw AndroidRunException(
                        AndroidRunError(
                            code = AndroidRunErrorCode.ARTIFACT_INVALID,
                            stage = AndroidRunStage.CONFIGURING,
                            detail = "Target activity ${alias.targetActivity} for alias $requestedClass is disabled in manifest of $pkg",
                            device = deviceId,
                        )
                    )
                }
                val targetProcess = activityProcessByName.getValue(target.name)
                return ResolvedLaunchComponent(
                    packageName = pkg,
                    activityName = requestedClass,
                    componentName = "$pkg/$requestedClass",
                    processName = targetProcess,
                    debuggable = manifest.debuggable,
                    versionCode = manifest.versionCode,
                    isAlias = true,
                )
            }

            val available = (activitiesByName.keys + aliasesByName.keys).joinToString(", ")
            throw AndroidRunException(
                AndroidRunError(
                    code = AndroidRunErrorCode.ARTIFACT_INVALID,
                    stage = AndroidRunStage.CONFIGURING,
                    detail = "Activity $requestedClass not found in manifest of $pkg" +
                            if (available.isNotEmpty()) " (available: $available)" else "",
                    device = deviceId,
                )
            )
        }

        val launcherCandidates = ArrayList<ResolvedLaunchComponent>()
        val seenCandidateNames = HashSet<String>()

        for (activity in activitiesByName.values) {
            if (activity.isLauncher && activity.enabled && activity.exported != false) {
                if (seenCandidateNames.add(activity.name)) {
                    launcherCandidates.add(
                        ResolvedLaunchComponent(
                            packageName = pkg,
                            activityName = activity.name,
                            componentName = "$pkg/${activity.name}",
                            processName = activityProcessByName.getValue(activity.name),
                            debuggable = manifest.debuggable,
                            versionCode = manifest.versionCode,
                            isAlias = false,
                        )
                    )
                }
            }
        }

        for (alias in aliasesByName.values) {
            if (alias.isLauncher && alias.enabled && alias.exported != false) {
                val target = activitiesByName[alias.targetActivity] ?: continue
                if (!target.enabled) continue
                if (seenCandidateNames.add(alias.name)) {
                    launcherCandidates.add(
                        ResolvedLaunchComponent(
                            packageName = pkg,
                            activityName = alias.name,
                            componentName = "$pkg/${alias.name}",
                            processName = activityProcessByName.getValue(target.name),
                            debuggable = manifest.debuggable,
                            versionCode = manifest.versionCode,
                            isAlias = true,
                        )
                    )
                }
            }
        }

        if (launcherCandidates.isEmpty() && manifest.badgingLaunchableActivities.isNotEmpty()) {
            for (rawName in manifest.badgingLaunchableActivities) {
                val normalized = normalizeComponentName(rawName, pkg)
                if (!seenCandidateNames.add(normalized)) continue
                val act = activitiesByName[normalized]
                if (act != null && act.enabled && act.exported != false) {
                    launcherCandidates.add(
                        ResolvedLaunchComponent(
                            packageName = pkg,
                            activityName = normalized,
                            componentName = "$pkg/$normalized",
                            processName = activityProcessByName.getValue(normalized),
                            debuggable = manifest.debuggable,
                            versionCode = manifest.versionCode,
                            isAlias = false,
                        )
                    )
                    continue
                }
                val alias = aliasesByName[normalized]
                if (alias != null && alias.enabled && alias.exported != false) {
                    val target = activitiesByName[alias.targetActivity] ?: continue
                    if (!target.enabled) continue
                    launcherCandidates.add(
                        ResolvedLaunchComponent(
                            packageName = pkg,
                            activityName = normalized,
                            componentName = "$pkg/$normalized",
                            processName = activityProcessByName.getValue(target.name),
                            debuggable = manifest.debuggable,
                            versionCode = manifest.versionCode,
                            isAlias = true,
                        )
                    )
                }
            }
        }

        if (launcherCandidates.isEmpty()) {
            throw AndroidRunException(
                AndroidRunError(
                    code = AndroidRunErrorCode.ARTIFACT_INVALID,
                    stage = AndroidRunStage.CONFIGURING,
                    detail = "No launcher activity found in $pkg",
                    device = deviceId,
                )
            )
        }
        if (launcherCandidates.size > 1) {
            val candidateNames = launcherCandidates.joinToString(", ") { it.componentName }
            throw AndroidRunException(
                AndroidRunError(
                    code = AndroidRunErrorCode.ARTIFACT_INVALID,
                    stage = AndroidRunStage.CONFIGURING,
                    detail = "Multiple launcher activities found in $pkg: $candidateNames; specify android.activity explicitly",
                    device = deviceId,
                )
            )
        }
        return launcherCandidates[0]
    }

    companion object {
        private const val ACTION_MAIN = "android.intent.action.MAIN"
        private const val CATEGORY_LAUNCHER = "android.intent.category.LAUNCHER"

        private val QUOTED_ATTR_REGEX = Regex("""(\w+)='([^']*)'""")

        fun combineBadgingAndXmlTree(
            apk: Path,
            badging: String,
            xmlTree: String,
        ): ParsedApkManifest {
            val badgingInfo = parseBadging(badging)
            val xmlInfo = parseXmlTree(xmlTree)

            val packageName = badgingInfo.packageName ?: xmlInfo.packageName
            ?: throw AndroidRunException(
                AndroidRunError(
                    code = AndroidRunErrorCode.ARTIFACT_INVALID,
                    stage = AndroidRunStage.CONFIGURING,
                    detail = "Unable to determine Android package name from APK: $apk",
                )
            )
            val versionCode = badgingInfo.versionCode ?: xmlInfo.versionCode
            val versionName = badgingInfo.versionName ?: xmlInfo.versionName
            val splitName = badgingInfo.splitName ?: xmlInfo.splitName
            val debuggable = badgingInfo.debuggable || (xmlInfo.debuggable == true)

            return ParsedApkManifest(
                path = apk,
                packageName = packageName,
                versionCode = versionCode,
                versionName = versionName,
                splitName = splitName,
                debuggable = debuggable,
                applicationEnabled = xmlInfo.applicationEnabled,
                applicationProcess = xmlInfo.applicationProcess,
                nativeAbis = badgingInfo.nativeAbis,
                activities = xmlInfo.activities,
                aliases = xmlInfo.aliases,
                badgingLaunchableActivities = badgingInfo.launchableActivities,
            )
        }

        private data class BadgingParseResult(
            val packageName: String? = null,
            val versionCode: Long? = null,
            val versionName: String? = null,
            val splitName: String? = null,
            val debuggable: Boolean = false,
            val nativeAbis: List<String> = emptyList(),
            val launchableActivities: List<String> = emptyList(),
        )

        private fun parseBadging(output: String): BadgingParseResult {
            var packageName: String? = null
            var versionCode: Long? = null
            var versionName: String? = null
            var splitName: String? = null
            var debuggable = false
            val nativeAbis = LinkedHashSet<String>()
            val launchableActivities = ArrayList<String>()

            for (rawLine in output.lineSequence()) {
                val line = rawLine.trim()
                if (line.isEmpty()) continue
                when {
                    line.startsWith("package:") -> {
                        val attrs = parseSingleQuotedAttrs(line.removePrefix("package:"))
                        packageName = attrs["name"]?.takeIf { it.isNotEmpty() } ?: packageName
                        versionCode = attrs["versionCode"]?.toLongOrNull() ?: versionCode
                        versionName = attrs["versionName"] ?: versionName
                        splitName = attrs["split"]?.takeIf { it.isNotEmpty() } ?: splitName
                    }

                    line == "application-debuggable" -> {
                        debuggable = true
                    }

                    line.startsWith("native-code:") -> {
                        val rest = line.removePrefix("native-code:")
                        val tokenRegex = Regex("""'([^']*)'""")
                        for (match in tokenRegex.findAll(rest)) {
                            val abi = match.groupValues[1].trim()
                            if (abi.isNotEmpty()) nativeAbis.add(abi)
                        }
                    }

                    line.startsWith("launchable-activity:") -> {
                        val attrs = parseSingleQuotedAttrs(line.removePrefix("launchable-activity:"))
                        attrs["name"]?.takeIf { it.isNotEmpty() }?.let { launchableActivities.add(it) }
                    }
                }
            }

            return BadgingParseResult(
                packageName = packageName,
                versionCode = versionCode,
                versionName = versionName,
                splitName = splitName,
                debuggable = debuggable,
                nativeAbis = nativeAbis.toList(),
                launchableActivities = launchableActivities,
            )
        }

        private fun parseSingleQuotedAttrs(text: String): Map<String, String> {
            val map = LinkedHashMap<String, String>()
            for (match in QUOTED_ATTR_REGEX.findAll(text)) {
                map[match.groupValues[1]] = match.groupValues[2]
            }
            return map
        }

        private class XmlNode(
            val tag: String,
            val indent: Int,
        ) {
            val attrs: MutableMap<String, String> = LinkedHashMap()
            val children: MutableList<XmlNode> = ArrayList()
        }

        private data class XmlTreeParseResult(
            val packageName: String? = null,
            val versionCode: Long? = null,
            val versionName: String? = null,
            val splitName: String? = null,
            val debuggable: Boolean? = null,
            val applicationEnabled: Boolean = true,
            val applicationProcess: String? = null,
            val activities: List<ParsedActivity> = emptyList(),
            val aliases: List<ParsedActivityAlias> = emptyList(),
        )

        private fun parseXmlTree(output: String): XmlTreeParseResult {
            val stack = ArrayDeque<XmlNode>()
            var manifestNode: XmlNode? = null

            for (rawLine in output.lineSequence()) {
                if (rawLine.isBlank()) continue
                val indent = rawLine.indexOfFirst { !it.isWhitespace() }
                if (indent < 0) continue
                val trimmed = rawLine.substring(indent)
                if (trimmed.startsWith("E: ")) {
                    val afterPrefix = trimmed.removePrefix("E: ")
                    val tag = afterPrefix.trimStart().takeWhile { !it.isWhitespace() }
                    while (stack.isNotEmpty() && stack.last().indent >= indent) {
                        stack.removeLast()
                    }
                    val node = XmlNode(tag, indent)
                    if (stack.isNotEmpty()) {
                        stack.last().children.add(node)
                    } else if (tag == "manifest") {
                        manifestNode = node
                    }
                    stack.addLast(node)
                } else if (trimmed.startsWith("A: ")) {
                    val target = stack.lastOrNull() ?: continue
                    val attrBody = trimmed.removePrefix("A: ")
                    val eqIdx = attrBody.indexOf('=')
                    if (eqIdx <= 0) continue
                    val rawKey = attrBody.substring(0, eqIdx).trim()
                    val rawVal = attrBody.substring(eqIdx + 1).trim()
                    val attrName = normalizeAttrName(rawKey)
                    target.attrs[attrName] = rawVal
                }
            }

            if (manifestNode == null) {
                return XmlTreeParseResult()
            }

            val packageName = extractStringValue(manifestNode.attrs["package"])
            val splitName = extractStringValue(manifestNode.attrs["split"])?.takeIf { it.isNotEmpty() }
            val versionCode = extractLongValue(manifestNode.attrs["versionCode"])
            val versionName = extractStringValue(manifestNode.attrs["versionName"])

            val appNode = manifestNode.children.firstOrNull { it.tag == "application" }
                ?: return XmlTreeParseResult(packageName, versionCode, versionName, splitName)

            val debuggable = extractBooleanValue(appNode.attrs["debuggable"])
            val applicationEnabled = extractBooleanValue(appNode.attrs["enabled"]) ?: true
            val applicationProcess = extractStringValue(appNode.attrs["process"])?.takeIf { it.isNotBlank() }

            val activities = ArrayList<ParsedActivity>()
            val aliases = ArrayList<ParsedActivityAlias>()

            for (child in appNode.children) {
                when (child.tag) {
                    "activity" -> {
                        val name = extractStringValue(child.attrs["name"])?.takeIf { it.isNotBlank() } ?: continue
                        val process = extractStringValue(child.attrs["process"])?.takeIf { it.isNotBlank() }
                        val enabled = extractBooleanValue(child.attrs["enabled"]) ?: true
                        val exported = extractBooleanValue(child.attrs["exported"])
                        val isLauncher = hasMainLauncherFilter(child)
                        activities.add(
                            ParsedActivity(
                                name = name,
                                process = process,
                                enabled = enabled,
                                exported = exported,
                                isLauncher = isLauncher,
                            )
                        )
                    }

                    "activity-alias" -> {
                        val name = extractStringValue(child.attrs["name"])?.takeIf { it.isNotBlank() } ?: continue
                        val targetActivity =
                            extractStringValue(child.attrs["targetActivity"])?.takeIf { it.isNotBlank() } ?: continue
                        val enabled = extractBooleanValue(child.attrs["enabled"]) ?: true
                        val exported = extractBooleanValue(child.attrs["exported"])
                        val isLauncher = hasMainLauncherFilter(child)
                        aliases.add(
                            ParsedActivityAlias(
                                name = name,
                                targetActivity = targetActivity,
                                enabled = enabled,
                                exported = exported,
                                isLauncher = isLauncher,
                            )
                        )
                    }
                }
            }

            return XmlTreeParseResult(
                packageName = packageName,
                versionCode = versionCode,
                versionName = versionName,
                splitName = splitName,
                debuggable = debuggable,
                applicationEnabled = applicationEnabled,
                applicationProcess = applicationProcess,
                activities = activities,
                aliases = aliases,
            )
        }

        private fun hasMainLauncherFilter(componentNode: XmlNode): Boolean {
            for (child in componentNode.children) {
                if (child.tag != "intent-filter") continue
                var hasMain = false
                var hasLauncher = false
                for (filterChild in child.children) {
                    val attrName = extractStringValue(filterChild.attrs["name"])
                    if (filterChild.tag == "action" && attrName == ACTION_MAIN) {
                        hasMain = true
                    } else if (filterChild.tag == "category" && attrName == CATEGORY_LAUNCHER) {
                        hasLauncher = true
                    }
                }
                if (hasMain && hasLauncher) return true
            }
            return false
        }

        private fun normalizeAttrName(rawKey: String): String {
            val withoutResId = rawKey.substringBefore('(').trim()
            val colonIdx = withoutResId.lastIndexOf(':')
            return if (colonIdx >= 0) withoutResId.substring(colonIdx + 1) else withoutResId
        }

        private fun extractStringValue(raw: String?): String? {
            if (raw == null) return null
            val trimmed = raw.trim()
            val rawMarker = "(Raw: \""
            val rawIdx = trimmed.lastIndexOf(rawMarker)
            if (rawIdx >= 0 && trimmed.endsWith("\")")) {
                return trimmed.substring(rawIdx + rawMarker.length, trimmed.length - 2)
            }
            if (trimmed.startsWith("\"")) {
                val endQuote = trimmed.indexOf('"', startIndex = 1)
                if (endQuote >= 1) {
                    return trimmed.substring(1, endQuote)
                }
            }
            return trimmed
        }

        private fun extractBooleanValue(raw: String?): Boolean? {
            if (raw == null) return null
            val token = raw.trim().substringAfterLast(')').trim().lowercase(Locale.ROOT)
            return when (token) {
                "true", "0xffffffff", "-1", "0x1", "1" -> true
                "false", "0x0", "0x00000000", "0" -> false
                else -> null
            }
        }

        private fun extractLongValue(raw: String?): Long? {
            if (raw == null) return null
            val token = raw.trim().substringAfterLast(')').trim()
            return if (token.startsWith("0x", ignoreCase = true)) {
                token.substring(2).toLongOrNull(16)
            } else {
                token.toLongOrNull()
            }
        }

        fun expandProcessName(rawProcess: String?, defaultProcess: String, packageName: String): String {
            if (rawProcess.isNullOrBlank()) return defaultProcess
            val trimmed = rawProcess.trim()
            return if (trimmed.startsWith(":")) {
                packageName + trimmed
            } else {
                trimmed
            }
        }

        fun normalizeComponentName(rawName: String, packageName: String): String {
            val trimmed = rawName.trim()
            return when {
                trimmed.startsWith(".") -> packageName + trimmed
                '.' !in trimmed -> "$packageName.$trimmed"
                else -> trimmed
            }
        }

        private fun parseRequestedActivityClass(
            requested: String,
            packageName: String,
            deviceId: String?,
        ): String {
            val trimmed = requested.trim()
            val slashIdx = trimmed.indexOf('/')
            if (slashIdx >= 0) {
                val pkgPart = trimmed.substring(0, slashIdx)
                val clsPart = trimmed.substring(slashIdx + 1)
                if (pkgPart != packageName || clsPart.isBlank()) {
                    throw AndroidRunException(
                        AndroidRunError(
                            code = AndroidRunErrorCode.INVALID_PARAMS,
                            stage = AndroidRunStage.CONFIGURING,
                            detail = "Activity '$requested' does not match target package '$packageName'",
                            device = deviceId,
                        )
                    )
                }
                return normalizeComponentName(clsPart, packageName)
            }
            return normalizeComponentName(trimmed, packageName)
        }
    }
}
