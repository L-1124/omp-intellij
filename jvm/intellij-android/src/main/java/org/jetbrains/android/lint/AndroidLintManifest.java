package org.jetbrains.android.lint;

import com.android.tools.lint.client.api.BlameFile;
import com.android.tools.lint.client.api.LintClient;
import com.android.tools.lint.client.api.XmlParser;
import com.android.tools.lint.detector.api.Location;
import com.android.utils.Pair;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.progress.ProgressManager;
import com.intellij.openapi.project.Project;
import org.jetbrains.android.resource.AndroidSources;
import org.w3c.dom.Document;
import org.w3c.dom.Node;

import java.io.BufferedReader;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.*;
import java.util.concurrent.CancellationException;
import java.util.regex.Pattern;

public class AndroidLintManifest {
    private static final Logger LOG = Logger.getInstance(AndroidLintManifest.class);
    private static final Pair<File, Node> NOT_FOUND = Pair.of(null, null);
    private static final Pattern UNRESOLVED_PLACEHOLDER = Pattern.compile("\\$\\{[a-zA-Z0-9_.]+}");

    private final AndroidLintModel model;
    private final Project ideaProject;
    private final LintClient client;

    private final Map<Object, BlameFile> reportFileCache = new HashMap<>();
    private final Map<Node, Pair<File, ? extends Node>> sourceNodeCache = new IdentityHashMap<>();
    private volatile Document resolvedMergedDocument;
    private volatile Document cachedManifestDocument;

    public AndroidLintManifest(AndroidLintModel model, Project ideaProject, LintClient client) {
        this.model = model;
        this.ideaProject = ideaProject;
        this.client = client;
    }

    public Document getMergedManifest(
            com.android.tools.lint.detector.api.Project lintProject,
            File targetFile,
            Document targetDom
    ) {
        ProgressManager.checkCanceled();

        if (cachedManifestDocument != null) {
            return cachedManifestDocument;
        }

        if (isValidBuiltSnapshot(targetFile, targetDom)) {
            File mergedFile = getMergedManifestFile();
            File reportFile = getManifestMergeReportFile();
            if (mergedFile != null && reportFile != null) {
                XmlParser parser = client != null ? client.getXmlParser() : null;
                Document mergedDoc = null;
                if (client != null) {
                    try {
                        mergedDoc = client.getXmlDocument(mergedFile, null);
                    } catch (CancellationException e) {
                        throw e;
                    } catch (Exception e) {
                        LOG.debug("Failed reading merged manifest via client", e);
                    }
                }
                if (mergedDoc == null && parser != null) {
                    try {
                        mergedDoc = parser.parseXml(mergedFile);
                    } catch (CancellationException e) {
                        throw e;
                    } catch (Exception e) {
                        LOG.debug("Failed parsing merged manifest via parser", e);
                    }
                }
                if (mergedDoc != null) {
                    resolveMergeManifestSources(mergedDoc, reportFile);
                    mergedDoc.setUserData(File.class.getName(), mergedFile, null);
                    this.resolvedMergedDocument = mergedDoc;
                    this.cachedManifestDocument = mergedDoc;
                    return mergedDoc;
                }
            }
        }

        // Clean / unbuilt / open changed sources: provide verified source-local target DOM without pretending merged
        this.resolvedMergedDocument = null;
        if (targetDom != null) {
            targetDom.setUserData(LintClient.MERGED_MANIFEST, null, null);
            if (targetFile != null) {
                targetDom.setUserData(File.class.getName(), targetFile, null);
            }
            this.cachedManifestDocument = targetDom;
            return targetDom;
        }

        File fallbackFile = targetFile != null ? targetFile : getPrimaryManifestFile();
        if (fallbackFile != null) {
            XmlParser parser = client != null ? client.getXmlParser() : null;
            Document sourceDoc = null;
            if (client != null) {
                try {
                    sourceDoc = client.getXmlDocument(fallbackFile, null);
                } catch (CancellationException e) {
                    throw e;
                } catch (Exception e) {
                    LOG.debug("Failed reading source manifest via client", e);
                }
            }
            if (sourceDoc == null && parser != null) {
                try {
                    sourceDoc = parser.parseXml(fallbackFile);
                } catch (CancellationException e) {
                    throw e;
                } catch (Exception e) {
                    LOG.debug("Failed parsing source manifest via parser", e);
                }
            }
            if (sourceDoc != null) {
                sourceDoc.setUserData(LintClient.MERGED_MANIFEST, null, null);
                sourceDoc.setUserData(File.class.getName(), fallbackFile, null);
                this.cachedManifestDocument = sourceDoc;
                return sourceDoc;
            }
        }

        return null;
    }

