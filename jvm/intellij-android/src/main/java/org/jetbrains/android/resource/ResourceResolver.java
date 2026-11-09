package org.jetbrains.android.resource;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.openapi.editor.Document;
import com.intellij.openapi.module.Module;
import com.intellij.openapi.module.ModuleManager;
import com.intellij.openapi.progress.ProgressManager;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.util.TextRange;
import com.intellij.openapi.vfs.VirtualFile;
import com.intellij.psi.*;
import com.intellij.psi.util.PsiTreeUtil;
import com.intellij.psi.xml.XmlAttribute;
import com.intellij.psi.xml.XmlAttributeValue;
import com.intellij.psi.xml.XmlFile;
import com.intellij.psi.xml.XmlTag;
import com.jetbrains.ls.api.core.features.LSDefinitionLocation;
import com.jetbrains.ls.api.core.util.PositionKt;
import com.jetbrains.lsp.protocol.Location;
import com.jetbrains.lsp.protocol.Position;
import com.jetbrains.lsp.protocol.Range;
import org.jetbrains.android.context.AndroidContext;
import org.jetbrains.android.context.AndroidQueryException;
import org.jetbrains.android.xml.AndroidXml;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.*;

public final class ResourceResolver {
    private static final java.util.regex.Pattern RESOURCE_TYPE = java.util.regex.Pattern.compile("[a-z][a-z0-9_]*");
    private static final java.util.regex.Pattern RESOURCE_NAME = java.util.regex.Pattern.compile("[A-Za-z_][A-Za-z0-9_.:]*");

    private ResourceResolver() {
    }

    public static ResourceReference findResourceReferenceAt(PsiFile file, int offset) {
        if (!(file instanceof XmlFile)) return null;
        XmlAttributeValue value = PsiTreeUtil.getParentOfType(file.findElementAt(offset), XmlAttributeValue.class, false);
        if (value == null || !value.getValueTextRange().contains(offset)) return null;
        String text = value.getParent() instanceof XmlAttribute attribute ? AndroidXml.value(attribute) : null;
        if (text == null || text.length() < 2 || (text.charAt(0) != '@' && text.charAt(0) != '?')) return null;
        boolean attribute = text.charAt(0) == '?';
        String body = text.substring(text.startsWith("@+") ? 2 : 1);
        int colon = body.indexOf(':');
        String namespace = colon < 0 ? null : body.substring(0, colon);
        if (colon >= 0) body = body.substring(colon + 1);
        int slash = body.indexOf('/');
        String type = slash < 0 && attribute ? "attr" : slash < 0 ? null : body.substring(0, slash);
        String name = slash < 0 ? body : body.substring(slash + 1);
        if (type == null || !RESOURCE_TYPE.matcher(type).matches() || !RESOURCE_NAME.matcher(name).matches())
            return null;
        Document document = file == null ? null : file.getFileDocument();
        if (document == null && file != null) document = PsiDocumentManager.getInstance(file.getProject()).getDocument(file);
        if (document == null) return null;
        return new ResourceReference(type, name, namespace, "android".equals(namespace), PositionKt.toLspRange(value.getValueTextRange(), document), null);
    }

    public static ResourceReference findRReferenceAt(Project project, PsiFile file, int offset) {
        PsiElement element = file.findElementAt(offset);
        Document document = file == null ? null : file.getFileDocument();
        if (document == null && file != null) document = PsiDocumentManager.getInstance(project).getDocument(file);
        if (document == null) return null;
        Set<PsiField> fields = new LinkedHashSet<>();
        TextRange referenceRange = null;
        for (PsiElement current = element; current != null && current != file; current = current.getParent()) {
            ProgressManager.checkCanceled();
            for (PsiReference reference : current.getReferences()) {
                if (!reference.getRangeInElement().shiftRight(current.getTextOffset()).contains(offset)) continue;
                PsiElement target = reference.resolve();
                if (target instanceof PsiField field) {
                    PsiClass type = field.getContainingClass();
                    PsiClass owner = type == null ? null : type.getContainingClass();
                    if (owner != null && "R".equals(owner.getName())) {
                        fields.add(field);
                        referenceRange = reference.getRangeInElement().shiftRight(current.getTextOffset());
                    }
                }
            }
            if (!fields.isEmpty()) break;
        }
        if (fields.size() != 1) return null;
        PsiField field = fields.iterator().next();
        PsiClass type = field.getContainingClass();
        String owner = type.getContainingClass().getQualifiedName();
        if (owner == null || !owner.endsWith(".R")) return null;
        String namespace = owner.substring(0, owner.length() - 2);
        VirtualFile origin = field.getContainingFile().getVirtualFile();
        String path = origin == null ? null : origin.getPath();
        if (path != null && path.contains("!/")) path = path.substring(0, path.indexOf("!/"));
        return new ResourceReference(type.getName(), field.getName(), namespace, namespace.equals("android"),
                PositionKt.toLspRange(referenceRange, document), path == null ? null : Path.of(path).toAbsolutePath().normalize());
    }

