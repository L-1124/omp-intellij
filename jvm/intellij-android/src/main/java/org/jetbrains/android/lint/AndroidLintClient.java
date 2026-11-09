package org.jetbrains.android.lint;

import com.android.ide.common.resources.ResourceRepository;
import com.android.tools.lint.client.api.*;
import com.android.tools.lint.detector.api.*;
import com.android.tools.lint.helpers.DefaultJavaEvaluator;
import com.android.tools.lint.helpers.DefaultUastParser;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.module.Module;
import com.intellij.openapi.progress.ProgressManager;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.roots.LanguageLevelModuleExtension;
import com.intellij.openapi.roots.LanguageLevelProjectExtension;
import com.intellij.openapi.roots.ModuleRootManager;
import com.intellij.openapi.vfs.VirtualFile;
import com.intellij.pom.java.LanguageLevel;
import com.intellij.psi.*;
import com.intellij.psi.search.GlobalSearchScope;
import com.intellij.util.lang.UrlClassLoader;
import org.jetbrains.android.resource.AndroidSources;
import org.jetbrains.kotlin.config.*;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.net.URL;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.CancellationException;
import java.util.function.Function;

public class AndroidLintClient extends LintClient {
    private static final Logger LOG = Logger.getInstance(AndroidLintClient.class);
    private static final Map<Module, Map<AarCacheKey, List<JarFileIssueRegistry>>> MODULE_AAR_CACHE =
            Collections.synchronizedMap(new WeakHashMap<>());

    private final AndroidLintModel model;
    private final PsiFile mainFile;
    private final String contents;
    private final Project ideaProject;
    private final Module ideaModule;
    private final Path mainFilePath;
    private final Scope scope;
    private final XmlParser xmlParser;
    private AndroidLintManifest manifest;
    private boolean analysisComplete;
    private boolean xmlParsingFailed;
    private final List<Incident> collectedIncidents = new ArrayList<>();
    private final Map<com.android.tools.lint.detector.api.Issue, com.android.tools.lint.detector.api.PartialResult> partialResults =
            new LinkedHashMap<>();
    private volatile Throwable lastDetectorFailure;

    public AndroidLintClient(AndroidLintModel model, PsiFile mainFile, String contents, Scope scope) {
        super(CLIENT_STUDIO);
        this.model = model;
        this.mainFile = mainFile;
        this.contents = contents;
        this.scope = scope;
        this.xmlParser = new AndroidLintXmlParser(this);
        this.ideaProject = mainFile != null ? mainFile.getProject() : null;
        this.ideaModule = model != null ? model.module() : null;
        VirtualFile vf = mainFile != null ? mainFile.getVirtualFile() : null;
        this.mainFilePath = vf != null ? vf.toNioPath().toAbsolutePath().normalize() : null;
        if (model != null && model.projectRoot() != null) {
            getConfigurations().setRootDir(model.projectRoot().toFile());
        }
    }


    @Override
    public CharSequence readFile(File file) {
        ProgressManager.checkCanceled();
        if (file == null) {
            return "";
        }
        Path filePath = file.toPath().toAbsolutePath().normalize();
        if (mainFilePath != null && filePath.equals(mainFilePath)) {
            return contents != null ? contents : "";
        }
        String text = AndroidSources.text(filePath);
        return text == null ? "" : text;
    }

    @Override
    public UastParser getUastParser(com.android.tools.lint.detector.api.Project project) {
        return new AndroidUastParser(project, ideaProject, mainFile, mainFilePath);
    }

    @Override
    public XmlParser getXmlParser() {
        return xmlParser;
    }

    @Override
    public org.w3c.dom.Document getXmlDocument(File file, CharSequence text) {
        ProgressManager.checkCanceled();
        return getXmlParser().parseXml(text == null ? readFile(file) : text, file);
    }

    private AndroidLintManifest manifest() {
        if (manifest == null) manifest = new AndroidLintManifest(model, ideaProject, this);
        return manifest;
    }

    @Override
    public org.w3c.dom.Document getMergedManifest(com.android.tools.lint.detector.api.Project project) {
        File target = scope == Scope.MANIFEST && mainFilePath != null ? mainFilePath.toFile() : null;
        return manifest().getMergedManifest(project, target,
                target == null ? null : getXmlDocument(target, contents));
    }

