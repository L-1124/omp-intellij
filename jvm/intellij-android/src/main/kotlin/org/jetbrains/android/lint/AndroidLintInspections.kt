package org.jetbrains.android.lint

import com.android.tools.lint.detector.api.Issue
import com.android.tools.lint.detector.api.Scope
import com.android.tools.lint.detector.api.Severity
import com.android.tools.lint.detector.api.TextFormat
import com.intellij.openapi.application.readAction
import com.intellij.openapi.module.Module
import com.intellij.openapi.module.ModuleManager
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.roots.ModuleRootManager
import com.intellij.openapi.roots.ProjectRootModificationTracker
import com.intellij.openapi.vfs.VirtualFile
import com.jetbrains.ls.api.core.LSAnalysisContext
import com.jetbrains.ls.api.core.LSServer
import com.jetbrains.ls.api.features.inspectCode.InspectionInfo
import com.jetbrains.ls.api.features.inspectCode.LSBatchInspection
import com.jetbrains.ls.api.features.language.LSLanguage
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import org.jetbrains.android.AndroidExtension
import org.jetbrains.android.context.AndroidContext
import org.jetbrains.android.context.AndroidQueryException
import org.jetbrains.android.resource.AndroidSources
import java.util.Collections
import java.util.LinkedHashMap
import java.util.TreeMap

internal class AndroidLintInspections {
    private data class ModelIdentity(
        val root: String,
        val variant: String?,
        val moduleName: String,
        val androidModuleName: String
    )

    private data class ModelKey(
        val identity: ModelIdentity,
        val fingerprint: String?,
        val ruleJars: List<String>
    )

    private data class DirectoryKey(
        val project: String,
        val rootsVersion: Long,
        val models: List<ModelKey>
    )

    private data class Probe(val module: Module, val roots: List<VirtualFile>)
    private data class Baseline(
        val project: Project,
        val rootsVersion: Long,
        val modules: List<Module>,
        val probes: List<Probe>,
        val snapshot: AndroidSources.Scope
    )

    private data class ModelInput(val key: ModelKey, val model: AndroidLintModel)

    private val cache = Collections.synchronizedMap(
        object : LinkedHashMap<DirectoryKey, List<LSBatchInspection>>(8, 0.75f, true) {
            override fun removeEldestEntry(
                eldest: MutableMap.MutableEntry<DirectoryKey, List<LSBatchInspection>>?
            ): Boolean = size > 8
        }
    )

    suspend fun inspections(server: LSServer, languages: Set<LSLanguage>): List<LSBatchInspection> {
        val requestContext = currentCoroutineContext()
        val openVersions = AndroidSources.Scope.openVersions(server)
        try {
            return server.withAnalysisContext {
                val project = contextOf<LSAnalysisContext>().project
                val baseline = readAction { baseline(project, server, openVersions) }
                val snapshots = ArrayList<AndroidSources.Scope>()
                snapshots.add(baseline.snapshot)
                val models = LinkedHashMap<ModelIdentity, ModelInput>()
                for ((module1, roots) in baseline.probes) {
                    requestContext.ensureActive()
                    readAction {
                        ProgressManager.checkCanceled()
                        if (module1.isDisposed) modified()
                        AndroidSources.Scope(server, null, openVersions).use { sources ->
                            sources.useSavedModelInputs()
                            for (root in roots) {
                                ProgressManager.checkCanceled()
                                val model = AndroidLintModelResolver.resolve(project, root, module1) ?: continue
                                val module = model.module ?: continue
                                val identity = ModelIdentity(
                                    model.moduleRoot?.toUri()?.toString() ?: root.url,
                                    model.variant,
                                    module.name,
                                    model.androidModule?.name ?: module.name
                                )
                                models.putIfAbsent(
                                    identity,
                                    ModelInput(ModelKey(identity, model.fingerprint, model.ruleJarFingerprints), model)
                                )
                            }
                            sources.verify()
                            snapshots.add(sources)
                        }
                    }
                }
                val inputs = models.values.sortedWith(
                    compareBy<ModelInput>(
                        { it.key.identity.root },
                        { it.key.identity.variant ?: "" },
                        { it.key.identity.moduleName },
                        { it.key.identity.androidModuleName }
                    )
                )
                val key = DirectoryKey(
                    project.locationHash,
                    baseline.rootsVersion,
                    java.util.List.copyOf(inputs.map { it.key })
                )
                val existing = cache[key]
                if (existing != null) {
                    return@withAnalysisContext readAction {
                        requestContext.ensureActive()
                        verify(baseline, snapshots)
                        existing
                    }
                }

                val catalog = Catalog(languages.filterTo(LinkedHashSet()) { it != AndroidExtension.XML })
                var complete = true
                for (input in inputs) {
                    requestContext.ensureActive()
                    readAction {
                        ProgressManager.checkCanceled()
                        if (input.model.module?.isDisposed != false) modified()
                        AndroidSources.Scope(server, null, openVersions).use { sources ->
                            sources.useSavedModelInputs()
                            val client = AndroidLintClient(input.model, null, null, null, null)
                            for (scope in listOf(Scope.JAVA_FILE, Scope.RESOURCE_FILE, Scope.MANIFEST)) {
                                for (issue in client.availableIssues(scope)) {
                                    ProgressManager.checkCanceled()
                                    catalog.add(issue, scope)
                                }
                            }
                            complete = complete && client.isIssueEnumerationComplete()
                            sources.verify()
                            snapshots.add(sources)
                        }
                    }
                }
                val values = catalog.build()
                readAction {
                    requestContext.ensureActive()
                    verify(baseline, snapshots)
                    if (complete) cache[key] = values
                    values
                }
            }
        } catch (error: AndroidQueryException) {
            error.throwAsLspError()
        }
    }

