package org.jetbrains.android.lint;

import com.android.tools.lint.checks.ApiDetector;
import com.android.tools.lint.client.api.Configuration;
import com.android.tools.lint.client.api.LintClient;
import com.android.tools.lint.detector.api.*;
import com.android.tools.lint.model.LintModelLintOptions;
import com.android.tools.lint.model.LintModelModule;
import org.jetbrains.android.resource.AndroidSources;
import org.junit.BeforeClass;
import org.junit.Test;

import java.io.File;
import java.io.IOException;
import java.lang.reflect.Proxy;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.EnumSet;
import java.util.List;
import java.util.Set;

import static org.junit.Assert.*;

public class AndroidLintConfigurationTest {

    private static final Issue TEST_ISSUE = Issue.create(
            "CustomCheck",
            "Custom check summary",
            "Custom check explanation",
            Category.CORRECTNESS,
            5,
            Severity.WARNING,
            new Implementation(Detector.class, EnumSet.of(Scope.RESOURCE_FILE))
    );

    @BeforeClass
    public static void setUp() {
        LintClient.setClientName(LintClient.CLIENT_UNIT_TESTS);
    }


    @Test
    public void intermediateLintXmlAffectsSeverityWhenRootDoesNotConfigureIssue() throws Exception {
        Path tempDir = Files.createTempDirectory("lint_config_inter_test");
        try (var scope = new AndroidSources.Scope(null, null)) {
            Path projectRoot = tempDir.resolve("project");
            Path intermediateDir = projectRoot.resolve("features");
            Path moduleDir = intermediateDir.resolve("chat");
            Files.createDirectories(moduleDir);

            Files.writeString(projectRoot.resolve("lint.xml"), "<lint></lint>");
            Files.writeString(intermediateDir.resolve("lint.xml"),
                    "<lint><issue id=\"NewApi\" severity=\"warning\"/></lint>");

            AndroidLintModel model = createModel(projectRoot, moduleDir, null);
            AndroidLintClient client = new AndroidLintClient(model, null, null, null);
            AndroidLintProject project = new AndroidLintProject(client, moduleDir.toFile(), null, model, null, null);

            Configuration config = client.getConfiguration(project, null);
            assertNotNull(config);
            assertEquals(Severity.WARNING, config.getSeverity(ApiDetector.UNSUPPORTED));
            assertTrue(config.isEnabled(ApiDetector.UNSUPPORTED));
        } finally {
            deleteRecursively(tempDir);
        }
    }

    @Test
    public void nearerModuleOverridesIntermediateAndRootConfigurations() throws Exception {
        Path tempDir = Files.createTempDirectory("lint_config_override_test");
        try (var scope = new AndroidSources.Scope(null, null)) {
            Path projectRoot = tempDir.resolve("project");
            Path intermediateDir = projectRoot.resolve("features");
            Path moduleDir = intermediateDir.resolve("chat");
            Files.createDirectories(moduleDir);

            Files.writeString(projectRoot.resolve("lint.xml"),
                    "<lint><issue id=\"NewApi\" severity=\"warning\"/><issue id=\"CustomCheck\" severity=\"warning\"/></lint>");
            Files.writeString(intermediateDir.resolve("lint.xml"),
                    "<lint><issue id=\"NewApi\" severity=\"error\"/><issue id=\"CustomCheck\" severity=\"error\"/></lint>");
            Files.writeString(moduleDir.resolve("lint.xml"),
                    "<lint><issue id=\"NewApi\" severity=\"ignore\"/></lint>");

            AndroidLintModel model = createModel(projectRoot, moduleDir, null);
            AndroidLintClient client = new AndroidLintClient(model, null, null, null);
            AndroidLintProject project = new AndroidLintProject(client, moduleDir.toFile(), null, model, null, null);

            Configuration config = client.getConfiguration(project, null);
            assertNotNull(config);

            // Module specifies 'ignore' -> overrides intermediate 'error' and root 'warning'
            assertEquals(Severity.IGNORE, config.getSeverity(ApiDetector.UNSUPPORTED));
            assertFalse(config.isEnabled(ApiDetector.UNSUPPORTED));

            // Module does not configure CustomCheck -> intermediate 'error' overrides root 'warning'
            assertEquals(Severity.ERROR, config.getSeverity(TEST_ISSUE));
            assertTrue(config.isEnabled(TEST_ISSUE));
        } finally {
            deleteRecursively(tempDir);
        }
    }

