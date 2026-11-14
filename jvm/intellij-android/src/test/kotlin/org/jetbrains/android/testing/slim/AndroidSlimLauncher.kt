package org.jetbrains.android.testing.slim

import com.intellij.idea.LoggerFactory
import com.intellij.ide.plugins.ClassLoaderConfigurator
import com.intellij.ide.plugins.CurrentProductMode
import com.intellij.ide.plugins.PluginMainDescriptor
import com.intellij.ide.plugins.PluginModuleId
import com.intellij.ide.plugins.PluginInitializationDiagnosticUtils
import com.intellij.ide.plugins.loadDescriptors
import com.intellij.openapi.diagnostic.Logger
import com.intellij.ls.server.workspace.workspaceManager
import com.intellij.platform.ide.bootstrap.ZipFilePoolImpl
import com.intellij.platform.productMode.ProductMode
import com.intellij.util.lang.ZipFilePool
import com.jetbrains.analyzer.api.defaultPluginSet
import com.jetbrains.analyzer.api.withAnalyzer
import com.jetbrains.analyzer.bootstrap.pluginSet
import com.jetbrains.analyzer.filewatcher.FileWatcher
import com.jetbrains.analyzer.index.IndexSerializers
import com.jetbrains.analyzer.plugins.originalDescriptorSupplierForMakePlugin
import com.jetbrains.ls.api.core.LSServer
import com.jetbrains.ls.imports.api.applyChangesWithDeduplication
import com.jetbrains.ls.snapshot.api.impl.core.InitializeOptions
import com.jetbrains.ls.snapshot.api.impl.core.LSConfigurationData
import com.jetbrains.ls.snapshot.api.impl.core.LSSessionConfig
import com.jetbrains.ls.snapshot.api.impl.core.LSWorkspaceConfig
import com.jetbrains.ls.snapshot.api.impl.core.LibraryRootsMode
import com.jetbrains.ls.snapshot.api.impl.core.NativeIndexingFileSystemProvider
import com.jetbrains.ls.snapshot.api.impl.core.PathMapping
import com.jetbrains.ls.snapshot.api.impl.core.buildUrlRelativizer
import com.jetbrains.ls.snapshot.api.impl.core.deserializeWorkspaceModelCache
import com.jetbrains.ls.snapshot.api.impl.core.rocks.Db
import com.jetbrains.ls.snapshot.api.impl.core.rocks.Workspace
import com.jetbrains.ls.snapshot.api.impl.core.rocks.readWorkspaceModelCache
import com.jetbrains.lsp.implementation.LspHandlerContext
import com.jetbrains.lsp.implementation.LspHandlers
import com.jetbrains.lsp.implementation.LspWireBody
import com.jetbrains.lsp.implementation.LspWireOutgoing
import com.jetbrains.lsp.implementation.withLsp
import com.jetbrains.lsp.protocol.URI
import fleet.util.async.use
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.runBlocking
import java.net.URLClassLoader
import java.nio.file.Files
import java.nio.file.Path
import java.util.ServiceLoader
import java.util.function.Consumer
import java.util.function.Supplier

object AndroidSlimLauncher {
    @JvmStatic
    fun main(args: Array<String>) {
        val logging = LoggerFactory()
        Logger.setFactory(logging)
        val exitCode = try {
            CurrentProductMode.withProductMode(ProductMode.MONOLITH) { run(args) }
            0
        } catch (error: Throwable) {
            error.printStackTrace()
            1
        }
        logging.flushHandlers()
        kotlin.system.exitProcess(exitCode)
    }