    public void resolveMergeManifestSources(Document mergedManifest, Object reportFile) {
        ProgressManager.checkCanceled();
        if (mergedManifest == null || reportFile == null) return;
        Object normalizedReport = reportFile;
        if (reportFile instanceof Path path) {
            normalizedReport = path.toFile();
        }
        mergedManifest.setUserData(LintClient.MERGED_MANIFEST, normalizedReport, null);
    }

    public Pair<File, ? extends Node> findManifestSourceNode(Node mergedNode) {
        ProgressManager.checkCanceled();
        if (mergedNode == null) return null;
        Document doc = mergedNode instanceof Document d ? d : mergedNode.getOwnerDocument();
        if (doc == null) return null;

        if (!isMergeManifestNode(mergedNode)) {
            Object fileObj = doc.getUserData(File.class.getName());
            if (fileObj instanceof File file) {
                return Pair.of(file, mergedNode);
            } else if (fileObj instanceof Path path) {
                return Pair.of(path.toFile(), mergedNode);
            }
            File primary = getPrimaryManifestFile();
            if (primary != null) {
                return Pair.of(primary, mergedNode);
            }
            return null;
        }

        Pair<File, ? extends Node> cached = sourceNodeCache.get(mergedNode);
        if (cached != null) {
            return cached == NOT_FOUND ? null : cached;
        }

        Object report = doc.getUserData(LintClient.MERGED_MANIFEST);
        if (report == null && doc == resolvedMergedDocument) {
            report = getManifestMergeReportFile();
        }
        if (report == null) {
            sourceNodeCache.put(mergedNode, NOT_FOUND);
            return null;
        }

        BlameFile blameFile = reportFileCache.get(report);
        if (blameFile == null) {
            try {
                if (report instanceof File file) {
                    blameFile = BlameFile.Companion.parse(file);
                } else if (report instanceof Path path) {
                    blameFile = BlameFile.Companion.parse(path.toFile());
                } else if (report instanceof List<?> list) {
                    @SuppressWarnings("unchecked")
                    List<String> lines = (List<String>) list;
                    blameFile = BlameFile.Companion.parse(lines);
                } else if (report instanceof String str) {
                    blameFile = BlameFile.Companion.parse(List.of(str.split("\n")));
                } else {
                    blameFile = BlameFile.Companion.getNONE();
                }
            } catch (CancellationException e) {
                throw e;
            } catch (Exception e) {
                LOG.debug("Failed parsing manifest blame file", e);
                blameFile = BlameFile.Companion.getNONE();
            }
            reportFileCache.put(report, blameFile);
        }

        Pair<File, ? extends Node> source = null;
        if (blameFile != null && blameFile != BlameFile.Companion.getNONE() && client != null) {
            try {
                source = blameFile.findSourceNode(client, mergedNode);
            } catch (CancellationException e) {
                throw e;
            } catch (Exception e) {
                LOG.debug("Failed resolving source node via blame", e);
            }
        }

        sourceNodeCache.put(mergedNode, source != null ? source : NOT_FOUND);
        return source;
    }

    public Location findManifestSourceLocation(Node mergedNode) {
        ProgressManager.checkCanceled();
        if (mergedNode == null) return null;
        Pair<File, ? extends Node> source = findManifestSourceNode(mergedNode);
        if (source != null && source.getFirst() != null && source.getSecond() != null) {
            XmlParser parser = client != null ? client.getXmlParser() : null;
            if (parser != null) {
                return parser.getLocation(source.getFirst(), source.getSecond());
            }
        }
        return null;
    }

    boolean isMergeManifestNode(Node node) {
        if (node == null) return false;
        Document doc = node instanceof Document d ? d : node.getOwnerDocument();
        if (doc == null) return false;
        if (resolvedMergedDocument != null && doc == resolvedMergedDocument) return true;
        return doc.getUserData(LintClient.MERGED_MANIFEST) != null;
    }

