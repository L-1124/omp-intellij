package org.jetbrains.android.lint;

import com.android.ide.common.rendering.api.ArrayResourceValueImpl;
import com.android.ide.common.rendering.api.AttributeFormat;
import com.android.ide.common.rendering.api.AttrResourceValueImpl;
import com.android.ide.common.rendering.api.PluralsResourceValueImpl;
import com.android.ide.common.rendering.api.ResourceNamespace;
import com.android.ide.common.rendering.api.ResourceValue;
import com.android.ide.common.rendering.api.ResourceValueImpl;
import com.android.ide.common.rendering.api.StyleItemResourceValueImpl;
import com.android.ide.common.rendering.api.StyleResourceValueImpl;
import com.android.ide.common.rendering.api.StyleableResourceValueImpl;
import com.android.ide.common.resources.AbstractResourceRepository;
import com.android.ide.common.resources.ResourceItem;
import com.android.ide.common.resources.ResourceRepository;
import com.android.ide.common.resources.ResourceVisitor;
import com.android.ide.common.resources.SingleNamespaceResourceRepository;
import com.android.ide.common.resources.configuration.FolderConfiguration;
import com.android.ide.common.util.PathString;
import com.android.ide.common.resources.ValueXmlHelper;
import com.android.resources.ResourceFolderType;
import com.android.resources.ResourceType;
import com.android.resources.ResourceUrl;
import com.android.tools.lint.client.api.ResourceRepositoryScope;
import com.android.tools.lint.detector.api.Scope;
import com.android.tools.lint.model.LintModelAndroidLibrary;
import com.android.tools.lint.model.LintModelLibrary;
import com.android.tools.lint.model.LintModelVariant;
import com.google.common.collect.ArrayListMultimap;
import com.google.common.collect.ImmutableListMultimap;
import com.google.common.collect.ListMultimap;
import com.intellij.openapi.progress.ProgressManager;
import com.intellij.openapi.module.Module;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.roots.LibraryOrderEntry;
import com.intellij.openapi.roots.ModuleOrderEntry;
import com.intellij.openapi.roots.ModuleRootManager;
import com.intellij.openapi.roots.OrderEntry;
import com.intellij.openapi.roots.OrderRootType;
import com.intellij.openapi.vfs.VfsUtilCore;
import com.intellij.openapi.vfs.VirtualFile;
import com.intellij.psi.xml.XmlAttribute;
import com.intellij.psi.xml.XmlFile;
import com.intellij.psi.xml.XmlTag;
import com.intellij.psi.xml.XmlText;
import org.jetbrains.android.context.AndroidContext;
import org.jetbrains.android.context.AndroidQueryException;
import org.jetbrains.android.resource.AndroidSources;
import org.jetbrains.android.xml.AndroidXml;

import java.io.BufferedReader;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.EnumSet;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Queue;
import java.util.Set;
import java.util.concurrent.CancellationException;
import java.util.regex.Pattern;

public final class AndroidLintResources {
    private static final Pattern R_TXT_LINE = Pattern.compile("^([a-z\\[\\]]+)\\s+([a-zA-Z0-9_]+)\\s+([a-zA-Z0-9_]+)\\s+(.+)$");

    public record Inputs(
            List<Path> resourceRoots,
            List<Path> manifests,
            Path mergedManifest,
            Path manifestMergeReport,
            String fingerprint,
            boolean complete
    ) {
        public Inputs {
            resourceRoots = resourceRoots == null ? List.of() : List.copyOf(resourceRoots);
            manifests = manifests == null ? List.of() : List.copyOf(manifests);
        }
    }

    private record CacheKey(
            Path projectRoot,
            Path moduleRoot,
            String variant,
            ResourceRepositoryScope scope,
            String fingerprint,
            Path currentPath,
            long currentDocStamp
    ) {
    }

    private record CachedRepository(
            LintResourceRepository repository,
            List<Path> trackedDirectories,
            List<Path> trackedFiles
    ) {
    }

    private static final int MAX_CACHE_SIZE = 64;
    private static final Map<CacheKey, CachedRepository> REPO_CACHE = Collections.synchronizedMap(
            new LinkedHashMap<>(64, 0.75f, true) {
                @Override
                protected boolean removeEldestEntry(Map.Entry<CacheKey, CachedRepository> eldest) {
                    return size() > MAX_CACHE_SIZE;
                }
            }
    );

    private record CachedFramework(
            LintResourceRepository repository,
            List<Path> trackedDirectories,
            List<Path> trackedFiles
    ) {
    }

    private static final Map<String, CachedFramework> FRAMEWORK_CACHE = Collections.synchronizedMap(
            new LinkedHashMap<>(16, 0.75f, true) {
                @Override
                protected boolean removeEldestEntry(Map.Entry<String, CachedFramework> eldest) {
                    return size() > 16;
                }
            }
    );

    private AndroidLintResources() {
    }

