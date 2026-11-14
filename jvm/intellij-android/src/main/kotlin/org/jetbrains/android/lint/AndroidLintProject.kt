package org.jetbrains.android.lint

import com.android.ide.common.repository.AgpVersion
import com.android.sdklib.AndroidTargetHash
import com.android.sdklib.AndroidVersion
import com.android.tools.lint.client.api.LintClient
import com.android.tools.lint.detector.api.ApiConstraint
import com.android.tools.lint.detector.api.Project
import com.android.tools.lint.model.*
import com.intellij.openapi.module.Module
import com.intellij.pom.java.LanguageLevel
import org.jetbrains.kotlin.config.LanguageVersionSettings
import org.jetbrains.kotlin.config.LanguageVersionSettingsImpl
import java.io.File

open class AndroidLintProject(
    client: LintClient?,
    dir: File,
    val ideaModule: Module? = null,
    val model: AndroidLintModel? = null,
    private val lintModelModule: LintModelModule? = null,
    private val lintModelVariant: LintModelVariant? = null
) : Project(client, dir, dir) {

    init {
        if (ideaModule != null && !ideaModule.isDisposed) {
            ideaProject = ideaModule.project
        }
        gradleProject = java.lang.Boolean.TRUE
        mergeManifests = true
    }

    private val fallbackModule: LintModelModule? by lazy {
        if (lintModelModule != null) lintModelModule
        else if (model != null) LightweightLintModelModule(dir, model)
        else null
    }

    private val fallbackVariant: LintModelVariant? by lazy {
        if (lintModelVariant != null) lintModelVariant
        else fallbackModule?.variants?.firstOrNull()
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
        val bm = buildModule
        if (bm != null) {
            return bm.type == LintModelModuleType.LIBRARY
        }
        return model?.isLibrary ?: false
    }

    override fun getBuildModule(): LintModelModule? = fallbackModule

    override fun getBuildVariant(): LintModelVariant? = fallbackVariant

    override fun isCoreLibraryDesugaringEnabled(): Boolean {
        return model?.coreLibraryDesugaringEnabled
            ?: (lintModelVariant?.buildFeatures?.coreLibraryDesugaringEnabled ?: false)
    }

    override fun getProguardFiles(): List<File> {
        val files = ArrayList<File>()
        model?.proguardFiles?.forEach { files.add(it.toFile()) }
        lintModelVariant?.proguardFiles?.forEach { files.add(it) }
        val currentSubset = subset
        if (currentSubset != null) {
            for (f in currentSubset) {
                if (f.name.endsWith(".pro") || f.name.endsWith(".cfg") || f.name.startsWith("proguard")) {
                    if (!files.contains(f)) files.add(f)
                }
            }
        }
        return files
    }

    fun getDesugaredMethodsFiles(): Collection<File> {
        return model?.desugaredMethodsFiles?.map { it.toFile() }
            ?: lintModelVariant?.desugaredMethodsFiles
            ?: emptyList()
    }

    override fun getPropertyFiles(): List<File> {
        val files = ArrayList<File>()
        val currentSubset = subset
        if (currentSubset != null) {
            for (f in currentSubset) {
                if (f.name.endsWith(".properties") && !files.contains(f)) {
                    files.add(f)
                }
            }
        }
        val defaults = super.getPropertyFiles()
        for (f in defaults) {
            if (!files.contains(f)) files.add(f)
        }
        return files
    }

    override fun getGradleBuildScripts(): List<File> {
        val currentSubset = subset
        if (currentSubset != null) {
            val scripts = currentSubset.filter { it.name.endsWith(".gradle") || it.name.endsWith(".gradle.kts") }
            if (scripts.isNotEmpty()) return scripts
        }
        return super.getGradleBuildScripts()
    }

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

    private class LightweightLintModelVariant(
        override val module: LintModelModule,
        private val model: AndroidLintModel
    ) : LintModelVariant {
        override val name: String = model.variant ?: "debug"
        override val useSupportLibraryVectorDrawables: Boolean = false

        override val libraryResolver: LintModelLibraryResolver = DefaultLintModelLibraryResolver(emptyMap())

        private val emptyGraph = DefaultLintModelDependencyGraph(emptyList(), libraryResolver)
        private val emptyDependencies = DefaultLintModelDependencies(emptyGraph, emptyGraph, libraryResolver)

        override val artifact: LintModelAndroidArtifact = DefaultLintModelAndroidArtifact(
            model.namespace ?: "",
            emptyList(),
            emptyList(),
            model.desugaredMethodsFiles.map { it.toFile() },
            emptyDependencies,
            emptyList(),
            LintModelArtifactType.MAIN
        )

        @Deprecated("This property is deprecated.", replaceWith = ReplaceWith("artifact"))
        override val mainArtifact: LintModelAndroidArtifact
            get() = artifact
        override val testArtifact: LintModelJavaArtifact? = null
        override val androidTestArtifact: LintModelAndroidArtifact? = null
        override val testFixturesArtifact: LintModelAndroidArtifact? = null
        override val mergedManifest: File? = model.mergedManifest()
        override val manifestMergeReport: File? = model.manifestMergeReport()
        override val `package`: String? = model.namespace
        override val minSdkVersion: AndroidVersion? = model.minSdk?.let { AndroidVersion(it, null) }
        override val targetSdkVersion: AndroidVersion? = model.targetSdk?.let { AndroidVersion(it, null) }
        override val resValues: Map<String, LintModelResourceField> = model.resValues.mapValues { (k, v) ->
            DefaultLintModelResourceField("string", k, v)
        }
        override val manifestPlaceholders: Map<String, String> = emptyMap()
        override val resourceConfigurations: Collection<String> = emptyList()
        override val proguardFiles: Collection<File> = model.proguardFiles.map { it.toFile() }
        override val consumerProguardFiles: Collection<File> = emptyList()
        override val sourceProviders: List<LintModelSourceProvider> = emptyList()
        override val testSourceProviders: List<LintModelSourceProvider> = emptyList()
        override val testFixturesSourceProviders: List<LintModelSourceProvider> = emptyList()
        override val debuggable: Boolean = false
        override val shrinkable: Boolean = false
        override val buildFeatures: LintModelBuildFeatures = DefaultLintModelBuildFeatures(
            false,
            model.coreLibraryDesugaringEnabled
        )
        override val partialResultsDir: File? = null
        override val desugaredMethodsFiles: Collection<File> = model.desugaredMethodsFiles.map { it.toFile() }
    }

    private class LightweightLintModelModule(
        override val dir: File,
        private val model: AndroidLintModel
    ) : LintModelModule {
        override val loader: LintModelModuleLoader? = null
        override val modulePath: String = dir.name
        override val type: LintModelModuleType =
            if (model.isLibrary) LintModelModuleType.LIBRARY else LintModelModuleType.APP
        override val mavenName: LintModelMavenName? = null
        override val agpVersion: AgpVersion? = null
        override val buildFolder: File = dir.resolve("build")
        override val lintOptions: LintModelLintOptions = DefaultLintModelLintOptions()
        override val lintRuleJars: List<File> = model.ruleJars.map { it.toFile() }
        override val resourcePrefix: String? = null
        override val dynamicFeatures: Collection<String> = emptyList()
        override val bootClassPath: List<File> = emptyList()
        override val javaSourceLevel: String = "17"
        override val compileTarget: String = model.compileTarget ?: ""
        override val variants: List<LintModelVariant> = listOf(LightweightLintModelVariant(this, model))
        override fun neverShrinking(): Boolean = false
        override val highlightGradualR8Api: Boolean = false
    }
}
