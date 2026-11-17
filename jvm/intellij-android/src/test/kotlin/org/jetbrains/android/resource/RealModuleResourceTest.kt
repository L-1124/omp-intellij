@file:Suppress("UnstableApiUsage")

package org.jetbrains.android.resource

import com.android.ide.common.rendering.api.ResourceNamespace
import com.android.ide.common.resources.ResourceSet
import com.android.utils.ILogger
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.nio.file.Files
import java.nio.file.Path

/**
 * End-to-end check against a real Android module when one is available.
 *
 * The module path comes from OMP_INTELLIJ_TEST_ANDROID_MODULE so an ordinary run skips it. This is
 * the only test that observes a real AGP layout; the fixture test covers the model semantics.
 */
class RealModuleResourceTest {

    private val noLog = object : ILogger {
        override fun error(t: Throwable?, format: String?, vararg args: Any?) {}
        override fun warning(format: String?, vararg args: Any?) {}
        override fun info(format: String?, vararg args: Any?) {}
        override fun verbose(format: String?, vararg args: Any?) {}
    }

    @Test
    fun realModuleDeclarationsComeFromSources() {
        val configured = System.getenv("OMP_INTELLIJ_TEST_ANDROID_MODULE")
        assumeTrue("OMP_INTELLIJ_TEST_ANDROID_MODULE not set", !configured.isNullOrBlank())
        val module = Path.of(configured!!)
        val res = module.resolve("src/main/res")
        assumeTrue("no source res directory at $res", Files.isDirectory(res))

        val namespace = manifestPackage(module.resolve("src/main/AndroidManifest.xml"))
            ?: module.fileName.toString()
        val set = ResourceSet("main", ResourceNamespace.fromPackageName(namespace), null, false, null)
        set.addSource(res.toFile())
        set.loadFromFiles(noLog)

        val types = set.dataMap.values().map { it.type.getName() }.toSet()
        assertTrue("expected string resources, got $types", types.contains("string"))
        assertTrue("expected style resources, got $types", types.contains("style"))
        assertTrue(
            "expected file-backed resources (drawable/mipmap/xml), got $types",
            types.any { it == "drawable" || it == "mipmap" || it == "xml" }
        )

        val keyed = set.dataMap.entries()
            .filter { it.value.type.getName() == "string" && it.value.name == "app_name" }
            .toList()
        assertTrue("app_name not declared", keyed.isNotEmpty())
        val path = keyed.first().value.source.toPath() ?: throw IllegalStateException("no source")
        assertTrue("unexpected source path: $path", path.toString().contains("values"))
        assertTrue("source file does not declare app_name", Files.readString(path).contains("name=\"app_name\""))
        assertEquals("expected one default declaration", 1, keyed.size)
    }

    private fun manifestPackage(manifest: Path): String? {
        if (!Files.isRegularFile(manifest)) return null
        val match = Regex("package=\"([^\"]+)\"").find(Files.readString(manifest)) ?: return null
        return match.groupValues[1]
    }
}