    public static Scope scope(AndroidLintModel model, Path path) {
        if (model == null || path == null) return null;
        path = path.toAbsolutePath().normalize();
        if (!path.toString().endsWith(".xml")) return null;

        // 1. Check confirmed manifests ONLY (no arbitrary .idea or build manifests)
        if (model.xmlInputs() != null && model.xmlInputs().manifests() != null) {
            for (Path manifest : model.xmlInputs().manifests()) {
                if (path.equals(manifest.toAbsolutePath().normalize())) {
                    return Scope.MANIFEST;
                }
            }
        }

        // 2. Check resource files: must be direct child of resource subfolder (<resRoot>/<folder>/<file.xml>)
        Path parent = path.getParent();
        if (parent != null && parent.getParent() != null) {
            Path grandParent = parent.getParent().toAbsolutePath().normalize();
            if (model.xmlInputs() != null && model.xmlInputs().resourceRoots() != null) {
                for (Path root : model.xmlInputs().resourceRoots()) {
                    if (grandParent.equals(root.toAbsolutePath().normalize())) {
                        ResourceFolderType folder = folderType(path);
                        if (folder != null) {
                            return Scope.RESOURCE_FILE;
                        }
                    }
                }
            }
        }
        return null;
    }

    public static ResourceFolderType folderType(Path path) {
        if (path == null) return null;
        Path parent = path.getParent();
        if (parent == null) return null;
        String folderName = parent.getFileName().toString();
        return ResourceFolderType.getFolderType(folderName);
    }

    public static ResourceRepository getRepository(AndroidLintModel model, ResourceRepositoryScope scope) {
        return getRepository(model, scope, null, null);
    }

    public static ResourceRepository getRepository(
            AndroidLintModel model,
            ResourceRepositoryScope scope,
            Path currentPath,
            XmlFile currentXml
    ) {
        if (model == null) {
            throw AndroidQueryException.modelUnavailable("Model is null; resource repository unavailable");
        }

        if (scope == ResourceRepositoryScope.ANDROID) {
            return getFrameworkRepository(model);
        }

        Inputs inputs = model.xmlInputs();
        if (inputs == null) {
            throw AndroidQueryException.modelUnavailable("Resource inputs are null for " + model.moduleRoot());
        }
        if (!inputs.complete()) {
            throw AndroidQueryException.modelUnavailable("Resource inputs are incomplete or unconfirmed for " + model.moduleRoot());
        }

        Path normCurrentPath = currentPath != null ? currentPath.toAbsolutePath().normalize() : null;
        long currentDocStamp = currentXml != null ? currentXml.getModificationStamp() : 0L;
        CacheKey key = new CacheKey(model.projectRoot(), model.moduleRoot(), model.variant(), scope, inputs.fingerprint(), normCurrentPath, currentDocStamp);
        CachedRepository cached = REPO_CACHE.get(key);
        if (cached != null) {
            for (Path dir : cached.trackedDirectories()) {
                AndroidSources.trackDirectory(dir);
            }
            for (Path file : cached.trackedFiles()) {
                AndroidSources.observeCompiledArchive(file);
            }
            return cached.repository();
        }

        TrackingCollector tracker = new TrackingCollector();
        LintResourceRepository repository = buildRepository(model, scope, normCurrentPath, currentXml, tracker);
        REPO_CACHE.put(key, new CachedRepository(repository, tracker.directories, tracker.files));
        return repository;
    }

    private static ResourceRepository getFrameworkRepository(AndroidLintModel model) {
        if (model.sdkHome() == null || model.compileTarget() == null) {
            throw AndroidQueryException.modelUnavailable("SDK home or compileTarget missing for ANDROID scope repository");
        }
        Path frameworkRes = model.sdkHome().resolve("platforms").resolve(model.compileTarget()).resolve("data/res");
        if (!Files.isDirectory(frameworkRes)) {
            throw AndroidQueryException.modelUnavailable("SDK framework resource directory missing: " + frameworkRes);
        }

        String cacheKey = model.compileTarget() + ":" + frameworkRes;
        CachedFramework cached = FRAMEWORK_CACHE.get(cacheKey);
        if (cached != null) {
            for (Path dir : cached.trackedDirectories()) {
                AndroidSources.trackDirectory(dir);
            }
            for (Path file : cached.trackedFiles()) {
                AndroidSources.observeCompiledArchive(file);
            }
            return cached.repository();
        }

        TrackingCollector tracker = new TrackingCollector();
        LintResourceRepository repo = new LintResourceRepository(ResourceNamespace.ANDROID, "android");
        parseResourceDirectory(model.module().getProject(), frameworkRes, ResourceNamespace.ANDROID, "android", repo, tracker, true, null, null, null);
        FRAMEWORK_CACHE.put(cacheKey, new CachedFramework(repo, tracker.directories, tracker.files));
        return repo;
    }

