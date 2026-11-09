package org.jetbrains.android.navigation;

import com.intellij.find.findUsages.FindUsagesHandler;
import com.intellij.find.findUsages.FindUsagesManager;
import com.intellij.find.findUsages.FindUsagesOptions;
import com.intellij.openapi.editor.Document;
import com.intellij.openapi.module.Module;
import com.intellij.openapi.module.ModuleManager;
import com.intellij.openapi.progress.ProgressManager;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.roots.LibraryOrderEntry;
import com.intellij.openapi.roots.ModuleRootManager;
import com.intellij.openapi.roots.OrderRootType;
import com.intellij.openapi.util.TextRange;
import com.intellij.openapi.vfs.VfsUtilCore;
import com.intellij.openapi.vfs.VirtualFile;
import com.intellij.psi.*;
import com.intellij.psi.search.GlobalSearchScope;
import com.intellij.psi.search.searches.ReferencesSearch;
import com.intellij.psi.util.PsiTreeUtil;
import com.intellij.psi.xml.XmlAttribute;
import com.intellij.psi.xml.XmlAttributeValue;
import com.intellij.psi.xml.XmlFile;
import com.intellij.psi.xml.XmlTag;
import com.jetbrains.ls.api.core.features.LSDefinitionLocation;
import com.jetbrains.ls.api.core.util.PositionKt;
import com.jetbrains.lsp.protocol.Location;
import kotlinx.serialization.json.Json;
import kotlinx.serialization.json.JsonArray;
import kotlinx.serialization.json.JsonElement;
import kotlinx.serialization.json.JsonElementKt;
import kotlinx.serialization.json.JsonObject;
import org.jetbrains.android.context.AndroidContext;
import org.jetbrains.android.context.AndroidFileInfo;
import org.jetbrains.android.context.AndroidFileRole;
import org.jetbrains.android.context.AndroidQueryException;
import org.jetbrains.android.resource.ResourceReference;
import org.jetbrains.android.resource.ResourceResolver;
import org.jetbrains.android.xml.AndroidXml;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.*;

public final class AndroidNavigationService {
    private static final AndroidNavigationService INSTANCE = new AndroidNavigationService();

    private AndroidNavigationService() {
    }

    public static AndroidNavigationService getInstance() {
        return INSTANCE;
    }

    public List<Location> getReferences(Project project, PsiFile file, int offset, boolean includeDeclaration) {
        ManifestClassTarget target = checkedTarget(project, file, offset);
        if (target != null) {
            return getManifestReferences(project, file, target, includeDeclaration);
        }

        ResourceDeclarationTarget resTarget = resolveResourceDeclaration(project, file, offset);
        if (resTarget != null) {
            return findResourceFieldReferences(
                    project,
                    resTarget.module(),
                    resTarget.namespace(),
                    resTarget.variant(),
                    resTarget.type(),
                    resTarget.name(),
                    null,
                    includeDeclaration,
                    resTarget.declarationLocation(),
                    null
            );
        }

        return List.of();
    }

    private List<Location> getManifestReferences(Project project, PsiFile file, ManifestClassTarget target, boolean includeDeclaration) {
        PsiElement element = target.targetElement();
        FindUsagesHandler handler = new FindUsagesManager(project).getFindUsagesHandler(element, true);
        if (handler == null) throw AndroidQueryException.modelUnavailable("Native class usage handler unavailable");
        var result = new LinkedHashSet<Location>();
        if (includeDeclaration) {
            Location declaration = PositionKt.getLspLocationForDefinition(element);
            if (declaration == null) throw AndroidQueryException.targetUnresolved(target.fqcn());
            result.add(declaration);
        }
        FindUsagesOptions options = handler.getFindUsagesOptions();
        options.isSearchForTextOccurrences = false;
        handler.processElementUsages(element, usage -> {
            ProgressManager.checkCanceled();
            PsiElement reference = usage.getElement();
            if (reference != null && !(reference.getContainingFile() instanceof XmlFile)) {
                Location location = PositionKt.getLspLocationForDefinition(reference);
                if (location != null) synchronized (result) {
                    result.add(location);
                }
            }
            return true;
        }, options);
        ProgressManager.checkCanceled();
        Document document = PsiDocumentManager.getInstance(project).getDocument(file);
        if (document == null) throw AndroidQueryException.modelUnavailable("Current XML document unavailable");
        Location current = PositionKt.toLspLocation(target.sourceValueRange(), file.getVirtualFile(), document);
        if (current == null) throw AndroidQueryException.modelUnavailable("Current XML location unavailable");
        result.add(current);
        return new ArrayList<>(result);
    }

