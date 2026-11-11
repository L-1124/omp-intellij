package org.jetbrains.android.debug

import com.intellij.debugger.engine.DebuggerUtils
import com.intellij.debugger.engine.FieldVisibilityProvider
import com.sun.jdi.Field

class AndroidFieldVisibilityProvider : FieldVisibilityProvider {
    override fun shouldDisplay(field: Field): Boolean {
        if (!DebuggerUtils.isAndroidVM(field.virtualMachine())) {
            return true
        }
        if (field.declaringType().name() != "java.lang.Object") {
            return true
        }
        return field.name() !in SHADOW_FIELDS
    }

    private companion object {
        private val SHADOW_FIELDS: Set<String> = setOf("shadow\$_klass_", "shadow\$_monitor_")
    }
}
