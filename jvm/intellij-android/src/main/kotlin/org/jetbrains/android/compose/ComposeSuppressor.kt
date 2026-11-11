@file:OptIn(KaExperimentalApi::class)

package org.jetbrains.android.compose

import com.intellij.codeInspection.InspectionSuppressor
import com.intellij.codeInspection.LanguageInspectionSuppressors
import com.intellij.codeInspection.SuppressQuickFix
import com.intellij.lang.Language
import com.intellij.openapi.application.Application
import com.intellij.openapi.progress.ProgressManager
import com.intellij.psi.PsiElement
import com.jetbrains.analyzer.api.AnalyzerContextKind
import com.jetbrains.analyzer.bootstrap.AnalyzerContainerBuilder
import com.jetbrains.ls.api.features.WorkspaceComponentEntry
import com.jetbrains.ls.snapshot.api.impl.core.LSConfigurationData
import com.jetbrains.ls.snapshot.api.impl.core.WorkspaceComponent
import org.jetbrains.kotlin.analysis.api.KaExperimentalApi
import org.jetbrains.kotlin.analysis.api.session.analyze
import org.jetbrains.kotlin.analysis.api.resolution.successfulConstructorCallOrNull
import org.jetbrains.kotlin.analysis.api.symbols.KaConstructorSymbol
import org.jetbrains.kotlin.idea.KotlinLanguage
import org.jetbrains.kotlin.name.ClassId
import org.jetbrains.kotlin.name.FqName
import org.jetbrains.kotlin.psi.KtNamedFunction

class ComposeSuppressor : InspectionSuppressor {
    override fun isSuppressedFor(element: PsiElement, toolId: String): Boolean {
        if (toolId != "FunctionName" && toolId != "TestFunctionName") return false
        val parent = element.parent
        val function = parent as? KtNamedFunction ?: return false
        if (function.nameIdentifier != element) return false
        if (function.annotationEntries.isEmpty()) return false
        ProgressManager.checkCanceled()
        val isComposable = analyze(function) {
            with(contextOf<org.jetbrains.kotlin.analysis.api.KaSession>()) {
                for (entry in function.annotationEntries) {
                    ProgressManager.checkCanceled()
                    var constructor: KaConstructorSymbol? = entry.resolveSymbol()
                    if (constructor == null) {
                        val callInfo = entry.resolveToCall()
                        val call = callInfo?.successfulConstructorCallOrNull()
                        val symbol = call?.signature?.symbol
                        if (symbol is KaConstructorSymbol) {
                            constructor = symbol
                        }
                    }
                    if (constructor != null) {
                        val classId = constructor.containingClassId
                        if (classId != null && COMPOSABLE_CLASS_ID == classId) {
                            return@analyze true
                        }
                    }
                }
                false
            }
        }
        return isComposable == true
    }

    override fun getSuppressActions(element: PsiElement?, toolId: String): Array<SuppressQuickFix> {
        return SuppressQuickFix.EMPTY_ARRAY
    }

    class Component private constructor() : WorkspaceComponent<Any> {
        override fun init(data: LSConfigurationData): Any = this

        override suspend fun registerInApplicationContainer(
            builder: AnalyzerContainerBuilder,
            application: Application,
            state: Any,
            contextKind: AnalyzerContextKind
        ) {
            registerOnce()
        }

        companion object {
            @JvmField
            val INSTANCE = Component()
        }
    }

    class Entry : WorkspaceComponentEntry {
        override fun component(): WorkspaceComponent<*> = Component.INSTANCE
    }

    companion object {
        @JvmField
        val INSTANCE = ComposeSuppressor()

        private val COMPOSABLE_CLASS_ID = ClassId.topLevel(FqName("androidx.compose.runtime.Composable"))

        @Volatile
        private var registered = false

        @JvmStatic
        fun registerOnce() {
            if (registered) return
            synchronized(ComposeSuppressor::class.java) {
                if (!registered) {
                    val kotlin: Language? = KotlinLanguage.INSTANCE
                    if (kotlin != null) {
                        LanguageInspectionSuppressors.INSTANCE.addExplicitExtension(kotlin, INSTANCE)
                    }
                    registered = true
                }
            }
        }
    }
}