    private fun baseline(project: Project, server: LSServer, versions: Map<String, Int?>): Baseline {
        ProgressManager.checkCanceled()
        if (project.isDisposed) modified()
        return AndroidSources.Scope(server, null, versions).use { sources ->
            sources.useSavedModelInputs()
            val rootsVersion = ProjectRootModificationTracker.getInstance(project).modificationCount
            val modules = ModuleManager.getInstance(project).modules.toList()
            val probes = ArrayList<Probe>(modules.size)
            for (module in modules) {
                ProgressManager.checkCanceled()
                if (module.isDisposed) modified()
                val roots = LinkedHashSet<VirtualFile>()
                AndroidContext.findModuleRoot(module)?.let { roots.add(it) }
                val manager = ModuleRootManager.getInstance(module)
                roots.addAll(manager.contentRoots)
                roots.addAll(manager.sourceRoots)
                probes.add(Probe(module, roots.toList()))
            }
            sources.verify()
            Baseline(project, rootsVersion, modules, probes, sources)
        }
    }

    private fun verify(baseline: Baseline, snapshots: List<AndroidSources.Scope>) {
        ProgressManager.checkCanceled()
        if (baseline.project.isDisposed) modified()
        if (ProjectRootModificationTracker.getInstance(baseline.project).modificationCount != baseline.rootsVersion) {
            modified()
        }
        val current = ModuleManager.getInstance(baseline.project).modules
        if (current.size != baseline.modules.size) modified()
        for (index in current.indices) {
            if (current[index] !== baseline.modules[index] || current[index].isDisposed) modified()
        }
        for (snapshot in snapshots) snapshot.verify()
    }

    private fun modified(): Nothing = throw AndroidQueryException("content_modified", -32801)

    internal class Catalog(private val sourceLanguages: Set<LSLanguage>) {
        private class Entry(var info: InspectionInfo, val languages: MutableSet<LSLanguage>)

        private val entries = TreeMap<String, Entry>()

        fun add(issue: Issue, scope: Scope) {
            val id = "AndroidLint.${issue.id}"
            val level = when (issue.defaultSeverity) {
                Severity.FATAL, Severity.ERROR -> "ERROR"
                Severity.WARNING -> "WARNING"
                Severity.IGNORE -> "DO_NOT_SHOW"
                else -> "INFORMATION"
            }
            val info = InspectionInfo(
                id = id,
                displayName = issue.getBriefDescription(TextFormat.RAW),
                groupPath = listOf("Android Lint", issue.category.fullName),
                defaultLevel = level,
                enabledByDefault = issue.isEnabledByDefault()
            )
            val entry = entries.getOrPut(issue.id) { Entry(info, LinkedHashSet()) }
            entry.info = info
            if (scope == Scope.JAVA_FILE) entry.languages.addAll(sourceLanguages)
            else entry.languages.add(AndroidExtension.XML)
        }

        fun build(): List<LSBatchInspection> = java.util.List.copyOf(entries.map { (id, entry) ->
            LSBatchInspection(entry.info, java.util.Set.copyOf(entry.languages), setOf(id))
        })
    }
}