    private static LintResourceRepository buildRepository(
            AndroidLintModel model,
            ResourceRepositoryScope scope,
            Path currentPath,
            XmlFile currentXml,
            TrackingCollector tracker
    ) {
        Project project = model.module().getProject();
        String pkg = model.namespace();
        ResourceNamespace primaryNs = pkg != null ? ResourceNamespace.fromPackageName(pkg) : ResourceNamespace.RES_AUTO;
        LintResourceRepository repo = new LintResourceRepository(primaryNs, pkg);

        // 1. Own resources in variant precedence order
        List<Path> ownRoots = model.xmlInputs().resourceRoots();
        for (Path root : ownRoots) {
            ProgressManager.checkCanceled();
            parseResourceDirectory(project, root, primaryNs, null, repo, tracker, false, null, currentPath, currentXml);
        }
        // 2. Local dependent project modules (recursive transitive traversal)
        if (scope == ResourceRepositoryScope.LOCAL_DEPENDENCIES || scope == ResourceRepositoryScope.ALL_DEPENDENCIES) {
            Set<Module> visited = new LinkedHashSet<>();
            Queue<Module> queue = new ArrayDeque<>();
            queue.add(model.androidModule());
            visited.add(model.androidModule());
            visited.add(model.module());

            while (!queue.isEmpty()) {
                Module current = queue.poll();
                for (OrderEntry entry : ModuleRootManager.getInstance(current).getOrderEntries()) {
                    ProgressManager.checkCanceled();
                    if (!(entry instanceof ModuleOrderEntry moduleEntry)) continue;
                    Module depModule = moduleEntry.getModule();
                    if (depModule == null || depModule.isDisposed() || !visited.add(depModule)) continue;
                    queue.add(depModule);

                    VirtualFile depRootVf = AndroidContext.findModuleRoot(depModule);
                    if (depRootVf == null) {
                        throw AndroidQueryException.modelUnavailable("Dependency module root not found: " + depModule.getName());
                    }
                    AndroidLintModel depModel = AndroidLintModelResolver.resolve(project, depRootVf, depModule);
                    if (depModel == null || depModel.xmlInputs() == null) {
                        throw AndroidQueryException.modelUnavailable("Model unavailable for dependency module: " + depModule.getName());
                    }
                    if (!depModel.xmlInputs().complete()) {
                        throw AndroidQueryException.modelUnavailable("Model incomplete for dependency module: " + depModule.getName());
                    }

                    String depPkg = depModel.namespace();
                    ResourceNamespace depNs = depPkg != null ? ResourceNamespace.fromPackageName(depPkg) : ResourceNamespace.RES_AUTO;
                    for (Path depResRoot : depModel.xmlInputs().resourceRoots()) {
                        ProgressManager.checkCanceled();
                        parseResourceDirectory(project, depResRoot, depNs, depModule.getName(), repo, tracker, false, null, currentPath, currentXml);
                    }
                }
            }
        }

        // 3. AAR Library dependencies
        if (scope == ResourceRepositoryScope.ALL_DEPENDENCIES) {
            if (model.sdkHome() != null && model.compileTarget() != null) {
                try {
                    repo.setFrameworkFallback(getFrameworkRepository(model));
                } catch (CancellationException e) {
                    throw e;
                } catch (Exception ignored) {
                }
            }

            LintModelVariant variant = model.lintModelVariant();
            if (variant != null && variant.getArtifact() != null && variant.getArtifact().getDependencies() != null) {
                for (LintModelLibrary lib : variant.getArtifact().getDependencies().getAll()) {
                    ProgressManager.checkCanceled();
                    if (lib instanceof LintModelAndroidLibrary androidLib) {
                        File resFolder = androidLib.getResFolder();
                        File symbolFile = androidLib.getSymbolFile();
                        File publicRes = androidLib.getPublicResources();
                        String libName = androidLib.getResolvedCoordinates().toString();
                        ResourceNamespace libNs = ResourceNamespace.RES_AUTO;

                        Set<String> publicNames = parsePublicFile(publicRes != null ? publicRes.toPath() : null, tracker);

                        if (resFolder != null && resFolder.isDirectory()) {
                            parseResourceDirectory(project, resFolder.toPath(), libNs, libName, repo, tracker, false, publicNames, currentPath, currentXml);
                        } else if (symbolFile != null && symbolFile.isFile()) {
                            parseRTxt(symbolFile.toPath(), libNs, libName, repo, tracker, publicNames);
                        }
                    }
                }
            } else {
                for (OrderEntry entry : ModuleRootManager.getInstance(model.androidModule()).getOrderEntries()) {
                    ProgressManager.checkCanceled();
                    if (!(entry instanceof LibraryOrderEntry libEntry) || libEntry.getLibrary() == null) continue;
                    for (String url : libEntry.getLibrary().getUrls(OrderRootType.CLASSES)) {
                        String pathStr = VfsUtilCore.urlToPath(url);
                        int sep = pathStr.indexOf("!/");
                        if (sep >= 0) pathStr = pathStr.substring(0, sep);
                        try {
                            Path classesJar = Path.of(pathStr).toAbsolutePath().normalize();
                            Path parent = classesJar.getParent();
                            if (parent == null) continue;
                            Path resDir = parent.resolve("res");
                            Path rTxt = parent.resolve("R.txt");
                            Path pubTxt = parent.resolve("public.txt");
                            if (!Files.isDirectory(resDir) && parent.getParent() != null) {
                                resDir = parent.getParent().resolve("res");
                                rTxt = parent.getParent().resolve("R.txt");
                                pubTxt = parent.getParent().resolve("public.txt");
                            }
                            String libName = libEntry.getLibraryName();
                            Set<String> publicNames = parsePublicFile(pubTxt, tracker);
                            if (Files.isDirectory(resDir)) {
                                parseResourceDirectory(project, resDir, ResourceNamespace.RES_AUTO, libName, repo, tracker, false, publicNames, currentPath, currentXml);
                            } else if (Files.isRegularFile(rTxt)) {
                                parseRTxt(rTxt, ResourceNamespace.RES_AUTO, libName, repo, tracker, publicNames);
                            }
                        } catch (CancellationException e) {
                            throw e;
                        } catch (Exception ignored) {
                        }
                    }
                }
            }
        }

        return repo;
    }

