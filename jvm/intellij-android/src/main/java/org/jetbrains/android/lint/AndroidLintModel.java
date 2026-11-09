package org.jetbrains.android.lint;

import com.android.tools.lint.model.LintModelModule;
import com.android.tools.lint.model.LintModelVariant;
import com.intellij.openapi.module.Module;

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
        String lintXmlFingerprint
) {
    public AndroidLintModel {
        ruleJars = ruleJars == null ? List.of() : List.copyOf(ruleJars);
        ruleJarFingerprints = ruleJarFingerprints == null ? List.of() : List.copyOf(ruleJarFingerprints);
    }
}
