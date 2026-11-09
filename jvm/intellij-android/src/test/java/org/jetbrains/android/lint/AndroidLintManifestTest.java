package org.jetbrains.android.lint;

import com.android.tools.lint.client.api.LintClient;
import com.android.utils.Pair;
import org.junit.AfterClass;
import org.junit.BeforeClass;
import org.junit.Test;
import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.Node;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.Assert.*;

public class AndroidLintManifestTest {
    private static com.intellij.openapi.Disposable disposable;
    private static com.intellij.core.CoreProjectEnvironment environment;

    @BeforeClass
    public static void setUp() {
        LintClient.setClientName(LintClient.CLIENT_UNIT_TESTS);
        disposable = com.intellij.openapi.util.Disposer.newDisposable();
        var application = new com.intellij.core.CoreApplicationEnvironment(disposable);
        environment = new com.intellij.core.CoreProjectEnvironment(disposable, application);
    }

    @AfterClass
    public static void tearDown() {
        com.intellij.openapi.util.Disposer.dispose(disposable);
    }

    private static class TestLintClient extends LintClient {
        private final AndroidLintXmlParser parser = new AndroidLintXmlParser(this);

        TestLintClient() {
            super(CLIENT_UNIT_TESTS);
        }

        @Override
        public com.android.tools.lint.client.api.XmlParser getXmlParser() {
            return parser;
        }

        @Override
        public com.android.tools.lint.client.api.UastParser getUastParser(com.android.tools.lint.detector.api.Project project) {
            return new com.android.tools.lint.helpers.DefaultUastParser(project, environment.getProject());
        }

        @Override
        public com.android.tools.lint.client.api.GradleVisitor getGradleVisitor() {
            return new com.android.tools.lint.client.api.GradleVisitor();
        }

        @Override
        public com.android.ide.common.resources.ResourceRepository getResources(com.android.tools.lint.detector.api.Project project, com.android.tools.lint.client.api.ResourceRepositoryScope scope) {
            return null;
        }

        @Override
        public void report(com.android.tools.lint.detector.api.Context context, com.android.tools.lint.detector.api.Incident incident, com.android.tools.lint.detector.api.TextFormat format) {
        }

        @Override
        public void log(com.android.tools.lint.detector.api.Severity severity, Throwable error, String format, Object... args) {
        }

        @Override
        public CharSequence readFile(File file) {
            if (file == null) return "";
            try {
                return Files.readString(file.toPath());
            } catch (IOException e) {
                return "";
            }
        }
    }

    @Test
    public void cleanManifestProvidesSourceDomWithoutPretendingMerged() {
        TestLintClient client = new TestLintClient();
        AndroidLintManifest helper = new AndroidLintManifest(null, environment.getProject(), client);

        assertFalse(helper.isValidBuiltSnapshot());

        File srcFile = new File("src/main/AndroidManifest.xml");
        String xml = "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n" +
                "<manifest xmlns:android=\"http://schemas.android.com/apk/res/android\"\n" +
                "    package=\"com.example.app\">\n" +
                "    <application android:debuggable=\"true\"/>\n" +
                "</manifest>";
        Document doc = client.getXmlParser().parseXml(xml, srcFile);
        assertNotNull(doc);

        Document result = helper.getMergedManifest(null, srcFile, doc);
        assertSame(doc, result);
        assertFalse(helper.isMergeManifestNode(doc.getDocumentElement()));
        assertNull(doc.getUserData(LintClient.MERGED_MANIFEST));

        Element app = (Element) doc.getElementsByTagName("application").item(0);
        Pair<File, ? extends Node> source = helper.findManifestSourceNode(app);
        assertNotNull(source);
        assertEquals(srcFile, source.getFirst());
        assertSame(app, source.getSecond());
    }