    private static Set<String> parsePublicFile(Path publicFile, TrackingCollector tracker) {
        if (publicFile == null || !Files.isRegularFile(publicFile)) return null;
        tracker.trackFile(publicFile);
        Set<String> publicNames = new HashSet<>();
        try (BufferedReader reader = Files.newBufferedReader(publicFile, StandardCharsets.UTF_8)) {
            String line;
            while ((line = reader.readLine()) != null) {
                line = line.trim();
                if (line.isEmpty() || line.startsWith("#")) continue;
                String[] parts = line.split("\\s+");
                if (parts.length >= 2) {
                    publicNames.add(parts[0] + ":" + parts[1]);
                }
            }
        } catch (IOException ignored) {
        }
        return publicNames;
    }

    private static void parseResourceDirectory(
            Project project,
            Path resDir,
            ResourceNamespace namespace,
            String libraryName,
            LintResourceRepository repo,
            TrackingCollector tracker,
            boolean isFramework,
            Set<String> publicNames,
            Path currentPath,
            XmlFile currentXml
    ) {
        tracker.trackDirectory(resDir);
        Set<Path> subfolders = new LinkedHashSet<>();
        if (Files.isDirectory(resDir)) {
            try (var stream = Files.list(resDir)) {
                stream.filter(Files::isDirectory).forEach(subfolders::add);
            } catch (IOException ignored) {
            }
        }
        if (currentPath != null && currentPath.getParent() != null && currentPath.getParent().getParent() != null
                && currentPath.getParent().getParent().equals(resDir)) {
            subfolders.add(currentPath.getParent());
        }

        List<Path> sortedSubfolders = subfolders.stream().sorted().toList();
        for (Path subfolder : sortedSubfolders) {
            ProgressManager.checkCanceled();
            tracker.trackDirectory(subfolder);
            String folderName = subfolder.getFileName().toString();
            ResourceFolderType folderType = ResourceFolderType.getFolderType(folderName);
            if (folderType == null) continue;
            FolderConfiguration config = FolderConfiguration.getConfigForFolder(folderName);
            if (config == null) config = FolderConfiguration.createDefault();

            Set<Path> files = new LinkedHashSet<>();
            if (Files.isDirectory(subfolder)) {
                try (var fileStream = Files.list(subfolder)) {
                    fileStream.filter(Files::isRegularFile).forEach(files::add);
                } catch (IOException ignored) {
                }
            }
            if (currentPath != null && currentPath.getParent() != null && currentPath.getParent().equals(subfolder)) {
                files.add(currentPath);
            }

            List<Path> sortedFiles = files.stream().sorted().toList();
            for (Path file : sortedFiles) {
                ProgressManager.checkCanceled();
                tracker.trackFile(file);
                XmlFile xmlFile;
                if (file.equals(currentPath) && currentXml != null) {
                    xmlFile = currentXml;
                } else if (file.toString().endsWith(".xml")) {
                    xmlFile = AndroidSources.diskXml(project, file);
                } else {
                    xmlFile = null;
                }

                if (folderType == ResourceFolderType.VALUES) {
                    if (xmlFile != null) {
                        parseValuesXml(file, xmlFile, namespace, libraryName, config, repo, isFramework, publicNames);
                    }
                } else {
                    parseFileResource(file, xmlFile, folderType, namespace, libraryName, config, repo, publicNames);
                }
            }
        }
    }

