import groovy.json.JsonSlurper
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import java.util.Properties
import java.util.UUID

plugins {
    java
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
val compileSdkJars = ilsLibJars + fileTree(ilsHomeDir.resolve("plugins")) {
    include("java/**/*.jar", "kotlin/**/*.jar", "xml/**/*.jar", "dap-jvm/**/*.jar")
}

java {
    toolchain {
        languageVersion.set(JavaLanguageVersion.of(25))
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

val adblibVersion = "9.4.1"
val lintVersion = "32.4.1"
val kxml2Version = "2.3.0"
val groovyVersion = "4.0.29"

dependencies {
    compileOnly(compileSdkJars)
    testCompileOnly(compileSdkJars)
    testRuntimeOnly(ilsLibJars + ilsPluginJars)


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
    archiveBaseName.set("intellij-android")
    archiveVersion.set("")
    archiveClassifier.set("")
    entryCompression = ZipEntryCompression.STORED
    isPreserveFileTimestamps = false
    isReproducibleFileOrder = true
}

abstract class StageExtensionTask : DefaultTask() {
    @get:InputFile
    @get:PathSensitive(PathSensitivity.NAME_ONLY)
    abstract val builtJar: RegularFileProperty

    @get:InputFiles
    @get:Classpath
    abstract val runtimeClasspath: ConfigurableFileCollection

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
        val jarFile = builtJar.get().asFile
        if (!jarFile.exists()) {
            throw GradleException("Built JAR does not exist at: ${jarFile.absolutePath}")
        }

        val upstreamJars = runtimeClasspath.files.filter { it.extension == "jar" && it != jarFile }
        val expectedNames = expectedUpstreamNames.get()
        val actualNames = upstreamJars.map { it.name }.toSet()
        if (actualNames != expectedNames) {
            throw GradleException("Unexpected upstream runtime JARs: expected $expectedNames, got $actualNames")
        }

        val allJars = listOf(jarFile) + upstreamJars.sortedBy { it.name }
        val outDir = extensionDir.get().asFile
        val targetLibDir = outDir.resolve("lib")
        val targetManifest = outDir.resolve("manifest.json")

        val workDir = temporaryDir.resolve("work-${UUID.randomUUID()}")
        val stagingLibDir = workDir.resolve("staging/lib").apply { mkdirs() }
        val stagedManifest = workDir.resolve("staging/manifest.json")
        val rollbackLibDir = workDir.resolve("rollback/lib").apply { mkdirs() }

        try {
            val assetRecords = allJars.map { jar ->
                val stagedJar = stagingLibDir.resolve(jar.name)
                jar.copyTo(stagedJar, overwrite = true)

                val bytes = stagedJar.readBytes()
                val shaHex = MessageDigest.getInstance("SHA-256")
                    .digest(bytes)
                    .joinToString("") { "%02x".format(it) }

                stagingLibDir.resolve("${jar.name}.sha256")
                    .writeText("$shaHex *${jar.name}\n", Charsets.UTF_8)

                mapOf(
                    "name" to jar.name,
                    "path" to "lib/${jar.name}",
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
            targetLibDir.mkdirs()

            val existingFiles = targetLibDir.listFiles()?.filter { it.isFile } ?: emptyList()
            for (existing in existingFiles) {
                Files.copy(
                    existing.toPath(),
                    rollbackLibDir.resolve(existing.name).toPath(),
                    StandardCopyOption.REPLACE_EXISTING
                )
            }

            var retainRollback = false
            try {
                val stagedFiles = stagingLibDir.listFiles()?.sortedBy { it.name } ?: emptyList()
                val stagedNames = stagedFiles.map { it.name }.toSet()

                for (stagedFile in stagedFiles) {
                    val target = targetLibDir.resolve(stagedFile.name)
                    Files.move(stagedFile.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING)
                }

                for (existing in existingFiles) {
                    if (existing.name !in stagedNames) {
                        Files.deleteIfExists(existing.toPath())
                    }
                }

                try {
                    Files.move(
                        stagedManifest.toPath(),
                        targetManifest.toPath(),
                        StandardCopyOption.ATOMIC_MOVE,
                        StandardCopyOption.REPLACE_EXISTING
                    )
                } catch (_: AtomicMoveNotSupportedException) {
                    Files.move(
                        stagedManifest.toPath(),
                        targetManifest.toPath(),
                        StandardCopyOption.REPLACE_EXISTING
                    )
                }
            } catch (failure: Throwable) {
                try {
                    targetLibDir.listFiles()?.forEach { it.delete() }
                    rollbackLibDir.listFiles()?.forEach { backup ->
                        Files.move(
                            backup.toPath(),
                            targetLibDir.resolve(backup.name).toPath(),
                            StandardCopyOption.REPLACE_EXISTING
                        )
                    }
                } catch (rollbackFailure: Exception) {
                    retainRollback = true
                    failure.addSuppressed(rollbackFailure)
                }
                if (retainRollback) {
                    logger.error("Asset rollback failed! Manual recovery available at: $rollbackLibDir")
                }
                throw failure
            }
        } finally {
            if (!workDir.resolve("rollback/lib").exists() || workDir.listFiles()?.isEmpty() == true) {
                workDir.deleteRecursively()
            }
        }

        logger.lifecycle("[stageExtension] Staged ${allJars.size} extension assets successfully to: $outDir")
    }
}

tasks.register<StageExtensionTask>("stageExtension") {
    group = "build"
    description =
        "Stages extension and dependency JARs, SHA-256 and manifest into resources/ils/$targetVersion/intellij-android/"

    builtJar.set(tasks.named<Jar>("jar").flatMap { it.archiveFile })
    runtimeClasspath.from(configurations.named("runtimeClasspath"))
    expectedUpstreamNames.set(
        setOf(
            "adblib-$adblibVersion.jar",
            "adblib-tools-$adblibVersion.jar",
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
    extensionDir.set(layout.projectDirectory.dir("../../resources/ils/$targetVersion/intellij-android"))
}
