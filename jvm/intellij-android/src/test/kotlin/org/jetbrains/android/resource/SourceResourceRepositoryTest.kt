@file:Suppress("UnstableApiUsage")

package org.jetbrains.android.resource

import com.android.ide.common.rendering.api.ResourceNamespace
import com.android.ide.common.resources.ResourceSet
import com.android.utils.ILogger
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files
import java.nio.file.Path

/**
 * Verifies that resource declarations come from source directories alone: no build output, no
 * merger.xml, no blame maps, no generated R jars. The fixture mirrors a real Android module's res
 * tree, so the assertions describe the declarations the IDE would show.
 */
class SourceResourceRepositoryTest {

    private val noLog = object : ILogger {
        override fun error(t: Throwable?, format: String?, vararg args: Any?) {}
        override fun warning(format: String?, vararg args: Any?) {}
        override fun info(format: String?, vararg args: Any?) {}
        override fun verbose(format: String?, vararg args: Any?) {}
    }

    /** Fixture lives outside the JVM subproject, so locate it by walking up to the repository root. */
    private fun fixtureRes(): Path {
        var current: Path? = Path.of("").toAbsolutePath()
        while (current != null) {
            val candidate = current.resolve("test-fixtures/android-xml/app/src/main/res")
            if (Files.isDirectory(candidate)) return candidate
            current = current.parent
        }
        throw IllegalStateException("test-fixtures/android-xml not found above ${Path.of("").toAbsolutePath()}")
    }

    private fun loadRes(res: Path, namespace: String = "com.example.app"): ResourceSet {
        val set = ResourceSet("main", ResourceNamespace.fromPackageName(namespace), null, false, null)
        set.addSource(res.toFile())
        set.loadFromFiles(noLog)
        return set
    }

    private fun names(set: ResourceSet, type: String): Set<String> =
        set.dataMap.keySet()
            .filter { it.startsWith("$type/") }
            .map { it.substringAfter('/') }
            .toSet()

    @Test
    fun valuesDeclarationsComeFromSourceXml() {
        val set = loadRes(fixtureRes())

        assertEquals(
            setOf("app_name", "hello_message", "entity_1", "emoji_greeting", "quoted_text"),
            names(set, "string")
        )
        assertTrue(names(set, "color").isNotEmpty())
        assertTrue(names(set, "dimen").isNotEmpty())
        assertTrue(names(set, "style").isNotEmpty())
        // attr and declare-styleable entries are parsed by the same model without extra branches.
        assertTrue("attr entries missing", names(set, "attr").isNotEmpty())
    }

    @Test
    fun nonValuesResourcesAreDeclaredByFileType() {
        val set = loadRes(fixtureRes())

        assertTrue(names(set, "layout").contains("activity_main"))
        assertTrue(names(set, "drawable").any { it.startsWith("reference_") })
        assertTrue(names(set, "xml").any { it.startsWith("reference_") })
        assertTrue(names(set, "raw").any { it.startsWith("reference_") })
        assertTrue(names(set, "menu").any { it.startsWith("menu_") })
        assertTrue(names(set, "anim").any { it.startsWith("reference_") })
        assertTrue(names(set, "animator").any { it.startsWith("reference_") })
    }

    @Test
    fun qualifiedValuesStaySeparatePerConfiguration() {
        val res = fixtureRes()
        val set = ResourceSet("main", ResourceNamespace.fromPackageName("com.example.app"), null, false, null)
        // addSource takes a res directory; qualified folders below it become configurations.
        set.addSource(res.toFile())
        set.loadFromFiles(noLog)

        val appName = set.dataMap.keySet()
            .filter { it.endsWith("/app_name") && it.startsWith("string") }
            .flatMap { set.dataMap.get(it) }
        assertEquals(
            "expected default and es qualifiers, got ${set.dataMap.keySet().filter { it.contains("app_name") }}",
            2, appName.size
        )
        val qualifiers = appName.map { it.configuration.qualifierString }.toSet()
        assertTrue("expected an unqualified default, got $qualifiers", qualifiers.any { it.isEmpty() })
        assertTrue("expected an es qualifier, got $qualifiers", qualifiers.any { it.startsWith("es") })
        val paths = appName.map { it.source.toPath() }.toSet()
        assertTrue(
            "default declaration path missing",
            paths.any { it.toString().endsWith("values${java.io.File.separator}strings.xml") })
        assertTrue("es declaration path missing", paths.any { it.toString().contains("values-es") })
    }

    @Test
    fun declarationPathPointsAtTheSourceFile() {
        val set = loadRes(fixtureRes())
        val item = set.dataMap.get("string/app_name").single()
        val path = item.source.toPath()
        assertTrue(
            "unexpected source path: $path",
            path.toString().endsWith("values${java.io.File.separator}strings.xml")
        )
        val text = Files.readString(path)
        assertTrue("source file does not declare app_name", text.contains("name=\"app_name\""))
    }

    @Test
    fun absentResourceIsDistinguishedFromUnreadableTree() {
        val set = loadRes(fixtureRes())
        assertFalse(set.dataMap.containsKey("string/does_not_exist"))
        assertTrue(set.dataMap.containsKey("string/app_name"))
    }

    @Test
    fun styleableAndCollectionTypesUseModelNames() {
        val set = loadRes(fixtureRes())
        // The XML tag is <declare-styleable>; the model names the type "styleable", which is what
        // ResourceResolver.key() must produce for the declaration lookup to match.
        assertTrue("styleable missing", names(set, "styleable").contains("CustomComponent"))
        assertTrue("attr missing", names(set, "attr").contains("globalAttr"))
        assertTrue("array missing", names(set, "array").contains("planets"))
        assertTrue("plurals missing", names(set, "plurals").contains("items_count"))
        assertTrue("id missing", names(set, "id").contains("custom_view_id"))
        assertTrue("bool missing", names(set, "bool").contains("feature_enabled"))
        assertTrue("integer missing", names(set, "integer").contains("max_retry_count"))
    }
}