    public static ResourceDeclarationTarget resolveResourceDeclaration(Project project, PsiFile file, int offset) {
        ProgressManager.checkCanceled();
        if (!(file instanceof XmlFile xml)) return null;
        AndroidFileInfo info = AndroidContext.identify(xml);
        if (!info.isAndroidFile()) return null;
        if (info.module() == null) return null;
        String namespace = info.namespace();
        String variant = info.variant();

        if (info.role() == AndroidFileRole.VALUES_XML) {
            PsiElement element = xml.findElementAt(offset);
            XmlTag tag = PsiTreeUtil.getParentOfType(element, XmlTag.class, false);
            if (tag == null) return null;
            XmlTag parent = tag.getParentTag();
            if (parent == null || !"resources".equals(parent.getName())) return null;
            String tagName = tag.getName();
            // Attribute and declare-styleable resources have distinct search paths;
            // keep native behavior per §7.4.
            if ("declare-styleable".equals(tagName) || "attr".equals(tagName)) return null;
            XmlAttribute nameAttr = tag.getAttribute("name");
            if (nameAttr == null || nameAttr.getValueElement() == null) return null;
            String rawName = AndroidXml.value(nameAttr);
            if (rawName == null || rawName.isBlank()) return null;
            String type;
            if ("item".equals(tagName)) {
                String rawType = AndroidXml.value(tag.getAttribute("type"));
                if (rawType == null || rawType.isBlank()) return null;
                type = rawType;
            } else if ("string-array".equals(tagName) || "integer-array".equals(tagName)) {
                type = "array";
            } else {
                type = tagName;
            }
            if ("attr".equals(type) || "declare-styleable".equals(type) || "styleable".equals(type)) {
                return null;
            }
            XmlAttributeValue val = nameAttr.getValueElement();
            TextRange nameRange = val.getValueTextRange();
            TextRange attrRange = nameAttr.getTextRange();
            int tagStart = tag.getTextOffset();
            int tagHeaderEnd = Math.min(tagStart + tagName.length() + 1, xml.getTextLength());
            TextRange tagRange = new TextRange(tagStart, tagHeaderEnd);
            if (!nameRange.contains(offset) && !attrRange.contains(offset) && !tagRange.contains(offset)) {
                return null;
            }
            Document document = PsiDocumentManager.getInstance(project).getDocument(xml);
            if (document == null) return null;
            Location declLoc = PositionKt.toLspLocation(nameRange, xml.getVirtualFile(), document);
            return new ResourceDeclarationTarget(info.module(), namespace, variant, type, rawName, declLoc);
        }

        if (info.role() == AndroidFileRole.RESOURCE_XML) {
            VirtualFile vFile = xml.getVirtualFile();
            VirtualFile parent = vFile != null ? vFile.getParent() : null;
            if (parent == null) return null;
            String folder = parent.getName();
            String type = folder.split("-", 2)[0];
            String fileName = xml.getName();
            int dot = fileName.indexOf('.');
            String rawName = dot >= 0 ? fileName.substring(0, dot) : fileName;
            XmlTag rootTag = xml.getRootTag();
            if (rootTag == null) return null;
            PsiElement nameToken = rootTag.getFirstChild();
            while (nameToken != null && !nameToken.getText().equals(rootTag.getName())) {
                nameToken = nameToken.getNextSibling();
            }
            int tagStart = rootTag.getTextOffset();
            TextRange tokenRange = nameToken != null ? nameToken.getTextRange()
                    : new TextRange(tagStart + 1, tagStart + 1 + rootTag.getName().length());
            TextRange rootHeaderRange = new TextRange(tagStart, tokenRange.getEndOffset());
            if (!rootHeaderRange.contains(offset)) {
                // Do not treat arbitrary elements inside file resources as resource declarations
                return null;
            }
            Document document = PsiDocumentManager.getInstance(project).getDocument(xml);
            if (document == null) return null;
            Location declLoc = PositionKt.toLspLocation(tokenRange, xml.getVirtualFile(), document);
            return new ResourceDeclarationTarget(info.module(), namespace, variant, type, rawName, declLoc);
        }

        return null;
    }

