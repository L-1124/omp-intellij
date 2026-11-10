package org.jetbrains.android.lint;

import com.android.sdklib.AndroidTargetHash;
import com.android.sdklib.AndroidVersion;
import org.codehaus.groovy.ast.ModuleNode;
import org.codehaus.groovy.control.SourceUnit;
import org.jetbrains.android.resource.AndroidLayout;
import org.junit.Test;

import java.io.File;
import java.nio.file.Path;
import java.util.List;
import java.util.Set;

import static org.junit.Assert.*;

public class AndroidGradleModelTest {
    private static com.intellij.openapi.Disposable disposable;
    private static com.intellij.core.CoreProjectEnvironment environment;

    @org.junit.BeforeClass
    public static void createPsiEnvironment() {
        com.android.tools.lint.client.api.LintClient.setClientName(com.android.tools.lint.client.api.LintClient.CLIENT_UNIT_TESTS);
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
    private static AndroidLintModelResolver.CleanAstResult cleanGroovy(String script) {
        return AndroidLintModelResolver.parseCleanGroovyAst(script);
    }

    private static ModuleNode parseGroovyModule(String script) {
        SourceUnit unit = SourceUnit.create("build.gradle", script);
        unit.parse();
        unit.completePhase();
        unit.convert();
        return unit.getAST();
    }

    @Test
    public void groovyCleanModelMatchesKotlinForUnambiguousLiterals() {
        String script = "plugins {\n" +
                "    id 'com.android.application'\n" +
                "}\n" +
                "android {\n" +
                "    compileSdk 34\n" +
                "    namespace 'com.example.groovyapp'\n" +
                "    defaultConfig {\n" +
                "        minSdk 21\n" +
                "        targetSdk 34\n" +
                "    }\n" +
                "}\n";

        var model = cleanGroovy(script);
        assertEquals(Integer.valueOf(21), model.minSdk());
        assertEquals(Integer.valueOf(34), model.targetSdk());
        assertEquals(Integer.valueOf(34), model.compileSdk());
        assertEquals("android-34", model.compileTarget());
        assertEquals("com.example.groovyapp", model.namespace());
        assertEquals(Boolean.FALSE, model.isLibrary());
        assertFalse(model.minSdkPremiseMissing());
        assertFalse(model.minSdkUnsafe());
        assertFalse(model.compileSdkUnsafe());
        assertFalse(model.targetSdkUnsafe());
    }

    @Test
    public void groovyCleanModelHandlesAssignmentSyntaxAndLibraryPlugin() {
        String script = "apply plugin: 'com.android.library'\n" +
                "android {\n" +
                "    compileSdkVersion = 35\n" +
                "    namespace = 'com.example.groovylib'\n" +
                "    defaultConfig {\n" +
                "        minSdkVersion = 24\n" +
                "        targetSdkVersion = 35\n" +
                "    }\n" +
                "}\n";

        var model = cleanGroovy(script);
        assertEquals(Integer.valueOf(24), model.minSdk());
        assertEquals(Integer.valueOf(35), model.targetSdk());
        assertEquals(Integer.valueOf(35), model.compileSdk());
        assertEquals("android-35", model.compileTarget());
        assertEquals("com.example.groovylib", model.namespace());
        assertEquals(Boolean.TRUE, model.isLibrary());
        assertFalse(model.minSdkPremiseMissing());
    }

    @Test
    public void groovyDynamicAssignmentsAreStickyAndNotOverwrittenByLaterLiterals() {
        String script = "android {\n" +
                "    compileSdk = selectedCompileSdk\n" +
                "    compileSdk 34\n" +
                "    defaultConfig {\n" +
                "        minSdk = selectedMin\n" +
                "        minSdk 21\n" +
                "        targetSdk = selectedTarget\n" +
                "        targetSdk 34\n" +
                "    }\n" +
                "}\n";

        var model = cleanGroovy(script);
        assertNull(model.compileSdk());
        assertNull(model.compileTarget());
        assertNull(model.minSdk());
        assertNull(model.targetSdk());
        assertTrue(model.compileSdkUnsafe());
        assertTrue(model.targetSdkUnsafe());
        assertTrue(model.minSdkUnsafe());
        assertTrue(model.minSdkPremiseMissing());
    }

    @Test
    public void groovyPreviewSdkPreservesPreviewTargetWithoutNumericGuess() {
        String script = "android {\n" +
                "    compileSdkPreview 'Baklava'\n" +
                "    defaultConfig {\n" +
                "        minSdk 21\n" +
                "        targetSdkPreview 'Baklava'\n" +
                "    }\n" +
                "}\n";

        var model = cleanGroovy(script);
        assertNull(model.compileSdk());
        assertEquals("android-Baklava", model.compileTarget());
        assertEquals(Integer.valueOf(21), model.minSdk());
        assertNull(model.targetSdk());
        assertTrue(model.targetSdkUnsafe());
    }

    @Test
    public void groovyUntrustedScriptDoesNotExecuteGrabOrTransformations() {
        String script = "@Grab('nonexistent.malicious:dependency:9.9.9')\n" +
                "import nonexistent.malicious.Package\n" +
                "android {\n" +
                "    compileSdk 34\n" +
                "    defaultConfig {\n" +
                "        minSdk 21\n" +
                "    }\n" +
                "}\n";

        var model = cleanGroovy(script);
        assertEquals(Integer.valueOf(34), model.compileSdk());
        assertEquals(Integer.valueOf(21), model.minSdk());
    }

    @Test
    public void groovyLayoutMatchesCustomResourceRootsAndManifest() throws Exception {
        String script = "android {\n" +
                "    namespace 'com.example.customlayout'\n" +
                "    sourceSets {\n" +
                "        main {\n" +
                "            res.srcDirs = ['src/main/res', 'src/custom/res']\n" +
                "            manifest.srcFile 'custom/AndroidManifest.xml'\n" +
                "        }\n" +
                "        debug {\n" +
                "            res.srcDir 'src/debug/res'\n" +
                "        }\n" +
                "    }\n" +
                "}\n";

        Path projectRoot = java.nio.file.Files.createTempDirectory("groovy_layout_custom").toAbsolutePath().normalize();
        try {
            AndroidLayout layout = createLayout(projectRoot, "debug", Set.of("main", "debug"), script);

            assertTrue(layout.android);
            assertEquals("com.example.customlayout", layout.namespace);
            assertTrue(layout.resources.contains(projectRoot.resolve("src/main/res").normalize()));
            assertTrue(layout.resources.contains(projectRoot.resolve("src/custom/res").normalize()));
            assertTrue(layout.resources.contains(projectRoot.resolve("src/debug/res").normalize()));
            assertTrue(layout.manifests.contains(projectRoot.resolve("custom/AndroidManifest.xml").normalize()));
            assertFalse(layout.manifests.contains(projectRoot.resolve("src/main/AndroidManifest.xml").normalize()));
        } finally {
            deleteRecursively(projectRoot);
        }
    }

    @Test
    public void groovyLayoutReplacesResourcesOnSetSrcDirs() throws Exception {
        String script = "android {\n" +
                "    sourceSets {\n" +
                "        getByName('main') {\n" +
                "            res.setSrcDirs(['res-override'])\n" +
                "        }\n" +
                "    }\n" +
                "}\n";

        Path projectRoot = java.nio.file.Files.createTempDirectory("groovy_layout_replace").toAbsolutePath().normalize();
        try {
            AndroidLayout layout = createLayout(projectRoot, null, Set.of("main"), script);

            assertTrue(layout.android);
            assertEquals(Set.of(projectRoot.resolve("res-override").normalize()), layout.resources);
        } finally {
            deleteRecursively(projectRoot);
        }
    }

    @Test
    public void groovyLayoutHandlesBracketAndPropertySourceSets() throws Exception {
        String script = "android {\n" +
                "    sourceSets['main'].res.srcDirs = ['bracket/res']\n" +
                "    sourceSets.debug.res.srcDirs = ['property/res']\n" +
                "}\n";

        Path projectRoot = java.nio.file.Files.createTempDirectory("groovy_layout_bracket").toAbsolutePath().normalize();
        try {
            AndroidLayout layout = createLayout(projectRoot, "debug", Set.of("main", "debug"), script);

            assertTrue(layout.android);
            assertTrue(layout.resources.contains(projectRoot.resolve("bracket/res").normalize()));
            assertTrue(layout.resources.contains(projectRoot.resolve("property/res").normalize()));
        } finally {
            deleteRecursively(projectRoot);
        }
    }

    @Test
    public void groovyLayoutInvalidatesOnDynamicExpressions() throws Exception {
        String script = "android {\n" +
                "    sourceSets {\n" +
                "        main {\n" +
                "            res.srcDirs = dynamicPaths()\n" +
                "        }\n" +
                "    }\n" +
                "}\n";

        Path projectRoot = java.nio.file.Files.createTempDirectory("groovy_layout_dynamic").toAbsolutePath().normalize();
        try {
            AndroidLayout layout = createLayout(projectRoot, null, Set.of("main"), script);

            assertTrue(layout.android);
            assertTrue(layout.resources.isEmpty());
        } finally {
            deleteRecursively(projectRoot);
        }
    }

    private static AndroidLayout createLayout(Path projectRoot, String variant, Set<String> importedSourceSets, String groovyScript) throws Exception {
        java.nio.file.Files.createDirectories(projectRoot);
        java.nio.file.Files.writeString(projectRoot.resolve("build.gradle"), groovyScript);
        var rootVf = new com.intellij.testFramework.LightVirtualFile("module") {
            @Override
            public String getPath() {
                return projectRoot.toString().replace('\\', '/');
            }
        };
        try (var scope = new org.jetbrains.android.resource.AndroidSources.Scope(null, null)) {
            scope.useSavedModelInputs();
            return new AndroidLayout(environment.getProject(), rootVf, variant, importedSourceSets);
        }
    }

    private static void deleteRecursively(Path path) {
        try {
            if (java.nio.file.Files.isDirectory(path)) {
                try (var s = java.nio.file.Files.list(path)) {
                    for (Path p : s.toList()) deleteRecursively(p);
                }
            }
            java.nio.file.Files.deleteIfExists(path);
        } catch (Exception ignored) {
        }
    }
    @Test
    public void androidLintProjectResolvesTargetHashAndBuildSdkWithoutNumericGuess() {
        // Standard platform
        AndroidLintModel standard = createModel(34, "android-34");
        AndroidLintProject standardProject = new AndroidLintProject(null, new File("."), null, standard, null, null);
        assertEquals("android-34", standardProject.getBuildTargetHash());
        assertEquals(34, standardProject.getBuildSdk());

        // Preview platform
        AndroidLintModel preview = createModel(null, "android-Baklava");
        AndroidLintProject previewProject = new AndroidLintProject(null, new File("."), null, preview, null, null);
        assertEquals("android-Baklava", previewProject.getBuildTargetHash());
        AndroidVersion baklavaVersion = AndroidTargetHash.getPlatformVersion("android-Baklava");
        assertNotNull(baklavaVersion);
        assertEquals(baklavaVersion.getFeatureLevel(), previewProject.getBuildSdk());

        // Add-on target
        AndroidLintModel addon = createModel(null, "Google Inc.:Google APIs:34");
        AndroidLintProject addonProject = new AndroidLintProject(null, new File("."), null, addon, null, null);
        assertEquals("Google Inc.:Google APIs:34", addonProject.getBuildTargetHash());
        assertEquals(34, addonProject.getBuildSdk());
    }

    private static AndroidLintModel createModel(Integer compileSdk, String compileTarget) {
        return new AndroidLintModel(
                null, null, null, null, null, null,
                compileSdk, compileTarget, 21, 34, "com.example",
                false, false, null, null,
                List.of(), List.of(), "fp", "xmlfp", null
        );
    }
}
