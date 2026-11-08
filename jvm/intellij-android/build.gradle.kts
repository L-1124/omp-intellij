import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import java.util.UUID

plugins {
    java
}

val targetVersion = "271.2085.0"

val ilsHomeProp = project.findProperty("ilsHome") as String?
val ilsHomeEnv = System.getenv("OMP_ILS_HOME")
val ilsHomeStr = if (!ilsHomeProp.isNullOrBlank()) ilsHomeProp else (ilsHomeEnv ?: "")

if (ilsHomeStr.isBlank()) {
    throw GradleException(
        "ILS home directory must be provided via -PilsHome=<path> or OMP_ILS_HOME environment variable."
    )
}

val ilsHomeDir = file(ilsHomeStr)
if (!ilsHomeDir.exists() || !ilsHomeDir.isDirectory) {
    throw GradleException("ILS home directory does not exist or is not a directory: ${ilsHomeDir.absolutePath}")
}

val buildTxt = ilsHomeDir.resolve("build.txt")
if (!buildTxt.exists()) {
    throw GradleException("ILS installation build.txt missing at: ${buildTxt.absolutePath}")
}

val buildVersion = buildTxt.readText().trim()
if (buildVersion != "ILS-$targetVersion") {
    throw GradleException("ILS build.txt mismatch: expected 'ILS-$targetVersion', got '$buildVersion'")
}

val ilsLibJars = fileTree(ilsHomeDir.resolve("lib")) {
    include("**/*.jar")
}
val ilsPluginJars = fileTree(ilsHomeDir.resolve("plugins")) {
    include("**/*.jar")
}
val sdkJars = ilsLibJars + ilsPluginJars

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

dependencies {
    compileOnly(sdkJars)
    testCompileOnly(sdkJars)
    testRuntimeOnly(sdkJars)

    implementation("com.android.tools.adblib:adblib:9.4.1") {
        isTransitive = false
    }
    implementation("com.android.tools.adblib:adblib-tools:9.4.1") {
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

tasks.register("stageExtension") {
    dependsOn(tasks.named("jar"))
    group = "build"
    description = "Stages extension and dependency JARs, SHA-256 and manifest into resources/ils/271.2085.0/intellij-android/"

    val jarTask = tasks.named<Jar>("jar")
    val runtimeClasspath = configurations.named("runtimeClasspath")
    inputs.file(jarTask.flatMap { it.archiveFile })
    inputs.files(runtimeClasspath)

    val extensionDir = file("${project.rootDir}/../../resources/ils/$targetVersion/intellij-android")
    outputs.dir(extensionDir)

    doLast {
        val builtJarFile = jarTask.get().archiveFile.get().asFile
        if (!builtJarFile.exists()) {
            throw GradleException("Built JAR does not exist at: ${builtJarFile.absolutePath}")
        }

        val upstreamJars = runtimeClasspath.get().files.filter { it.extension == "jar" && it != builtJarFile }
        val expectedUpstreamNames = setOf("adblib-9.4.1.jar", "adblib-tools-9.4.1.jar")
        val actualUpstreamNames = upstreamJars.map { it.name }.toSet()
        if (actualUpstreamNames != expectedUpstreamNames) {
            throw GradleException("Unexpected upstream runtime JARs: expected $expectedUpstreamNames, got $actualUpstreamNames")
        }

        val allJars = listOf(builtJarFile) + upstreamJars.sortedBy { it.name }

        extensionDir.mkdirs()
        val targetLibDir = extensionDir.resolve("lib")
        targetLibDir.mkdirs()
        val targetManifest = extensionDir.resolve("manifest.json")

        val stagingDir = extensionDir.resolve(".staging-${UUID.randomUUID()}")
        stagingDir.mkdirs()
        val stagingLibDir = stagingDir.resolve("lib")
        stagingLibDir.mkdirs()

        try {
            val assetRecords = mutableListOf<Map<String, Any>>()

            for (jar in allJars) {
                val stagedJar = stagingLibDir.resolve(jar.name)
                jar.copyTo(stagedJar, overwrite = true)

                val bytes = stagedJar.readBytes()
                val md = MessageDigest.getInstance("SHA-256")
                val shaHex = md.digest(bytes).joinToString("") { "%02x".format(it) }

                val stagedShaFile = stagingLibDir.resolve("${jar.name}.sha256")
                stagedShaFile.writeText("$shaHex *${jar.name}\n", Charsets.UTF_8)

                assetRecords.add(
                    mapOf(
                        "name" to jar.name,
                        "path" to "lib/${jar.name}",
                        "sha256" to shaHex,
                        "size" to bytes.size
                    )
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
  "serverVersion": "$targetVersion",
  "extensionId": "org.jetbrains.android",
  "buildTimestamp": "2026-01-01T00:00:00Z",
  "targetJavaVersion": 25,
  "classFileVersion": 69,
  "toolchain": {
    "javacVersion": "javac 25",
    "jarVersion": "Gradle 9.8.0"
  },
  "assets": [
$assetsJson
  ]
}
"""
            val stagedManifest = stagingDir.resolve("manifest.json")
            stagedManifest.writeText(manifestContent, Charsets.UTF_8)

            val rollbackDir = extensionDir.resolve(".rollback-${UUID.randomUUID()}")
            rollbackDir.mkdirs()
            val backups = mutableMapOf<File, File>()
            val replaced = mutableListOf<File>()
            var retainRollback = false
            try {
                val stagedFiles = stagingLibDir.listFiles()?.sortedBy { it.name }
                    ?: throw GradleException("Staging library directory is unreadable")
                for (stagedFile in stagedFiles) {
                    val target = targetLibDir.resolve(stagedFile.name)
                    if (target.exists()) {
                        val backup = rollbackDir.resolve(stagedFile.name)
                        Files.copy(target.toPath(), backup.toPath(), StandardCopyOption.REPLACE_EXISTING)
                        backups[target] = backup
                    }
                }
                for (stagedFile in stagedFiles) {
                    val target = targetLibDir.resolve(stagedFile.name)
                    Files.move(stagedFile.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING)
                    replaced.add(target)
                }
                Files.move(
                    stagedManifest.toPath(),
                    targetManifest.toPath(),
                    StandardCopyOption.ATOMIC_MOVE,
                    StandardCopyOption.REPLACE_EXISTING
                )
            } catch (failure: Throwable) {
                for (target in replaced.asReversed()) {
                    try {
                        val backup = backups[target]
                        if (backup == null) Files.deleteIfExists(target.toPath())
                        else Files.move(backup.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING)
                    } catch (rollbackFailure: Exception) {
                        retainRollback = true
                        failure.addSuppressed(rollbackFailure)
                    }
                }
                if (retainRollback) logger.error("Asset rollback requires recovery from $rollbackDir")
                throw failure
            } finally {
                if (!retainRollback) rollbackDir.deleteRecursively()
            }

            logger.lifecycle("[stageExtension] Staged ${allJars.size} extension assets successfully to: $extensionDir")
        } finally {
            stagingDir.deleteRecursively()
        }
    }
}
