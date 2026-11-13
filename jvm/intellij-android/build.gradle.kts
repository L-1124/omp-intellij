import groovy.json.JsonSlurper
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import java.util.Properties
import java.util.UUID

plugins {
    java
    kotlin("jvm") version "2.4.20"
}

val metadataFile = layout.projectDirectory.file("../../src/server/bundle-metadata.ts")
val metadataText = providers.fileContents(metadataFile).asText.orNull
    ?: throw GradleException("Bundle metadata not found at: ${metadataFile.asFile.absolutePath}")

val versionMatch = Regex("""export\s+const\s+DEFAULT_SERVER_VERSION\s*=\s*['"]([^'"]+)['"]\s*;""")
    .find(metadataText)
    ?: throw GradleException("Unable to extract DEFAULT_SERVER_VERSION from ${metadataFile.asFile.absolutePath}")

val targetVersion = versionMatch.groupValues[1].trim()
if (!Regex("""^\d+(?:\.\d+){2,3}$""").matches(targetVersion)) {
    throw GradleException("Extracted DEFAULT_SERVER_VERSION '$targetVersion' is not a valid server version")
}

fun resolveIlsHomeDir(): File? {
    val prop = providers.gradleProperty("ilsHome").orNull
    if (!prop.isNullOrBlank()) {
        val f = file(prop)
        if (f.isDirectory) return f
    }

    val localPropsFile = layout.projectDirectory.file("local.properties").asFile
    if (localPropsFile.isFile) {
        val props = Properties().apply {
            localPropsFile.inputStream().use { load(it) }
        }
        val p = props.getProperty("ils.home")
        if (!p.isNullOrBlank()) {
            val f = file(p)
            if (f.isDirectory) return f
        }
    }

    val userHome = System.getProperty("user.home")
    val cfgFile = file("$userHome/.omp/agent/intellij.json")
    if (cfgFile.isFile) {
        runCatching {
            val json = JsonSlurper().parse(cfgFile) as? Map<*, *>
            val serverMap = json?.get("server") as? Map<*, *>
            val installDir = (serverMap?.get("installDir") ?: json?.get("installDir")) as? String
            if (!installDir.isNullOrBlank()) {
                val candidate = file("$installDir/versions/$targetVersion")
                if (candidate.isDirectory) return candidate
            }
        }
    }

    val defaultCandidate = file("$userHome/.omp/servers/intellij/versions/$targetVersion")
    return defaultCandidate.takeIf { it.isDirectory }
}

val resolvedHome = resolveIlsHomeDir()
val ilsHomeDir: File = resolvedHome ?: layout.buildDirectory.dir("missing-ils-sdk").get().asFile

val buildTxt = ilsHomeDir.resolve("build.txt")
val isValidIls = resolvedHome != null && buildTxt.isFile && buildTxt.readText().trim() == "ILS-$targetVersion"

if (!isValidIls) {
    logger.warn(
        "[WARN] ILS $targetVersion SDK not resolved at ${ilsHomeDir.absolutePath}.\n" +
                "Run `node ../../scripts/setup-dev-env.mjs` to auto-configure development environment,\n" +
                "or specify `ils.home=<path>` in jvm/intellij-android/local.properties."
    )
}

val jbrDir = ilsHomeDir.resolve("jbr")
if (jbrDir.isDirectory) {
    val existingInstallations = System.getProperty("org.gradle.java.installations.paths")
    val jbrPath = jbrDir.absolutePath
    if (existingInstallations.isNullOrBlank()) {
        System.setProperty("org.gradle.java.installations.paths", jbrPath)
    } else if (!existingInstallations.contains(jbrPath)) {
        System.setProperty("org.gradle.java.installations.paths", "$existingInstallations,$jbrPath")
    }
}

val ilsLibJars = fileTree(ilsHomeDir.resolve("lib")) {
    include("*.jar")
}
val ilsPluginJars = fileTree(ilsHomeDir.resolve("plugins")) {
    include("**/*.jar")
}
val coreIlsLibJars = fileTree(ilsHomeDir.resolve("lib")) {
    include("*.jar")
    exclude("language-server.dap.*.jar", "intellij.platform.dap.*.jar", "intellij.libraries.kotlinx.io.jar")
}
val coreCompileSdkJars = coreIlsLibJars + fileTree(ilsHomeDir.resolve("plugins")) {
    include("java/**/*.jar", "kotlin/**/*.jar", "xml/**/*.jar", "dap-jvm/**/*.jar")
    exclude("**/language-server.dap.*.jar")
}
val dapCompileSdkJars = ilsLibJars + fileTree(ilsHomeDir.resolve("plugins")) {
    include("java/**/*.jar", "kotlin/**/*.jar", "kotlin.lsp/**/*.jar", "xml/**/*.jar", "dap-jvm/**/*.jar")
}
val gradleActionCompileSdkJars = files(
    ilsHomeDir.resolve("lib/util-8.jar"),
    ilsHomeDir.resolve("plugins/kotlin.lsp/lib/modules/intellij.libraries.gradle.tooling.jar")
)