    boolean isValidBuiltSnapshot() {
        return isValidBuiltSnapshot(null, null);
    }

    boolean isValidBuiltSnapshot(File targetFile, Document targetDom) {
        ProgressManager.checkCanceled();
        if (model == null) return false;
        String variant = model.variant();
        if (variant == null || variant.isBlank()) return false;

        // Disallow when SDK premise is missing: incomplete model cannot validate built state
        if (model.minSdkPremiseMissing()) {
            return false;
        }

        File mergedFile = getMergedManifestFile();
        if (mergedFile == null || !Files.isRegularFile(mergedFile.toPath())) {
            return false;
        }
        Path mergedPath = mergedFile.toPath().toAbsolutePath().normalize();
        if (!pathMatchesVariant(mergedPath, variant)) {
            return false;
        }
        AndroidSources.observeCompiledArchive(mergedPath);

        File reportFile = getManifestMergeReportFile();
        if (reportFile == null || !Files.isRegularFile(reportFile.toPath())) {
            return false;
        }
        Path reportPath = reportFile.toPath().toAbsolutePath().normalize();
        if (!pathMatchesVariant(reportPath, variant)) {
            return false;
        }
        if (!isAgpDecisionLog(reportPath)) {
            return false;
        }
        AndroidSources.observeCompiledArchive(reportPath);

        long mergedTime;
        try {
            mergedTime = Files.getLastModifiedTime(mergedPath).toMillis();
        } catch (IOException e) {
            return false;
        }

        // Verify build script freshness: changes in build.gradle(.kts) invalidate built manifest
        if (model.moduleRoot() != null) {
            for (String scriptName : List.of("build.gradle.kts", "build.gradle")) {
                Path script = model.moduleRoot().resolve(scriptName);
                if (Files.isRegularFile(script)) {
                    AndroidSources.observeCompiledArchive(script);
                    try {
                        if (Files.getLastModifiedTime(script).toMillis() > mergedTime) {
                            return false;
                        }
                    } catch (IOException e) {
                        return false;
                    }
                }
            }
        }

        try {
            if (UNRESOLVED_PLACEHOLDER.matcher(Files.readString(mergedPath)).find()) return false;
        } catch (IOException e) {
            return false;
        }

        List<File> sourceManifests = getSourceManifestFiles();
        if (sourceManifests.isEmpty()) {
            return false;
        }

        for (File src : sourceManifests) {
            if (src == null) continue;
            Path srcPath = src.toPath().toAbsolutePath().normalize();
            AndroidSources.observeCompiledArchive(srcPath);

            if (!Files.isRegularFile(srcPath)) {
                return false;
            }

            try {
                long srcTime = Files.getLastModifiedTime(srcPath).toMillis();
                if (srcTime > mergedTime) {
                    return false;
                }
            } catch (IOException e) {
                return false;
            }


            if (targetFile != null && targetFile.toPath().toAbsolutePath().normalize().equals(srcPath)) {
                if (client != null) {
                    CharSequence editorText = client.readFile(targetFile);
                    if (editorText != null) {
                        try {
                            String diskText = Files.readString(srcPath);
                            if (!normalizeLf(editorText).equals(normalizeLf(diskText))) {
                                return false;
                            }
                        } catch (IOException e) {
                            return false;
                        }
                    }
                }
            }
        }

        return true;
    }

    private static boolean pathMatchesVariant(Path path, String variant) {
        String pathStr = path.toString().replace('\\', '/').toLowerCase();
        String vLower = variant.toLowerCase();
        return pathStr.contains("/" + vLower + "/")
                || pathStr.contains("-" + vLower + "-")
                || pathStr.contains("process" + vLower + "manifest")
                || pathStr.contains("process" + vLower + "mainmanifest");
    }

    private static boolean isAgpDecisionLog(Path reportPath) {
        try (BufferedReader reader = Files.newBufferedReader(reportPath, StandardCharsets.UTF_8)) {
            String line;
            int linesRead = 0;
            while ((line = reader.readLine()) != null && linesRead < 20) {
                linesRead++;
                String trimmed = line.trim();
                if (trimmed.startsWith("-- Merging decision tree log ---")) {
                    return true;
                }
                if (trimmed.startsWith("ADDED from ") || trimmed.startsWith("MERGED from ") || trimmed.startsWith("INJECTED from ")) {
                    return true;
                }
            }
        } catch (IOException ignored) {
        }
        return false;
    }

