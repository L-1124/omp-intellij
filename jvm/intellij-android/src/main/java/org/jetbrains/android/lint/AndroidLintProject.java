package org.jetbrains.android.lint;

import com.android.sdklib.AndroidVersion;
import com.android.tools.lint.client.api.LintClient;
import com.android.tools.lint.detector.api.ApiConstraint;
import com.android.tools.lint.detector.api.Project;
import com.android.tools.lint.model.LintModelModule;
import com.android.tools.lint.model.LintModelModuleType;
import com.android.tools.lint.model.LintModelVariant;
import com.intellij.openapi.module.Module;
import com.intellij.pom.java.LanguageLevel;
import org.jetbrains.kotlin.config.LanguageVersionSettings;
import org.jetbrains.kotlin.config.LanguageVersionSettingsImpl;

import java.io.File;

public class AndroidLintProject extends Project {
    private final AndroidLintModel model;
    private final Module ideaModule;
    private final LintModelModule lintModelModule;
    private final LintModelVariant lintModelVariant;

    public AndroidLintProject(
            LintClient client,
            File dir,
            Module ideaModule,
            AndroidLintModel model,
            LintModelModule lintModelModule,
            LintModelVariant lintModelVariant
    ) {
        super(client, dir, dir);
        this.model = model;
        this.ideaModule = ideaModule;
        this.lintModelModule = lintModelModule;
        this.lintModelVariant = lintModelVariant;

        if (ideaModule != null && !ideaModule.isDisposed()) {
            setIdeaProject(ideaModule.getProject());
        }
        this.gradleProject = Boolean.TRUE;
        this.mergeManifests = true;
    }

    public AndroidLintModel getModel() {
        return model;
    }

    public Module getIdeaModule() {
        return ideaModule;
    }

    @Override
    public boolean isAndroidProject() {
        return true;
    }

    @Override
    public boolean isLibrary() {
        if (lintModelModule != null) {
            return lintModelModule.getType() == LintModelModuleType.LIBRARY;
        }
        return model != null && model.isLibrary();
    }

    @Override
    public LintModelModule getBuildModule() {
        return lintModelModule;
    }

    @Override
    public LintModelVariant getBuildVariant() {
        return lintModelVariant;
    }

    @Override
    public String getPackage() {
        return model != null ? model.namespace() : null;
    }

    @Override
    public int getBuildSdk() {
        return model != null && model.compileSdk() != null ? model.compileSdk() : 0;
    }

    @Override
    public String getBuildTargetHash() {
        if (model != null && model.compileTarget() != null) {
            return model.compileTarget();
        }
        if (model != null && model.compileSdk() != null) {
            return "android-" + model.compileSdk();
        }
        return null;
    }

    @Override
    public AndroidVersion getMinSdkVersion() {
        if (model != null && model.minSdk() != null) {
            return new AndroidVersion(model.minSdk(), null);
        }
        return AndroidVersion.DEFAULT;
    }

    @Override
    public ApiConstraint getMinSdkVersions() {
        if (model != null && model.minSdk() != null) {
            return ApiConstraint.Companion.get(model.minSdk(), 0);
        }
        return ApiConstraint.NONE;
    }

    @Override
    public AndroidVersion getTargetSdkVersion() {
        if (model != null && model.targetSdk() != null) {
            return new AndroidVersion(model.targetSdk(), null);
        }
        if (model != null && model.minSdk() != null) {
            return getMinSdkVersion();
        }
        return AndroidVersion.DEFAULT;
    }

    @Override
    public LanguageLevel getJavaLanguageLevel() {
        LintClient client = getClient();
        if (client != null) {
            return client.getJavaLanguageLevel(this);
        }
        return LanguageLevel.JDK_17;
    }

    @Override
    public LanguageVersionSettings getKotlinLanguageLevel() {
        LintClient client = getClient();
        if (client != null) {
            return client.getKotlinLanguageLevel(this);
        }
        return LanguageVersionSettingsImpl.DEFAULT;
    }
}