    private static void parseFileResource(
            Path file,
            XmlFile xmlFile,
            ResourceFolderType folderType,
            ResourceNamespace namespace,
            String libraryName,
            FolderConfiguration config,
            LintResourceRepository repo,
            Set<String> publicNames
    ) {
        String fileName = file.getFileName().toString();
        int dot = fileName.indexOf('.');
        String resName = dot > 0 ? fileName.substring(0, dot) : fileName;
        ResourceType type = folderType.getResourceType();
        if (type == null) return;

        boolean isPub = publicNames == null || publicNames.contains(type.getName() + ":" + resName);
        PathString pathString = new PathString(file);
        ResourceValueImpl value = new ResourceValueImpl(namespace, type, resName, file.toString(), libraryName);
        LintResourceItem item = new LintResourceItem(resName, type, namespace, libraryName, config, value, pathString, true, isPub);
        repo.add(item);

        if (xmlFile != null && xmlFile.getRootTag() != null) {
            collectIdsFromTag(xmlFile.getRootTag(), namespace, libraryName, config, pathString, repo, publicNames);
        }
    }

    private static void collectIdsFromTag(
            XmlTag tag,
            ResourceNamespace namespace,
            String libraryName,
            FolderConfiguration config,
            PathString pathString,
            LintResourceRepository repo,
            Set<String> publicNames
    ) {
        ProgressManager.checkCanceled();
        for (XmlAttribute attr : tag.getAttributes()) {
            String val = AndroidXml.value(attr);
            if (val != null) {
                ResourceUrl url = ResourceUrl.parse(val);
                if (url != null && url.isCreate() && url.type == ResourceType.ID && !url.isFramework() && url.namespace == null && url.hasValidName()) {
                    String idName = url.name;
                    boolean isPub = publicNames == null || publicNames.contains("id:" + idName);
                    ResourceValueImpl idVal = new ResourceValueImpl(namespace, ResourceType.ID, idName, val, libraryName);
                    LintResourceItem idItem = new LintResourceItem(idName, ResourceType.ID, namespace, libraryName, config, idVal, pathString, false, isPub);
                    repo.add(idItem);
                }
            }
        }
        for (XmlTag child : tag.getSubTags()) {
            collectIdsFromTag(child, namespace, libraryName, config, pathString, repo, publicNames);
        }
    }

