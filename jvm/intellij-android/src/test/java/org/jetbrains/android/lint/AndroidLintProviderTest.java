package org.jetbrains.android.lint;

import com.android.tools.lint.checks.ApiDetector;
import com.android.tools.lint.client.api.*;
import com.android.tools.lint.detector.api.*;
import com.android.ide.common.resources.ResourceRepository;
import com.jetbrains.lsp.protocol.DiagnosticSeverity;

import java.io.File;
import java.util.EnumSet;
import java.util.List;

import com.intellij.openapi.editor.impl.DocumentImpl;
import com.jetbrains.lsp.protocol.Position;
import com.jetbrains.lsp.protocol.Range;
import org.junit.Test;

import static org.junit.Assert.*;

public class AndroidLintProviderTest {
    private static com.intellij.openapi.Disposable disposable;
    private static com.intellij.core.CoreProjectEnvironment environment;

    @org.junit.BeforeClass
    public static void createPsiEnvironment() {
        LintClient.setClientName(LintClient.CLIENT_UNIT_TESTS);
        disposable = com.intellij.openapi.util.Disposer.newDisposable();
        var application = new com.intellij.core.CoreApplicationEnvironment(disposable);
        application.registerFileType(org.jetbrains.kotlin.idea.KotlinFileType.INSTANCE, "kt;kts");
        application.registerParserDefinition(new org.jetbrains.kotlin.parsing.KotlinParserDefinition());
        environment = new com.intellij.core.CoreProjectEnvironment(disposable, application);
    }

    @org.junit.AfterClass
    public static void disposePsiEnvironment() {
        com.intellij.openapi.util.Disposer.dispose(disposable);
    }

    private static AndroidLintModelResolver.CleanAstResult clean(String script) {
        var file = new org.jetbrains.kotlin.psi.KtPsiFactory(environment.getProject(), false)
                .createFile("build.gradle.kts", script);
        return AndroidLintModelResolver.parseCleanAst(file);
    }

    @Test
    public void cleanModelAcceptsOnlyUnambiguousDecimalLiterals() {
        var model = clean("android { compileSdk = 37; defaultConfig { minSdk = 21; targetSdkVersion(37) } }");
        assertEquals(Integer.valueOf(21), model.minSdk());
        assertEquals(Integer.valueOf(37), model.targetSdk());
        assertEquals(Integer.valueOf(37), model.compileSdk());
        assertFalse(model.minSdkPremiseMissing());
    }

    @Test
    public void cleanModelPreservesMissingPremiseForFlavorsAndBuildTypeOverrides() {
        for (String override : List.of("productFlavors { create(\"demo\") { minSdk = 26 } }",
                "buildTypes { getByName(\"debug\") { minSdkVersion(26) } }")) {
            var model = clean("android { defaultConfig { minSdk = 21 }; " + override + " }");
            assertNull(model.minSdk());
            assertTrue(model.minSdkPremiseMissing());
        }
    }

    @Test
    public void cleanModelDoesNotEvaluateDynamicExpressionsOrInventSdkDefaults() {
        for (String expression : List.of("libs.versions.minSdk.get().toInt()", "20 + 1", "minimumSdk()")) {
            var model = clean("android { defaultConfig { minSdk = " + expression + " } }");
            assertNull(model.minSdk());
            assertNull(model.targetSdk());
            assertTrue(model.minSdkPremiseMissing());
        }
        var empty = clean("android { compileSdk = 37 }");
        assertNull(empty.minSdk());
        assertNull(empty.targetSdk());
        assertTrue(empty.minSdkPremiseMissing());
    }

    @Test
    public void cleanModelRejectsPreviewAndLaterDynamicAssignments() {
        var preview = clean("android { defaultConfig { minSdk = 21; minSdkPreview = \"Future\" } }");
        assertNull(preview.minSdk());
        assertTrue(preview.minSdkPremiseMissing());
        var dynamic = clean("android { compileSdk = 37; compileSdk = selectedCompileSdk; defaultConfig { minSdk = 21; targetSdk = 37; targetSdk = selectedTarget } }");
        assertNull(dynamic.compileSdk());
        assertNull(dynamic.targetSdk());
        assertEquals(Integer.valueOf(21), dynamic.minSdk());
    }

