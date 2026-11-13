package org.jetbrains.android.run

import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.nio.file.Files
import java.nio.file.Path

class AndroidApkManifestInspectorTest {
    @get:Rule
    val tempFolder = TemporaryFolder()

    private class FakeAapt2Runner(
        private val badgingByApk: Map<Path, String>,
        private val xmlTreeByApk: Map<Path, String>,
    ) : Aapt2Runner {
        override suspend fun dumpBadging(apk: Path): String =
            badgingByApk[apk] ?: error("Missing fake badging for $apk")

        override suspend fun dumpXmlTree(apk: Path, entryPath: String): String =
            xmlTreeByApk[apk] ?: error("Missing fake xmltree for $apk")
    }

    private fun createDummyApk(name: String): Path {
        val file = tempFolder.newFile(name).toPath()
        Files.writeString(file, "apk")
        return file
    }

    @Test
    fun testRelativeProcessAndAliasTargetActivityProcessResolution() = runBlocking {
        val apk = createDummyApk("app-debug.apk")
        val badging = """
            package: name='com.example.app' versionCode='12' versionName='1.2'
            application-debuggable
            native-code: 'arm64-v8a' 'x86_64'
            launchable-activity: name='com.example.app.AliasEntry' label='' icon=''
        """.trimIndent()
        val xmlTree = """
            N: android=http://schemas.android.com/apk/res/android (line=1)
              E: manifest (line=2)
                A: http://schemas.android.com/apk/res/android:versionCode(0x0101021b)=12
                A: package="com.example.app" (Raw: "com.example.app")
                  E: application (line=5)
                    A: http://schemas.android.com/apk/res/android:debuggable(0x0101000f)=(type 0x12)0xffffffff
                    A: http://schemas.android.com/apk/res/android:process(0x01010011)=":appproc" (Raw: ":appproc")
                      E: activity (line=8)
                        A: http://schemas.android.com/apk/res/android:name(0x01010003)=".CustomActivity" (Raw: ".CustomActivity")
                        A: http://schemas.android.com/apk/res/android:process(0x01010011)=":custom" (Raw: ":custom")
                        A: http://schemas.android.com/apk/res/android:exported(0x01010010)=true
                      E: activity (line=12)
                        A: http://schemas.android.com/apk/res/android:name(0x01010003)=".PlainActivity" (Raw: ".PlainActivity")
                        A: http://schemas.android.com/apk/res/android:exported(0x01010010)=true
                      E: activity-alias (line=16)
                        A: http://schemas.android.com/apk/res/android:name(0x01010003)=".AliasEntry" (Raw: ".AliasEntry")
                        A: http://schemas.android.com/apk/res/android:targetActivity(0x01010202)="CustomActivity" (Raw: "CustomActivity")
                        A: http://schemas.android.com/apk/res/android:exported(0x01010010)=true
                          E: intent-filter (line=19)
                              E: action (line=20)
                                A: http://schemas.android.com/apk/res/android:name(0x01010003)="android.intent.action.MAIN" (Raw: "android.intent.action.MAIN")
                              E: category (line=21)
                                A: http://schemas.android.com/apk/res/android:name(0x01010003)="android.intent.category.LAUNCHER" (Raw: "android.intent.category.LAUNCHER")
        """.trimIndent()

        val inspector = AndroidApkManifestInspector(
            FakeAapt2Runner(mapOf(apk to badging), mapOf(apk to xmlTree))
        )

        val resolvedAlias = inspector.validateAndResolveLaunch(
            apks = listOf(apk),
            deviceAbis = listOf("arm64-v8a"),
            requestedActivity = null,
            requireDebuggable = true,
        )
        assertEquals("com.example.app", resolvedAlias.packageName)
        assertEquals("com.example.app/com.example.app.AliasEntry", resolvedAlias.launchComponent.componentName)
        assertTrue(resolvedAlias.launchComponent.isAlias)
        assertEquals("com.example.app:custom", resolvedAlias.processName)
        assertTrue(resolvedAlias.debuggable)

        val resolvedPlain = inspector.validateAndResolveLaunch(
            apks = listOf(apk),
            deviceAbis = listOf("arm64-v8a"),
            requestedActivity = ".PlainActivity",
            requireDebuggable = true,
        )
        assertEquals("com.example.app:appproc", resolvedPlain.processName)
        assertFalse(resolvedPlain.launchComponent.isAlias)
    }