    public List<Location> findResourceFieldReferences(
            Project project,
            Module ownerModule,
            String namespace,
            String variant,
            String type,
            String name,
            List<Path> candidateClassOrigins,
            boolean includeDeclaration,
            Location declarationLocation,
            List<Path> participatingClassOriginsOut
    ) {
        ProgressManager.checkCanceled();
        if (ownerModule == null) {
            throw AndroidQueryException.modelUnavailable("Owner module unavailable");
        }
        VirtualFile moduleRootVf = AndroidContext.findModuleRoot(ownerModule);
        if (moduleRootVf == null) {
            throw AndroidQueryException.modelUnavailable("Module root unavailable for " + ownerModule.getName());
        }
        Path moduleRoot = Path.of(moduleRootVf.getPath()).toAbsolutePath().normalize();

        if (variant == null) {
            throw AndroidQueryException.ambiguousVariant("Variant ambiguous for " + ownerModule.getName());
        }
        if (namespace == null || namespace.isBlank()) {
            throw AndroidQueryException.targetUnresolved("Namespace unresolved for " + ownerModule.getName());
        }

        // Verify AGP build snapshot provenance
        ResourceResolver.verifyProvenance(project, moduleRoot, variant, namespace, type, name);

        // Verify class origins
        List<Path> verifiedJars = ResourceResolver.findVerifiedRClassOrigins(moduleRoot, variant);
        Path intermediatesDir = moduleRoot.resolve("build/intermediates");
        for (var entry : ModuleRootManager.getInstance(ownerModule).getOrderEntries()) {
            if (entry instanceof LibraryOrderEntry lib && lib.getLibrary() != null) {
                for (String url : lib.getLibrary().getUrls(OrderRootType.CLASSES)) {
                    String cleanPath = VfsUtilCore.urlToPath(url);
                    int sep = cleanPath.indexOf("!/");
                    if (sep >= 0) cleanPath = cleanPath.substring(0, sep);
                    try {
                        Path p = Path.of(cleanPath).toAbsolutePath().normalize();
                        if (p.startsWith(intermediatesDir) && p.toString().replace('\\', '/').contains("/" + variant + "/") && Files.isRegularFile(p)) {
                            if (!verifiedJars.contains(p)) verifiedJars.add(p);
                        }
                    } catch (Exception ignored) {
                    }
                }
            }
        }
        if (verifiedJars.isEmpty()) {
            throw AndroidQueryException.missingSnapshot("Compiled R jar not found for variant " + variant);
        }

        Set<Path> allowedOrigins = new LinkedHashSet<>();
        if (candidateClassOrigins != null && !candidateClassOrigins.isEmpty()) {
            for (Path candidate : candidateClassOrigins) {
                if (!Files.isRegularFile(candidate) || !candidate.startsWith(intermediatesDir)
                        || !candidate.toString().replace('\\', '/').contains("/" + variant + "/")) {
                    throw AndroidQueryException.ambiguousTarget("Class origin does not belong to owner module and variant: " + candidate);
                }
                if (!verifiedJars.contains(candidate)) {
                    throw AndroidQueryException.missingSnapshot("Class origin is not a verified build artifact for variant " + variant + ": " + candidate);
                }
                allowedOrigins.add(candidate);
            }
        } else {
            allowedOrigins.addAll(verifiedJars);
        }

        // Locate R class in owner module scope
        JavaPsiFacade facade = JavaPsiFacade.getInstance(project);
        GlobalSearchScope depLibScope = ownerModule.getModuleWithDependenciesAndLibrariesScope(false);
        PsiClass[] rClasses = facade.findClasses(namespace + ".R", depLibScope);
        if (rClasses.length == 0) {
            throw AndroidQueryException.classNotFound(namespace + ".R");
        }

        List<PsiClass> verifiedRClasses = new ArrayList<>();
        for (PsiClass rClass : rClasses) {
            ProgressManager.checkCanceled();
            PsiFile containing = rClass.getContainingFile();
            if (containing == null || containing.getVirtualFile() == null) continue;
            String path = containing.getVirtualFile().getPath();
            int sep = path.indexOf("!/");
            if (sep >= 0) path = path.substring(0, sep);
            Path archive = Path.of(path).toAbsolutePath().normalize();
            if (allowedOrigins.contains(archive)) {
                verifiedRClasses.add(rClass);
                if (participatingClassOriginsOut != null && !participatingClassOriginsOut.contains(archive)) {
                    participatingClassOriginsOut.add(archive);
                }
            }
        }
        // AGP application R archives also contain dependency namespaces. Search only compiled copies
        // in imported consumers; an unrelated module with the same namespace remains excluded.
        for (Module consumer : com.intellij.openapi.module.ModuleManager.getInstance(project).getModules()) {
            if (consumer == ownerModule || !consumer.getModuleWithDependenciesScope().isSearchInModuleContent(ownerModule)) continue;
            var consumerRoot = AndroidContext.findModuleRoot(consumer);
            String consumerVariant = AndroidContext.resolveVariant(consumer, consumerRoot);
            if (consumerRoot == null || consumerVariant == null) continue;
            if (namespace.equals(AndroidContext.resolveNamespace(project, consumer))) continue;
            for (Module dependency : com.intellij.openapi.module.ModuleManager.getInstance(project).getModules()) {
                if (!consumer.getModuleWithDependenciesScope().isSearchInModuleContent(dependency)) continue;
                if (!namespace.equals(AndroidContext.resolveNamespace(project, dependency))) continue;
                var dependencyRoot = AndroidContext.findModuleRoot(dependency);
                if (dependencyRoot != null && !Path.of(dependencyRoot.getPath()).toAbsolutePath().normalize()
                        .equals(moduleRoot)) {
                    throw AndroidQueryException.ambiguousTarget("Consumer has multiple resource owners for " + namespace);
                }
            }
            Set<Path> copies = new HashSet<>(ResourceResolver.findVerifiedRClassOrigins(Path.of(consumerRoot.getPath()), consumerVariant));
            for (PsiClass copy : facade.findClasses(namespace + ".R", consumer.getModuleWithDependenciesAndLibrariesScope(false))) {
                PsiFile containing = copy.getContainingFile();
                String path = containing == null || containing.getVirtualFile() == null ? "" : containing.getVirtualFile().getPath();
                int separator = path.indexOf("!/");
                if (separator < 0) continue;
                Path archive = Path.of(path.substring(0, separator)).toAbsolutePath().normalize();
                if (!copies.contains(archive)) continue;
                if (!verifiedRClasses.contains(copy)) verifiedRClasses.add(copy);
                if (participatingClassOriginsOut != null && !participatingClassOriginsOut.contains(archive)) {
                    participatingClassOriginsOut.add(archive);
                }
            }
        }
        if (verifiedRClasses.isEmpty()) {
            throw AndroidQueryException.classNotFound("Verified R class not found for " + namespace + ".R");
        }

        String rTypeName = (type.equals("string-array") || type.equals("integer-array")) ? "array" : type;
        String rFieldName = name.replace('.', '_').replace(':', '_');
        List<PsiField> fields = new ArrayList<>();
        for (PsiClass rClass : verifiedRClasses) {
            ProgressManager.checkCanceled();
            PsiClass inner = rClass.findInnerClassByName(rTypeName, false);
            if (inner == null) {
                throw AndroidQueryException.fieldNotFound("Inner R class not found for R." + rTypeName);
            }
            PsiField field = inner.findFieldByName(rFieldName, false);
            if (field == null) {
                throw AndroidQueryException.fieldNotFound("R field not found for R." + rTypeName + "." + rFieldName);
            }
            fields.add(field);
        }

        // Search scope: intersection of ownerModule.getModuleWithDependentsScope() and projectScope
        GlobalSearchScope projectScope = GlobalSearchScope.projectScope(project);
        GlobalSearchScope dependentsScope = ownerModule.getModuleWithDependentsScope();
        GlobalSearchScope searchScope = dependentsScope.intersectWith(projectScope);

        Set<Location> codeReferences = new LinkedHashSet<>();
        Map<Document, Long> docStamps = new LinkedHashMap<>();
        for (PsiField field : fields) {
            ProgressManager.checkCanceled();
            // Proven ownership and the imported consumer graph define visibility, including omitted library R roots.
            ReferencesSearch.search(field, searchScope, true).forEach(reference -> {
                ProgressManager.checkCanceled();
                PsiElement element = reference.getElement();
                if (element == null) return true;
                PsiFile containing = element.getContainingFile();
                if (containing == null || containing instanceof XmlFile) return true;
                VirtualFile vFile = containing.getVirtualFile();
                if (vFile == null || !vFile.isValid()) return true;
                org.jetbrains.android.resource.AndroidSources.observe(vFile);
                Document doc = containing.getFileDocument();
                if (doc == null) return true;
                synchronized (docStamps) {
                    docStamps.putIfAbsent(doc, doc.getModificationStamp());
                }

                int start = element.getTextRange().getStartOffset() + reference.getRangeInElement().getStartOffset();
                int end = element.getTextRange().getStartOffset() + reference.getRangeInElement().getEndOffset();
                if (start < 0 || end > doc.getTextLength() || start > end) return true;

                Location loc = PositionKt.toLspLocation(new TextRange(start, end), vFile, doc);
                if (loc != null) {
                    synchronized (codeReferences) {
                        codeReferences.add(loc);
                    }
                }
                return true;
            });
        }

        ProgressManager.checkCanceled();
        for (var entry : docStamps.entrySet()) {
            if (entry.getKey().getModificationStamp() != entry.getValue()) {
                throw new AndroidQueryException("content_modified", -32801);
            }
        }

        List<Location> result = new ArrayList<>();
        if (includeDeclaration && declarationLocation != null) {
            result.add(declarationLocation);
        }
        result.addAll(codeReferences);
        return result;
    }