    @Test
    public void validBuiltSnapshotResolvesMergedManifestAndBlame() throws Exception {
        Path tempDir = Files.createTempDirectory("lint_manifest_test");
        try {
            Path srcDir = tempDir.resolve("src/main");
            Files.createDirectories(srcDir);
            Path srcManifest = srcDir.resolve("AndroidManifest.xml");
            String srcXml = "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n" +
                    "<manifest xmlns:android=\"http://schemas.android.com/apk/res/android\"\n" +
                    "    package=\"com.example.app\">\n" +
                    "    <application android:debuggable=\"true\"/>\n" +
                    "</manifest>";
            Files.writeString(srcManifest, srcXml);

            Thread.sleep(50);

            Path mergedDir = tempDir.resolve("build/intermediates/merged_manifests/debug/processDebugManifest");
            Files.createDirectories(mergedDir);
            Path mergedManifest = mergedDir.resolve("AndroidManifest.xml");
            String mergedXml = "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n" +
                    "<manifest xmlns:android=\"http://schemas.android.com/apk/res/android\"\n" +
                    "    package=\"com.example.app\"\n" +
                    "    android:versionCode=\"1\" >\n" +
                    "    <application\n" +
                    "        android:debuggable=\"true\" />\n" +
                    "</manifest>";
            Files.writeString(mergedManifest, mergedXml);

            Path logDir = tempDir.resolve("build/outputs/logs");
            Files.createDirectories(logDir);
            Path blameReport = logDir.resolve("manifest-merger-debug-report.txt");
            String blameText = "-- Merging decision tree log ---\n" +
                    "manifest\n" +
                    "ADDED from " + srcManifest.toAbsolutePath() + ":2:1-6:12\n" +
                    "application\n" +
                    "ADDED from " + srcManifest.toAbsolutePath() + ":4:5-5:41\n" +
                    "\tandroid:debuggable\n" +
                    "\tADDED from " + srcManifest.toAbsolutePath() + ":4:18-42\n";
            Files.writeString(blameReport, blameText);

            AndroidLintModel model = new AndroidLintModel(null, null, tempDir, tempDir, "debug", null, 34, "android-34", 26, 34, "com.example.app", false, false, null, null, List.of(), List.of(), "fingerprint", "lintXmlFingerprint", null);

            TestLintClient client = new TestLintClient();
            AndroidLintManifest helper = new AndroidLintManifest(model, environment.getProject(), client);

            assertTrue(helper.isValidBuiltSnapshot());
            assertEquals(mergedManifest.toFile(), helper.getMergedManifestFile());
            assertEquals(blameReport.toFile(), helper.getManifestMergeReportFile());

            Document mergedDoc = helper.getMergedManifest(null, null, null);
            assertNotNull(mergedDoc);
            assertTrue(helper.isMergeManifestNode(mergedDoc.getDocumentElement()));
            assertNotNull(mergedDoc.getUserData(LintClient.MERGED_MANIFEST));

            Element appElement = (Element) mergedDoc.getElementsByTagName("application").item(0);
            assertNotNull(appElement);
            assertTrue(helper.isMergeManifestNode(appElement));

            Pair<File, ? extends Node> source = helper.findManifestSourceNode(appElement);
            assertNotNull("Source mapping should succeed via BlameFile", source);
            assertEquals(srcManifest.toFile().getCanonicalPath(), source.getFirst().getCanonicalPath());

            var location = helper.findManifestSourceLocation(appElement);
            assertNotNull(location);
            assertEquals(srcManifest.toFile().getCanonicalPath(), location.getFile().getCanonicalPath());

            // Freshness test: touching the source manifest makes it newer than merged manifest -> invalidates!
            Thread.sleep(50);
            Files.writeString(srcManifest, srcXml + "\n<!-- edited -->");
            assertFalse("Modified source manifest must invalidate merged snapshot", helper.isValidBuiltSnapshot());
        } finally {
            deleteRecursively(tempDir);
        }
    }

    @Test
    public void crlfDoesNotFalselyInvalidateFreshSnapshot() throws Exception {
        Path tempDir = Files.createTempDirectory("lint_manifest_crlf_test");
        try {
            Path srcDir = tempDir.resolve("src/main");
            Files.createDirectories(srcDir);
            Path srcManifest = srcDir.resolve("AndroidManifest.xml");
            // Disk file has CRLF
            Files.writeString(srcManifest, "<manifest package=\"com.example.app\">\r\n<application/>\r\n</manifest>");

            Thread.sleep(50);

            Path mergedDir = tempDir.resolve("build/intermediates/merged_manifests/debug/processDebugManifest");
            Files.createDirectories(mergedDir);
            Path mergedManifest = mergedDir.resolve("AndroidManifest.xml");
            Files.writeString(mergedManifest, "<manifest package=\"com.example.app\">\n<application/>\n</manifest>");

            Path logDir = tempDir.resolve("build/outputs/logs");
            Files.createDirectories(logDir);
            Path blameReport = logDir.resolve("manifest-merger-debug-report.txt");
            Files.writeString(blameReport, "-- Merging decision tree log ---\nmanifest\nADDED from " + srcManifest.toAbsolutePath() + ":1:1\n");

            AndroidLintModel model = new AndroidLintModel(null, null, tempDir, tempDir, "debug", null, 34, "android-34", 26, 34, "com.example.app", false, false, null, null, List.of(), List.of(), "fp", "xmlFp", null);

            // Client returns normalized LF from in-memory document
            TestLintClient client = new TestLintClient() {
                @Override
                public CharSequence readFile(File file) {
                    if (file.equals(srcManifest.toFile())) {
                        return "<manifest package=\"com.example.app\">\n<application/>\n</manifest>";
                    }
                    return super.readFile(file);
                }
            };

            AndroidLintManifest helper = new AndroidLintManifest(model, environment.getProject(), client);
            assertTrue("CRLF vs LF line endings must not trigger false dirty detection",
                    helper.isValidBuiltSnapshot(srcManifest.toFile(), null));
        } finally {
            deleteRecursively(tempDir);
        }
    }