    @Override
    public void resolveMergeManifestSources(org.w3c.dom.Document document, Object reportFile) {
        manifest().resolveMergeManifestSources(document, reportFile);
    }

    @Override
    public com.android.utils.Pair<File, ? extends org.w3c.dom.Node> findManifestSourceNode(org.w3c.dom.Node node) {
        return manifest().findManifestSourceNode(node);
    }

    @Override
    public Location findManifestSourceLocation(org.w3c.dom.Node node) {
        return manifest().findManifestSourceLocation(node);
    }

    PsiFile xmlSource(File file) {
        Path path = file.toPath().toAbsolutePath().normalize();
        if (path.equals(mainFilePath)) return mainFile;
        return ideaProject == null ? null : AndroidSources.diskXml(ideaProject, path);
    }

    void xmlParsingFailed() {
        xmlParsingFailed = true;
    }

    @Override
    public GradleVisitor getGradleVisitor() {
        return new GradleVisitor();
    }

    @Override
    public ResourceRepository getResources(com.android.tools.lint.detector.api.Project project, ResourceRepositoryScope scope) {
        return AndroidLintResources.getRepository(model, scope, mainFilePath,
                mainFile instanceof com.intellij.psi.xml.XmlFile xml ? xml : null);
    }

    @Override
    public com.android.tools.lint.detector.api.PartialResult getPartialResults(
            com.android.tools.lint.detector.api.Project project, com.android.tools.lint.detector.api.Issue issue) {
        var result = partialResults.computeIfAbsent(issue,
                key -> new com.android.tools.lint.detector.api.PartialResult(key, new LinkedHashMap<>()));
        return com.android.tools.lint.detector.api.PartialResult.withRequestedProject(result, project);
    }

    @Override
    public File getSdkHome() {
        return model != null && model.sdkHome() != null ? model.sdkHome().toFile() : null;
    }

    @Override
    public File getCacheDir(String name, boolean create) {
        Path cacheRoot = Path.of(System.getProperty("java.io.tmpdir"), "android-lint-cache");
        Path dir = name != null ? cacheRoot.resolve(name) : cacheRoot;
        if (create) {
            try {
                Files.createDirectories(dir);
            } catch (IOException ignored) {
            }
        }
        return dir.toFile();
    }

    @Override
    public ClassLoader createUrlClassLoader(List<? extends File> files, ClassLoader parent) {
        File cacheAarDir = getCacheDir("aar", true);
        List<Path> copiedPaths = new ArrayList<>();
        if (files != null) {
            for (File f : files) {
                if (f != null && f.isFile()) {
                    try {
                        Path copied = copyToAarCache(f.toPath(), cacheAarDir.toPath());
                        copiedPaths.add(copied);
                    } catch (CancellationException e) {
                        throw e;
                    } catch (IOException e) {
                        LOG.warn("Failed to copy AAR jar to cache: " + f, e);
                    }
                }
            }
        }
        return UrlClassLoader.build().parent(parent).allowLock(false).files(copiedPaths).get();
    }

    @Override
    public ClassLoader createUrlClassLoader(URL[] urls, ClassLoader parent) {
        List<File> files = new ArrayList<>();
        if (urls != null) {
            for (URL url : urls) {
                if (url != null && "file".equalsIgnoreCase(url.getProtocol())) {
                    try {
                        files.add(new File(url.toURI()));
                    } catch (Exception e) {
                        files.add(new File(url.getPath()));
                    }
                }
            }
        }
        return createUrlClassLoader(files, parent);
    }

    @Override
    public List<File> findGlobalRuleJars(LintDriver driver, boolean warnDeprecated) {
        return Collections.emptyList();
    }

    @Override
    public Iterable<File> findRuleJars(com.android.tools.lint.detector.api.Project project) {
        return Collections.emptyList();
    }

