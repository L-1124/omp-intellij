// Declaration stub: the lint-checks 32.4.1 Maven artifact omits the build-generated
// LibraryVersionLabels class, but GooglePlaySdkIndex's companion init and message
// builders reference its enums (NoClassDefFoundError without this). Method-body-only
// references (e.g. LibraryVersionLabels.Severity) stay unresolved at runtime because
// the offline index never reports ready. Re-verify on lint version upgrades.
package com.android.tools.lint.checks

class LibraryVersionLabels private constructor() {
    class PolicyIssuesInfo private constructor() {
        enum class SdkPolicy {
            SDK_POLICY_UNKNOWN,
            SDK_POLICY_ADS,
            SDK_POLICY_DEVICE_AND_NETWORK_ABUSE,
            SDK_POLICY_DECEPTIVE_BEHAVIOR,
            SDK_POLICY_USER_DATA,
            SDK_POLICY_PERMISSIONS,
            SDK_POLICY_MOBILE_UNWANTED_SOFTWARE,
            SDK_POLICY_MALWARE
        }
    }

    class SecurityVulnerabilitiesInfo private constructor() {
        enum class SdkSecurityVulnerabilityType {
            SDK_SECURITY_VULNERABILITY_TYPE_UNSPECIFIED,
            SDK_SECURITY_VULNERABILITY_TYPE_UNSAFE_TRUST_MANAGER,
            SDK_SECURITY_VULNERABILITY_TYPE_UNSAFE_HOSTNAME_VERIFIER,
            SDK_SECURITY_VULNERABILITY_TYPE_UNSAFE_SSL_ERROR_HANDLER,
            SDK_SECURITY_VULNERABILITY_TYPE_ZIP_PATH_TRAVERSAL,
            SDK_SECURITY_VULNERABILITY_TYPE_UNSAFE_WEBVIEW_OAUTH,
            SDK_SECURITY_VULNERABILITY_TYPE_UNSAFE_CIPHER_MODE,
            SDK_SECURITY_VULNERABILITY_TYPE_UNSAFE_ENCRYPTION,
            SDK_SECURITY_VULNERABILITY_TYPE_IMPLICIT_PENDING_INTENT,
            SDK_SECURITY_VULNERABILITY_TYPE_IMPLICIT_INTERNAL_INTENT,
            SDK_SECURITY_VULNERABILITY_TYPE_CROSS_APP_SCRIPTING,
            SDK_SECURITY_VULNERABILITY_TYPE_FILE_BASED_XSS,
            SDK_SECURITY_VULNERABILITY_TYPE_INTENT_SCHEME_HIJACKING,
            SDK_SECURITY_VULNERABILITY_TYPE_JS_INTERFACE_INJECTION,
            SDK_SECURITY_VULNERABILITY_TYPE_INTENT_REDIRECTION,
            SDK_SECURITY_VULNERABILITY_TYPE_FRAGMENT_INJECTION,
            SDK_SECURITY_VULNERABILITY_TYPE_PATH_TRAVERSAL,
            SDK_SECURITY_VULNERABILITY_TYPE_SQL_INJECTION,
            SDK_SECURITY_VULNERABILITY_TYPE_LEAKED_GCP_KEYS,
            SDK_SECURITY_VULNERABILITY_TYPE_VULNERABLE_LIBS
        }
    }
}