    @Test
    fun testMultiLauncherRequiresExplicitActivityAndReportsCandidates() = runBlocking {
        val apk = createDummyApk("multi-launcher.apk")
        val badging = "package: name='com.example.multi' versionCode='1'\napplication-debuggable\n"
        val xmlTree = """
            E: manifest (line=1)
              A: package="com.example.multi" (Raw: "com.example.multi")
                E: application (line=2)
                  A: android:debuggable=true
                    E: activity (line=3)
                      A: android:name=".MainActivity" (Raw: ".MainActivity")
                      A: android:exported=true
                        E: intent-filter
                            E: action
                              A: android:name="android.intent.action.MAIN"
                            E: category
                              A: android:name="android.intent.category.LAUNCHER"
                    E: activity (line=8)
                      A: android:name=".SecondActivity" (Raw: ".SecondActivity")
                      A: android:exported=true
                        E: intent-filter
                            E: action
                              A: android:name="android.intent.action.MAIN"
                            E: category
                              A: android:name="android.intent.category.LAUNCHER"
        """.trimIndent()

        val inspector = AndroidApkManifestInspector(
            FakeAapt2Runner(mapOf(apk to badging), mapOf(apk to xmlTree))
        )
        try {
            inspector.validateAndResolveLaunch(listOf(apk), listOf("x86_64"), null, requireDebuggable = true)
            fail("Expected ARTIFACT_INVALID for multiple launcher activities")
        } catch (e: AndroidRunException) {
            assertEquals(AndroidRunErrorCode.ARTIFACT_INVALID, e.error.code)
            assertTrue(e.error.detail.contains("com.example.multi/com.example.multi.MainActivity"))
            assertTrue(e.error.detail.contains("com.example.multi/com.example.multi.SecondActivity"))
        }

        val explicit = inspector.validateAndResolveLaunch(
            listOf(apk),
            listOf("x86_64"),
            "SecondActivity",
            requireDebuggable = true,
        )
        assertEquals("com.example.multi/com.example.multi.SecondActivity", explicit.launchComponent.componentName)
    }

    @Test
    fun testSplitApkValidationPackageVersionDuplicateBaseAndAbiMismatch() = runBlocking {
        val base = createDummyApk("base.apk")
        val splitArm = createDummyApk("split-arm64.apk")
        val splitDup = createDummyApk("split-dup.apk")
        val splitWrongPkg = createDummyApk("split-wrongpkg.apk")
        val splitWrongVer = createDummyApk("split-wrongver.apk")

        val baseBadging = "package: name='com.example.split' versionCode='7'\napplication-debuggable\n"
        val baseXml = """
            E: manifest
              A: package="com.example.split"
              A: android:versionCode=7
                E: application
                  A: android:debuggable=true
                    E: activity
                      A: android:name=".MainActivity"
                      A: android:exported=true
                        E: intent-filter
                            E: action
                              A: android:name="android.intent.action.MAIN"
                            E: category
                              A: android:name="android.intent.category.LAUNCHER"
        """.trimIndent()

        val armBadging =
            "package: name='com.example.split' versionCode='7' split='config.arm64_v8a'\nnative-code: 'arm64-v8a'\n"
        val armXml =
            "E: manifest\n  A: package=\"com.example.split\"\n  A: split=\"config.arm64_v8a\"\n  A: android:versionCode=7\n"

        val dupBadging = armBadging
        val dupXml = armXml

        val wrongPkgBadging = "package: name='com.example.other' versionCode='7' split='config.other'\n"
        val wrongPkgXml =
            "E: manifest\n  A: package=\"com.example.other\"\n  A: split=\"config.other\"\n  A: android:versionCode=7\n"

        val wrongVerBadging = "package: name='com.example.split' versionCode='8' split='config.v8'\n"
        val wrongVerXml =
            "E: manifest\n  A: package=\"com.example.split\"\n  A: split=\"config.v8\"\n  A: android:versionCode=8\n"

        val inspector = AndroidApkManifestInspector(
            FakeAapt2Runner(
                mapOf(
                    base to baseBadging,
                    splitArm to armBadging,
                    splitDup to dupBadging,
                    splitWrongPkg to wrongPkgBadging,
                    splitWrongVer to wrongVerBadging,
                ),
                mapOf(
                    base to baseXml,
                    splitArm to armXml,
                    splitDup to dupXml,
                    splitWrongPkg to wrongPkgXml,
                    splitWrongVer to wrongVerXml,
                ),
            )
        )

        val valid = inspector.validateAndResolveLaunch(
            apks = listOf(base, splitArm),
            deviceAbis = listOf("arm64-v8a", "armeabi-v7a"),
            requestedActivity = null,
            requireDebuggable = true,
        )
        assertEquals(1, valid.splits.size)

        // ABI mismatch
        try {
            inspector.validateAndResolveLaunch(listOf(base, splitArm), listOf("x86_64"), null, true)
            fail("Expected ABI_MISMATCH")
        } catch (e: AndroidRunException) {
            assertEquals(AndroidRunErrorCode.ABI_MISMATCH, e.error.code)
        }

        // Missing base APK
        try {
            inspector.validateAndResolveLaunch(listOf(splitArm), listOf("arm64-v8a"), null, true)
            fail("Expected ARTIFACT_INVALID for missing base")
        } catch (e: AndroidRunException) {
            assertEquals(AndroidRunErrorCode.ARTIFACT_INVALID, e.error.code)
        }

        // Duplicate splitName
        try {
            inspector.validateAndResolveLaunch(listOf(base, splitArm, splitDup), listOf("arm64-v8a"), null, true)
            fail("Expected ARTIFACT_INVALID for duplicate splitName")
        } catch (e: AndroidRunException) {
            assertEquals(AndroidRunErrorCode.ARTIFACT_INVALID, e.error.code)
        }

        // Package mismatch
        try {
            inspector.validateAndResolveLaunch(listOf(base, splitWrongPkg), listOf("arm64-v8a"), null, true)
            fail("Expected ARTIFACT_INVALID for mismatched split package")
        } catch (e: AndroidRunException) {
            assertEquals(AndroidRunErrorCode.ARTIFACT_INVALID, e.error.code)
        }

        // VersionCode mismatch
        try {
            inspector.validateAndResolveLaunch(listOf(base, splitWrongVer), listOf("arm64-v8a"), null, true)
            fail("Expected ARTIFACT_INVALID for mismatched split versionCode")
        } catch (e: AndroidRunException) {
            assertEquals(AndroidRunErrorCode.ARTIFACT_INVALID, e.error.code)
        }
    }

