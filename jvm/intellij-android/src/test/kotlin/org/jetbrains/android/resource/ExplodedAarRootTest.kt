@file:Suppress("UnstableApiUsage")

package org.jetbrains.android.resource

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.nio.file.Files
import java.nio.file.Path

/**
 * Verifies that an exploded AAR is recognised from the URLs AGP gives a library entry.
 *
 * A library root points inside the unpacked archive, so discovery has to walk up to the directory
 * holding `res` beside `AndroidManifest.xml`. Getting this wrong silently drops every library
 * resource, which is why the rule is asserted on a synthetic layout and on a real AGP directory.
 */
class ExplodedAarRootTest {

    private fun file(root: Path, relative: String) {
        val path = root.resolve(relative)
        Files.createDirectories(path.parent)
        Files.writeString(path, "")
    }

    private fun explode(root: Path, name: String, pkg: String) {
        Files.createDirectories(root.resolve("$name/res/values"))
        Files.writeString(root.resolve("$name/res/values/values.xml"), "<resources/>")
        Files.writeString(
            root.resolve("$name/AndroidManifest.xml"),
            "<?xml version=\"1.0\"?><manifest package=\"$pkg\"/>",
        )
        file(root, "$name/jars/classes.jar")
        file(root, "$name/material.aar")
        file(root, "$name/sources.jar")
    }

    @Test
    fun classJarInsideExplodedAarResolvesToLibraryRoot() {
        val root = Files.createTempDirectory("aar-root")
        try {
            explode(root, "material-1.14.0", "com.google.android.material")
            val classes = root.resolve("material-1.14.0/jars/classes.jar")

            val found = SourceResourceRepository.explodedAarRoot(classes.toString())

            assertEquals(root.resolve("material-1.14.0").toAbsolutePath().normalize(), found)
            assertTrue("res must exist under the discovered root", Files.isDirectory(found!!.resolve("res")))
        } finally {
            deleteTree(root)
        }
    }

    @Test
    fun sourcesJarAtLibraryRootAlsoResolves() {
        val root = Files.createTempDirectory("aar-root")
        try {
            explode(root, "appcompat-1.8.0", "androidx.appcompat")
            val sources = root.resolve("appcompat-1.8.0/sources.jar")

            assertEquals(
                root.resolve("appcompat-1.8.0").toAbsolutePath().normalize(),
                SourceResourceRepository.explodedAarRoot(sources.toString()),
            )
        } finally {
            deleteTree(root)
        }
    }

    @Test
    fun plainJarWithoutResAndManifestIsNotALibrary() {
        val root = Files.createTempDirectory("aar-root")
        try {
            file(root, "guava-33.0/guava.jar")
            assertNull(SourceResourceRepository.explodedAarRoot(root.resolve("guava-33.0/guava.jar").toString()))
        } finally {
            deleteTree(root)
        }
    }

    @Test
    fun walkStopsAtBuildDirectory() {
        val root = Files.createTempDirectory("aar-root")
        try {
            // A module's own build output must never be mistaken for an exploded library.
            file(root, "app/build/intermediates/lib/classes.jar")
            Files.createDirectories(root.resolve("app/res"))
            Files.writeString(root.resolve("app/AndroidManifest.xml"), "<manifest package=\"x\"/>")

            assertNull(
                SourceResourceRepository.explodedAarRoot(
                    root.resolve("app/build/intermediates/lib/classes.jar").toString()
                )
            )
        } finally {
            deleteTree(root)
        }
    }

    @Test
    fun realAgpTransformDirectoryIsRecognised() {
        val cache = System.getenv("GRADLE_USER_HOME")?.let { Path.of(it, "caches") }
            ?: Path.of(System.getProperty("user.home"), ".gradle", "caches")
        val transforms = cache.resolve("9.8.0/transforms")
        assumeTrue("no AGP transforms directory at $transforms", Files.isDirectory(transforms))

        var candidate: Path? = null
        Files.list(transforms).use { stream ->
            for (entry in stream) {
                val transformed = entry.resolve("transformed")
                if (!Files.isDirectory(transformed)) continue
                Files.list(transformed).use { libs ->
                    for (lib in libs) {
                        if (Files.isDirectory(lib.resolve("res")) &&
                            Files.isRegularFile(lib.resolve("jars/classes.jar"))
                        ) {
                            candidate = lib
                            break
                        }
                    }
                }
                if (candidate != null) break
            }
        }
        val library = candidate
        assumeTrue("no exploded AAR with res and jars/classes.jar found", library != null)

        val classes = library!!.resolve("jars/classes.jar")
        val found = SourceResourceRepository.explodedAarRoot(classes.toString())
        assertNotNull("exploded AAR not recognised: $library", found)
        assertEquals(library.toAbsolutePath().normalize(), found)
        assertTrue("manifest missing beside res", Files.isRegularFile(found!!.resolve("AndroidManifest.xml")))
    }

    private fun deleteTree(root: Path) {
        Files.walk(root).use { stream ->
            stream.sorted(Comparator.reverseOrder()).forEach { Files.deleteIfExists(it) }
        }
    }
}
