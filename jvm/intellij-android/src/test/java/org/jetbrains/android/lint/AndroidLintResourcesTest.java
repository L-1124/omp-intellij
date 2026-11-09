package org.jetbrains.android.lint;

import com.android.ide.common.rendering.api.ResourceNamespace;
import com.android.ide.common.rendering.api.ResourceValue;
import com.android.ide.common.rendering.api.StyleItemResourceValue;
import com.android.ide.common.rendering.api.StyleResourceValue;
import com.android.ide.common.resources.ResourceItem;
import com.android.ide.common.resources.ResourceRepository;
import com.android.ide.common.resources.configuration.FolderConfiguration;
import com.android.ide.common.util.PathString;
import com.android.resources.ResourceFolderType;
import com.android.resources.ResourceType;
import com.android.tools.lint.client.api.ResourceRepositoryScope;
import com.android.tools.lint.detector.api.Scope;
import org.jetbrains.android.context.AndroidQueryException;
import org.junit.Test;

import java.io.File;
import java.nio.file.Path;
import java.util.Collection;
import java.util.List;

import static org.junit.Assert.*;

public class AndroidLintResourcesTest {

    @Test
    public void folderTypeMatchesFolderNames() {
        assertEquals(ResourceFolderType.LAYOUT, AndroidLintResources.folderType(Path.of("src/main/res/layout/activity_main.xml")));
        assertEquals(ResourceFolderType.LAYOUT, AndroidLintResources.folderType(Path.of("src/main/res/layout-sw600dp/activity_main.xml")));
        assertEquals(ResourceFolderType.VALUES, AndroidLintResources.folderType(Path.of("src/main/res/values/strings.xml")));
        assertEquals(ResourceFolderType.VALUES, AndroidLintResources.folderType(Path.of("src/main/res/values-v21/styles.xml")));
        assertEquals(ResourceFolderType.DRAWABLE, AndroidLintResources.folderType(Path.of("src/main/res/drawable-hdpi/icon.png")));
        assertNull(AndroidLintResources.folderType(Path.of("src/main/res/unknown-folder/file.xml")));
    }

    @Test
    public void scopeDistinguishesManifestsAndResourcesAndRejectsInvalidPaths() {
        Path moduleRoot = Path.of("/app").toAbsolutePath().normalize();
        Path mainRes = moduleRoot.resolve("src/main/res");
        Path mainMf = moduleRoot.resolve("src/main/AndroidManifest.xml");
        Path customMf = moduleRoot.resolve("src/custom/AndroidManifest.xml");

        var inputs = new AndroidLintResources.Inputs(
                List.of(mainRes),
                List.of(mainMf, customMf),
                null,
                null,
                "test-fingerprint",
                true
        );

        AndroidLintModel model = new AndroidLintModel(
                null, null, moduleRoot, moduleRoot, "debug", null, 34, "android-34",
                21, 34, "com.example.app", false, false, null, null,
                List.of(), List.of(), "model-fp", "lint-fp", inputs
        );

        assertEquals(Scope.MANIFEST, AndroidLintResources.scope(model, mainMf));
        assertEquals(Scope.MANIFEST, AndroidLintResources.scope(model, customMf));

        Path layoutXml = mainRes.resolve("layout/activity_main.xml");
        assertEquals(Scope.RESOURCE_FILE, AndroidLintResources.scope(model, layoutXml));

        Path valuesXml = mainRes.resolve("values/strings.xml");
        assertEquals(Scope.RESOURCE_FILE, AndroidLintResources.scope(model, valuesXml));

        Path layoutPng = mainRes.resolve("layout/image.png");
        assertNull(AndroidLintResources.scope(model, layoutPng));

        Path nestedXml = mainRes.resolve("layout/nested/item.xml");
        assertNull(AndroidLintResources.scope(model, nestedXml));

        Path buildMf = moduleRoot.resolve("build/intermediates/merged_manifests/AndroidManifest.xml");
        assertNull(AndroidLintResources.scope(model, buildMf));

        Path outsideXml = Path.of("/other/res/layout/activity_main.xml");
        assertNull(AndroidLintResources.scope(model, outsideXml));
    }

    @Test
    public void repositoryPrecedenceRetainsVariantOverMainForSameConfig() {
        var repo = new AndroidLintResources.LintResourceRepository(
                ResourceNamespace.fromPackageName("com.example.app"),
                "com.example.app"
        );

        FolderConfiguration defaultConfig = FolderConfiguration.createDefault();
        ResourceNamespace ns = ResourceNamespace.fromPackageName("com.example.app");

        // Variant item added first (higher precedence)
        var variantValue = new com.android.ide.common.rendering.api.ResourceValueImpl(ns, ResourceType.STRING, "app_name", "Variant App", null);
        var variantItem = new AndroidLintResources.LintResourceItem(
                "app_name", ResourceType.STRING, ns, null, defaultConfig, variantValue, new PathString("/app/src/debug/res/values/strings.xml"), false, true
        );
        repo.add(variantItem);

        // Main item added second (lower precedence)
        var mainValue = new com.android.ide.common.rendering.api.ResourceValueImpl(ns, ResourceType.STRING, "app_name", "Main App", null);
        var mainItem = new AndroidLintResources.LintResourceItem(
                "app_name", ResourceType.STRING, ns, null, defaultConfig, mainValue, new PathString("/app/src/main/res/values/strings.xml"), false, true
        );
        repo.add(mainItem);

        List<ResourceItem> items = repo.getResources(ns, ResourceType.STRING, "app_name");
        assertEquals(1, items.size());
        assertEquals("Variant App", items.get(0).getResourceValue().getValue());

        List<ResourceItem> autoItems = repo.getResources(ResourceNamespace.RES_AUTO, ResourceType.STRING, "app_name");
        assertEquals(1, autoItems.size());
        assertEquals("Variant App", autoItems.get(0).getResourceValue().getValue());
    }