    static List<Path> configurationFiles(Path projectRoot, Path moduleRoot) {
        if (projectRoot == null && moduleRoot == null) {
            return Collections.emptyList();
        }
        if (projectRoot == null) {
            return List.of(moduleRoot.toAbsolutePath().normalize().resolve("lint.xml"));
        }
        if (moduleRoot == null) {
            return List.of(projectRoot.toAbsolutePath().normalize().resolve("lint.xml"));
        }

        Path normProject = projectRoot.toAbsolutePath().normalize();
        Path normModule = moduleRoot.toAbsolutePath().normalize();

        if (normProject.equals(normModule)) {
            return List.of(normProject.resolve("lint.xml"));
        }

        if (!normModule.startsWith(normProject)) {
            return List.of(normProject.resolve("lint.xml"), normModule.resolve("lint.xml"));
        }

        Path rel = normProject.relativize(normModule);
        List<Path> result = new ArrayList<>(rel.getNameCount() + 1);
        result.add(normProject.resolve("lint.xml"));
        Path current = normProject;
        for (int i = 0; i < rel.getNameCount(); i++) {
            current = current.resolve(rel.getName(i));
            result.add(current.resolve("lint.xml"));
        }
        return Collections.unmodifiableList(result);
    }

    @Override
    public Configuration getConfiguration(com.android.tools.lint.detector.api.Project project, LintDriver driver) {
        Configuration effectiveXmlConfig = null;

        if (model != null) {
            Path projectRoot = model.projectRoot();
            Path moduleRoot = model.moduleRoot();
            List<Path> configFiles = configurationFiles(projectRoot, moduleRoot);
            Configuration previous = null;
            for (Path configPath : configFiles) {
                String text = AndroidSources.text(configPath);
                if (text != null && !text.isEmpty()) {
                    Configuration config = LintXmlConfiguration.Companion.create(getConfigurations(), configPath.toFile(), text);
                    if (previous != null) {
                        getConfigurations().setParent(config, previous);
                    }
                    previous = config;
                }
            }
            effectiveXmlConfig = previous;
        }

        if (project != null && project.getBuildModule() != null && project.getBuildModule().getLintOptions() != null) {
            return getConfigurations().createLintOptionsConfiguration(
                    project,
                    project.getBuildModule().getLintOptions(),
                    false,
                    effectiveXmlConfig,
                    () -> {
                        var configuration = new com.android.tools.lint.client.api.LintOptionsConfiguration(
                                getConfigurations(), project.getBuildModule().getLintOptions(), false);
                        configuration.setAssociatedLocation(Location.create(project.getDir()));
                        return configuration;
                    }
            );
        }
        if (effectiveXmlConfig != null) {
            return effectiveXmlConfig;
        }
        return super.getConfiguration(project, driver);
    }

    @Override
    public void report(Context context, Incident incident, TextFormat format) {
        if (incident == null) return;
        if (incident.getSeverity() == Severity.IGNORE) return;
        Location location = incident.getLocation();
        if (location == null || location == Location.NONE) return;
        File file = location.getFile();
        if (file == null) return;
        Path incidentPath = file.toPath().toAbsolutePath().normalize();
        if (mainFilePath == null || !incidentPath.equals(mainFilePath)) return;
        Position start = location.getStart();
        Position end = location.getEnd();
        if (start == null || end == null || start.getOffset() < 0 || start.getOffset() >= end.getOffset()) {
            return;
        }
        String msg = incident.getMessage();
        if (format != null && msg != null) {
            msg = format.convertTo(msg, TextFormat.RAW);
        }
        incident.setMessage(msg != null ? msg : "");
        collectedIncidents.add(incident);
    }

    @Override
    public void log(Severity severity, Throwable exception, String format, Object... args) {
        if (exception instanceof CancellationException) {
            throw (CancellationException) exception;
        }
        if (exception != null && exception.getCause() instanceof CancellationException) {
            throw (CancellationException) exception.getCause();
        }
        Throwable root = exception;
        while (root != null && root.getCause() != null && root.getCause() != root) {
            if (root instanceof LinkageError) {
                break;
            }
            root = root.getCause();
        }
        if (root instanceof RuntimeException || root instanceof Error) {
            lastDetectorFailure = root;
            if (root instanceof Error error) throw error;
            throw (RuntimeException) root;
        }
        String msg = format != null ? String.format(format, args) : (exception != null ? exception.getMessage() : "");
        LOG.debug("AndroidLintClient: " + msg, exception);
    }

    @Override
    public void runReadAction(Runnable action) {
        ProgressManager.checkCanceled();
        try {
            action.run();
        } catch (CancellationException canceled) {
            throw canceled;
        } catch (RuntimeException | Error failure) {
            lastDetectorFailure = failure;
            throw failure;
        }
    }

