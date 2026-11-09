package org.jetbrains.android.lint;

import com.android.tools.lint.checks.ApiDetector;
import com.android.tools.lint.checks.BuiltinIssueRegistry;
import com.android.tools.lint.checks.ManifestDetector;
import com.android.tools.lint.checks.ManifestTypoDetector;
import com.android.tools.lint.checks.NamespaceDetector;
import com.android.tools.lint.client.api.IssueRegistry;
import com.android.tools.lint.detector.api.Implementation;
import com.android.tools.lint.detector.api.Issue;
import com.android.tools.lint.detector.api.Platform;
import com.android.tools.lint.detector.api.Scope;

import java.util.ArrayList;
import java.util.Collections;
import java.util.EnumSet;
import java.util.List;

public class AndroidLintIssueRegistry extends BuiltinIssueRegistry {
    private static final List<Issue> FILTERED_ISSUES;
    private static final List<Issue> NO_API_DETECTOR_ISSUES;

    static {
        List<Issue> filtered = new ArrayList<>();
        List<Issue> noApi = new ArrayList<>();
        BuiltinIssueRegistry builtin = new BuiltinIssueRegistry();
        for (Issue issue : builtin.getIssues()) {
            if (isIssueSupported(issue)) {
                filtered.add(issue);
                if (!isApiDetectorIssue(issue)) {
                    noApi.add(issue);
                }
            }
        }
        FILTERED_ISSUES = Collections.unmodifiableList(filtered);
        NO_API_DETECTOR_ISSUES = Collections.unmodifiableList(noApi);
    }

    private final List<Issue> issues;

    public AndroidLintIssueRegistry() {
        this(false);
    }

    public AndroidLintIssueRegistry(boolean minSdkPremiseMissing) {
        this.issues = minSdkPremiseMissing ? NO_API_DETECTOR_ISSUES : FILTERED_ISSUES;
    }

    public static IssueRegistry create(boolean minSdkPremiseMissing) {
        return new AndroidLintIssueRegistry(minSdkPremiseMissing);
    }

    @Override
    public List<Issue> getIssues() {
        return issues;
    }

    @Override
    public boolean cacheable() {
        return false;
    }

    static boolean isIssueSupported(Issue issue) {
        if (issue == null) {
            return false;
        }
        EnumSet<Platform> platforms = issue.getPlatforms();
        if (platforms.contains(Platform.JDK) && !platforms.contains(Platform.ANDROID)) {
            return false;
        }
        Implementation impl = issue.getImplementation();
        if (impl == null) {
            return false;
        }
        if (impl.getDetectorClass() == ApiDetector.class) {
            return true;
        }
        if (issue.equals(NamespaceDetector.UNUSED)
                || issue.equals(ManifestTypoDetector.ISSUE)
                || issue.equals(ManifestDetector.WRONG_PARENT)) {
            return false;
        }
        EnumSet<Scope> mainScope = impl.getScope();
        EnumSet<Scope>[] analysisScopes = impl.getAnalysisScopes();
        boolean hasJavaFile = mainScope.contains(Scope.JAVA_FILE);
        if (!hasJavaFile && analysisScopes != null) {
            for (EnumSet<Scope> as : analysisScopes) {
                if (as != null && as.contains(Scope.JAVA_FILE)) {
                    hasJavaFile = true;
                    break;
                }
            }
        }
        if (!hasJavaFile) {
            return false;
        }

        boolean containsClassScope = mainScope.contains(Scope.CLASS_FILE)
                || mainScope.contains(Scope.ALL_CLASS_FILES)
                || mainScope.contains(Scope.JAVA_LIBRARIES);
        if (containsClassScope) {
            if (analysisScopes == null || analysisScopes.length == 0) {
                return false;
            }
            for (EnumSet<Scope> as : analysisScopes) {
                if (as != null
                        && !as.contains(Scope.CLASS_FILE)
                        && !as.contains(Scope.ALL_CLASS_FILES)
                        && !as.contains(Scope.JAVA_LIBRARIES)
                        && as.contains(Scope.JAVA_FILE)) {
                    return true;
                }
            }
            return false;
        }
        return true;
    }

    static boolean isApiDetectorIssue(Issue issue) {
        if (issue == null) {
            return false;
        }
        Implementation impl = issue.getImplementation();
        return impl != null && impl.getDetectorClass() == ApiDetector.class;
    }
}