    @Test
    public void repositoryPreservesDistinctConfigurations() {
        var repo = new AndroidLintResources.LintResourceRepository(
                ResourceNamespace.fromPackageName("com.example.app"),
                "com.example.app"
        );

        ResourceNamespace ns = ResourceNamespace.fromPackageName("com.example.app");
        FolderConfiguration defaultConfig = FolderConfiguration.createDefault();
        FolderConfiguration esConfig = FolderConfiguration.getConfigForFolder("values-es");

        var defaultValue = new com.android.ide.common.rendering.api.ResourceValueImpl(ns, ResourceType.STRING, "greeting", "Hello", null);
        repo.add(new AndroidLintResources.LintResourceItem("greeting", ResourceType.STRING, ns, null, defaultConfig, defaultValue, new PathString("/app/res/values/strings.xml"), false, true));

        var esValue = new com.android.ide.common.rendering.api.ResourceValueImpl(ns, ResourceType.STRING, "greeting", "Hola", null);
        repo.add(new AndroidLintResources.LintResourceItem("greeting", ResourceType.STRING, ns, null, esConfig, esValue, new PathString("/app/res/values-es/strings.xml"), false, true));

        List<ResourceItem> items = repo.getResources(ns, ResourceType.STRING, "greeting");
        assertEquals(2, items.size());
    }

    @Test
    public void repositorySupportsStyleItemsAndNamespaceAliases() {
        var repo = new AndroidLintResources.LintResourceRepository(
                ResourceNamespace.fromPackageName("com.example.app"),
                "com.example.app"
        );

        ResourceNamespace ns = ResourceNamespace.fromPackageName("com.example.app");
        var style = new com.android.ide.common.rendering.api.StyleResourceValueImpl(ns, "AppTheme", "Theme.AppCompat", null);
        style.addItem(new com.android.ide.common.rendering.api.StyleItemResourceValueImpl(ResourceNamespace.ANDROID, "windowNoTitle", "true", null));
        style.addItem(new com.android.ide.common.rendering.api.StyleItemResourceValueImpl(ResourceNamespace.RES_AUTO, "colorPrimary", "#123456", null));

        repo.add(new AndroidLintResources.LintResourceItem("AppTheme", ResourceType.STYLE, ns, null, FolderConfiguration.createDefault(), style, new PathString("/app/res/values/styles.xml"), false, true));

        List<ResourceItem> items = repo.getResources(ns, ResourceType.STYLE, "AppTheme");
        assertEquals(1, items.size());

        StyleResourceValue retrieved = (StyleResourceValue) items.get(0).getResourceValue();
        assertEquals("Theme.AppCompat", retrieved.getParentStyleName());

        StyleItemResourceValue androidItem = retrieved.getItem(ResourceNamespace.ANDROID, "windowNoTitle");
        assertNotNull(androidItem);
        assertEquals("true", androidItem.getValue());

        StyleItemResourceValue customItem = retrieved.getItem(ResourceNamespace.RES_AUTO, "colorPrimary");
        assertNotNull(customItem);
        assertEquals("#123456", customItem.getValue());
    }

    @Test
    public void publicResourcesDistinguishesPublicFromPrivate() {
        var repo = new AndroidLintResources.LintResourceRepository(
                ResourceNamespace.fromPackageName("com.example.lib"),
                "com.example.lib"
        );
        ResourceNamespace ns = ResourceNamespace.fromPackageName("com.example.lib");

        var pubVal = new com.android.ide.common.rendering.api.ResourceValueImpl(ns, ResourceType.STRING, "public_string", "Public", null);
        repo.add(new AndroidLintResources.LintResourceItem("public_string", ResourceType.STRING, ns, "lib", FolderConfiguration.createDefault(), pubVal, new PathString("/lib/res/values/strings.xml"), false, true));

        var privVal = new com.android.ide.common.rendering.api.ResourceValueImpl(ns, ResourceType.STRING, "private_string", "Private", null);
        repo.add(new AndroidLintResources.LintResourceItem("private_string", ResourceType.STRING, ns, "lib", FolderConfiguration.createDefault(), privVal, new PathString("/lib/res/values/strings.xml"), false, false));

        Collection<ResourceItem> publicOnly = repo.getPublicResources(ns, ResourceType.STRING);
        assertEquals(1, publicOnly.size());
        assertEquals("public_string", publicOnly.iterator().next().getName());
        var all = repo.getResources(ns, ResourceType.STRING);
        assertEquals(2, all.size());
    }

    @Test(expected = AndroidQueryException.class)
    public void getRepositoryThrowsWhenModelInputsIncomplete() {
        Path root = Path.of("/app").toAbsolutePath().normalize();
        var incompleteInputs = new AndroidLintResources.Inputs(
                List.of(root.resolve("src/main/res")),
                List.of(root.resolve("src/main/AndroidManifest.xml")),
                null,
                null,
                "fingerprint",
                false // incomplete
        );

        AndroidLintModel model = new AndroidLintModel(
                null, null, root, root, "debug", null, 34, "android-34",
                null, 34, null, false, true, null, null,
                List.of(), List.of(), "fp", "lint-fp", incompleteInputs
        );

        AndroidLintResources.getRepository(model, ResourceRepositoryScope.PROJECT_ONLY);
    }
}
