package org.jetbrains.android.lint

import com.android.sdklib.AndroidTargetHash
import com.android.sdklib.AndroidVersion
import com.android.tools.lint.client.api.LintClient
import com.android.tools.lint.detector.api.ApiConstraint
import com.android.tools.lint.detector.api.Project
import com.android.tools.lint.model.LintModelModule
import com.android.tools.lint.model.LintModelModuleType
import com.android.tools.lint.model.LintModelVariant
import com.intellij.openapi.module.Module
import com.intellij.pom.java.LanguageLevel
import org.jetbrains.kotlin.config.LanguageVersionSettings
import org.jetbrains.kotlin.config.LanguageVersionSettingsImpl
import java.io.File

open class AndroidLintProject(
    client: LintClient?,
    dir: File,
    val ideaModule: Module?,
    val model: AndroidLintModel?,
    private val lintModelModule: LintModelModule?,
    private val lintModelVariant: LintModelVariant?
) : Project(client, dir, dir) {

    init {
        if (ideaModule != null && !ideaModule.isDisposed) {
            setIdeaProject(ideaModule.project)
        }
        gradleProject = java.lang.Boolean.TRUE
        mergeManifests = true
    }

    override fun getResourceFolders(): List<File> {
        return model?.resourceFolders() ?: emptyList()
    }

    override fun getManifestFiles(): List<File> {
        val currentModel = this.model ?: return emptyList()
        val currentSubset = subset
        if (currentSubset != null) {
            val manifests = currentModel.manifestFiles()
            for (file in currentSubset) {
                if (manifests.contains(file)) return listOf(file)
            }
        }
        return currentModel.manifestFiles()
    }

    override fun isAndroidProject(): Boolean = true

    override fun isLibrary(): Boolean {
        if (lintModelModule != null) {
            return lintModelModule.type == LintModelModuleType.LIBRARY
        }
        return model?.isLibrary ?: false
    }

    override fun getBuildModule(): LintModelModule? = lintModelModule

    override fun getBuildVariant(): LintModelVariant? = lintModelVariant

    override fun getPackage(): String? = model?.namespace

    override fun getBuildSdk(): Int {
        val compileSdk = model?.compileSdk
        if (compileSdk != null) {
            return compileSdk
        }
        val compileTarget = model?.compileTarget
        if (compileTarget != null) {
            val version = AndroidTargetHash.getVersionFromHash(compileTarget)
            if (version != null) {
                return version.featureLevel
            }
        }
        return 0
    }

    override fun getBuildTargetHash(): String? {
        val compileTarget = model?.compileTarget
        if (compileTarget != null) {
            return compileTarget
        }
        val compileSdk = model?.compileSdk
        if (compileSdk != null) {
            return AndroidTargetHash.PLATFORM_HASH_PREFIX + compileSdk
        }
        return null
    }

    override fun getMinSdkVersion(): AndroidVersion {
        val minSdk = model?.minSdk
        if (minSdk != null) {
            return AndroidVersion(minSdk, null)
        }
        return AndroidVersion.DEFAULT
    }

    override fun getMinSdkVersions(): ApiConstraint {
        val minSdk = model?.minSdk
        if (minSdk != null) {
            return ApiConstraint.get(minSdk, 0)
        }
        return ApiConstraint.NONE
    }

    override fun getTargetSdkVersion(): AndroidVersion {
        val targetSdk = model?.targetSdk
        if (targetSdk != null) {
            return AndroidVersion(targetSdk, null)
        }
        if (model?.minSdk != null) {
            return minSdkVersion
        }
        return AndroidVersion.DEFAULT
    }

    override fun getJavaLanguageLevel(): LanguageLevel {
        val currentClient = client
        if (currentClient != null) {
            return currentClient.getJavaLanguageLevel(this)
        }
        return LanguageLevel.JDK_17
    }

    override fun getKotlinLanguageLevel(): LanguageVersionSettings {
        val currentClient = client
        if (currentClient != null) {
            return currentClient.getKotlinLanguageLevel(this)
        }
        return LanguageVersionSettingsImpl.DEFAULT
    }
}