    @Override
    public <T> T runReadAction(com.intellij.openapi.util.Computable<T> action) {
        ProgressManager.checkCanceled();
        try {
            return action.compute();
        } catch (CancellationException canceled) {
            throw canceled;
        } catch (RuntimeException | Error failure) {
            lastDetectorFailure = failure;
            throw failure;
        }
    }

    @Override
    public LanguageLevel getJavaLanguageLevel(com.android.tools.lint.detector.api.Project project) {
        if (ideaModule != null && !ideaModule.isDisposed()) {
            LanguageLevelModuleExtension ext = ModuleRootManager.getInstance(ideaModule)
                    .getModuleExtension(LanguageLevelModuleExtension.class);
            if (ext != null && ext.getLanguageLevel() != null) {
                return ext.getLanguageLevel();
            }
            if (ideaProject != null && !ideaProject.isDisposed()) {
                LanguageLevel projectLevel = LanguageLevelProjectExtension.getInstance(ideaProject).getLanguageLevel();
                if (projectLevel != null) {
                    return projectLevel;
                }
            }
        }
        return LanguageLevel.JDK_17;
    }

    @Override
    public LanguageVersionSettings getKotlinLanguageLevel(com.android.tools.lint.detector.api.Project project) {
        if (ideaModule != null && !ideaModule.isDisposed() && ideaProject != null && !ideaProject.isDisposed()) {
            try {
                KotlinFacetSettingsProvider provider = ideaProject.getService(KotlinFacetSettingsProvider.class);
                if (provider != null) {
                    IKotlinFacetSettings settings = provider.getSettings(ideaModule);
                    if (settings != null && settings.getLanguageLevel() != null) {
                        return new LanguageVersionSettingsImpl(
                                settings.getLanguageLevel(),
                                ApiVersion.Companion.createByLanguageVersion(settings.getApiLevel())
                        );
                    }
                }
            } catch (CancellationException e) {
                throw e;
            } catch (Throwable ignored) {
            }
        }
        return LanguageVersionSettingsImpl.DEFAULT;
    }

    public List<Incident> analyze() {
        ProgressManager.checkCanceled();
        if (model == null || mainFilePath == null) {
            return List.of();
        }
        File moduleDir = model.moduleRoot().toFile();
        File mainIoFile = mainFilePath.toFile();
        if (scope != Scope.JAVA_FILE && !mainIoFile.isFile()) return List.of();

        List<IssueRegistry> registries = new ArrayList<>();
        IssueRegistry builtin = AndroidLintIssueRegistry.create(model.minSdkPremiseMissing(), scope);
        if (model.minSdkPremiseMissing()) {
            LOG.debug("Skipping ApiDetector checks: minSdk premise missing for module " + (ideaModule != null ? ideaModule.getName() : ""));
        }
        registries.add(builtin);

        AndroidLintProject preProject = new AndroidLintProject(
                this,
                moduleDir,
                ideaModule,
                model,
                model.lintModelModule(),
                model.lintModelVariant()
        );
        preProject.addFile(mainIoFile);

        LintRequest request = new LintRequest(this, List.of(mainIoFile));
        request.setProjects(List.of(preProject));
        request.setScope(EnumSet.of(scope));
        request.setPlatform(Platform.ANDROID_SET);

        LintDriver preDriver = new LintDriver(builtin, this, request);
        preDriver.setCheckTestSources(true);
        preDriver.setCheckDependencies(false);

        if (model.ruleJars() != null) {
            for (Path jarPath : model.ruleJars()) {
                ProgressManager.checkCanceled();
                if (jarPath == null || !Files.isRegularFile(jarPath)) continue;
                try {
                    List<JarFileIssueRegistry> jarRegistries = loadAarRegistries(jarPath, preProject, preDriver);
                    if (jarRegistries != null) {
                        registries.addAll(jarRegistries);
                    }
                } catch (CancellationException e) {
                    throw e;
                } catch (Throwable t) {
                    LOG.warn("Failed to load lint rules from " + jarPath, t);
                }
            }
        }

        List<IssueRegistry> uniqueRegistries = new ArrayList<>(new java.util.LinkedHashSet<>(registries));
        return runWithIsolation(uniqueRegistries, reg -> {
            ProgressManager.checkCanceled();
            collectedIncidents.clear();
            partialResults.clear();
            lastDetectorFailure = null;

            AndroidLintProject runProject = new AndroidLintProject(
                    this,
                    moduleDir,
                    ideaModule,
                    model,
                    model.lintModelModule(),
                    model.lintModelVariant()
            );
            runProject.addFile(mainIoFile);

            LintRequest req = new LintRequest(this, List.of(mainIoFile));
            req.setProjects(List.of(runProject));
            req.setScope(EnumSet.of(scope));
            req.setPlatform(Platform.ANDROID_SET);

            LintDriver driver = new LintDriver(reg, this, req);
            driver.setCheckTestSources(true);
            driver.setCheckDependencies(false);
            driver.analyze();

            if (lastDetectorFailure != null) {
                Throwable failure = lastDetectorFailure;
                lastDetectorFailure = null;
                if (failure instanceof Error error) throw error;
                throw (RuntimeException) failure;
            }

            analysisComplete = true;
            return List.copyOf(collectedIncidents);
        });
    }