    @Test
    public void nonAgpDecisionLogRejectsBuiltSnapshot() throws Exception {
        Path tempDir = Files.createTempDirectory("lint_manifest_non_agp_log");
        try {
            Path srcDir = tempDir.resolve("src/main");
            Files.createDirectories(srcDir);
            Path srcManifest = srcDir.resolve("AndroidManifest.xml");
            Files.writeString(srcManifest, "<manifest package=\"com.example.app\"/>");

            Thread.sleep(50);

            Path mergedDir = tempDir.resolve("build/intermediates/merged_manifests/debug/processDebugManifest");
            Files.createDirectories(mergedDir);
            Path mergedManifest = mergedDir.resolve("AndroidManifest.xml");
            Files.writeString(mergedManifest, "<manifest package=\"com.example.app\"/>");

            Path logDir = tempDir.resolve("build/outputs/logs");
            Files.createDirectories(logDir);
            Path wrongLog = logDir.resolve("manifest-merger-debug-report.txt");
            // Write a generic XML/log file that is NOT an AGP decision tree log
            Files.writeString(wrongLog, "Some random build summary or resource log without decision tree markers");

            AndroidLintModel model = new AndroidLintModel(null, null, tempDir, tempDir, "debug", null, 34, "android-34", 26, 34, "com.example.app", false, false, null, null, List.of(), List.of(), "fp", "xmlFp", null);

            TestLintClient client = new TestLintClient();
            AndroidLintManifest helper = new AndroidLintManifest(model, environment.getProject(), client);

            assertFalse("Non-AGP decision log must be rejected", helper.isValidBuiltSnapshot());
        } finally {
            deleteRecursively(tempDir);
        }
    }

    @Test
    public void modifiedBuildScriptInvalidatesBuiltSnapshot() throws Exception {
        Path tempDir = Files.createTempDirectory("lint_manifest_build_script_test");
        try {
            Path srcDir = tempDir.resolve("src/main");
            Files.createDirectories(srcDir);
            Path srcManifest = srcDir.resolve("AndroidManifest.xml");
            Files.writeString(srcManifest, "<manifest package=\"com.example.app\"/>");

            Path buildGradle = tempDir.resolve("build.gradle.kts");
            Files.writeString(buildGradle, "android { compileSdk = 34 }");

            Thread.sleep(50);

            Path mergedDir = tempDir.resolve("build/intermediates/merged_manifests/debug/processDebugManifest");
            Files.createDirectories(mergedDir);
            Path mergedManifest = mergedDir.resolve("AndroidManifest.xml");
            Files.writeString(mergedManifest, "<manifest package=\"com.example.app\"/>");

            Path logDir = tempDir.resolve("build/outputs/logs");
            Files.createDirectories(logDir);
            Path blameReport = logDir.resolve("manifest-merger-debug-report.txt");
            Files.writeString(blameReport, "-- Merging decision tree log ---\nmanifest\nADDED from " + srcManifest.toAbsolutePath() + ":1:1\n");

            AndroidLintModel model = new AndroidLintModel(null, null, tempDir, tempDir, "debug", null, 34, "android-34", 26, 34, "com.example.app", false, false, null, null, List.of(), List.of(), "fp", "xmlFp", null);

            TestLintClient client = new TestLintClient();
            AndroidLintManifest helper = new AndroidLintManifest(model, environment.getProject(), client);

            assertTrue(helper.isValidBuiltSnapshot());

            // Modify build.gradle.kts after merged manifest -> must invalidate!
            Thread.sleep(50);
            Files.writeString(buildGradle, "android { compileSdk = 35 }");
            assertFalse("Build script modification must invalidate built snapshot", helper.isValidBuiltSnapshot());
        } finally {
            deleteRecursively(tempDir);
        }
    }