    private static String normalizeLf(CharSequence text) {
        if (text == null) return "";
        return text.toString().replace("\r\n", "\n").replace('\r', '\n');
    }

    List<File> getSourceManifestFiles() {
        ProgressManager.checkCanceled();
        Set<File> results = new LinkedHashSet<>();
        Set<Path> seen = new LinkedHashSet<>();

        if (model != null) {
            List<File> modelFiles = model.manifestFiles();
            if (modelFiles != null) {
                for (File f : modelFiles) {
                    if (f != null && seen.add(f.toPath().toAbsolutePath().normalize())) {
                        results.add(f);
                    }
                }
            }

            if (model.lintModelVariant() != null) {
                for (var provider : model.lintModelVariant().getSourceProviders()) {
                    if (provider != null) {
                        for (File f : provider.getManifestFiles()) {
                            if (f != null && seen.add(f.toPath().toAbsolutePath().normalize())) {
                                results.add(f);
                            }
                        }
                    }
                }
            }

            if (results.isEmpty() && model.moduleRoot() != null) {
                Path std = model.moduleRoot().resolve("src/main/AndroidManifest.xml");
                AndroidSources.observeCompiledArchive(std);
                if (Files.isRegularFile(std) && seen.add(std.toAbsolutePath().normalize())) {
                    results.add(std.toFile());
                }
            }
        }

        return List.copyOf(results);
    }

    File getPrimaryManifestFile() {
        List<File> files = getSourceManifestFiles();
        return files.isEmpty() ? null : files.get(0);
    }

    File getMergedManifestFile() {
        if (model == null) return null;
        File fromModel = model.mergedManifest();
        if (fromModel != null && Files.isRegularFile(fromModel.toPath())) {
            return fromModel;
        }
        if (model.lintModelVariant() != null) {
            File f = model.lintModelVariant().getMergedManifest();
            if (f != null && Files.isRegularFile(f.toPath())) return f;
        }
        for (Path p : mergedManifestCandidates(model.moduleRoot(), model.variant())) {
            AndroidSources.observeCompiledArchive(p);
            if (Files.isRegularFile(p)) return p.toFile();
        }
        return null;
    }

    File getManifestMergeReportFile() {
        if (model == null) return null;
        File fromModel = model.manifestMergeReport();
        if (fromModel != null && Files.isRegularFile(fromModel.toPath())) {
            return fromModel;
        }
        if (model.lintModelVariant() != null) {
            File f = model.lintModelVariant().getManifestMergeReport();
            if (f != null && Files.isRegularFile(f.toPath())) return f;
        }
        for (Path p : mergerReportCandidates(model.moduleRoot(), model.variant())) {
            AndroidSources.observeCompiledArchive(p);
            if (Files.isRegularFile(p)) return p.toFile();
        }
        return null;
    }

    static List<Path> mergedManifestCandidates(Path root, String variant) {
        if (root == null || variant == null || variant.isBlank()) return List.of();
        String cap = Character.toUpperCase(variant.charAt(0)) + variant.substring(1);
        return List.of(
                root.resolve("build/intermediates/merged_manifests/" + variant + "/process" + cap + "Manifest/AndroidManifest.xml"),
                root.resolve("build/intermediates/merged_manifest/" + variant + "/process" + cap + "MainManifest/AndroidManifest.xml"),
                root.resolve("build/intermediates/merged_manifests/" + variant + "/AndroidManifest.xml"),
                root.resolve("build/intermediates/merged_manifest/" + variant + "/AndroidManifest.xml"));
    }

    static List<Path> mergerReportCandidates(Path root, String variant) {
        if (root == null || variant == null || variant.isBlank()) return List.of();
        String cap = Character.toUpperCase(variant.charAt(0)) + variant.substring(1);
        return List.of(
                root.resolve("build/outputs/logs/manifest-merger-" + variant + "-report.txt"),
                root.resolve("build/intermediates/manifest_merge_blame_file/" + variant + "/process" + cap
                        + "MainManifest/manifest-merger-blame-" + variant + "-report.txt"));
    }


}