    boolean isAnalysisComplete() {
        return analysisComplete && !xmlParsingFailed;
    }

    static List<Incident> runWithIsolation(
            List<? extends IssueRegistry> registries,
            Function<IssueRegistry, List<Incident>> runner
    ) {
        if (registries == null || registries.isEmpty()) {
            return Collections.emptyList();
        }
        if (registries.size() == 1) {
            try {
                List<Incident> result = runner.apply(registries.get(0));
                return result != null ? result : Collections.emptyList();
            } catch (CancellationException | org.jetbrains.android.context.AndroidQueryException e) {
                throw e;
            } catch (Throwable t) {
                LOG.warn("Failed lint registry execution: " + registries.get(0), t);
                return Collections.emptyList();
            }
        }

        try {
            CompositeIssueRegistry composite = new CompositeIssueRegistry(new ArrayList<>(registries));
            List<Incident> result = runner.apply(composite);
            return result != null ? result : Collections.emptyList();
        } catch (CancellationException | org.jetbrains.android.context.AndroidQueryException e) {
            throw e;
        } catch (Throwable t) {
            LOG.warn("Composite lint registry execution failed, retrying with per-registry isolation", t);
            List<Incident> combined = new ArrayList<>();
            for (IssueRegistry registry : registries) {
                try {
                    List<Incident> batch = runner.apply(registry);
                    if (batch != null && !batch.isEmpty()) {
                        combined.addAll(batch);
                    }
                } catch (CancellationException | org.jetbrains.android.context.AndroidQueryException e) {
                    throw e;
                } catch (Throwable regError) {
                    LOG.warn("Skipping failing lint issue registry: " + registry, regError);
                }
            }
            return combined;
        }
    }

    private List<JarFileIssueRegistry> loadAarRegistries(Path originalJar, AndroidLintProject project, LintDriver driver) {
        try {
            File cacheAarDir = getCacheDir("aar", true);
            Path copiedJar = copyToAarCache(originalJar, cacheAarDir.toPath());
            long lastModified = Files.getLastModifiedTime(originalJar).toMillis();
            long size = Files.size(originalJar);
            AarCacheKey key = new AarCacheKey(copiedJar, lastModified, size);

            Map<AarCacheKey, List<JarFileIssueRegistry>> moduleCache = null;
            if (ideaModule != null) {
                moduleCache = MODULE_AAR_CACHE.computeIfAbsent(ideaModule, m -> Collections.synchronizedMap(
                        new LinkedHashMap<>(16, 0.75f, true) {
                            @Override
                            protected boolean removeEldestEntry(Map.Entry<AarCacheKey, List<JarFileIssueRegistry>> eldest) {
                                return size() > 32;
                            }
                        }
                ));
                List<JarFileIssueRegistry> cached = moduleCache.get(key);
                if (cached != null) {
                    return cached;
                }
            }

            List<JarFileIssueRegistry> list = JarFileIssueRegistry.Factory.get(
                    this,
                    List.of(copiedJar.toFile()),
                    project,
                    driver,
                    true
            );
            if (list != null && !list.isEmpty()) {
                if (moduleCache != null) {
                    moduleCache.put(key, list);
                }
                return list;
            }
        } catch (CancellationException e) {
            throw e;
        } catch (Throwable t) {
            LOG.warn("Failed to load AAR lint registry from " + originalJar, t);
        }
        return Collections.emptyList();
    }

