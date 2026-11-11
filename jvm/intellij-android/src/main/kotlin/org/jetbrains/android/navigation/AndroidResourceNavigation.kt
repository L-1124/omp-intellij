package org.jetbrains.android.navigation

import com.intellij.navigation.DirectNavigationProvider
import com.intellij.openapi.application.Application
import com.intellij.openapi.module.ModuleManager
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.util.TextRange
import com.intellij.psi.PsiClass
import com.intellij.psi.PsiElement
import com.intellij.psi.PsiField
import com.intellij.psi.PsiFile
import com.intellij.psi.impl.FakePsiElement
import com.jetbrains.analyzer.api.AnalyzerContextKind
import com.jetbrains.analyzer.bootstrap.AnalyzerContainerBuilder
import com.jetbrains.ls.api.core.util.offsetByPosition
import com.jetbrains.ls.api.features.WorkspaceComponentEntry
import com.jetbrains.ls.snapshot.api.impl.core.LSConfigurationData
import com.jetbrains.ls.snapshot.api.impl.core.WorkspaceComponent
import org.jetbrains.android.context.AndroidContext
import org.jetbrains.android.context.AndroidQueryException
import org.jetbrains.android.resource.AndroidLocations
import org.jetbrains.android.resource.AndroidSources
import org.jetbrains.android.resource.ResourceReference
import org.jetbrains.android.resource.ResourceResolver
import java.nio.file.Path

class AndroidResourceNavigation : DirectNavigationProvider {

    override fun getNavigationElement(element: PsiElement): PsiElement? {
        val field = element as? PsiField ?: return null
        val type = field.containingClass ?: return null
        val owner = type.containingClass
        val qualified = owner?.qualifiedName
        if (qualified == null || !qualified.endsWith(".R") || qualified == "android.R") return null
        val containingFile = field.containingFile ?: return null
        val file = containingFile.virtualFile
        if (file == null || !file.path.contains("!/")) return null
        val origin = Path.of(file.path.substring(0, file.path.indexOf("!/"))).toAbsolutePath().normalize()
        try {
            AndroidSources.open(containingFile.virtualFile).use { sources ->
                for (module in ModuleManager.getInstance(element.project).modules) {
                    ProgressManager.checkCanceled()
                    if (!AndroidContext.isAndroidModule(module)) continue
                    val root = AndroidContext.findModuleRoot(module)
                    if (root == null || !origin.startsWith(Path.of(root.path).toAbsolutePath().normalize())) continue
                    val typeName = type.name ?: continue
                    val reference = ResourceReference(
                        typeName,
                        field.name,
                        qualified.substring(0, qualified.length - 2),
                        false,
                        null,
                        origin
                    )
                    val definitions = ResourceResolver.resolveAll(element.project, module, reference)
                    if (definitions.isEmpty()) continue
                    val location = definitions[0].location
                    val path = AndroidLocations.path(location)
                    val xml = AndroidSources.navigationFile(element.project, path) ?: continue
                    val document = xml.fileDocument ?: continue
                    val start = document.offsetByPosition(location.range.start)
                    val end = document.offsetByPosition(location.range.end)
                    sources.verify()
                    return Declaration(xml, TextRange(start, end))
                }
                return null
            }
        } catch (error: AndroidQueryException) {
            if (error.errorCode == -32801) {
                error.throwAsLspError()
            }
            return null
        }
    }

    private class Declaration(
        private val file: PsiFile,
        private val range: TextRange
    ) : FakePsiElement() {
        override fun getParent(): PsiElement = file

        override fun getContainingFile(): PsiFile = file

        override fun getTextRange(): TextRange = range

        override fun getTextOffset(): Int = range.startOffset

        override fun getNavigationElement(): PsiElement = this

        override fun getText(): String = file.text.substring(range.startOffset, range.endOffset)
    }

    class Component private constructor() : WorkspaceComponent<Any> {
        override fun init(data: LSConfigurationData): Any = this

        override suspend fun registerInApplicationContainer(
            builder: AnalyzerContainerBuilder,
            application: Application,
            state: Any,
            contextKind: AnalyzerContextKind
        ) {
            builder.extension("com.intellij.lang.directNavigationProvider", AndroidResourceNavigation.INSTANCE)
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
        val INSTANCE = AndroidResourceNavigation()
    }
}