    private static void parseValuesXml(
            Path file,
            XmlFile xmlFile,
            ResourceNamespace namespace,
            String libraryName,
            FolderConfiguration config,
            LintResourceRepository repo,
            boolean isFramework,
            Set<String> publicNames
    ) {
        if (xmlFile == null) return;
        XmlTag root = xmlFile.getRootTag();
        if (root == null || !root.getName().equals("resources")) return;

        PathString pathString = new PathString(file);
        Set<String> fileDeclaredPublic = new HashSet<>();
        for (XmlTag tag : root.getSubTags()) {
            if ("public".equals(tag.getName())) {
                String pType = tag.getAttributeValue("type");
                String pName = tag.getAttributeValue("name");
                if (pType != null && pName != null) {
                    fileDeclaredPublic.add(pType + ":" + pName);
                }
            }
        }

        for (XmlTag tag : root.getSubTags()) {
            ProgressManager.checkCanceled();
            String tagName = tag.getName();
            if ("public".equals(tagName)) continue;
            String name = tag.getAttributeValue("name");
            if (name == null || name.isEmpty()) continue;

            ResourceType type = switch (tagName) {
                case "string" -> ResourceType.STRING;
                case "color" -> ResourceType.COLOR;
                case "dimen" -> ResourceType.DIMEN;
                case "bool" -> ResourceType.BOOL;
                case "integer" -> ResourceType.INTEGER;
                case "style" -> ResourceType.STYLE;
                case "attr" -> ResourceType.ATTR;
                case "declare-styleable" -> ResourceType.STYLEABLE;
                case "plurals" -> ResourceType.PLURALS;
                case "array", "string-array", "integer-array" -> ResourceType.ARRAY;
                case "item" -> {
                    String typeAttr = tag.getAttributeValue("type");
                    yield typeAttr != null ? ResourceType.fromXmlTagName(typeAttr) : null;
                }
                default -> ResourceType.fromXmlTagName(tagName);
            };

            if (type == null) continue;

            boolean isPub;
            if (isFramework) {
                isPub = fileDeclaredPublic.contains(type.getName() + ":" + name) || (publicNames != null && publicNames.contains(type.getName() + ":" + name));
            } else if (publicNames != null) {
                isPub = publicNames.contains(type.getName() + ":" + name) || fileDeclaredPublic.contains(type.getName() + ":" + name);
            } else {
                isPub = fileDeclaredPublic.isEmpty() || fileDeclaredPublic.contains(type.getName() + ":" + name);
            }

            ResourceValue resValue;
            if (type == ResourceType.STYLE) {
                String parentStyle = tag.getAttributeValue("parent");
                StyleResourceValueImpl style = new StyleResourceValueImpl(namespace, name, parentStyle, libraryName);
                for (XmlTag itemTag : tag.getSubTags()) {
                    if ("item".equals(itemTag.getName())) {
                        String itemName = itemTag.getAttributeValue("name");
                        String itemVal = parseRawText(itemTag);
                        if (itemName != null) {
                            ResourceNamespace attrNs = namespace;
                            String attrName = itemName;
                            if (itemName.startsWith("android:")) {
                                attrNs = ResourceNamespace.ANDROID;
                                attrName = itemName.substring(8);
                            }
                            style.addItem(new StyleItemResourceValueImpl(attrNs, attrName, itemVal, libraryName));
                            if (!attrNs.equals(ResourceNamespace.RES_AUTO) && !attrNs.equals(ResourceNamespace.ANDROID)) {
                                style.addItem(new StyleItemResourceValueImpl(ResourceNamespace.RES_AUTO, attrName, itemVal, libraryName));
                            }
                        }
                    }
                }
                resValue = style;
            } else if (type == ResourceType.ATTR) {
                resValue = parseAttrTag(tag, namespace, name, libraryName);
            } else if (type == ResourceType.STYLEABLE) {
                StyleableResourceValueImpl styleable = new StyleableResourceValueImpl(namespace, name, null, libraryName);
                for (XmlTag attrTag : tag.getSubTags()) {
                    if ("attr".equals(attrTag.getName())) {
                        String attrName = attrTag.getAttributeValue("name");
                        if (attrName != null && !attrName.isEmpty()) {
                            ResourceNamespace attrNs = namespace;
                            if (attrName.startsWith("android:")) {
                                attrNs = ResourceNamespace.ANDROID;
                                attrName = attrName.substring(8);
                            }
                            AttrResourceValueImpl childAttr = parseAttrTag(attrTag, attrNs, attrName, libraryName);
                            styleable.addValue(childAttr);
                            if (attrNs != ResourceNamespace.ANDROID && hasAttrDefinition(attrTag)) {
                                boolean isChildPub = publicNames == null || publicNames.contains("attr:" + attrName) || fileDeclaredPublic.contains("attr:" + attrName);
                                repo.add(new LintResourceItem(attrName, ResourceType.ATTR, attrNs, libraryName, config, childAttr, pathString, false, isChildPub));
                            }
                        }
                    }
                }
                resValue = styleable;
            } else if (type == ResourceType.ARRAY) {
                ArrayResourceValueImpl arr = new ArrayResourceValueImpl(namespace, name, libraryName);
                for (XmlTag elem : tag.getSubTags()) {
                    arr.addElement(parseRawText(elem));
                }
                resValue = arr;
            } else if (type == ResourceType.PLURALS) {
                PluralsResourceValueImpl plurals = new PluralsResourceValueImpl(namespace, name, null, libraryName);
                for (XmlTag item : tag.getSubTags()) {
                    String quantity = item.getAttributeValue("quantity");
                    if (quantity != null) {
                        plurals.addPlural(quantity, parseRawText(item));
                    }
                }
                resValue = plurals;
            } else {
                String textVal = parseRawText(tag);
                resValue = new ResourceValueImpl(namespace, type, name, textVal, libraryName);
            }

            LintResourceItem item = new LintResourceItem(name, type, namespace, libraryName, config, resValue, pathString, false, isPub);
            repo.add(item);
        }
    }

    private static String parseRawText(XmlTag tag) {
        if (tag == null || tag.getValue() == null) return null;
        if (tag.getValue().hasCDATA()) {
            StringBuilder sb = new StringBuilder();
            for (XmlText text : tag.getValue().getTextElements()) {
                sb.append(text.getValue());
            }
            return sb.toString().trim();
        }
        String raw = tag.getValue().getText();
        if (raw == null) return null;
        return ValueXmlHelper.unescapeResourceString(raw, true, true);
    }

    private static AttrResourceValueImpl parseAttrTag(
            XmlTag tag,
            ResourceNamespace namespace,
            String name,
            String libraryName
    ) {
        AttrResourceValueImpl attr = new AttrResourceValueImpl(namespace, name, libraryName);
        Set<AttributeFormat> formats = EnumSet.noneOf(AttributeFormat.class);
        String formatString = tag.getAttributeValue("format");
        if (formatString != null) {
            formats.addAll(AttributeFormat.parse(formatString));
        }

        for (XmlTag child : tag.getSubTags()) {
            String childName = child.getName();
            if ("enum".equals(childName)) {
                formats.add(AttributeFormat.ENUM);
            } else if ("flag".equals(childName)) {
                formats.add(AttributeFormat.FLAGS);
            } else {
                continue;
            }
            String valName = child.getAttributeValue("name");
            if (valName != null && !valName.isEmpty()) {
                String desc = child.getAttributeValue("description");
                if (desc == null) desc = child.getAttributeValue("_description");
                Integer numericValue = null;
                String valueStr = child.getAttributeValue("value");
                if (valueStr != null) {
                    try {
                        numericValue = Integer.valueOf(Long.decode(valueStr.trim()).intValue());
                    } catch (NumberFormatException ignored) {
                    }
                }
                attr.addValue(valName, numericValue, desc);
            }
        }
        attr.setFormats(formats);

        String description = tag.getAttributeValue("description");
        if (description == null) description = tag.getAttributeValue("_description");
        if (description != null) {
            attr.setDescription(description);
        }
        String groupName = tag.getAttributeValue("_groupName");
        if (groupName != null) {
            attr.setGroupName(groupName);
        }
        return attr;
    }