    private fun run(args: Array<String>) = runBlocking {
        require(args.size == 4)
        val home = Path.of(System.getProperty("idea.home.path"))
        val project = Path.of(args[0]).toAbsolutePath()
        val watcherLibrary = java.nio.file.Files.walk(home.resolve("lib/filewatcher")).use { paths ->
            paths.filter { it.fileName.toString() == System.mapLibraryName("filewatcher_jni") }.toList().single()
        }
        FileWatcher.loadLibrary(watcherLibrary)
        val index = Path.of(args[1]).toAbsolutePath()
        val pool = ZipFilePoolImpl()
        ZipFilePool.PATH_CLASSLOADER_POOL = pool
        val discovery = loadDescriptors(CompletableDeferred(pool), null)
        val sourceSet = pluginSet("slim-source", discovery.pluginLists.flatMap { it.plugins })
        ClassLoaderConfigurator(sourceSet).configure()
        val sources = sourceSet.buildPluginIdMap().mapKeys { it.key.idString } +
                sourceSet.buildContentModuleIdMap().mapKeys { it.key.name }
        originalDescriptorSupplierForMakePlugin = sources::get
        val originalXml = checkNotNull(sources["org.jetbrains.ls.plugin.xml"] as? PluginMainDescriptor)
        check(originalXml.contentModules.any { it.moduleId.name == "intellij.xml.psi.impl" })
        val coreId = PluginModuleId("language-server.api.features.impl.android", "jetbrains")
        val dapId = PluginModuleId("language-server.api.features.impl.android.dap", "jetbrains")
        val android =
            checkNotNull(sourceSet.enabledPlugins.find { it.pluginId.idString == "org.jetbrains.android" }) {
                discovery.pluginLists.flatMap { it.plugins }.mapNotNull { plugin ->
                    sourceSet.resolvedPluginSet.getExclusionReason(plugin)?.let {
                        "${plugin.pluginId}: ${PluginInitializationDiagnosticUtils.getLogMessage(it)}"
                    }
                }.joinToString("\n")
            }
        val sourceCore = checkNotNull(sourceSet.findEnabledModule(coreId))
        val sourceLoader = checkNotNull(sourceCore.pluginClassLoader)
        val urls = listOf(
            Path.of(args[3]),
            home.resolve("plugins/java/lib/modules/language-server.analyzer.java.jar"),
            home.resolve("plugins/kotlin/lib/modules/language-server.analyzer.kotlin.jar"),
            home.resolve("plugins/xml/lib/modules/language-server.analyzer.xml.jar")
        ).map { it.toUri().toURL() }.toTypedArray()
        URLClassLoader(urls, sourceLoader).use { bootstrap ->
            @Suppress("UNCHECKED_CAST")
            val native = ServiceLoader.load(Supplier::class.java, bootstrap).single().get()
                    as List<PluginMainDescriptor>
            CurrentProductMode.withProductMode(ProductMode.MONOLITH) {
                val junit = checkNotNull(sources["JUnit"] as? PluginMainDescriptor)
                val plugins = defaultPluginSet(native + android + junit)
                check(plugins.enabledPlugins.any { it.pluginId.idString == "JUnit" })
                check(plugins.enabledPlugins.none {
                    it.pluginId.idString == "org.jetbrains.ls.feature.kotlin" || it.pluginId.idString.contains(".dap")
                })
                val core = checkNotNull(plugins.findEnabledModule(coreId))
                check(!plugins.isModuleEnabled(dapId))
                check(core.pluginClassLoader === sourceLoader)
                check(sourceLoader.javaClass.name == "com.intellij.ide.plugins.cl.PluginClassLoader")
                val xml = native.single { it.pluginId.idString == "org.jetbrains.ls.plugin.xml" }
                val xmlModule = xml.contentModules.single { it.moduleId.name == "language-server.analyzer.xml" }
                checkNotNull(xmlModule.pluginClassLoader).loadClass("com.intellij.ide.highlighter.XmlFileType")
                println("SLIM_BOOTSTRAP_OK xml-modules=${xml.contentModules.size} core=ENABLED dap=absent kotlin-feature=absent")
                runBlocking {
                    withAnalyzer(isUnitTestMode = true) { analyzer ->
                        val importedModel = readImportedModel(index)
                        val slimIndex = index.resolveSibling("${index.fileName}-slim")
                        val config = LSWorkspaceConfig(
                            indexPath = slimIndex,
                            workspaceFolders = listOf(project),
                            collectRocksDbStatistics = false,
                            libraryRootsModeForTests = LibraryRootsMode.IncludeSources,
                            analysisPluginSet = plugins,
                            importPluginSet = plugins,
                            writePluginSet = plugins,
                            debuggerPluginSet = plugins,
                            indexingPluginSet = plugins,
                            workspaceComponents = emptyList(),
                            pathMapping = PathMapping.ofWorkspaceFolders(listOf(project)),
                            forkFromIndexPath = null,
                            buildToolDrivers = emptyMap(),
                            moduleMappers = emptyMap(),
                            importFolders = emptyList(),
                            rootUri = URI(project.toUri().toString()),
                            importOptions = InitializeOptions(defaultSdk = Path.of(args[2]), indexDir = slimIndex),
                            importOnOpen = false,
                            configData = LSConfigurationData.EMPTY,
                            indexingFileSystemProvider = NativeIndexingFileSystemProvider,
                            lspToIJLanguage = emptyMap()
                        )
                        URLClassLoader(arrayOf(Path.of(args[3]).toUri().toURL()), sourceLoader).use { caller ->
                            @Suppress("UNCHECKED_CAST")
                            val invocation = ServiceLoader.load(Consumer::class.java, caller).single()
                                    as Consumer<Pair<LSServer, LspHandlerContext>>
                            check(invocation.javaClass.classLoader === caller)
                            workspaceManager(analyzer).use { manager ->
                                manager.workspace(config).use { workspace ->
                                    val structure = workspace.workspaceStructure
                                    val update = structure.prepareWorkspaceModelUpdate { urls, storage ->
                                        val imported = checkNotNull(
                                            deserializeWorkspaceModelCache(
                                                importedModel,
                                                buildUrlRelativizer(config.pathMapping),
                                                urls
                                            )
                                        ) { "Cannot deserialize imported native workspace model" }
                                        storage.applyChangesWithDeduplication(imported)
                                    }
                                    structure.applyWorkspaceModelUpdate(update).await()
                                    workspace.session(LSSessionConfig(null, true, false, false, false, false))
                                        .use { server ->
                                            server.waitForHighWatermark()
                                            val incoming = Channel<LspWireBody>(Channel.UNLIMITED)
                                            val outgoing = Channel<LspWireOutgoing>(Channel.UNLIMITED)
                                            try {
                                                withLsp(incoming, outgoing, LspHandlers.EMPTY) { client ->
                                                    invocation.accept(server to LspHandlerContext(client, this))
                                                }
                                            } finally {
                                                incoming.close()
                                                outgoing.close()
                                            }
                                        }
                                }
                            }
                        }
                    }
                }
                println("SLIM_ANDROID_ANALYSIS_OK core=ENABLED dap=absent kotlin-feature=absent")
            }
        }
    }

    private suspend fun readImportedModel(index: Path): ByteArray {
        val rocks = index.resolve("rocks")
        val version = Files.list(rocks).use { paths ->
            paths.filter {
                it.fileName.toString().matches(Regex("v\\d+")) && Files.isRegularFile(it.resolve("CURRENT"))
            }.toList().single().fileName.toString().drop(1).toInt()
        }
        // The slim index has a different schema; transfer native entities, not index data.
        return Db.open(rocks, version, createIfMissing = false, deleteStaleVersions = false).use { db ->
            Workspace.open(db, emptyMap(), IndexSerializers.EMPTY).use { source ->
                checkNotNull(source.readWorkspaceModelCache()) { "Imported native workspace has no model cache" }
            }
        }
    }
}
