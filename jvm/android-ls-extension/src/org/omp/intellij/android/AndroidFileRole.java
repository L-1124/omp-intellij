package org.omp.intellij.android;

/**
 * Android XML and source file roles recognized by the language server extension.
 */
public enum AndroidFileRole {
    /** AndroidManifest.xml in a confirmed Android source set. */
    MANIFEST,
    /** values*.xml under an Android res directory. */
    VALUES_XML,
    /** Other XML resources (layout, drawable, menu, anim, xml, etc.). */
    RESOURCE_XML,
    /** Kotlin or Java source file in an Android module. */
    KOTLIN_OR_JAVA,
    /** File is not part of a confirmed Android source set. */
    NOT_ANDROID
}