    public static List<LSDefinitionLocation> resolve(Project project, Module module, ResourceReference reference) {
        List<LSDefinitionLocation> all = resolveAll(project, module, reference);
        if (reference != null && reference.classOrigin() != null && reference.originRange() != null) {
            // When queried from Kotlin or Java, the platform's LSCommonDefinitionProvider
            // resolves the R field and navigates to the first source via AndroidResourceNavigation
            // (DirectNavigationProvider). Emitting only supplementary qualifiers prevents duplicate
            // reporting of the first source in ILS 271's union stream.
            return all.size() <= 1 ? List.of() : all.subList(1, all.size());
        }
        return all;
    }

    public static List<LSDefinitionLocation> resolveAll(Project project, Module module, ResourceReference reference) {
        if (module == null || reference.isFramework()) return List.of();
        List<Module> owners = new ArrayList<>();
        owners.add(module);
        for (Module candidate : ModuleManager.getInstance(project).getModules()) {
            if (candidate != module && module.getModuleWithDependenciesScope().isSearchInModuleContent(candidate))
                owners.add(candidate);
        }
        Set<Location> locations = new LinkedHashSet<>();
        for (Module owner : owners) {
            ProgressManager.checkCanceled();
            VirtualFile root = AndroidContext.findModuleRoot(owner);
            if (root == null) continue;
            Path path = Path.of(root.getPath()).toAbsolutePath().normalize();
            if (reference.classOrigin() != null && !reference.classOrigin().startsWith(path)) continue;
            String namespace = AndroidContext.resolveNamespace(project, owner);
            if (reference.namespace() != null && !reference.namespace().equals(namespace)) continue;
            String variant = AndroidContext.resolveVariant(owner, root);
            if (namespace == null || variant == null) continue;
            try {
                locations.addAll(new Provenance(project, path, variant, namespace).resolve(reference.type(), reference.name()));
            } catch (InvalidProvenance | java.nio.file.InvalidPathException ignored) {
                // Optional definition enhancement leaves the original provider's target intact.
            } catch (AndroidQueryException error) {
                if (error.getErrorCode() == -32801) throw error;
            }
        }
        List<LSDefinitionLocation> result = new ArrayList<>(locations.size());
        for (Location location : locations) result.add(new LSDefinitionLocation(location, reference.originRange()));
        return result;
    }

    public static String key(String type, String name) {
        if (type.equals("string-array") || type.equals("integer-array")) type = "array";
        return type + '\0' + name.replace('.', '_').replace(':', '_');
    }

    public static void verifyProvenance(Project project, Path module, String variant, String namespace, String type, String name) {
        Provenance provenance = new Provenance(project, module, variant, namespace);
        if (!Files.isRegularFile(provenance.merger)) {
            throw AndroidQueryException.missingSnapshot("Build snapshot merger.xml not found for variant " + variant);
        }
        try {
            provenance.load();
            String wanted = key(type, name);
            provenance.validate(wanted, type, name);
        } catch (InvalidProvenance e) {
            throw AndroidQueryException.staleSnapshot("Resource declaration is missing from snapshot or modified without rebuilding: " + type + "/" + name + (e.getMessage() != null ? " (" + e.getMessage() + ")" : ""));
        }
    }

    public static List<Path> findVerifiedRClassOrigins(Path module, String variant) {
        String cap = Character.toUpperCase(variant.charAt(0)) + variant.substring(1);
        String processTask = "process" + cap + "Resources";
        String generateTask = "generate" + cap + "RFile";
        String bundleTask = "bundle" + cap + "ClassesToCompileJar";
        List<Path> candidates = List.of(
                module.resolve("build/intermediates/compile_and_runtime_r_class_jar").resolve(variant).resolve(processTask).resolve("R.jar"),
                module.resolve("build/intermediates/compile_r_class_jar").resolve(variant).resolve(processTask).resolve("R.jar"),
                module.resolve("build/intermediates/compile_r_class_jar").resolve(variant).resolve(generateTask).resolve("R.jar"),
                module.resolve("build/intermediates/compile_and_runtime_not_namespaced_r_class_jar").resolve(variant).resolve(processTask).resolve("R.jar"),
                module.resolve("build/intermediates/compile_app_classes_jar").resolve(variant).resolve(bundleTask).resolve("classes.jar")
        );
        List<Path> found = new ArrayList<>();
        for (Path p : candidates) {
            if (Files.isRegularFile(p)) {
                found.add(p.toAbsolutePath().normalize());
            }
        }
        return found;
    }