    public JsonObject findResourceFieldReferencesCommand(
            Project project,
            String moduleName,
            String namespace,
            String type,
            String name,
            List<Path> candidateClassOrigins
    ) {
        Module ownerModule = requireModule(project, moduleName, namespace);
        VirtualFile moduleRootVf = AndroidContext.findModuleRoot(ownerModule);
        if (moduleRootVf == null) {
            throw AndroidQueryException.modelUnavailable("Module root not found for " + moduleName);
        }
        String variant = AndroidContext.resolveVariant(ownerModule, moduleRootVf);
        if (variant == null) {
            throw AndroidQueryException.ambiguousVariant("Variant ambiguous for " + moduleName);
        }

        List<Path> participatingOrigins = new ArrayList<>();
        List<Location> references = findResourceFieldReferences(
                project, ownerModule, namespace, variant, type, name,
                candidateClassOrigins, false, null, participatingOrigins
        );

        Map<String, JsonElement> response = new LinkedHashMap<>();
        response.put("protocolVersion", JsonElementKt.JsonPrimitive(1));
        response.put("fieldResolved", JsonElementKt.JsonPrimitive(true));

        List<JsonElement> refElements = new ArrayList<>();
        for (Location loc : references) {
            refElements.add(Json.Default.encodeToJsonElement(Location.Companion.serializer(), loc));
        }
        response.put("references", new JsonArray(refElements));

        Map<String, JsonElement> originObj = new LinkedHashMap<>();
        originObj.put("moduleName", JsonElementKt.JsonPrimitive(ownerModule.getName()));
        originObj.put("namespace", JsonElementKt.JsonPrimitive(namespace));
        List<JsonElement> originUris = new ArrayList<>();
        for (Path p : participatingOrigins) {
            originUris.add(JsonElementKt.JsonPrimitive(p.toUri().toString()));
        }
        originObj.put("classOrigins", new JsonArray(originUris));
        response.put("origin", new JsonObject(originObj));

        return new JsonObject(response);
    }