java {
    toolchain {
        languageVersion.set(JavaLanguageVersion.of(25))
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_25)
    }
}

tasks.withType<JavaCompile>().configureEach {
    options.encoding = "UTF-8"
    options.release.set(25)
}

repositories {
    google()
    mavenCentral()
}

dependencyLocking {
    lockAllConfigurations()
}

val builderModelVersion = "9.4.1"
val adblibVersion = "9.4.1"
val lintVersion = "32.4.1"
val kxml2Version = "2.3.0"
val groovyVersion = "4.0.29"

val gradleAction by sourceSets.creating
val dap by sourceSets.creating

// Gradle loads the action in the project's JDK, independently of the ILS JBR.
tasks.named<org.jetbrains.kotlin.gradle.tasks.KotlinJvmCompile>("compileGradleActionKotlin") {
    compilerOptions.jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
}
tasks.named<JavaCompile>(gradleAction.compileJavaTaskName) {
    options.release.set(17)
}

configurations.named(dap.implementationConfigurationName) {
    extendsFrom(configurations.named("implementation").get())
}
configurations.named("testImplementation") {
    extendsFrom(configurations.named(dap.implementationConfigurationName).get())
}

dependencies {
    compileOnly(coreCompileSdkJars)
    "gradleActionCompileOnly"(gradleActionCompileSdkJars)
    "gradleActionImplementation"("com.android.tools.build:builder-model:$builderModelVersion") {
        isTransitive = false
    }
    "dapCompileOnly"(gradleAction.output)
    "dapCompileOnly"(sourceSets.main.get().output)
    "dapCompileOnly"(dapCompileSdkJars)
    "dapImplementation"("com.android.tools.build:builder-model:$builderModelVersion") {
        isTransitive = false
    }
    testCompileOnly(dapCompileSdkJars)
    testRuntimeOnly(ilsLibJars + ilsPluginJars)
    testImplementation(dap.output)
    testImplementation(gradleAction.output)


    implementation("com.android.tools.adblib:adblib:$adblibVersion") {
        isTransitive = false
    }
    implementation("com.android.tools.adblib:adblib-tools:$adblibVersion") {
        isTransitive = false
    }
    implementation("com.android.tools.lint:lint-api:$lintVersion") {
        isTransitive = false
    }
    implementation("com.android.tools.lint:lint-checks:$lintVersion") {
        isTransitive = false
    }
    implementation("com.android.tools.lint:lint-model:$lintVersion") {
        isTransitive = false
    }
    implementation("com.android.tools:common:$lintVersion") {
        isTransitive = false
    }
    implementation("com.android.tools:sdklib:$lintVersion") {
        isTransitive = false
    }
    implementation("net.sf.kxml:kxml2:$kxml2Version") {
        isTransitive = false
    }
    implementation("com.android.tools:sdk-common:$lintVersion") {
        isTransitive = false
    }
    implementation("com.android.tools.layoutlib:layoutlib-api:$lintVersion") {
        isTransitive = false
    }
    implementation("com.android.tools.build:manifest-merger:$lintVersion") {
        isTransitive = false
    }
    implementation("org.apache.groovy:groovy:$groovyVersion") {
        isTransitive = false
    }

    testImplementation("junit:junit:4.13.2")
}

tasks.named<Jar>("jar") {
    archiveBaseName.set("language-server.api.features.impl.android")
    archiveVersion.set("")
    archiveClassifier.set("")
    exclude("META-INF/plugin.xml")
    entryCompression = ZipEntryCompression.STORED
    isPreserveFileTimestamps = false
    isReproducibleFileOrder = true
}

val descriptorJar = tasks.register<Jar>("descriptorJar") {
    archiveBaseName.set("language-server-plugins-android-lsp")
    archiveVersion.set("")
    archiveClassifier.set("")
    from(tasks.named("processResources")) {
        include("META-INF/plugin.xml")
    }
    entryCompression = ZipEntryCompression.STORED
    isPreserveFileTimestamps = false
    isReproducibleFileOrder = true
}

val dapJar = tasks.register<Jar>("dapJar") {
    archiveBaseName.set("language-server.api.features.impl.android.dap")
    archiveVersion.set("")
    archiveClassifier.set("")
    from(dap.output)
    from(gradleAction.output)
    entryCompression = ZipEntryCompression.STORED
    isPreserveFileTimestamps = false
    isReproducibleFileOrder = true
}