    private static String declaration(XmlTag tag) {
        XmlTag parent = tag.getParentTag();
        if (parent == null || !(parent.getName().equals("resources") || tag.getName().equals("attr") && parent.getName().equals("declare-styleable")))
            return null;
        String name = AndroidXml.value(tag.getAttribute("name"));
        String type = tag.getName().equals("item") ? AndroidXml.value(tag.getAttribute("type")) : tag.getName();
        return name == null || type == null ? null : key(type, name);
    }

    private static Map<String, List<TextRange>> declarations(XmlFile file) {
        Map<String, List<TextRange>> result = new LinkedHashMap<>();
        if (file == null || file.getRootTag() == null) return result;
        collect(file.getRootTag(), result);
        return result;
    }

    private static void collect(XmlTag tag, Map<String, List<TextRange>> result) {
        ProgressManager.checkCanceled();
        String identity = declaration(tag);
        XmlAttribute name = tag.getAttribute("name");
        if (identity != null && name != null && name.getValueElement() != null)
            result.computeIfAbsent(identity, ignored -> new ArrayList<>()).add(name.getValueElement().getValueTextRange());
        for (XmlAttribute attribute : tag.getAttributes()) {
            String value = AndroidXml.value(attribute);
            if (value != null && value.startsWith("@+id/") && attribute.getValueElement() != null)
                result.computeIfAbsent(key("id", value.substring(5)), ignored -> new ArrayList<>()).add(attribute.getValueElement().getValueTextRange());
        }
        for (XmlTag child : tag.getSubTags()) collect(child, result);
    }

    private static List<Path> children(Path path) {
        ProgressManager.checkCanceled();
        AndroidSources.track(path);
        try (var stream = Files.list(path)) {
            return stream.sorted().toList();
        } catch (java.nio.file.NoSuchFileException missing) {
            return List.of();
        } catch (IOException error) {
            throw new InvalidProvenance();
        }
    }

    private static final class InvalidProvenance extends RuntimeException {
        InvalidProvenance(String message) {
            super(message);
        }

        InvalidProvenance() {
            super();
        }
    }

    private static final class Provenance {
        private final Project project;
        private final Path module;
        private final String variant;
        private final String namespace;
        private final String task;
        private final Path incremental;
        private final Path merger;
        private final Path merged;
        private final Path blame;
        private java.nio.file.attribute.FileTime mergedAt;
        private final Set<Path> roots = new LinkedHashSet<>();
        private final Map<Path, Set<String>> membership = new LinkedHashMap<>();
        private final Map<String, Path> sourceIds = new LinkedHashMap<>();

        Provenance(Project project, Path module, String variant, String namespace) {
            this.project = project;
            this.module = module;
            this.variant = variant;
            this.namespace = namespace;
            String cap = Character.toUpperCase(variant.charAt(0)) + variant.substring(1);
            String mergeTask = "merge" + cap + "Resources";
            String packageTask = "package" + cap + "Resources";
            Path mTask = module.resolve("build/intermediates/incremental").resolve(variant).resolve(mergeTask);
            Path pTask = module.resolve("build/intermediates/incremental").resolve(packageTask);
            Path pTaskVar = module.resolve("build/intermediates/incremental").resolve(variant).resolve(packageTask);
            Set<String> producers = new LinkedHashSet<>();
            for (Path origin : findVerifiedRClassOrigins(module, variant)) {
                String producer = origin.getParent().getFileName().toString();
                if (producer.equals("generate" + cap + "RFile")) producers.add(packageTask);
                else if (producer.equals("process" + cap + "Resources")) producers.add(mergeTask);
            }
            if (producers.size() > 1)
                throw new AndroidQueryException("ambiguous_target: Conflicting compiled resource producers for " + module, -32803);
            boolean isLibrary = producers.contains(packageTask);
            if (isLibrary) {
                task = packageTask;
                incremental = Files.isRegularFile(pTaskVar.resolve("merger.xml")) ? pTaskVar : pTask;
            } else {
                task = mergeTask;
                incremental = mTask;
            }
            merger = incremental.resolve("merger.xml");
            merged = incremental.resolve("merged.dir");
            Path b1 = module.resolve("build/intermediates/merged_res_blame_folder").resolve(variant).resolve(task).resolve("out");
            Path b2 = module.resolve("build/intermediates/merged_res_blame_folder").resolve(task).resolve("out");
            blame = Files.isDirectory(b1) ? b1 : b2;
        }

