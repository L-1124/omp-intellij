package org.jetbrains.android.context

import com.intellij.openapi.module.Module
import com.intellij.openapi.vfs.VirtualFile

@JvmRecord
data class AndroidFileInfo(
    val role: AndroidFileRole,
    val module: Module?,
    val moduleRoot: VirtualFile?,
    val variant: String?,
    val namespace: String?,
    val isAndroidFile: Boolean
) {
    companion object {
        @JvmStatic
        fun nonAndroid() = AndroidFileInfo(AndroidFileRole.NOT_ANDROID, null, null, null, null, false)
    }
}