    @Test
    public void unchangedGradleLintOptionsPreservePrecedenceOverCascadedXml() throws Exception {
        Path tempDir = Files.createTempDirectory("lint_config_gradle_test");
        try (var scope = new AndroidSources.Scope(null, null)) {
            Path projectRoot = tempDir.resolve("project");
            Path intermediateDir = projectRoot.resolve("features");
            Path moduleDir = intermediateDir.resolve("chat");
            Files.createDirectories(moduleDir);

            Files.writeString(intermediateDir.resolve("lint.xml"),
                    "<lint><issue id=\"NewApi\" severity=\"error\"/></lint>");
            Files.writeString(moduleDir.resolve("lint.xml"),
                    "<lint><issue id=\"NewApi\" severity=\"error\"/></lint>");

            LintModelLintOptions lintOptions = createLintOptions(Set.of("NewApi"), Set.of());
            LintModelModule buildModule = createBuildModule(moduleDir.toFile(), lintOptions);

            AndroidLintModel model = createModel(projectRoot, moduleDir, buildModule);
            AndroidLintClient client = new AndroidLintClient(model, null, null, null);
            AndroidLintProject project = new AndroidLintProject(client, moduleDir.toFile(), null, model, buildModule, null);

            Configuration config = client.getConfiguration(project, null);
            assertNotNull(config);

            // Gradle lintOptions disables NewApi -> takes precedence over module & intermediate error
            assertEquals(Severity.IGNORE, config.getSeverity(ApiDetector.UNSUPPORTED));
            assertFalse(config.isEnabled(ApiDetector.UNSUPPORTED));
        } finally {
            deleteRecursively(tempDir);
        }
    }

    @Test
    public void creatingIntermediateConfigurationInvalidatesTheReadSnapshot() throws Exception {
        Path tempDir = Files.createTempDirectory("lint_config_disk_absent_test");
        try {
            Path projectRoot = tempDir.resolve("project");
            Path intermediateDir = projectRoot.resolve("features");
            Path moduleDir = intermediateDir.resolve("chat");
            Files.createDirectories(moduleDir);

            // Neither root nor intermediate nor module has lint.xml initially
            try (var scope = new AndroidSources.Scope(null, null)) {
                AndroidLintModel model = createModel(projectRoot, moduleDir, null);
                AndroidLintClient client = new AndroidLintClient(model, null, null, null);
                AndroidLintProject project = new AndroidLintProject(client, moduleDir.toFile(), null, model, null, null);

                client.getConfiguration(project, null);
                scope.verify();
                Files.writeString(intermediateDir.resolve("lint.xml"),
                        "<lint><issue id=\"NewApi\" severity=\"ignore\"/></lint>");
                assertThrows(org.jetbrains.android.context.AndroidQueryException.class, scope::verify);
            }
        } finally {
            deleteRecursively(tempDir);
        }
    }

    private static AndroidLintModel createModel(Path projectRoot, Path moduleRoot, LintModelModule buildModule) {
        return new AndroidLintModel(
                null,
                null,
                moduleRoot,
                projectRoot,
                "debug",
                null,
                34,
                "android-34",
                21,
                34,
                "com.example.test",
                false,
                false,
                buildModule,
                null,
                List.of(),
                List.of(),
                "test-fingerprint",
                "test-xml-fingerprint",
                null
        );
    }

    private static LintModelLintOptions createLintOptions(Set<String> disable, Set<String> enable) {
        return (LintModelLintOptions) Proxy.newProxyInstance(
                LintModelLintOptions.class.getClassLoader(),
                new Class<?>[]{LintModelLintOptions.class},
                (proxy, method, args) -> {
                    String name = method.getName();
                    if ("getDisable".equals(name)) return disable;
                    if ("getEnable".equals(name)) return enable;
                    if ("getCheck".equals(name)) return null;
                    if ("getSeverityOverrides".equals(name)) return null;
                    if ("hashCode".equals(name)) return System.identityHashCode(proxy);
                    if ("equals".equals(name)) return proxy == (args != null && args.length > 0 ? args[0] : null);
                    if ("toString".equals(name)) return "ProxyLintOptions";
                    if (method.getReturnType().equals(boolean.class)) return false;
                    return null;
                }
        );
    }

    private static LintModelModule createBuildModule(File dir, LintModelLintOptions lintOptions) {
        return (LintModelModule) Proxy.newProxyInstance(
                LintModelModule.class.getClassLoader(),
                new Class<?>[]{LintModelModule.class},
                (proxy, method, args) -> {
                    String name = method.getName();
                    if ("getLintOptions".equals(name)) return lintOptions;
                    if ("getDir".equals(name)) return dir;
                    if ("hashCode".equals(name)) return System.identityHashCode(proxy);
                    if ("equals".equals(name)) return proxy == (args != null && args.length > 0 ? args[0] : null);
                    if ("toString".equals(name)) return "ProxyBuildModule";
                    return null;
                }
        );
    }

    private static void deleteRecursively(Path path) {
        if (!Files.exists(path)) return;
        try (var stream = Files.walk(path)) {
            stream.sorted(java.util.Comparator.reverseOrder()).forEach(p -> {
                try {
                    Files.deleteIfExists(p);
                } catch (IOException ignored) {
                }
            });
        } catch (IOException ignored) {
        }
    }
}