        private void load() {
            XmlFile file = AndroidSources.xml(project, merger);
            XmlTag tag = file == null ? null : file.getRootTag();
            if (tag == null || !tag.getName().equals("merger") || !"3".equals(tag.getAttributeValue("version")))
                throw new InvalidProvenance();
            for (XmlTag dataset : tag.getSubTags()) {
                ProgressManager.checkCanceled();
                if (!dataset.getName().equals("dataSet")) continue;
                for (XmlTag source : dataset.getSubTags()) {
                    if (!source.getName().equals("source") || source.getAttributeValue("path") == null) continue;
                    Path root = Path.of(source.getAttributeValue("path")).toAbsolutePath().normalize();
                    roots.add(root);
                    for (XmlTag item : source.getSubTags()) {
                        ProgressManager.checkCanceled();
                        if (!item.getName().equals("file") || item.getAttributeValue("path") == null) continue;
                        Path path = Path.of(item.getAttributeValue("path")).toAbsolutePath().normalize();
                        if (!path.startsWith(root)) throw new InvalidProvenance();
                        Set<String> keys = membership.computeIfAbsent(path, ignored -> new LinkedHashSet<>());
                        String name = AndroidXml.value(item.getAttribute("name")), type = AndroidXml.value(item.getAttribute("type"));
                        if (name != null && type != null) keys.add(key(type, name));
                        for (XmlTag child : item.getSubTags()) {
                            name = AndroidXml.value(child.getAttribute("name"));
                            type = child.getName().equals("item") ? AndroidXml.value(child.getAttribute("type")) : child.getName();
                            if (name != null && type != null) keys.add(key(type, name));
                            if (child.getName().equals("declare-styleable")) for (XmlTag attr : child.getSubTags()) {
                                String attribute = AndroidXml.value(attr.getAttribute("name"));
                                if (attr.getName().equals("attr") && attribute != null)
                                    keys.add(key("attr", attribute));
                            }
                        }
                    }
                }
            }
            Set<Path> paths = new LinkedHashSet<>(roots);
            paths.add(output());
            paths.add(merged);
            paths.add(incremental.resolve("stripped.dir"));
            Path pngs = module.resolve("build/generated/res/pngs").resolve(variant);
            if (Files.isDirectory(pngs)) paths.add(pngs);
            List<Path> sorted = paths.stream().sorted(Comparator.comparing(path -> path.toString().replace('\\', '/'))).toList();
            String moduleName = module.getFileName().toString();
            String prefix = namespace + (namespace.endsWith(moduleName) ? "" : "." + moduleName);
            for (int index = 0; index < sorted.size(); index++) {
                Path path = sorted.get(index);
                sourceIds.put((prefix + "-" + path.getParent().getFileName() + "-" + index).replace(' ', '_'), path);
            }
            try {
                mergedAt = Files.getLastModifiedTime(merger);
                for (Path source : List.of(module.resolve("build.gradle.kts"), module.resolve("build.gradle"), module.getParent().resolve("settings.gradle.kts"), module.getParent().resolve("settings.gradle"), module.getParent().resolve("gradle/libs.versions.toml"))) {
                    if (Files.exists(source) && Files.getLastModifiedTime(source).compareTo(mergedAt) > 0)
                        throw new InvalidProvenance();
                    PsiFile current = AndroidSources.current(project, source);
                    String disk = AndroidSources.text(source);
                    if (current != null && !current.getText().equals(disk == null ? null : com.intellij.openapi.util.text.StringUtil.convertLineSeparators(disk)))
                        throw new InvalidProvenance();
                }
            } catch (IOException error) {
                throw new InvalidProvenance();
            }
        }

        private Path output() {
            return module.resolve("build/intermediates/merged_res").resolve(variant).resolve(task);
        }

