import com.android.build.api.variant.ApplicationAndroidComponentsExtension
import org.gradle.api.DefaultTask
import org.gradle.api.file.DirectoryProperty
import org.gradle.api.tasks.OutputDirectory
import org.gradle.api.tasks.TaskAction

plugins {
    id("com.android.application")
}

android {
    namespace = "com.example.ompattachfixture"
    compileSdk = 37

    defaultConfig {
        applicationId = "com.example.ompattachfixture"
        minSdk = 26
        targetSdk = 37
        versionCode = 1
        versionName = "1.0.0"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_21
        targetCompatibility = JavaVersion.VERSION_21
    }

    buildFeatures {
        buildConfig = true
    }
    buildTypes {
        getByName("release") {
            signingConfig = signingConfigs.getByName("debug")
            isMinifyEnabled = false
        }
    }
}

dependencies {
    implementation(project(":lib"))
}

abstract class GenerateCounterTask : DefaultTask() {
    @get:OutputDirectory
    abstract val outputDir: DirectoryProperty

    @TaskAction
    fun generate() {
        val packageDir = outputDir.get().asFile.resolve("com/example/ompattachfixture")
        packageDir.mkdirs()
        packageDir.resolve("GeneratedCounter.java").writeText(
            """
            package com.example.ompattachfixture;

            public final class GeneratedCounter {
                private static volatile int lastRecorded = 0;

                public static int record(int value) {
                    int doubled = value * 2;
                    lastRecorded = doubled;
                    return doubled;
                }

                public static int getLastRecorded() {
                    return lastRecorded;
                }
            }
            """.trimIndent() + "\n"
        )
    }
}

extensions.configure(ApplicationAndroidComponentsExtension::class.java) {
    onVariants { variant ->
        val variantTitle = variant.name.replaceFirstChar { it.uppercase() }
        val genTask = tasks.register("generate${variantTitle}CounterSource", GenerateCounterTask::class.java)
        variant.sources.java?.addGeneratedSourceDirectory(genTask, GenerateCounterTask::outputDir)
    }
}
