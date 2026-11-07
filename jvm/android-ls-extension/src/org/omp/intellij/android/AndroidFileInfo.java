package org.omp.intellij.android;

import com.intellij.openapi.module.Module;
import com.intellij.openapi.vfs.VirtualFile;

/**
 * Identity and model information for an Android source or resource file.
 *
 * @param role          Role of the file (MANIFEST, VALUES_XML, etc.)
 * @param module        Module containing the file, if confirmed
 * @param moduleRoot    Root content directory of the module containing the build script
 * @param variant       Confirmed build variant (e.g. "debug", "release"), or null if unknown
 * @param namespace     Confirmed Android namespace / package, or null if unknown
 * @param isAndroidFile True if verified to belong to a confirmed Android module
 */
public record AndroidFileInfo(
        AndroidFileRole role,
        Module module,
        VirtualFile moduleRoot,
        String variant,
        String namespace,
        boolean isAndroidFile
) {
    public static AndroidFileInfo nonAndroid() {
        return new AndroidFileInfo(AndroidFileRole.NOT_ANDROID, null, null, null, null, false);
    }
}