        private Path decode(String value) {
            int separator = value.indexOf(":/");
            if (separator >= 0 && !(separator == 1 && Character.isLetter(value.charAt(0)))) {
                Path root = sourceIds.get(value.substring(0, separator));
                if (root == null) throw new InvalidProvenance();
                Path path = root.resolve(value.substring(separator + 2)).normalize();
                if (!path.startsWith(root)) throw new InvalidProvenance();
                return path;
            }
            return Path.of(value).toAbsolutePath().normalize();
        }

        private boolean fileMatches(Path path, String type, String name) {
            if (path.getParent() == null || path.getParent().getFileName() == null) return false;
            String folder = path.getParent().getFileName().toString();
            String filename = path.getFileName().toString();
            int extension = filename.lastIndexOf('.');
            if (extension >= 0) filename = filename.substring(0, extension);
            if (filename.endsWith(".9")) filename = filename.substring(0, filename.length() - 2);
            return (folder.equals(type) || folder.startsWith(type + "-")) && filename.equals(name);
        }

        private void validate(String wanted, String type, String name) {
            Set<Path> actual = new LinkedHashSet<>();
            for (Path root : roots) {
                Set<Path> folders = new LinkedHashSet<>(children(root));
                VirtualFile virtualRoot = com.intellij.openapi.vfs.VirtualFileManager.getInstance().findFileByUrl(com.intellij.openapi.vfs.VfsUtilCore.pathToUrl(root.toString()));
                if (virtualRoot != null) for (VirtualFile child : virtualRoot.getChildren())
                    if (child.isDirectory()) folders.add(Path.of(child.getPath()));
                for (Path folder : folders) {
                    String folderName = folder.getFileName().toString();
                    boolean values = folderName.equals("values") || folderName.startsWith("values-");
                    boolean typed = folderName.equals(type) || folderName.startsWith(type + "-");
                    if (!values && !typed && !type.equals("id")) continue;
                    Set<Path> files = new LinkedHashSet<>(children(folder));
                    if (virtualRoot != null) {
                        VirtualFile virtualFolder = virtualRoot.findChild(folderName);
                        if (virtualFolder != null) for (VirtualFile child : virtualFolder.getChildren())
                            if (!child.isDirectory()) files.add(Path.of(child.getPath()).toAbsolutePath().normalize());
                    }
                    for (Path path : files) {
                        ProgressManager.checkCanceled();
                        boolean built = membership.getOrDefault(path, Set.of()).contains(wanted);
                        AndroidSources.track(path);
                        boolean regular = Files.isRegularFile(path);
                        if (built && !regular) throw new InvalidProvenance();
                        if (regular && path.toString().endsWith(".xml") && AndroidSources.modifiedAfter(path, mergedAt)) {
                            PsiFile current = AndroidSources.current(project, path);
                            if (current != null && path.toString().endsWith(".xml") &&
                                    !current.getText().equals(com.intellij.openapi.util.text.StringUtil.convertLineSeparators(AndroidSources.text(path))))
                                throw new InvalidProvenance();
                        }
                        if (values || type.equals("id")) {
                            if (!path.toString().endsWith(".xml")) continue;
                            boolean exists = declarations(AndroidSources.xml(project, path)).containsKey(wanted);
                            if (exists != built) throw new InvalidProvenance();
                            if (exists) actual.add(path);
                        } else if (typed && fileMatches(path, type, name)) {
                            if (!built) throw new InvalidProvenance();
                            actual.add(path);
                        }
                    }
                }
            }
            for (var entry : membership.entrySet())
                if (entry.getValue().contains(wanted) && !actual.contains(entry.getKey()))
                    throw new InvalidProvenance();
        }