    @Test
    public void openChangedSourcesInvalidateMergedSnapshot() throws Exception {
        Path tempDir = Files.createTempDirectory("lint_manifest_open_changed");
        try {
            Path srcDir = tempDir.resolve("src/main");
            Files.createDirectories(srcDir);
            Path srcManifest = srcDir.resolve("AndroidManifest.xml");
            String srcXml = "<manifest package=\"com.example.app\"/>";
            Files.writeString(srcManifest, srcXml);

            Thread.sleep(50);

            Path mergedDir = tempDir.resolve("build/intermediates/merged_manifests/debug/processDebugManifest");
            Files.createDirectories(mergedDir);
            Path mergedManifest = mergedDir.resolve("AndroidManifest.xml");
            Files.writeString(mergedManifest, "<manifest package=\"com.example.app\"/>");

            Path logDir = tempDir.resolve("build/outputs/logs");
            Files.createDirectories(logDir);
            Path blameReport = logDir.resolve("manifest-merger-debug-report.txt");
            Files.writeString(blameReport, "-- Merging decision tree log ---\nmanifest\nADDED from " + srcManifest.toAbsolutePath() + ":1:1\n");

            AndroidLintModel model = new AndroidLintModel(null, null, tempDir, tempDir, "debug", null, 34, "android-34", 26, 34, "com.example.app", false, false, null, null, List.of(), List.of(), "fingerprint", "lintXmlFingerprint", null);

            // A client simulating open editor with unsaved content differing from disk
            TestLintClient client = new TestLintClient() {
                @Override
                public CharSequence readFile(File file) {
                    if (file.equals(srcManifest.toFile())) {
                        return "<manifest package=\"com.example.app\"><application/></manifest>";
                    }
                    return super.readFile(file);
                }
            };

            AndroidLintManifest helper = new AndroidLintManifest(model, environment.getProject(), client);

            assertFalse("Open changed sources must invalidate merged snapshot",
                    helper.isValidBuiltSnapshot(srcManifest.toFile(), null));

            Document targetDom = client.getXmlParser().parseXml("<manifest package=\"com.example.app\"><application/></manifest>", srcManifest.toFile());
            Document result = helper.getMergedManifest(null, srcManifest.toFile(), targetDom);
            assertSame(targetDom, result);
            assertFalse(helper.isMergeManifestNode(result.getDocumentElement()));
        } finally {
            deleteRecursively(tempDir);
        }
    }

    @Test
    public void mismatchedVariantProvenanceRejectsMergedSnapshot() throws Exception {
        Path tempDir = Files.createTempDirectory("lint_manifest_variant_test");
        try {
            Path srcDir = tempDir.resolve("src/main");
            Files.createDirectories(srcDir);
            Path srcManifest = srcDir.resolve("AndroidManifest.xml");
            Files.writeString(srcManifest, "<manifest package=\"com.example.app\"/>");

            Thread.sleep(50);

            // Artifacts generated only for "debug"
            Path mergedDir = tempDir.resolve("build/intermediates/merged_manifests/debug/processDebugManifest");
            Files.createDirectories(mergedDir);
            Files.writeString(mergedDir.resolve("AndroidManifest.xml"), "<manifest package=\"com.example.app\"/>");

            Path logDir = tempDir.resolve("build/outputs/logs");
            Files.createDirectories(logDir);
            Path blameReport = logDir.resolve("manifest-merger-debug-report.txt");
            Files.writeString(blameReport, "-- Merging decision tree log ---\nmanifest\nADDED from " + srcManifest.toAbsolutePath() + ":1:1\n");

            // Model is configured for variant "release"
            AndroidLintModel releaseModel = new AndroidLintModel(null, null, tempDir, tempDir, "release", null, 34, "android-34", 26, 34, "com.example.app", false, false, null, null, List.of(), List.of(), "fingerprint", "lintXmlFingerprint", null);

            TestLintClient client = new TestLintClient();
            AndroidLintManifest helper = new AndroidLintManifest(releaseModel, environment.getProject(), client);

            assertFalse("Mismatched variant must not accept artifacts of a different variant", helper.isValidBuiltSnapshot());
            assertNull(helper.getMergedManifestFile());
        } finally {
            deleteRecursively(tempDir);
        }
    }

    private static void deleteRecursively(Path path) {
        if (!Files.exists(path)) return;
        try (var stream = Files.walk(path)) {
            stream.sorted((a, b) -> b.compareTo(a)).forEach(p -> {
                try {
                    Files.deleteIfExists(p);
                } catch (IOException ignored) {
                }
            });
        } catch (IOException ignored) {
        }
    }
}