    @Test
    fun testNonDebuggableApkRejectedWhenDebugRequiredAndAllowedInNoDebug() = runBlocking {
        val apk = createDummyApk("app-release.apk")
        val badging =
            "package: name='com.example.rel' versionCode='1'\nlaunchable-activity: name='com.example.rel.MainActivity'\n"
        val xmlTree = """
            E: manifest
              A: package="com.example.rel"
                E: application
                  E: activity
                    A: android:name="com.example.rel.MainActivity"
                    A: android:exported=true
                      E: intent-filter
                          E: action
                            A: android:name="android.intent.action.MAIN"
                          E: category
                            A: android:name="android.intent.category.LAUNCHER"
        """.trimIndent()
        val inspector = AndroidApkManifestInspector(
            FakeAapt2Runner(mapOf(apk to badging), mapOf(apk to xmlTree))
        )

        try {
            inspector.validateAndResolveLaunch(listOf(apk), listOf("x86_64"), null, requireDebuggable = true)
            fail("Expected NOT_DEBUGGABLE")
        } catch (e: AndroidRunException) {
            assertEquals(AndroidRunErrorCode.NOT_DEBUGGABLE, e.error.code)
        }

        val okNoDebug =
            inspector.validateAndResolveLaunch(listOf(apk), listOf("x86_64"), null, requireDebuggable = false)
        assertFalse(okNoDebug.debuggable)
        assertEquals("com.example.rel", okNoDebug.processName)
    }

    @Test
    fun testMissingAapt2ReportsPrerequisiteMissingAndTextManifestParserWorks() = runBlocking {
        val missingAapt2 = tempFolder.root.toPath().resolve("missing-aapt2")
        val runner = ProcessAapt2Runner(explicitAapt2Path = missingAapt2)
        try {
            runner.resolveAapt2Path()
            fail("Expected PREREQUISITE_MISSING")
        } catch (e: AndroidRunException) {
            assertEquals(AndroidRunErrorCode.PREREQUISITE_MISSING, e.error.code)
        }

        val manifestPath = tempFolder.newFile("AndroidManifest.xml").toPath()
        Files.writeString(
            manifestPath,
            """
            <?xml version="1.0" encoding="utf-8"?>
            <manifest xmlns:android="http://schemas.android.com/apk/res/android"
                package="com.example.textmanifest">
                <application android:label="Text">
                    <activity android:name=".MainActivity" android:exported="true">
                        <intent-filter>
                            <action android:name="android.intent.action.MAIN" />
                            <category android:name="android.intent.category.LAUNCHER" />
                        </intent-filter>
                    </activity>
                </application>
            </manifest>
            """.trimIndent()
        )
        val parsed = AndroidApkManifestInspector(runner).parseTextManifest(manifestPath)
        assertEquals("com.example.textmanifest", parsed.`package`)
        assertEquals("com.example.textmanifest.MainActivity", parsed.launcherActivity?.name)
    }
}