        List<Location> resolve(String type, String name) {
            load();
            String wanted = key(type, name);
            validate(wanted, type, name);
            Set<Location> result = new LinkedHashSet<>();
            for (Path folder : children(merged)) {
                String qualifier = folder.getFileName().toString();
                if (!qualifier.equals("values") && !qualifier.startsWith("values-")) continue;
                Path output = folder.resolve(qualifier.equals("values") ? "values.xml" : qualifier + ".xml");
                XmlFile xml = AndroidSources.xml(project, output);
                if (xml == null || xml.getRootTag() == null) continue;
                for (XmlTag tag : xml.getRootTag().getSubTags()) {
                    if (!wanted.equals(declaration(tag))) continue;
                    Path blameFile = blame.resolve("multi-v2").resolve(qualifier + ".json");
                    JsonElement json = json(blameFile);
                    if (json == null && qualifier.startsWith("values-")) {
                        json = json(blame.resolve("multi-v2").resolve(qualifier.replace("values-", "values-b+") + ".json"));
                    }
                    if (json == null) throw new InvalidProvenance("Blame map missing for qualifier " + qualifier);
                    boolean mapped = false;
                    for (JsonElement log : array(object(json).get("logs"))) {
                        ProgressManager.checkCanceled();
                        JsonObject object = object(log);
                        if (!decode(string(object, "outputFile")).equals(output)) continue;
                        for (JsonElement item : array(object.get("map"))) {
                            JsonObject map = object(item);
                            // AGP omits "to" when every target coordinate equals "from".
                            JsonObject to = object(map.has("to") ? map.get("to") : map.get("from"));
                            int[] starts = numbers(to, "startOffsets"), ends = numbers(to, "endOffsets");
                            if (ends.length == 0) ends = starts;
                            boolean matches = false;
                            for (int index = 0; index < Math.min(starts.length, ends.length); index++)
                                if (starts[index] <= tag.getTextOffset() && ends[index] >= tag.getTextOffset())
                                    matches = true;
                            if (starts.length == 0) {
                                Document document = xml.getFileDocument();
                                if (document == null) document = PsiDocumentManager.getInstance(project).getDocument(xml);
                                if (document != null) {
                                    int line = document.getLineNumber(tag.getTextOffset());
                                    for (int startLine : numbers(to, "startLines"))
                                        if (startLine == line) matches = true;
                                }
                            }
                            if (matches) {
                                addValue(decode(string(map, "source")), wanted, result);
                                mapped = true;
                            }
                        }
                    }
                    if (!mapped) throw new InvalidProvenance("Unmapped resource in blame: " + wanted + " in " + output);
                }
            }
            JsonElement single = json(blame.resolve("single").resolve(task + ".json"));
            if (single != null) for (JsonElement item : array(single)) {
                ProgressManager.checkCanceled();
                JsonObject entry = object(item);
                Path source = decode(string(entry, "source"));
                if (!fileMatches(source, type, name)) continue;
                if (!decode(string(entry, "merged")).startsWith(output()) || !membership.getOrDefault(source, Set.of()).contains(wanted) || !Files.isRegularFile(source))
                    throw new InvalidProvenance();
                result.add(AndroidLocations.at(source, new Range(new Position(0, 0), new Position(0, 0))));
            }
            return new ArrayList<>(result);
        }

        private void addValue(Path path, String wanted, Set<Location> result) {
            if (!membership.getOrDefault(path, Set.of()).contains(wanted)) throw new InvalidProvenance("Resource missing in snapshot membership: " + path);
            XmlFile file = AndroidSources.xml(project, path);
            if (file == null) throw new InvalidProvenance("Source XML cannot be opened: " + path);
            List<TextRange> ranges = declarations(file).get(wanted);
            if (ranges == null || ranges.isEmpty()) throw new InvalidProvenance("Declaration range missing for " + wanted + " in " + path);
            Document document = file.getFileDocument();
            if (document == null) document = PsiDocumentManager.getInstance(project).getDocument(file);
            if (document == null) throw new InvalidProvenance("Document unavailable for " + path);
            for (TextRange range : ranges)
                result.add(AndroidLocations.at(path, PositionKt.toLspRange(range, document)));
        }
        private JsonElement json(Path path) {
            String text = AndroidSources.text(path);
            if (text == null) return null;
            try {
                return JsonParser.parseString(text);
            } catch (com.google.gson.JsonParseException error) {
                throw new InvalidProvenance();
            }
        }

        private JsonObject object(JsonElement value) {
            if (value == null || !value.isJsonObject()) throw new InvalidProvenance();
            return value.getAsJsonObject();
        }

        private JsonArray array(JsonElement value) {
            if (value == null || !value.isJsonArray()) throw new InvalidProvenance();
            return value.getAsJsonArray();
        }

        private String string(JsonObject object, String name) {
            JsonElement value = object.get(name);
            if (value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isString())
                throw new InvalidProvenance();
            return value.getAsString();
        }

        private int[] numbers(JsonObject object, String name) {
            if (!object.has(name)) return new int[0];
            String value = string(object, name);
            if (value.isEmpty()) return new int[0];
            try {
                String[] parts = value.split(",");
                int[] numbers = new int[parts.length];
                for (int index = 0; index < parts.length; index++) numbers[index] = Integer.parseInt(parts[index]);
                return numbers;
            } catch (NumberFormatException error) {
                throw new InvalidProvenance();
            }
        }
    }
}
