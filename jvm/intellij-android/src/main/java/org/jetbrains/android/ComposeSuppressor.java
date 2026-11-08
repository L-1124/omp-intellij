package org.jetbrains.android;

import com.intellij.codeInspection.InspectionSuppressor;
import com.intellij.codeInspection.LanguageInspectionSuppressors;
import com.intellij.codeInspection.SuppressQuickFix;
import com.intellij.lang.Language;
import com.intellij.openapi.application.Application;
import com.intellij.openapi.progress.ProgressManager;
import com.intellij.psi.PsiElement;
import com.jetbrains.analyzer.api.AnalyzerContextKind;
import com.jetbrains.analyzer.bootstrap.AnalyzerContainerBuilder;
import com.jetbrains.ls.api.features.WorkspaceComponentEntry;
import com.jetbrains.ls.snapshot.api.impl.core.LSConfigurationData;
import com.jetbrains.ls.snapshot.api.impl.core.WorkspaceComponent;
import kotlin.Unit;
import kotlin.coroutines.Continuation;
import org.jetbrains.kotlin.analysis.api.resolution.KaCallInfo;
import org.jetbrains.kotlin.analysis.api.resolution.KaCallInfoKt;
import org.jetbrains.kotlin.analysis.api.resolution.KaFunctionCall;
import org.jetbrains.kotlin.analysis.api.session.AnalyzeKt;
import org.jetbrains.kotlin.analysis.api.symbols.KaConstructorSymbol;
import org.jetbrains.kotlin.idea.KotlinLanguage;
import org.jetbrains.kotlin.name.ClassId;
import org.jetbrains.kotlin.name.FqName;
import org.jetbrains.kotlin.psi.KtAnnotationEntry;
import org.jetbrains.kotlin.psi.KtNamedFunction;

public final class ComposeSuppressor implements InspectionSuppressor {
    public static final ComposeSuppressor INSTANCE = new ComposeSuppressor();
    private static final ClassId COMPOSABLE_CLASS_ID = ClassId.topLevel(new FqName("androidx.compose.runtime.Composable"));
    private static volatile boolean registered = false;

    public ComposeSuppressor() {
    }

    public static void registerOnce() {
        if (registered) return;
        synchronized (ComposeSuppressor.class) {
            if (!registered) {
                Language kotlin = KotlinLanguage.INSTANCE;
                if (kotlin != null) {
                    LanguageInspectionSuppressors.INSTANCE.addExplicitExtension(kotlin, INSTANCE);
                }
                registered = true;
            }
        }
    }

    @Override
    public boolean isSuppressedFor(PsiElement element, String toolId) {
        if (!"FunctionName".equals(toolId) && !"TestFunctionName".equals(toolId)) return false;
        if (element == null) return false;
        PsiElement parent = element.getParent();
        if (!(parent instanceof KtNamedFunction function)) return false;
        if (function.getNameIdentifier() != element) return false;
        if (function.getAnnotationEntries().isEmpty()) return false;
        ProgressManager.checkCanceled();
        Boolean isComposable = AnalyzeKt.analyze(function, session -> {
            for (KtAnnotationEntry entry : function.getAnnotationEntries()) {
                ProgressManager.checkCanceled();
                KaConstructorSymbol constructor = session.resolveSymbol(entry);
                if (constructor == null) {
                    KaCallInfo callInfo = session.resolveToCall(entry);
                    KaFunctionCall<KaConstructorSymbol> call = KaCallInfoKt.successfulConstructorCallOrNull(callInfo);
                    if (call != null && call.getSignature() != null) {
                        constructor = call.getSignature().getSymbol();
                    }
                }
                if (constructor != null) {
                    ClassId classId = constructor.getContainingClassId();
                    if (classId != null && COMPOSABLE_CLASS_ID.equals(classId)) {
                        return Boolean.TRUE;
                    }
                }
            }
            return Boolean.FALSE;
        });
        return isComposable != null && isComposable;
    }

    @Override
    public SuppressQuickFix[] getSuppressActions(PsiElement element, String toolId) {
        return SuppressQuickFix.EMPTY_ARRAY;
    }

    public static final class Component implements WorkspaceComponent<Object> {
        public static final Component INSTANCE = new Component();

        private Component() {
        }

        @Override
        public Object init(LSConfigurationData data) {
            return this;
        }

        @Override
        public Object registerInApplicationContainer(
                AnalyzerContainerBuilder builder,
                Application application,
                Object state,
                AnalyzerContextKind kind,
                Continuation<? super Unit> continuation) {
            ComposeSuppressor.registerOnce();
            return Unit.INSTANCE;
        }
    }

    public static final class Entry implements WorkspaceComponentEntry {
        @Override
        public WorkspaceComponent<?> component() {
            return Component.INSTANCE;
        }
    }
}
