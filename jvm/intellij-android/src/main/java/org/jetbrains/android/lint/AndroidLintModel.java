package org.jetbrains.android.lint;

import com.android.tools.lint.model.LintModelModule;
import com.android.tools.lint.model.LintModelVariant;
import com.intellij.openapi.module.Module;

import java.io.File;
import java.nio.file.Path;
import java.util.List;

public record AndroidLintModel(
        Module module,
        Module androidModule,
        Path moduleRoot,
        Path projectRoot,
        String variant,
        Path sdkHome,
        Integer compileSdk,
        String compileTarget,
        Integer minSdk,
        Integer targetSdk,
        String namespace,
        boolean isLibrary,
        boolean minSdkPremiseMissing,
        LintModelModule lintModelModule,
        LintModelVariant lintModelVariant,
        List<Path> ruleJars,
        List<String> ruleJarFingerprints,
        String fingerprint,
        String lintXmlFingerprint,
        AndroidLintResources.Inputs xmlInputs
) {
    public AndroidLintModel {
        ruleJars = ruleJars == null ? List.of() : List.copyOf(ruleJars);
        ruleJarFingerprints = ruleJarFingerprints == null ? List.of() : List.copyOf(ruleJarFingerprints);
    }

    public List<File> resourceFolders() {
        if (xmlInputs == null || xmlInputs.resourceRoots() == null) return List.of();
        return xmlInputs.resourceRoots().stream().map(Path::toFile).toList();
    }

    public List<File> manifestFiles() {
        if (xmlInputs == null || xmlInputs.manifests() == null) return List.of();
        return xmlInputs.manifests().stream().map(Path::toFile).toList();
    }

    public File mergedManifest() {
        return xmlInputs != null && xmlInputs.mergedManifest() != null ? xmlInputs.mergedManifest().toFile() : null;
    }

    public File manifestMergeReport() {
        return xmlInputs != null && xmlInputs.manifestMergeReport() != null ? xmlInputs.manifestMergeReport().toFile() : null;
    }
}