    @Test
    public void cleanModelDoesNotBorrowConfigurationFromNestedProjects() {
        var nested = clean("subprojects { android { defaultConfig { minSdk = 21 } } }");
        assertNull(nested.minSdk());
        assertTrue(nested.minSdkPremiseMissing());
    }

    @Test
    public void rangesUseUtf16OffsetsAndClampAtDocumentEnd() {
        var document = new DocumentImpl("a\uD83D\uDE00z\nnext");
        assertEquals(new Range(new Position(0, 1), new Position(0, 3)),
                AndroidLintProvider.range(document, 1, 3));
        assertEquals(new Range(new Position(0, 3), new Position(1, 4)),
                AndroidLintProvider.range(document, 3, 100));
        assertEquals(new Range(new Position(1, 0), new Position(1, 4)),
                AndroidLintProvider.range(document, 5, 9));
    }

    @Test
    public void invalidOrEmptyRangesDoNotProduceDiagnostics() {
        var document = new DocumentImpl("abc");
        assertNull(AndroidLintProvider.range(document, -1, 2));
        assertNull(AndroidLintProvider.range(document, 1, 1));
        assertNull(AndroidLintProvider.range(document, 2, 1));
        assertNull(AndroidLintProvider.range(document, 3, 8));
    }

    @Test
    public void editorRegistryRetainsNewApiAndRejectsBytecodeOnlyRules() {
        var issues = new AndroidLintIssueRegistry().getIssues();
        assertTrue(issues.contains(ApiDetector.UNSUPPORTED));
        for (Issue issue : issues) {
            var implementation = issue.getImplementation();
            if (implementation.getDetectorClass() == ApiDetector.class) continue;
            EnumSet<Scope> bytecode = EnumSet.of(Scope.CLASS_FILE, Scope.ALL_CLASS_FILES, Scope.JAVA_LIBRARIES);
            if (implementation.getScope().stream().noneMatch(bytecode::contains)) continue;
            assertTrue(issue.getId(), java.util.Arrays.stream(implementation.getAnalysisScopes())
                    .anyMatch(scope -> scope.contains(Scope.JAVA_FILE) && scope.stream().noneMatch(bytecode::contains)));
        }
    }

    @Test
    public void editorScopesRequireAllPrerequisitesOrACompleteAnalysisAlternative() {
        var mixed = new Implementation(TestDetector.class,
                EnumSet.of(Scope.RESOURCE_FILE, Scope.JAVA_FILE));
        var issue = Issue.create("MixedInputs", "Mixed inputs", "Needs both inputs.",
                Category.CORRECTNESS, 5, Severity.WARNING, mixed);
        assertFalse(AndroidLintIssueRegistry.isIssueSupported(issue, Scope.RESOURCE_FILE));
        assertFalse(AndroidLintIssueRegistry.isIssueSupported(issue, Scope.JAVA_FILE));
        var incremental = new Implementation(TestDetector.class,
                EnumSet.of(Scope.RESOURCE_FILE, Scope.JAVA_FILE), EnumSet.of(Scope.RESOURCE_FILE));
        var partial = Issue.create("IncrementalInputs", "Incremental inputs", "Supports a single XML file.",
                Category.CORRECTNESS, 5, Severity.WARNING, incremental);
        assertTrue(AndroidLintIssueRegistry.isIssueSupported(partial, Scope.RESOURCE_FILE));
        assertFalse(AndroidLintIssueRegistry.isIssueSupported(partial, Scope.MANIFEST));
    }

    public static final class TestDetector extends Detector implements XmlScanner {
    }

    @Test
    public void xmlConfigurationAppliesIgnoreAndWarning() {
        LintClient client = new XmlClient();
        File file = new File("lint.xml");
        String ignored = "<lint><issue id=\"NewApi\" severity=\"ignore\"/></lint>";
        Configuration configuration = LintXmlConfiguration.create(client.getConfigurations(), file, ignored);
        assertEquals(Severity.IGNORE, configuration.getSeverity(ApiDetector.UNSUPPORTED));
        String warning = "<lint><issue id=\"NewApi\" severity=\"warning\"/></lint>";
        configuration = LintXmlConfiguration.create(new ConfigurationHierarchy(client, null), file, warning);
        assertEquals(Severity.WARNING, configuration.getSeverity(ApiDetector.UNSUPPORTED));
        var parser = new AndroidLintXmlParser(client);
        var xml = parser.parseXml(warning, file);
        assertNotNull(xml);
        var issue = xml.getElementsByTagName("issue").item(0);
        var location = parser.getLocation(file, issue);
        assertEquals(warning.indexOf("<issue"), location.getStart().getOffset());
        assertEquals(warning.indexOf("/>") + 2, location.getEnd().getOffset());
    }

