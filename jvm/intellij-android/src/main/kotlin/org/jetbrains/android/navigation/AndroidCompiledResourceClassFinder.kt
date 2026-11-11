package org.jetbrains.android.navigation

import com.intellij.openapi.application.Application
import com.intellij.openapi.module.ModuleManager
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.util.io.FileUtil
import com.intellij.openapi.vfs.JarFileSystem
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.openapi.vfs.VirtualFileManager
import com.intellij.openapi.vfs.impl.jar.CoreJarFileSystem
import com.intellij.psi.ClassFileViewProvider
import com.intellij.psi.PsiClass
import com.intellij.psi.PsiClassOwner
import com.intellij.psi.PsiElementFinder
import com.intellij.psi.PsiManager
import com.intellij.psi.PsiPackage
import com.intellij.psi.impl.compiled.ClsFileImpl
import com.intellij.psi.impl.java.stubs.impl.PsiJavaFileStubImpl
import com.intellij.psi.search.GlobalSearchScope
import com.intellij.psi.stubs.StubTree
import com.intellij.util.cls.ClsFormatException
import com.jetbrains.analyzer.api.AnalyzerContextKind
import com.jetbrains.analyzer.bootstrap.AnalyzerContainerBuilder
import com.jetbrains.analyzer.filesystem.AnalyzerVirtualFile
import com.jetbrains.ls.api.features.WorkspaceComponentEntry
import com.jetbrains.ls.snapshot.api.impl.core.LSConfigurationData
import com.jetbrains.ls.snapshot.api.impl.core.WorkspaceComponent
import org.jetbrains.android.context.AndroidContext
import org.jetbrains.android.context.AndroidQueryException
import org.jetbrains.android.resource.AndroidSources
import org.jetbrains.android.resource.ResourceResolver
import java.io.IOException
import java.nio.file.Path
import java.util.concurrent.ConcurrentHashMap

class AndroidCompiledResourceClassFinder(private val project: Project) : PsiElementFinder() {
    private val archives = CoreJarFileSystem()
    private val compiledClasses = ConcurrentHashMap<VirtualFile, Array<PsiClass>>()

    init {
        Disposer.register(project) { archives.clearHandlersCache() }
    }

    override fun findClass(qualifiedName: String, scope: GlobalSearchScope): PsiClass? {
        val classes = findClasses(qualifiedName, scope)
        return if (classes.isEmpty()) null else classes[0]
    }

    override fun getClasses(psiPackage: PsiPackage, scope: GlobalSearchScope): Array<PsiClass> {
        val name = psiPackage.qualifiedName
        return if (name.isEmpty()) PsiClass.EMPTY_ARRAY else findClasses("$name.R", scope)
    }

    override fun findClasses(qualifiedName: String, scope: GlobalSearchScope): Array<PsiClass> {
        if (!qualifiedName.endsWith(".R")) return PsiClass.EMPTY_ARRAY
        val result = LinkedHashSet<PsiClass>()
        for (module in ModuleManager.getInstance(project).modules) {
            ProgressManager.checkCanceled()
            if (!scope.isSearchInModuleContent(module)) continue
            val root = AndroidContext.findModuleRoot(module) ?: continue
            val variant = AndroidContext.resolveVariant(module, root) ?: continue
            for (origin in ResourceResolver.findVerifiedRClassOrigins(Path.of(root.path), variant)) {
                AndroidSources.observeCompiledArchive(origin)
                val url = JarFileSystem.PROTOCOL_PREFIX + FileUtil.toSystemIndependentName(origin.toString()) +
                        JarFileSystem.JAR_SEPARATOR + qualifiedName.replace('.', '/') + ".class"
                var file = VirtualFileManager.getInstance().findFileByUrl(url)
                if (file == null) {
                    file = archives.findFileByPath(url.substring(JarFileSystem.PROTOCOL_PREFIX.length))
                }
                if (file == null || (file is AnalyzerVirtualFile && scope.contains(file))) continue
                val classes: Array<PsiClass> = if (file.fileSystem == archives) {
                    compiledClasses.computeIfAbsent(file) { f -> readCompiledClasses(f) }
                } else {
                    val psi = PsiManager.getInstance(project).findFile(file)
                    if (psi is PsiClassOwner) psi.classes else PsiClass.EMPTY_ARRAY
                }
                for (psiClass in classes) {
                    if (qualifiedName == psiClass.qualifiedName) {
                        result.add(psiClass)
                    }
                }
            }
        }
        return if (result.isEmpty()) PsiClass.EMPTY_ARRAY else result.toTypedArray()
    }

    private fun readCompiledClasses(file: VirtualFile): Array<PsiClass> {
        try {
            // The headless indexed stub loader requires AnalyzerVirtualFile; parse the actual class bytes with the platform builder.
            val stub = ClsFileImpl.buildFileStub(file, file.contentsToByteArray()) ?: return PsiClass.EMPTY_ARRAY
            val provider = ClassFileViewProvider(PsiManager.getInstance(project), file, false)
            val tree = StubTree(stub)
            val compiled = object : ClsFileImpl(provider) {
                override fun getStubTree(): StubTree = tree
            }
            (stub as PsiJavaFileStubImpl).psi = compiled
            provider.forceCachedPsi(compiled)
            return compiled.classes
        } catch (error: Exception) {
            when (error) {
                is IOException, is ClsFormatException -> {
                    throw AndroidQueryException.modelUnavailable("Cannot parse compiled resource class: ${file.path}")
                }

                else -> throw error
            }
        }
    }

    class Entry : WorkspaceComponentEntry, WorkspaceComponent<Any> {
        override fun component(): WorkspaceComponent<*> = this

        override fun init(data: LSConfigurationData): Any = this

        override suspend fun registerInApplicationContainer(
            builder: AnalyzerContainerBuilder,
            application: Application,
            state: Any,
            contextKind: AnalyzerContextKind
        ) {
            builder.extension("com.intellij.resolveScopeEnlarger", AndroidResourceResolveScope())
        }

        override suspend fun registerInProjectContainer(
            builder: AnalyzerContainerBuilder,
            project: Project,
            state: Any,
            contextKind: AnalyzerContextKind
        ) {
            builder.extension("com.intellij.java.elementFinder", AndroidCompiledResourceClassFinder(project))
        }
    }
}
