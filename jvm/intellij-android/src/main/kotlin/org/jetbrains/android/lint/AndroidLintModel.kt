package org.jetbrains.android.lint

import com.android.tools.lint.model.LintModelModule
import com.android.tools.lint.model.LintModelVariant
import com.intellij.openapi.module.Module
import java.io.File
import java.nio.file.Path
import java.util.Objects

class AndroidLintModel(
    @get:JvmName("module") val module: Module?,
    @get:JvmName("androidModule") val androidModule: Module?,
    @get:JvmName("moduleRoot") val moduleRoot: Path?,
    @get:JvmName("projectRoot") val projectRoot: Path?,
    @get:JvmName("variant") val variant: String?,
    @get:JvmName("sdkHome") val sdkHome: Path?,
    @get:JvmName("compileSdk") val compileSdk: Int?,
    @get:JvmName("compileTarget") val compileTarget: String?,
    @get:JvmName("minSdk") val minSdk: Int?,
    @get:JvmName("targetSdk") val targetSdk: Int?,
    @get:JvmName("namespace") val namespace: String?,
    @get:JvmName("isLibrary") val isLibrary: Boolean,
    @get:JvmName("minSdkPremiseMissing") val minSdkPremiseMissing: Boolean,
    @get:JvmName("lintModelModule") val lintModelModule: LintModelModule?,
    @get:JvmName("lintModelVariant") val lintModelVariant: LintModelVariant?,
    ruleJars: List<Path>? = null,
    ruleJarFingerprints: List<String>? = null,
    @get:JvmName("fingerprint") val fingerprint: String?,
    @get:JvmName("lintXmlFingerprint") val lintXmlFingerprint: String?,
    @get:JvmName("xmlInputs") val xmlInputs: AndroidLintResources.Inputs?,
    @get:JvmName("coreLibraryDesugaringEnabled") val coreLibraryDesugaringEnabled: Boolean = false,
    desugaredMethodsFiles: List<Path>? = null,
    resValues: Map<String, String>? = null,
    proguardFiles: List<Path>? = null
) {
    @get:JvmName("ruleJars")
    val ruleJars: List<Path> = if (ruleJars == null) java.util.List.of() else java.util.List.copyOf(ruleJars)

    @get:JvmName("ruleJarFingerprints")
    val ruleJarFingerprints: List<String> =
        if (ruleJarFingerprints == null) java.util.List.of() else java.util.List.copyOf(ruleJarFingerprints)

    @get:JvmName("desugaredMethodsFiles")
    val desugaredMethodsFiles: List<Path> =
        if (desugaredMethodsFiles == null) java.util.List.of() else java.util.List.copyOf(desugaredMethodsFiles)

    @get:JvmName("resValues")
    val resValues: Map<String, String> =
        if (resValues == null) java.util.Map.of() else java.util.Map.copyOf(resValues)

    @get:JvmName("proguardFiles")
    val proguardFiles: List<Path> =
        if (proguardFiles == null) java.util.List.of() else java.util.List.copyOf(proguardFiles)

    fun resourceFolders(): List<File> {
        val roots = xmlInputs?.resourceRoots ?: return emptyList()
        return roots.map { it.toFile() }
    }

    fun manifestFiles(): List<File> {
        val manifests = xmlInputs?.manifests ?: return emptyList()
        return manifests.map { it.toFile() }
    }

    fun mergedManifest(): File? = xmlInputs?.mergedManifest?.toFile()

    fun manifestMergeReport(): File? = xmlInputs?.manifestMergeReport?.toFile()

    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is AndroidLintModel) return false
        return module == other.module &&
                androidModule == other.androidModule &&
                moduleRoot == other.moduleRoot &&
                projectRoot == other.projectRoot &&
                variant == other.variant &&
                sdkHome == other.sdkHome &&
                compileSdk == other.compileSdk &&
                compileTarget == other.compileTarget &&
                minSdk == other.minSdk &&
                targetSdk == other.targetSdk &&
                namespace == other.namespace &&
                isLibrary == other.isLibrary &&
                minSdkPremiseMissing == other.minSdkPremiseMissing &&
                lintModelModule == other.lintModelModule &&
                lintModelVariant == other.lintModelVariant &&
                ruleJars == other.ruleJars &&
                ruleJarFingerprints == other.ruleJarFingerprints &&
                fingerprint == other.fingerprint &&
                lintXmlFingerprint == other.lintXmlFingerprint &&
                xmlInputs == other.xmlInputs &&
                coreLibraryDesugaringEnabled == other.coreLibraryDesugaringEnabled &&
                desugaredMethodsFiles == other.desugaredMethodsFiles &&
                resValues == other.resValues &&
                proguardFiles == other.proguardFiles
    }

    override fun hashCode(): Int {
        return Objects.hash(
            module, androidModule, moduleRoot, projectRoot, variant, sdkHome,
            compileSdk, compileTarget, minSdk, targetSdk, namespace, isLibrary,
            minSdkPremiseMissing, lintModelModule, lintModelVariant, ruleJars,
            ruleJarFingerprints, fingerprint, lintXmlFingerprint, xmlInputs,
            coreLibraryDesugaringEnabled, desugaredMethodsFiles, resValues, proguardFiles
        )
    }

    override fun toString(): String {
        return "AndroidLintModel(module=$module, androidModule=$androidModule, moduleRoot=$moduleRoot, projectRoot=$projectRoot, variant=$variant, sdkHome=$sdkHome, compileSdk=$compileSdk, compileTarget=$compileTarget, minSdk=$minSdk, targetSdk=$targetSdk, namespace=$namespace, isLibrary=$isLibrary, minSdkPremiseMissing=$minSdkPremiseMissing, lintModelModule=$lintModelModule, lintModelVariant=$lintModelVariant, ruleJars=$ruleJars, ruleJarFingerprints=$ruleJarFingerprints, fingerprint=$fingerprint, lintXmlFingerprint=$lintXmlFingerprint, xmlInputs=$xmlInputs, coreLibraryDesugaringEnabled=$coreLibraryDesugaringEnabled, desugaredMethodsFiles=$desugaredMethodsFiles, resValues=$resValues, proguardFiles=$proguardFiles)"
    }
}
