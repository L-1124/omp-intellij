package org.jetbrains.android.resource;

import com.intellij.core.CoreApplicationEnvironment;
import com.intellij.core.CoreProjectEnvironment;
import com.intellij.ide.highlighter.XmlFileType;
import com.intellij.lang.xml.XMLLanguage;
import com.intellij.lang.xml.XMLParserDefinition;
import com.intellij.openapi.Disposable;
import com.intellij.openapi.util.Disposer;
import com.intellij.psi.PsiManager;
import com.intellij.psi.SingleRootFileViewProvider;
import com.intellij.psi.xml.XmlAttribute;
import com.intellij.psi.xml.XmlAttributeValue;
import com.intellij.psi.xml.XmlFile;
import com.intellij.psi.xml.XmlTag;
import com.intellij.testFramework.LightVirtualFile;
import org.junit.AfterClass;
import org.junit.BeforeClass;
import org.junit.Test;

import static org.junit.Assert.*;

public class ResourceResolverTest {
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

    private static ResourceReference findReferenceInAttr(XmlFile file, String attrName) {
        XmlTag root = file.getRootTag();
        assertNotNull(root);
        XmlAttribute attr = root.getAttribute(attrName);
        assertNotNull("Attribute " + attrName + " missing", attr);
        XmlAttributeValue val = attr.getValueElement();
        assertNotNull("Attribute value for " + attrName + " missing", val);
        int offset = val.getValueTextRange().getStartOffset() + 1;
        return ResourceResolver.findResourceReferenceAt(file, offset);
    }

    @Test
    public void findResourceReferenceAtResolvesStandardAndThemeForms() {
        String xml = """
                <LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"
                    xmlns:app="http://schemas.android.com/apk/res-auto"
                    android:text="@string/app_name"
                    android:id="@+id/btn_ok"
                    android:src="@android:string/cancel"
                    android:background="?attr/colorPrimary"
                    android:textColor="?android:attr/textColorPrimary"
                    android:tint="?android:textColorSecondary"
                    android:theme="?themeColor"
                    android:drawable="@*android:drawable/internal_asset"
                    app:custom="@com.example.lib:string/lib_title"
                    android:style="@style/Theme.AppCompat"
                />
                """;
        XmlFile file = createXmlFile("activity_main.xml", xml);

        ResourceReference textRef = findReferenceInAttr(file, "android:text");
        assertNotNull(textRef);
        assertEquals("string", textRef.type());
        assertEquals("app_name", textRef.name());
        assertNull(textRef.namespace());
        assertFalse(textRef.isFramework());

        ResourceReference idRef = findReferenceInAttr(file, "android:id");
        assertNotNull(idRef);
        assertEquals("id", idRef.type());
        assertEquals("btn_ok", idRef.name());
        assertNull(idRef.namespace());
        assertFalse(idRef.isFramework());

        ResourceReference androidStringRef = findReferenceInAttr(file, "android:src");
        assertNotNull(androidStringRef);
        assertEquals("string", androidStringRef.type());
        assertEquals("cancel", androidStringRef.name());
        assertEquals("android", androidStringRef.namespace());
        assertTrue(androidStringRef.isFramework());

        ResourceReference bgRef = findReferenceInAttr(file, "android:background");
        assertNotNull(bgRef);
        assertEquals("attr", bgRef.type());
        assertEquals("colorPrimary", bgRef.name());
        assertNull(bgRef.namespace());
        assertFalse(bgRef.isFramework());

        ResourceReference textColorRef = findReferenceInAttr(file, "android:textColor");
        assertNotNull(textColorRef);
        assertEquals("attr", textColorRef.type());
        assertEquals("textColorPrimary", textColorRef.name());
        assertEquals("android", textColorRef.namespace());
        assertTrue(textColorRef.isFramework());

        ResourceReference tintRef = findReferenceInAttr(file, "android:tint");
        assertNotNull(tintRef);
        assertEquals("attr", tintRef.type());
        assertEquals("textColorSecondary", tintRef.name());
        assertEquals("android", tintRef.namespace());
        assertTrue(tintRef.isFramework());

        ResourceReference themeRef = findReferenceInAttr(file, "android:theme");
        assertNotNull(themeRef);
        assertEquals("attr", themeRef.type());
        assertEquals("themeColor", themeRef.name());
        assertNull(themeRef.namespace());
        assertFalse(themeRef.isFramework());

        ResourceReference privateFwRef = findReferenceInAttr(file, "android:drawable");
        assertNotNull(privateFwRef);
        assertEquals("drawable", privateFwRef.type());
        assertEquals("internal_asset", privateFwRef.name());
        assertEquals("android", privateFwRef.namespace());
        assertTrue(privateFwRef.isFramework());

        ResourceReference customNsRef = findReferenceInAttr(file, "app:custom");
        assertNotNull(customNsRef);
        assertEquals("string", customNsRef.type());
        assertEquals("lib_title", customNsRef.name());
        assertEquals("com.example.lib", customNsRef.namespace());
        assertFalse(customNsRef.isFramework());

        ResourceReference styleRef = findReferenceInAttr(file, "android:style");
        assertNotNull(styleRef);
        assertEquals("style", styleRef.type());
        assertEquals("Theme.AppCompat", styleRef.name());
        assertNull(styleRef.namespace());
        assertFalse(styleRef.isFramework());
    }

    @Test
    public void findResourceReferenceAtRejectsMalformedReferences() {
        String xml = """
                <LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"
                    android:a="@null"
                    android:b="@empty"
                    android:c="@invalid_type/item"
                    android:d="@string/"
                    android:e="@/app_name"
                    android:f="@"
                    android:g="?"
                    android:h="@+"
                    android:i="@android:string/foo:bar"
                    android:j="plain_text"
                    android:k="http://schemas.android.com"
                    android:l="@string/123invalid"
                    android:m="?attr/"
                    android:n="?android:"
                    android:o="@android:"
                />
                """;
        XmlFile file = createXmlFile("malformed.xml", xml);

        String[] attrs = {
                "android:a", "android:b", "android:c", "android:d", "android:e",
                "android:f", "android:g", "android:h", "android:i", "android:j",
                "android:k", "android:l", "android:m", "android:n", "android:o"
        };
        for (String attr : attrs) {
            ResourceReference ref = findReferenceInAttr(file, attr);
            assertNull("Expected null reference for attribute " + attr, ref);
        }
    }

}
