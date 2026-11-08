package org.jetbrains.android.debug;

import com.intellij.debugger.engine.DebuggerUtils;
import com.intellij.debugger.engine.FieldVisibilityProvider;
import com.sun.jdi.Field;
import java.util.Set;

public final class AndroidFieldVisibilityProvider implements FieldVisibilityProvider {
    private static final Set<String> SHADOW_FIELDS = Set.of("shadow$_klass_", "shadow$_monitor_");

    @Override
    public boolean shouldDisplay(Field field) {
        if (!DebuggerUtils.isAndroidVM(field.virtualMachine())) {
            return true;
        }
        if (!"java.lang.Object".equals(field.declaringType().name())) {
            return true;
        }
        return !SHADOW_FIELDS.contains(field.name());
    }
}
