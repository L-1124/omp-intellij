package org.jetbrains.android.run

import com.android.builder.model.v2.ide.ProjectType
import com.android.builder.model.v2.models.AndroidProject
import com.android.builder.model.v2.models.BasicAndroidProject
import com.android.builder.model.v2.models.Versions
import org.gradle.tooling.BuildAction
import org.gradle.tooling.BuildController
import java.io.File
import java.io.Serializable

data class AndroidVariantModelDto(
    val name: String,
    val assembleTask: String?,
    val listingFile: File?,
    val abiFilters: Set<String>?,
    val applicationId: String?,
) : Serializable {
    companion object {
        private const val serialVersionUID: Long = 1L
    }
}

data class AndroidProjectModelDto(
    val buildRoot: File,
    val module: String,
    val projectDir: File,
    val agpVersion: String?,
    val projectType: String,
    val isApplication: Boolean,
    val variants: List<AndroidVariantModelDto>,
) : Serializable {
    companion object {
        private const val serialVersionUID: Long = 1L
    }
}

data class AndroidRunModelResultDto(
    val buildRoot: File,
    val projects: List<AndroidProjectModelDto>,
    val includedBuildRoots: List<File>,
    val nonAndroidProjectPaths: List<String>,
    val versionFailureDiagnostics: List<String>,
) : Serializable {
    companion object {
        private const val serialVersionUID: Long = 1L
    }
}

class AndroidRunModelAction : BuildAction<AndroidRunModelResultDto>, Serializable {
    override fun execute(controller: BuildController): AndroidRunModelResultDto {
        val build = controller.buildModel
        val buildRoot = build.rootProject.projectDirectory
        val projects = ArrayList<AndroidProjectModelDto>()
        val nonAndroidProjectPaths = ArrayList<String>()
        val versionFailureDiagnostics = ArrayList<String>()

        for (project in build.projects) {
            val versions = controller.findModel(project, Versions::class.java)
            if (versions == null) {
                nonAndroidProjectPaths.add(project.path)
                continue
            }

            val basic = controller.findModel(project, BasicAndroidProject::class.java)
            val android = controller.findModel(project, AndroidProject::class.java)
            if (basic == null || android == null) {
                val missing = buildList {
                    if (basic == null) add(Versions.BASIC_ANDROID_PROJECT)
                    if (android == null) add(Versions.ANDROID_PROJECT)
                }.joinToString(", ")
                versionFailureDiagnostics.add(
                    "${project.path}: agp=${versions.agp}, versions=${versions.versions.keys}, missing=[$missing]"
                )
                continue
            }

            val projectPath = project.path
            val variants = ArrayList<AndroidVariantModelDto>()
            for (variant in android.variants) {
                val mainArtifact = variant.mainArtifact
                val qualifiedTask = qualifyTaskName(projectPath, mainArtifact.assembleTaskName)
                val abiFilters = mainArtifact.abiFilters?.let { LinkedHashSet(it) }
                variants.add(
                    AndroidVariantModelDto(
                        name = variant.name,
                        assembleTask = qualifiedTask,
                        listingFile = mainArtifact.assembleTaskOutputListingFile,
                        abiFilters = abiFilters,
                        applicationId = mainArtifact.applicationId,
                    )
                )
            }

            projects.add(
                AndroidProjectModelDto(
                    buildRoot = buildRoot,
                    module = projectPath,
                    projectDir = project.projectDirectory,
                    agpVersion = versions.agp,
                    projectType = basic.projectType.name,
                    isApplication = basic.projectType == ProjectType.APPLICATION,
                    variants = variants,
                )
            )
        }

        val includedBuildRoots = ArrayList<File>()
        for (included in build.includedBuilds) {
            includedBuildRoots.add(included.rootProject.projectDirectory)
        }

        return AndroidRunModelResultDto(
            buildRoot = buildRoot,
            projects = projects,
            includedBuildRoots = includedBuildRoots,
            nonAndroidProjectPaths = nonAndroidProjectPaths,
            versionFailureDiagnostics = versionFailureDiagnostics,
        )
    }

    private fun qualifyTaskName(projectPath: String, rawTaskName: String?): String? {
        val trimmed = rawTaskName?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        if (trimmed.startsWith(":")) {
            return trimmed
        }
        return if (projectPath == ":") ":$trimmed" else "$projectPath:$trimmed"
    }

    companion object {
        private const val serialVersionUID: Long = 1L
    }
}