    private static boolean hasAttrDefinition(XmlTag tag) {
        if (tag.getAttributeValue("format") != null) return true;
        for (XmlTag child : tag.getSubTags()) {
            String name = child.getName();
            if ("enum".equals(name) || "flag".equals(name)) return true;
        }
        return false;
    }

    private static void parseRTxt(
            Path rTxtFile,
            ResourceNamespace namespace,
            String libraryName,
            LintResourceRepository repo,
            TrackingCollector tracker,
            Set<String> publicNames
    ) {
        if (!Files.isRegularFile(rTxtFile)) return;
        tracker.trackFile(rTxtFile);
        try (BufferedReader reader = Files.newBufferedReader(rTxtFile, StandardCharsets.UTF_8)) {
            String line;
            while ((line = reader.readLine()) != null) {
                var matcher = R_TXT_LINE.matcher(line.trim());
                if (matcher.matches()) {
                    String typeStr = matcher.group(2);
                    String name = matcher.group(3);
                    ResourceType type = ResourceType.fromXmlTagName(typeStr);
                    if (type != null) {
                        boolean isPub = publicNames == null || publicNames.contains(type.getName() + ":" + name);
                        // R.txt does not contain actual string values; value is set to null
                        ResourceValueImpl val = new ResourceValueImpl(namespace, type, name, null, libraryName);
                        LintResourceItem item = new LintResourceItem(name, type, namespace, libraryName, FolderConfiguration.createDefault(), val, new PathString(rTxtFile), false, isPub);
                        repo.add(item);
                    }
                }
            }
        } catch (IOException ignored) {
        }
    }

    public static final class LintResourceItem implements ResourceItem {
        private final String name;
        private final ResourceType type;
        private final ResourceNamespace namespace;
        private final String libraryName;
        private final FolderConfiguration configuration;
        private final ResourceValue resourceValue;
        private final PathString source;
        private final boolean fileBased;
        private final boolean isPublic;

        public LintResourceItem(
                String name,
                ResourceType type,
                ResourceNamespace namespace,
                String libraryName,
                FolderConfiguration configuration,
                ResourceValue resourceValue,
                PathString source,
                boolean fileBased,
                boolean isPublic
        ) {
            this.name = name;
            this.type = type;
            this.namespace = namespace;
            this.libraryName = libraryName;
            this.configuration = configuration != null ? configuration : FolderConfiguration.createDefault();
            this.resourceValue = resourceValue;
            this.source = source;
            this.fileBased = fileBased;
            this.isPublic = isPublic;
        }

        @Override
        public String getName() {
            return name;
        }

        @Override
        public ResourceType getType() {
            return type;
        }

        @Override
        public ResourceNamespace getNamespace() {
            return namespace;
        }

        @Override
        public String getLibraryName() {
            return libraryName;
        }

        @Override
        public FolderConfiguration getConfiguration() {
            return configuration;
        }

        @Override
        public ResourceValue getResourceValue() {
            return resourceValue;
        }

        @Override
        public PathString getSource() {
            return source;
        }

        @Override
        public PathString getOriginalSource() {
            return source;
        }

        @Override
        public boolean isFileBased() {
            return fileBased;
        }

        public boolean isPublic() {
            return isPublic;
        }

        @Override
        public String toString() {
            return "LintResourceItem(" + namespace + ":" + type + "/" + name + ")";
        }
    }

    public static final class LintResourceRepository extends AbstractResourceRepository implements SingleNamespaceResourceRepository {
        private final ResourceNamespace defaultNamespace;
        private final String packageName;
        private final Map<ResourceNamespace, Map<ResourceType, ListMultimap<String, ResourceItem>>> storage = new LinkedHashMap<>();
        private final Set<ResourceNamespace> namespaces = new LinkedHashSet<>();
        private ResourceRepository frameworkFallback;

        public LintResourceRepository(ResourceNamespace defaultNamespace, String packageName) {
            this.defaultNamespace = defaultNamespace != null ? defaultNamespace : ResourceNamespace.RES_AUTO;
            this.packageName = packageName;
            this.namespaces.add(this.defaultNamespace);
            this.namespaces.add(ResourceNamespace.RES_AUTO);
        }

        public void setFrameworkFallback(ResourceRepository fallback) {
            this.frameworkFallback = fallback;
        }