    @Test
    public void diagnosticMappingPreservesSeverityAndDeduplicatesByRangeCodeAndMessage() {
        var document = new DocumentImpl("abc\nnext");
        var location = com.android.tools.lint.detector.api.Location.create(new File("Main.java"), document.getText(), 4, 8);
        var warning = new Incident(ApiDetector.UNSUPPORTED, "API requires 26", location).overrideSeverity(Severity.WARNING);
        var ignored = new Incident(ApiDetector.UNSUPPORTED, "ignored", location).overrideSeverity(Severity.IGNORE);
        var values = AndroidLintProvider.diagnostics(List.of(warning, ignored, warning), document);
        assertEquals(1, values.size());
        assertEquals(new Range(new Position(1, 0), new Position(1, 4)), values.getFirst().getRange());
        assertEquals(DiagnosticSeverity.Warning, values.getFirst().getSeverity());
        assertEquals("android-lint", values.getFirst().getSource());
        assertEquals("API requires 26", values.getFirst().getMessage());
        assertEquals(kotlinx.serialization.json.JsonElementKt.JsonPrimitive("NewApi"),
                ((kotlinx.serialization.json.JsonObject) values.getFirst().getData()).get("issueId"));
    }

    @Test
    public void registryIsolationDiscardsPartialOutputAndRetainsHealthyIncidents() {
        IssueRegistry healthy = new IssueRegistry() {
            @Override
            public List<Issue> getIssues() {
                return List.of(ApiDetector.UNSUPPORTED);
            }
        };
        IssueRegistry broken = new IssueRegistry() {
            @Override
            public List<Issue> getIssues() {
                throw new NoSuchMethodError("incompatible lint API");
            }
        };
        var location = com.android.tools.lint.detector.api.Location.create(new File("Main.java"), "call", 0, 4);
        var expected = new Incident(ApiDetector.UNSUPPORTED, "requires API 26", location);
        var partial = new java.util.ArrayList<Incident>();
        var incidents = AndroidLintClient.runWithIsolation(List.of(healthy, broken), registry -> {
            partial.clear();
            partial.add(expected);
            registry.getIssues();
            return List.copyOf(partial);
        });
        assertEquals(List.of(expected), incidents);
    }

    @Test
    public void registryIsolationPropagatesCancellationWithoutRetry() {
        var canceled = new java.util.concurrent.CancellationException("request canceled");
        var attempts = new java.util.concurrent.atomic.AtomicInteger();
        var registry = new AndroidLintIssueRegistry();
        var result = assertThrows(java.util.concurrent.CancellationException.class,
                () -> AndroidLintClient.runWithIsolation(List.of(registry), ignored -> {
                    attempts.incrementAndGet();
                    throw canceled;
                }));
        assertSame(canceled, result);
        assertEquals(1, attempts.get());
    }

    private static final class XmlClient extends LintClient {
        XmlClient() {
            super(CLIENT_UNIT_TESTS);
        }

        @Override
        public XmlParser getXmlParser() {
            return new AndroidLintXmlParser(this);
        }

        @Override
        public CharSequence readFile(File file) {
            throw new AssertionError(file);
        }

        @Override
        public void report(Context context, Incident incident, TextFormat format) {
            throw new AssertionError(incident);
        }

        @Override
        public void log(Severity severity, Throwable error, String format, Object... args) {
            throw new AssertionError(format, error);
        }

        @Override
        public UastParser getUastParser(com.android.tools.lint.detector.api.Project project) {
            throw new AssertionError();
        }

        @Override
        public GradleVisitor getGradleVisitor() {
            throw new AssertionError();
        }

        @Override
        public ResourceRepository getResources(com.android.tools.lint.detector.api.Project project, ResourceRepositoryScope scope) {
            throw new AssertionError();
        }
    }
}