    private static Module requireModule(Project project, String moduleName, String namespace) {
        Module module = ModuleManager.getInstance(project).findModuleByName(moduleName);
        if (module == null || !AndroidContext.isAndroidModule(module)) {
            throw AndroidQueryException.modelUnavailable("Android module not found: " + moduleName);
        }
        verifyModuleNamespace(project, module, namespace);
        return module;
    }

    private static void verifyModuleNamespace(Project project, Module module, String namespace) {
        if (namespace != null && !namespace.isBlank()) {
            String resolvedNs = AndroidContext.resolveNamespace(project, module);
            if (!namespace.equals(resolvedNs)) {
                throw AndroidQueryException.targetUnresolved("Namespace mismatch for module " + module.getName()
                        + ": expected " + namespace + " but got " + resolvedNs);
            }
        }
    }


    public List<LSDefinitionLocation> getDefinitions(Project project, PsiFile file, int offset) {
        ManifestClassTarget target = checkedTarget(project, file, offset);
        if (target != null) {
            Location location = PositionKt.getLspLocationForDefinition(target.targetElement());
            if (location == null) throw AndroidQueryException.targetUnresolved(target.fqcn());
            Document document = PsiDocumentManager.getInstance(project).getDocument(file);
            return List.of(new LSDefinitionLocation(location, PositionKt.toLspRange(target.sourceValueRange(), document)));
        }
        AndroidFileInfo info = AndroidContext.identify(file);
        if (!info.isAndroidFile()) return List.of();
        ResourceReference reference = info.role() == AndroidFileRole.KOTLIN_OR_JAVA
                ? ResourceResolver.findRReferenceAt(project, file, offset) : ResourceResolver.findResourceReferenceAt(file, offset);
        if (reference == null || reference.isFramework()) return List.of();
        return ResourceResolver.resolve(project, info.module(), reference);
    }

    private static ManifestClassTarget checkedTarget(Project project, PsiFile file, int offset) {
        ProgressManager.checkCanceled();
        ManifestClassTarget target = ManifestTarget.resolve(project, file, offset);
        if (target == null || !target.isClassAttribute()) return null;
        if (target.failureReason() != null)
            throw new AndroidQueryException(target.failureReason() + ": " + target.fqcn());
        return target;
    }
}