tasks.named("assemble") {
    dependsOn(descriptorJar, dapJar)
}

abstract class StageExtensionTask : DefaultTask() {
    @get:InputFile
    @get:PathSensitive(PathSensitivity.NAME_ONLY)
    abstract val descriptorJar: RegularFileProperty

    @get:InputFiles
    @get:PathSensitive(PathSensitivity.NAME_ONLY)
    abstract val moduleJars: ConfigurableFileCollection

    @get:InputFiles
    @get:Classpath
    abstract val runtimeClasspath: ConfigurableFileCollection

    @get:Input
    abstract val expectedModuleNames: SetProperty<String>

    @get:Input
    abstract val expectedUpstreamNames: SetProperty<String>

    @get:Input
    abstract val serverVersion: Property<String>

    @get:Input
    abstract val gradleVersion: Property<String>

    @get:OutputDirectory
    abstract val extensionDir: DirectoryProperty

    @TaskAction
    fun stage() {
        val descFile = descriptorJar.get().asFile
        if (!descFile.exists()) {
            throw GradleException("Descriptor JAR does not exist at: ${descFile.absolutePath}")
        }
        val modFiles = moduleJars.files.filter { it.extension == "jar" }
        for (modFile in modFiles) {
            if (!modFile.exists()) {
                throw GradleException("Module JAR does not exist at: ${modFile.absolutePath}")
            }
        }
        val expectedMods = expectedModuleNames.get()
        val actualMods = modFiles.map { it.name }.toSet()
        if (actualMods != expectedMods) {
            throw GradleException("Unexpected module JARs: expected $expectedMods, got $actualMods")
        }

        val modFileSet = modFiles.toSet()
        val upstreamJars =
            runtimeClasspath.files.filter { it.extension == "jar" && it != descFile && it !in modFileSet }
        val expectedNames = expectedUpstreamNames.get()
        val actualNames = upstreamJars.map { it.name }.toSet()
        if (actualNames != expectedNames) {
            throw GradleException("Unexpected upstream runtime JARs: expected $expectedNames, got $actualNames")
        }

        data class StagedAsset(val file: File, val relPath: String)

        val assetList = buildList {
            add(StagedAsset(descFile, "lib/${descFile.name}"))
            for (modFile in modFiles.sortedBy { it.name }) {
                add(StagedAsset(modFile, "lib/modules/${modFile.name}"))
            }
            for (jar in upstreamJars.sortedBy { it.name }) {
                add(StagedAsset(jar, "lib/${jar.name}"))
            }
        }

        val outDir = extensionDir.get().asFile
        val targetManifest = outDir.resolve("manifest.json")

        val workDir = temporaryDir.resolve("work-${UUID.randomUUID()}")
        val stagingDir = workDir.resolve("staging").apply { mkdirs() }
        val stagedManifest = stagingDir.resolve("manifest.json")
        val rollbackDir = workDir.resolve("rollback").apply { mkdirs() }
        var retainRollback = false

        fun replaceFile(source: File, target: File) {
            target.parentFile.mkdirs()
            try {
                Files.move(
                    source.toPath(),
                    target.toPath(),
                    StandardCopyOption.ATOMIC_MOVE,
                    StandardCopyOption.REPLACE_EXISTING
                )
            } catch (_: AtomicMoveNotSupportedException) {
                Files.move(source.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING)
            }
        }

        try {
            val assetRecords = assetList.map { asset ->
                val stagedJar = stagingDir.resolve(asset.relPath)
                stagedJar.parentFile.mkdirs()
                asset.file.copyTo(stagedJar, overwrite = true)

                val bytes = stagedJar.readBytes()
                val shaHex = MessageDigest.getInstance("SHA-256")
                    .digest(bytes)
                    .joinToString("") { "%02x".format(it) }

                stagingDir.resolve("${asset.relPath}.sha256")
                    .writeText("$shaHex *${asset.file.name}\n", Charsets.UTF_8)

                mapOf(
                    "name" to asset.file.name,
                    "path" to asset.relPath,
                    "sha256" to shaHex,
                    "size" to bytes.size
                )
            }

            val assetsJson = assetRecords.joinToString(",\n") { record ->
                """    {
      "name": "${record["name"]}",
      "path": "${record["path"]}",
      "sha256": "${record["sha256"]}",
      "size": ${record["size"]}
    }"""
            }

            val manifestContent = """{
  "serverVersion": "${serverVersion.get()}",
  "extensionId": "org.jetbrains.android",
  "buildTimestamp": "2026-01-01T00:00:00Z",
  "targetJavaVersion": 25,
  "classFileVersion": 69,
  "toolchain": {
    "javacVersion": "javac 25",
    "jarVersion": "Gradle ${gradleVersion.get()}"
  },
  "assets": [
$assetsJson
  ]
}
"""
            stagedManifest.writeText(manifestContent, Charsets.UTF_8)

            outDir.mkdirs()

            if (outDir.exists()) {
                val existingFiles = outDir.walkTopDown().filter { it.isFile }.toList()
                for (existing in existingFiles) {
                    val rel = existing.relativeTo(outDir).invariantSeparatorsPath
                    val backup = rollbackDir.resolve(rel)
                    backup.parentFile.mkdirs()
                    Files.copy(existing.toPath(), backup.toPath(), StandardCopyOption.REPLACE_EXISTING)
                }
            }

            try {
                val stagedFiles = stagingDir.walkTopDown().filter { it.isFile && it != stagedManifest }.toList()
                val stagedRelPaths =
                    stagedFiles.map { it.relativeTo(stagingDir).invariantSeparatorsPath }.toSet() + "manifest.json"

                for (stagedFile in stagedFiles) {
                    val rel = stagedFile.relativeTo(stagingDir).invariantSeparatorsPath
                    val target = outDir.resolve(rel)
                    if (target.isFile && Files.mismatch(stagedFile.toPath(), target.toPath()) == -1L) continue
                    replaceFile(stagedFile, target)
                }

                outDir.walkTopDown().filter { it.isFile }.forEach { file ->
                    val rel = file.relativeTo(outDir).invariantSeparatorsPath
                    if (rel !in stagedRelPaths) {
                        Files.deleteIfExists(file.toPath())
                    }
                }

                outDir.walkBottomUp().filter { it.isDirectory && it != outDir && it.listFiles()?.isEmpty() == true }
                    .forEach {
                        it.delete()
                    }
                replaceFile(stagedManifest, targetManifest)
            } catch (failure: Throwable) {
                try {
                    outDir.deleteRecursively()
                    outDir.mkdirs()
                    if (rollbackDir.exists()) {
                        val backupFiles = rollbackDir.walkTopDown().filter { it.isFile }.toList()
                        for (backup in backupFiles) {
                            val rel = backup.relativeTo(rollbackDir).invariantSeparatorsPath
                            val target = outDir.resolve(rel)
                            replaceFile(backup, target)
                        }
                    }
                } catch (rollbackFailure: Exception) {
                    retainRollback = true
                    failure.addSuppressed(rollbackFailure)
                }
                if (retainRollback) {
                    logger.error("Asset rollback failed! Manual recovery available at: $rollbackDir")
                }
                throw failure
            }
        } finally {
            if (!retainRollback) workDir.deleteRecursively()
        }

        logger.lifecycle("[stageExtension] Staged ${assetList.size} extension assets successfully to: $outDir")
    }
}

