package org.jetbrains.android.lint;

import com.android.tools.lint.checks.ApiDetector;
import com.android.tools.lint.checks.BuiltinIssueRegistry;
import com.android.tools.lint.client.api.IssueRegistry;
import com.android.tools.lint.detector.api.Implementation;
import com.android.tools.lint.detector.api.Issue;
import com.android.tools.lint.detector.api.Platform;
import com.android.tools.lint.detector.api.Scope;

import java.util.ArrayList;
import java.util.EnumSet;
import java.util.List;

public class AndroidLintIssueRegistry extends BuiltinIssueRegistry {
    private static final java.util.Map<Scope, List<Issue>> EDITOR_ISSUES = new java.util.EnumMap<>(Scope.class);
    private static final java.util.Map<Scope, List<Issue>> NO_API_ISSUES = new java.util.EnumMap<>(Scope.class);

    static {
        BuiltinIssueRegistry builtin = new BuiltinIssueRegistry();
        for (Scope scope : List.of(Scope.JAVA_FILE, Scope.RESOURCE_FILE, Scope.MANIFEST)) {
            List<Issue> filtered = new ArrayList<>();
            List<Issue> noApi = new ArrayList<>();
            for (Issue issue : builtin.getIssues()) {
                if (isIssueSupported(issue, scope)) {
                    filtered.add(issue);
                    if (!isApiDetectorIssue(issue)) noApi.add(issue);
                }
            }
            EDITOR_ISSUES.put(scope, List.copyOf(filtered));
            NO_API_ISSUES.put(scope, List.copyOf(noApi));
        }
    }

    private final List<Issue> issues;

    public AndroidLintIssueRegistry() {
        this(false);
    }

    public AndroidLintIssueRegistry(boolean minSdkPremiseMissing) {
        this(minSdkPremiseMissing, Scope.JAVA_FILE);
    }

    public AndroidLintIssueRegistry(boolean minSdkPremiseMissing, Scope scope) {
        this.issues = (minSdkPremiseMissing ? NO_API_ISSUES : EDITOR_ISSUES).getOrDefault(scope, List.of());
    }

    public static IssueRegistry create(boolean minSdkPremiseMissing, Scope scope) {
        return new AndroidLintIssueRegistry(minSdkPremiseMissing, scope);
    }

    @Override
    public List<Issue> getIssues() {
        return issues;
    }

    @Override
    public boolean cacheable() {
        return false;
    }

    static boolean isIssueSupported(Issue issue, Scope scope) {
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
        return impl.isAdequate(EnumSet.of(scope));
    }

    static boolean isApiDetectorIssue(Issue issue) {
        if (issue == null) {
            return false;
        }
        Implementation impl = issue.getImplementation();
        return impl != null && impl.getDetectorClass() == ApiDetector.class;
    }
}
