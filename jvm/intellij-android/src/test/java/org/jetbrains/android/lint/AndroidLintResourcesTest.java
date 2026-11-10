package org.jetbrains.android.lint;

import com.android.ide.common.rendering.api.AttrResourceValue;
import com.android.ide.common.rendering.api.AttributeFormat;
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
import com.intellij.core.CoreApplicationEnvironment;
import com.intellij.core.CoreProjectEnvironment;
import com.intellij.ide.highlighter.XmlFileType;
import com.intellij.lang.xml.XMLLanguage;
import com.intellij.lang.xml.XMLParserDefinition;
import com.intellij.openapi.module.Module;
import com.intellij.openapi.Disposable;
import com.intellij.openapi.util.Disposer;
import com.intellij.psi.PsiManager;
import com.intellij.psi.SingleRootFileViewProvider;
import com.intellij.psi.xml.XmlFile;
import com.intellij.testFramework.LightVirtualFile;
import org.junit.AfterClass;
import org.junit.BeforeClass;
import org.junit.Test;

import java.io.File;
import java.nio.file.Path;
import java.util.Collection;
import java.util.List;
import java.lang.reflect.Proxy;

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

    private static Disposable disposable;
    private static CoreProjectEnvironment environment;

    @BeforeClass
    public static void setUp() {
        disposable = Disposer.newDisposable();
        CoreApplicationEnvironment application = new CoreApplicationEnvironment(disposable);
        application.registerFileType(XmlFileType.INSTANCE, "xml");
        application.registerParserDefinition(new XMLParserDefinition());
        application.registerApplicationService(
                com.intellij.platform.syntax.psi.PsiSyntaxBuilderFactory.class,
                new com.intellij.platform.syntax.psi.PsiSyntaxBuilderFactoryImpl());
        CoreApplicationEnvironment.registerApplicationExtensionPoint(
                com.intellij.openapi.extensions.ExtensionPointName.create("com.intellij.metaLanguage"),
                com.intellij.lang.MetaLanguage.class);
        application.addExplicitExtension(com.intellij.platform.syntax.psi.ElementTypeConverters.getInstance(),
                XMLLanguage.INSTANCE, new com.intellij.psi.xml.XmlElementTypeConverterExtension());
        application.addExplicitExtension(com.intellij.platform.syntax.psi.LanguageSyntaxDefinitions.getINSTANCE(),
                XMLLanguage.INSTANCE, new com.intellij.lang.xml.XmlSyntaxDefinitionExtension());
        application.addExplicitExtension(com.intellij.lang.LanguageASTFactory.INSTANCE,
                XMLLanguage.INSTANCE, new com.intellij.lang.xml.XmlASTFactory());

        environment = new CoreProjectEnvironment(disposable, application);
    }

    @AfterClass
    public static void tearDown() {
        Disposer.dispose(disposable);
    }

    private static XmlFile createXmlFile(String name, String content) {
        LightVirtualFile virtualFile = new LightVirtualFile(name, XmlFileType.INSTANCE, content);
        SingleRootFileViewProvider.doNotCheckFileSizeLimit(virtualFile);
        SingleRootFileViewProvider provider = new SingleRootFileViewProvider(
                PsiManager.getInstance(environment.getProject()), virtualFile, false, XmlFileType.INSTANCE);
        return (XmlFile) provider.getPsi(XMLLanguage.INSTANCE);
    }

    private static Module createLightModule() {
        return (Module) Proxy.newProxyInstance(
                Module.class.getClassLoader(),
                new Class<?>[]{Module.class},
                (proxy, method, args) -> {
                    if ("getProject".equals(method.getName())) return environment.getProject();
                    if ("getName".equals(method.getName())) return "app";
                    if ("isDisposed".equals(method.getName())) return false;
                    return null;
                }
        );
    }

    @Test
    public void valuesXmlParsesEscapedStringsAndCdata() {
        Path root = Path.of("/app").toAbsolutePath().normalize();
        Path resDir = root.resolve("src/main/res");
        Path stringsXmlPath = resDir.resolve("values/strings.xml");

        String xmlContent = """
                <resources>
                  <string name="escaped_str">Line 1\\nLine 2\\tTab \\'quote\\' \\"double\\"</string>
                  <string name="quoted_str">"  leading and trailing  "</string>
                  <string name="unicode_str">Unicode \\u0041\\u0042</string>
                  <string name="entities_str">&lt;b&gt;Bold&lt;/b&gt; &amp; &quot;quote&quot;</string>
                  <string name="cdata_str"><![CDATA[<b>CDATA Content</b> & raw]]></string>
                  <string name="formatted_str">Hello %1$s, count %2$d</string>
                  <string name="ref_str">@string/other_str</string>
                  <string-array name="item_list">
                    <item>First\\nItem</item>
                    <item>" Second Item "</item>
                  </string-array>
                </resources>
                """;

        XmlFile xmlFile = createXmlFile("strings.xml", xmlContent);
        var inputs = new AndroidLintResources.Inputs(
                List.of(resDir),
                List.of(root.resolve("src/main/AndroidManifest.xml")),
                null,
                null,
                "fp-values-strings",
                true
        );
        AndroidLintModel model = new AndroidLintModel(
                createLightModule(), null, root, root, "debug", null, 34, "android-34",
                21, 34, "com.example.app", false, false, null, null,
                List.of(), List.of(), "model-fp", "lint-fp", inputs
        );

        ResourceRepository repo = AndroidLintResources.getRepository(model, ResourceRepositoryScope.PROJECT_ONLY, stringsXmlPath, xmlFile);
        ResourceNamespace ns = ResourceNamespace.fromPackageName("com.example.app");

        List<ResourceItem> escapedItems = repo.getResources(ns, ResourceType.STRING, "escaped_str");
        assertEquals(1, escapedItems.size());
        assertEquals("Line 1\nLine 2\tTab 'quote' \"double\"", escapedItems.get(0).getResourceValue().getValue());

        List<ResourceItem> quotedItems = repo.getResources(ns, ResourceType.STRING, "quoted_str");
        assertEquals("  leading and trailing  ", quotedItems.get(0).getResourceValue().getValue());

        List<ResourceItem> unicodeItems = repo.getResources(ns, ResourceType.STRING, "unicode_str");
        assertEquals("Unicode AB", unicodeItems.get(0).getResourceValue().getValue());

        List<ResourceItem> entitiesItems = repo.getResources(ns, ResourceType.STRING, "entities_str");
        assertEquals("<b>Bold</b> & \"quote\"", entitiesItems.get(0).getResourceValue().getValue());

        List<ResourceItem> cdataItems = repo.getResources(ns, ResourceType.STRING, "cdata_str");
        assertEquals("<b>CDATA Content</b> & raw", cdataItems.get(0).getResourceValue().getValue());

        List<ResourceItem> formattedItems = repo.getResources(ns, ResourceType.STRING, "formatted_str");
        assertEquals("Hello %1$s, count %2$d", formattedItems.get(0).getResourceValue().getValue());

        List<ResourceItem> refItems = repo.getResources(ns, ResourceType.STRING, "ref_str");
        assertEquals("@string/other_str", refItems.get(0).getResourceValue().getValue());

        List<ResourceItem> arrayItems = repo.getResources(ns, ResourceType.ARRAY, "item_list");
        assertEquals(1, arrayItems.size());
        var arrayVal = (com.android.ide.common.rendering.api.ArrayResourceValue) arrayItems.get(0).getResourceValue();
        assertEquals(2, arrayVal.getElementCount());
        assertEquals("First\nItem", arrayVal.getElement(0));
        assertEquals(" Second Item ", arrayVal.getElement(1));
    }

    @Test
    public void valuesXmlParsesAttrFormatsAndEnumFlagMetadata() {
        Path root = Path.of("/app").toAbsolutePath().normalize();
        Path resDir = root.resolve("src/main/res");
        Path attrsXmlPath = resDir.resolve("values/attrs.xml");

        String xmlContent = """
                <resources>
                  <attr name="customColor" format="reference|color" />
                  <attr name="gravity">
                    <flag name="top" value="0x01" />
                    <flag name="bottom" value="0x02" />
                    <flag name="fill" value="0x80000000" />
                  </attr>
                  <attr name="alignment">
                    <enum name="left" value="1" />
                    <enum name="right" value="2" />
                  </attr>
                  <declare-styleable name="CustomView">
                    <attr name="customColor" />
                    <attr name="mode" format="enum">
                      <enum name="auto" value="0" />
                      <enum name="manual" value="1" />
                    </attr>
                  </declare-styleable>
                </resources>
                """;

        XmlFile xmlFile = createXmlFile("attrs.xml", xmlContent);
        var inputs = new AndroidLintResources.Inputs(
                List.of(resDir),
                List.of(root.resolve("src/main/AndroidManifest.xml")),
                null,
                null,
                "fp-values-attrs",
                true
        );
        AndroidLintModel model = new AndroidLintModel(
                createLightModule(), null, root, root, "debug", null, 34, "android-34",
                21, 34, "com.example.app", false, false, null, null,
                List.of(), List.of(), "model-fp", "lint-fp", inputs
        );

        ResourceRepository repo = AndroidLintResources.getRepository(model, ResourceRepositoryScope.PROJECT_ONLY, attrsXmlPath, xmlFile);
        ResourceNamespace ns = ResourceNamespace.fromPackageName("com.example.app");

        List<ResourceItem> customColorItems = repo.getResources(ns, ResourceType.ATTR, "customColor");
        assertEquals(1, customColorItems.size());
        AttrResourceValue customColor = (AttrResourceValue) customColorItems.get(0).getResourceValue();
        assertTrue(customColor.getFormats().contains(AttributeFormat.COLOR));
        assertTrue(customColor.getFormats().contains(AttributeFormat.REFERENCE));

        List<ResourceItem> gravityItems = repo.getResources(ns, ResourceType.ATTR, "gravity");
        assertEquals(1, gravityItems.size());
        AttrResourceValue gravity = (AttrResourceValue) gravityItems.get(0).getResourceValue();
        assertTrue(gravity.getFormats().contains(AttributeFormat.FLAGS));
        assertEquals(Integer.valueOf(1), gravity.getAttributeValues().get("top"));
        assertEquals(Integer.valueOf(2), gravity.getAttributeValues().get("bottom"));
        assertEquals(Integer.valueOf(-2147483648), gravity.getAttributeValues().get("fill"));

        List<ResourceItem> alignmentItems = repo.getResources(ns, ResourceType.ATTR, "alignment");
        assertEquals(1, alignmentItems.size());
        AttrResourceValue alignment = (AttrResourceValue) alignmentItems.get(0).getResourceValue();
        assertTrue(alignment.getFormats().contains(AttributeFormat.ENUM));
        assertEquals(Integer.valueOf(1), alignment.getAttributeValues().get("left"));
        assertEquals(Integer.valueOf(2), alignment.getAttributeValues().get("right"));

        List<ResourceItem> modeItems = repo.getResources(ns, ResourceType.ATTR, "mode");
        assertEquals(1, modeItems.size());
        AttrResourceValue modeAttr = (AttrResourceValue) modeItems.get(0).getResourceValue();
        assertTrue(modeAttr.getFormats().contains(AttributeFormat.ENUM));
        assertEquals(Integer.valueOf(0), modeAttr.getAttributeValues().get("auto"));
        assertEquals(Integer.valueOf(1), modeAttr.getAttributeValues().get("manual"));
    }

    @Test
    public void collectIdsFromTagUsesResourceUrlAndRejectsMalformed() {
        Path root = Path.of("/app").toAbsolutePath().normalize();
        Path resDir = root.resolve("src/main/res");
        Path layoutXmlPath = resDir.resolve("layout/activity_main.xml");

        String layoutContent = """
                <LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"
                    android:id="@+id/container">
                  <Button android:id="@+id/btn_ok" />
                  <Button android:id="@+android:id/button1" />
                  <TextView android:id="@+id/" />
                  <TextView android:id="@+id/123invalid" />
                </LinearLayout>
                """;

        XmlFile xmlFile = createXmlFile("activity_main.xml", layoutContent);
        var inputs = new AndroidLintResources.Inputs(
                List.of(resDir),
                List.of(root.resolve("src/main/AndroidManifest.xml")),
                null,
                null,
                "fp-layout-ids",
                true
        );
        AndroidLintModel model = new AndroidLintModel(
                createLightModule(), null, root, root, "debug", null, 34, "android-34",
                21, 34, "com.example.app", false, false, null, null,
                List.of(), List.of(), "model-fp", "lint-fp", inputs
        );

        ResourceRepository repo = AndroidLintResources.getRepository(model, ResourceRepositoryScope.PROJECT_ONLY, layoutXmlPath, xmlFile);
        ResourceNamespace ns = ResourceNamespace.fromPackageName("com.example.app");

        assertTrue(repo.hasResources(ns, ResourceType.ID, "container"));
        assertTrue(repo.hasResources(ns, ResourceType.ID, "btn_ok"));
        assertFalse("App declarations must not inject into framework namespace", repo.hasResources(ResourceNamespace.ANDROID, ResourceType.ID, "button1"));
        assertFalse(repo.hasResources(ns, ResourceType.ID, "button1"));
        assertFalse(repo.hasResources(ns, ResourceType.ID, ""));
        assertFalse(repo.hasResources(ns, ResourceType.ID, "123invalid"));
    }
}