tasks.register<StageExtensionTask>("stageExtension") {
    group = "build"
    description =
        "Stages extension and dependency JARs, SHA-256 and manifest into resources/ils/$targetVersion/android.lsp/"

    descriptorJar.set(tasks.named<Jar>("descriptorJar").flatMap { it.archiveFile })
    moduleJars.from(
        tasks.named<Jar>("jar").flatMap { it.archiveFile },
        dapJar.flatMap { it.archiveFile }
    )
    expectedModuleNames.set(
        setOf(
            "language-server.api.features.impl.android.jar",
            "language-server.api.features.impl.android.dap.jar"
        )
    )
    runtimeClasspath.from(
        configurations.named("runtimeClasspath"),
        configurations.named(dap.runtimeClasspathConfigurationName)
    )
    expectedUpstreamNames.set(
        setOf(
            "adblib-$adblibVersion.jar",
            "adblib-tools-$adblibVersion.jar",
            "builder-model-$builderModelVersion.jar",
            "lint-api-$lintVersion.jar",
            "lint-checks-$lintVersion.jar",
            "lint-model-$lintVersion.jar",
            "manifest-merger-$lintVersion.jar",
            "common-$lintVersion.jar",
            "sdklib-$lintVersion.jar",
            "kxml2-$kxml2Version.jar",
            "sdk-common-$lintVersion.jar",
            "layoutlib-api-$lintVersion.jar",
            "groovy-$groovyVersion.jar"
        )
    )
    serverVersion.set(targetVersion)
    gradleVersion.set(gradle.gradleVersion)
    extensionDir.set(layout.projectDirectory.dir("../../resources/ils/$targetVersion/android.lsp"))
}