    private static Path copyToAarCache(Path originalJar, Path cacheDir) throws IOException {
        MessageDigest md;
        try {
            md = MessageDigest.getInstance("SHA-256");
        } catch (Exception e) {
            throw new IOException("SHA-256 not available", e);
        }

        byte[] buf = new byte[65536];
        try (InputStream in = Files.newInputStream(originalJar)) {
            int r;
            while ((r = in.read(buf)) != -1) {
                ProgressManager.checkCanceled();
                md.update(buf, 0, r);
            }
        }

        String sha256 = HexFormat.of().formatHex(md.digest());
        Path target = cacheDir.resolve(sha256 + ".jar");
        long originalSize = Files.size(originalJar);

        if (Files.exists(target) && Files.size(target) == originalSize) {
            return target;
        }

        Path temp = cacheDir.resolve(sha256 + ".tmp." + UUID.randomUUID());
        try {
            Files.copy(originalJar, temp, StandardCopyOption.REPLACE_EXISTING);
            try {
                Files.move(temp, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            } catch (AtomicMoveNotSupportedException e) {
                Files.move(temp, target, StandardCopyOption.REPLACE_EXISTING);
            }
        } finally {
            try {
                Files.deleteIfExists(temp);
            } catch (IOException ignored) {
            }
        }
        return target;
    }

    private record AarCacheKey(Path copiedJarPath, long originalLastModified, long originalSize) {
    }

    private static final class AndroidUastParser extends DefaultUastParser {
        private final PsiFile mainFile;
        private final Path mainFilePath;

        AndroidUastParser(com.android.tools.lint.detector.api.Project project, Project ideaProject, PsiFile mainFile, Path mainFilePath) {
            super(project, ideaProject);
            this.mainFile = mainFile;
            this.mainFilePath = mainFilePath;
            setPrepared(true);
        }

        @Override
        public org.jetbrains.uast.UFile parse(com.android.tools.lint.detector.api.JavaContext context) {
            if (context != null && mainFile != null && mainFilePath != null && context.file != null) {
                if (context.file.toPath().toAbsolutePath().normalize().equals(mainFilePath)) {
                    org.jetbrains.uast.UElement uElem = org.jetbrains.uast.UastFacade.INSTANCE.convertElementWithParent(mainFile, org.jetbrains.uast.UFile.class);
                    if (uElem instanceof org.jetbrains.uast.UFile) {
                        return (org.jetbrains.uast.UFile) uElem;
                    }
                }
            }
            return super.parse(context);
        }

        @Override
        protected DefaultJavaEvaluator createEvaluator(com.android.tools.lint.detector.api.Project project, Project ideaProject) {
            Module mod = null;
            if (project instanceof AndroidLintProject androidProject) {
                mod = androidProject.getIdeaModule();
                if (mod == null && androidProject.getModel() != null) {
                    mod = androidProject.getModel().module();
                }
            }
            return new AndroidJavaEvaluator(ideaProject, project, mod);
        }
    }

    private static final class AndroidJavaEvaluator extends DefaultJavaEvaluator {
        private final Project ideaProject;
        private final Module ideaModule;

        AndroidJavaEvaluator(Project ideaProject, com.android.tools.lint.detector.api.Project lintProject, Module ideaModule) {
            super(ideaProject, lintProject);
            this.ideaProject = ideaProject;
            this.ideaModule = ideaModule;
        }

        @Override
        public PsiPackage getPackage(PsiElement node) {
            if (node != null) {
                PsiFile containingFile = (node instanceof PsiFile) ? (PsiFile) node : node.getContainingFile();
                if (containingFile != null) {
                    PsiDirectory dir = containingFile.getParent();
                    if (dir != null) {
                        PsiPackage pkg = JavaDirectoryService.getInstance().getPackage(dir);
                        if (pkg != null) {
                            return pkg;
                        }
                    }
                }
            }
            return super.getPackage(node);
        }

        @Override
        public PsiClass findClass(String qualifiedName) {
            ProgressManager.checkCanceled();
            if (ideaModule != null && !ideaModule.isDisposed() && ideaProject != null) {
                GlobalSearchScope scope = ideaModule.getModuleWithDependenciesAndLibrariesScope(true);
                return JavaPsiFacade.getInstance(ideaProject).findClass(qualifiedName, scope);
            }
            return super.findClass(qualifiedName);
        }
    }

}
