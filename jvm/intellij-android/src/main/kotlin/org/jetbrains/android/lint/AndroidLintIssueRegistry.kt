package org.jetbrains.android.lint

import com.android.tools.lint.checks.ApiDetector
import com.android.tools.lint.checks.BuiltinIssueRegistry
import com.android.tools.lint.client.api.IssueRegistry
import com.android.tools.lint.detector.api.Implementation
import com.android.tools.lint.detector.api.Issue
import com.android.tools.lint.detector.api.Platform
import com.android.tools.lint.detector.api.Scope
import java.util.ArrayList
import java.util.EnumMap
import java.util.EnumSet

class AndroidLintIssueRegistry @JvmOverloads constructor(
    minSdkPremiseMissing: Boolean = false,
    scope: Scope = Scope.JAVA_FILE
) : BuiltinIssueRegistry() {

    override val issues: List<Issue> =
        (if (minSdkPremiseMissing) NO_API_ISSUES else EDITOR_ISSUES)[scope] ?: emptyList()

    override fun cacheable(): Boolean = false

    companion object {
        private val EDITOR_ISSUES: MutableMap<Scope, List<Issue>> = EnumMap(Scope::class.java)
        private val NO_API_ISSUES: MutableMap<Scope, List<Issue>> = EnumMap(Scope::class.java)

        init {
            val builtin = BuiltinIssueRegistry()
            for (scope in listOf(Scope.JAVA_FILE, Scope.RESOURCE_FILE, Scope.MANIFEST)) {
                val filtered = ArrayList<Issue>()
                val noApi = ArrayList<Issue>()
                for (issue in builtin.issues) {
                    if (isIssueSupported(issue, scope)) {
                        filtered.add(issue)
                        if (!isApiDetectorIssue(issue)) {
                            noApi.add(issue)
                        }
                    }
                }
                EDITOR_ISSUES[scope] = java.util.List.copyOf(filtered)
                NO_API_ISSUES[scope] = java.util.List.copyOf(noApi)
            }
        }

        @JvmStatic
        fun create(minSdkPremiseMissing: Boolean, scope: Scope): IssueRegistry {
            return AndroidLintIssueRegistry(minSdkPremiseMissing, scope)
        }

        @JvmStatic
        fun isIssueSupported(issue: Issue?, scope: Scope): Boolean {
            if (issue == null) {
                return false
            }
            val platforms = issue.platforms
            if (platforms.contains(Platform.JDK) && !platforms.contains(Platform.ANDROID)) {
                return false
            }
            val impl = issue.implementation ?: return false
            return impl.isAdequate(EnumSet.of(scope))
        }

        @JvmStatic
        fun isApiDetectorIssue(issue: Issue?): Boolean {
            if (issue == null) {
                return false
            }
            val impl = issue.implementation ?: return false
            return impl.detectorClass == ApiDetector::class.java
        }
    }
}
