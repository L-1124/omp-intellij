package org.jetbrains.android.lint

import com.android.tools.lint.checks.ApiDetector
import com.android.tools.lint.checks.BuiltinIssueRegistry
import com.android.tools.lint.checks.GooglePlaySdkIndex
import com.android.tools.lint.checks.GradleDetector
import com.android.tools.lint.client.api.IssueRegistry
import com.android.tools.lint.detector.api.Issue
import com.android.tools.lint.detector.api.Platform
import com.android.tools.lint.detector.api.Scope
import java.util.*

class AndroidLintIssueRegistry @JvmOverloads constructor(
    minSdkPremiseMissing: Boolean = false,
    scope: Scope = Scope.JAVA_FILE
) : BuiltinIssueRegistry() {

    override val issues: List<Issue> =
        (if (minSdkPremiseMissing) NO_API_ISSUES else EDITOR_ISSUES)[scope] ?: emptyList()

    override fun cacheable(): Boolean = false

    private class OfflineGooglePlaySdkIndex : GooglePlaySdkIndex(null) {
        override fun readUrlData(url: String, timeout: Int, lastModified: Long): ReadUrlDataResult {
            return ReadUrlDataResult(ByteArray(0), false)
        }

        override fun error(throwable: Throwable, message: String?) {
        }
    }

    companion object {
        internal val PLAY_SDK_INDEX_ISSUES = setOf(
            "PlaySdkIndexNonCompliant",
            "PlaySdkIndexDeprecated",
            "PlaySdkIndexVulnerability",
            "PlaySdkIndexGenericIssues"
        )

        private val SUPPORTED_SCOPES = listOf(
            Scope.JAVA_FILE,
            Scope.RESOURCE_FILE,
            Scope.MANIFEST,
            Scope.GRADLE_FILE,
            Scope.TOML_FILE,
            Scope.PROGUARD_FILE,
            Scope.PROPERTY_FILE
        )

        private val EDITOR_ISSUES: MutableMap<Scope, List<Issue>> = EnumMap(Scope::class.java)
        private val NO_API_ISSUES: MutableMap<Scope, List<Issue>> = EnumMap(Scope::class.java)

        init {
            GradleDetector.playSdkIndexFactory = { _, _ -> OfflineGooglePlaySdkIndex() }

            val builtin = BuiltinIssueRegistry()
            for (scope in SUPPORTED_SCOPES) {
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
            if (issue.id in PLAY_SDK_INDEX_ISSUES) {
                return false
            }
            val platforms = issue.platforms
            if (platforms.contains(Platform.JDK) && !platforms.contains(Platform.ANDROID)) {
                return false
            }
            val impl = issue.implementation
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