        public synchronized void add(ResourceItem item) {
            ResourceNamespace ns = item.getNamespace();
            namespaces.add(ns);
            addItemToNamespace(ns, item);
            if (!ns.equals(ResourceNamespace.RES_AUTO) && !ns.equals(ResourceNamespace.ANDROID)) {
                addItemToNamespace(ResourceNamespace.RES_AUTO, item);
            }
        }

        private void addItemToNamespace(ResourceNamespace ns, ResourceItem item) {
            Map<ResourceType, ListMultimap<String, ResourceItem>> forNs = storage.computeIfAbsent(ns, k -> new LinkedHashMap<>());
            ListMultimap<String, ResourceItem> forType = forNs.computeIfAbsent(item.getType(), k -> ArrayListMultimap.create());

            List<ResourceItem> existing = forType.get(item.getName());
            boolean overridden = false;
            for (ResourceItem ex : existing) {
                if (Objects.equals(ex.getConfiguration(), item.getConfiguration())) {
                    overridden = true;
                    break;
                }
            }
            if (!overridden) {
                forType.put(item.getName(), item);
            }
        }

        @Override
        protected ListMultimap<String, ResourceItem> getResourcesInternal(ResourceNamespace namespace, ResourceType resourceType) {
            Map<ResourceType, ListMultimap<String, ResourceItem>> forNs = storage.get(namespace);
            if (forNs == null && namespace.equals(ResourceNamespace.RES_AUTO)) {
                forNs = storage.get(defaultNamespace);
            } else if (forNs == null && namespace.equals(defaultNamespace)) {
                forNs = storage.get(ResourceNamespace.RES_AUTO);
            }
            if (forNs == null) {
                if (namespace.equals(ResourceNamespace.ANDROID) && frameworkFallback != null) {
                    return frameworkFallback.getResources(namespace, resourceType);
                }
                return ImmutableListMultimap.of();
            }
            ListMultimap<String, ResourceItem> map = forNs.get(resourceType);
            return map != null ? map : ImmutableListMultimap.of();
        }

        @Override
        public boolean hasResources(ResourceNamespace namespace, ResourceType resourceType, String resourceName) {
            boolean has = super.hasResources(namespace, resourceType, resourceName);
            if (!has && namespace.equals(ResourceNamespace.ANDROID) && frameworkFallback != null) {
                return frameworkFallback.hasResources(namespace, resourceType, resourceName);
            }
            return has;
        }

        @Override
        public boolean hasResources(ResourceNamespace namespace, ResourceType resourceType) {
            boolean has = super.hasResources(namespace, resourceType);
            if (!has && namespace.equals(ResourceNamespace.ANDROID) && frameworkFallback != null) {
                return frameworkFallback.hasResources(namespace, resourceType);
            }
            return has;
        }

        @Override
        public ResourceVisitor.VisitResult accept(ResourceVisitor visitor) {
            for (Map<ResourceType, ListMultimap<String, ResourceItem>> forNs : storage.values()) {
                for (ListMultimap<String, ResourceItem> multimap : forNs.values()) {
                    for (ResourceItem item : multimap.values()) {
                        if (visitor.visit(item) == ResourceVisitor.VisitResult.ABORT) {
                            return ResourceVisitor.VisitResult.ABORT;
                        }
                    }
                }
            }
            return ResourceVisitor.VisitResult.CONTINUE;
        }

        @Override
        public ResourceNamespace getNamespace() {
            return defaultNamespace;
        }

        @Override
        public String getPackageName() {
            return packageName;
        }

        @Override
        public Set<ResourceNamespace> getNamespaces() {
            return Collections.unmodifiableSet(namespaces);
        }

        @Override
        public Collection<ResourceItem> getPublicResources(ResourceNamespace namespace, ResourceType type) {
            List<ResourceItem> all = getResources(namespace, type).values().stream().toList();
            List<ResourceItem> pub = new ArrayList<>();
            for (ResourceItem item : all) {
                if (item instanceof LintResourceItem lri && lri.isPublic()) {
                    pub.add(item);
                }
            }
            return pub;
        }

        @Override
        public Collection<SingleNamespaceResourceRepository> getLeafResourceRepositories() {
            return Collections.singletonList(this);
        }
    }

    private static final class TrackingCollector {
        final List<Path> directories = new ArrayList<>();
        final List<Path> files = new ArrayList<>();
        final Set<Path> seenDirs = new LinkedHashSet<>();
        final Set<Path> seenFiles = new LinkedHashSet<>();

        void trackDirectory(Path dir) {
            if (dir != null && seenDirs.add(dir.toAbsolutePath().normalize())) {
                directories.add(dir.toAbsolutePath().normalize());
                AndroidSources.trackDirectory(dir);
            }
        }

        void trackFile(Path file) {
            if (file != null && seenFiles.add(file.toAbsolutePath().normalize())) {
                files.add(file.toAbsolutePath().normalize());
                AndroidSources.observeCompiledArchive(file);
            }
        }
    }
}
