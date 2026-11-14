package org.jetbrains.android.resource

import com.android.ide.common.resources.configuration.FolderConfiguration
import com.android.ide.common.resources.getIdentifiedSourceSetMap
import com.android.ide.common.resources.isRelativeSourceSetResource
import com.android.ide.common.resources.relativeResourcePathToAbsolutePath
import com.android.resources.ResourceFolderType
import com.android.resources.getFieldNameByResourceName
import com.android.utils.SdkUtils
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files

class AndroidFoldersTest {

    @Test
    fun isValuesRecognizesStandardAndVersion36Point1Qualifiers() {
        assertTrue(AndroidFolders.isValues("values"))
        assertTrue(AndroidFolders.isValues("values-v36.1"))
        assertTrue(AndroidFolders.isValues("values-land-v36.1"))
        assertTrue(AndroidFolders.isValues("values-zh-rCN"))
        assertTrue(AndroidFolders.isValues("values-b+es+419"))
        assertTrue(AndroidFolders.isValues("values-night"))
        assertTrue(AndroidFolders.isValues("values-sw600dp"))
        assertTrue(AndroidFolders.isValues("values-highdr"))

        assertFalse(AndroidFolders.isValues("values-invalidqualifier"))
        assertFalse(AndroidFolders.isValues("layout"))
        assertFalse(AndroidFolders.isValues("layout-land"))
        assertFalse(AndroidFolders.isValues("drawable-hdpi"))
    }

    @Test
    fun folderConfigurationRecognizesVersion36Point1() {
        val config = FolderConfiguration.getConfigForFolder("values-v36.1")
        assertNotNull(config)
        assertEquals(ResourceFolderType.VALUES, ResourceFolderType.getFolderType("values-v36.1"))
        assertNotNull(config!!.versionQualifier)
        assertEquals("v36.1", config.versionQualifier!!.folderSegment)
    }

    @Test
    fun isResourceFolderValidatesKnownFolderTypesAndQualifiers() {
        assertTrue(AndroidFolders.isResourceFolder("layout"))
        assertTrue(AndroidFolders.isResourceFolder("layout-land"))
        assertTrue(AndroidFolders.isResourceFolder("layout-v36.1"))
        assertTrue(AndroidFolders.isResourceFolder("drawable-xhdpi"))
        assertTrue(AndroidFolders.isResourceFolder("values-night"))

        assertFalse(AndroidFolders.isResourceFolder("invalid-folder"))
        assertFalse(AndroidFolders.isResourceFolder("layout-invalidqualifier"))
    }

    @Test
    fun folderNamesPreservesNonValuesFirstThenValuesOrdering() {
        assertEquals(listOf("color", "values"), AndroidFolders.folderNames("color"))
        assertEquals(listOf("drawable", "values"), AndroidFolders.folderNames("drawable"))
        assertEquals(listOf("font"), AndroidFolders.folderNames("font"))
        assertEquals(listOf("layout"), AndroidFolders.folderNames("layout"))
        assertEquals(listOf("menu"), AndroidFolders.folderNames("menu"))
        assertEquals(listOf("anim"), AndroidFolders.folderNames("anim"))
        assertEquals(listOf("values"), AndroidFolders.folderNames("string"))
        assertEquals(listOf("values"), AndroidFolders.folderNames("dimen"))
        assertEquals(listOf("values"), AndroidFolders.folderNames("style"))
        assertEquals(listOf("values"), AndroidFolders.folderNames("array"))
        assertEquals(listOf("values"), AndroidFolders.folderNames("string-array"))
        assertEquals(listOf("values"), AndroidFolders.folderNames("integer-array"))
        assertEquals(listOf("values"), AndroidFolders.folderNames("id"))
    }

    @Test
    fun fileNameToResourceNameNormalizesMultiDotAndNinePatch() {
        assertEquals("foo.bar", SdkUtils.fileNameToResourceName("foo.bar.png"))
        assertEquals("foo.bar", SdkUtils.fileNameToResourceName("foo.bar.9.png"))
        assertEquals("icon", SdkUtils.fileNameToResourceName("icon.xml"))
        assertEquals("main_layout", SdkUtils.fileNameToResourceName("main_layout.xml"))
    }

    @Test
    fun rClassNamingNormalizesHyphenAndDots() {
        assertEquals("Theme_My_App", getFieldNameByResourceName("Theme.My-App"))
        assertEquals("Theme_Foo_Bar", getFieldNameByResourceName("Theme.Foo-Bar"))
        assertEquals("btn_ok", getFieldNameByResourceName("btn-ok"))
        assertEquals("app_name", getFieldNameByResourceName("app.name"))
    }

    @Test
    fun relativeResourceUtilsSourceSetMappingAndDecoding() {
        val tempDir = Files.createTempDirectory("omp-rel-res-test")
        try {
            val mainRes = tempDir.resolve("src/main/res").toFile().apply { mkdirs() }
            val debugRes = tempDir.resolve("src/debug/res").toFile().apply { mkdirs() }

            val sourceSets = listOf(mainRes, debugRes)
            val map = getIdentifiedSourceSetMap(
                sourceSets,
                "com.example.app",
                "app"
            )

            assertTrue(map.isNotEmpty())
            val firstEntry = map.entries.first()
            val prefix = firstEntry.key
            val rootPath = firstEntry.value

            val relPath = "$prefix:/values/strings.xml"
            assertTrue(isRelativeSourceSetResource(relPath))

            val absPath = relativeResourcePathToAbsolutePath(relPath, map)
            val expected = File(rootPath, "values/strings.xml").absolutePath
            assertEquals(expected, absPath)
        } finally {
            tempDir.toFile().deleteRecursively()
        }
    }
}
