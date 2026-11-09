package org.jetbrains.android.lint;

import com.android.tools.lint.model.LintModelLibrary;
import com.android.tools.lint.model.LintModelModule;
import com.android.tools.lint.model.LintModelModuleType;
import com.android.tools.lint.model.LintModelSerialization;
import com.android.tools.lint.model.LintModelVariant;
import com.android.tools.lint.model.PathVariables;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.module.Module;
import com.intellij.openapi.module.ModuleManager;
import com.intellij.openapi.progress.ProcessCanceledException;
import com.intellij.openapi.progress.ProgressManager;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.roots.LibraryOrderEntry;
import com.intellij.openapi.roots.ModuleRootManager;
import com.intellij.openapi.roots.OrderEntry;
import com.intellij.openapi.roots.OrderRootType;
import com.intellij.openapi.vfs.VfsUtilCore;
import com.intellij.openapi.vfs.VirtualFile;
import com.intellij.psi.PsiElement;
import com.intellij.psi.PsiFile;
import com.intellij.psi.util.PsiTreeUtil;
import com.intellij.psi.xml.XmlFile;
import com.intellij.psi.xml.XmlTag;
import org.jetbrains.android.context.AndroidContext;
import org.jetbrains.android.resource.AndroidSources;
import org.jetbrains.kotlin.psi.KtAnonymousInitializer;
import org.jetbrains.kotlin.psi.KtBinaryExpression;
import org.jetbrains.kotlin.psi.KtBlockExpression;
import org.jetbrains.kotlin.psi.KtCallExpression;
import org.jetbrains.kotlin.psi.KtConstantExpression;
import org.jetbrains.kotlin.psi.KtEscapeStringTemplateEntry;
import org.jetbrains.kotlin.psi.KtExpression;
import org.jetbrains.kotlin.psi.KtFile;
import org.jetbrains.kotlin.psi.KtLambdaArgument;
import org.jetbrains.kotlin.psi.KtLambdaExpression;
import org.jetbrains.kotlin.psi.KtScript;
import org.jetbrains.kotlin.psi.KtScriptInitializer;
import org.jetbrains.kotlin.psi.KtStringTemplateEntry;
import org.jetbrains.kotlin.psi.KtStringTemplateExpression;
import org.jetbrains.kotlin.psi.KtValueArgument;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Properties;
import java.util.Set;
import java.util.concurrent.CancellationException;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class AndroidLintModelResolver {
    private static final Logger LOG = Logger.getInstance(AndroidLintModelResolver.class);

    public record CleanAstResult(
            Integer minSdk,
            Integer targetSdk,
            Integer compileSdk,
            String compileTarget,
            String namespace,
            Boolean isLibrary,
            boolean minSdkPremiseMissing,
            boolean minSdkUnsafe
    ) {
    }

    private AndroidLintModelResolver() {
    }

    public static AndroidLintModel resolve(Project project, VirtualFile mainFile) {
        if (project == null || project.isDisposed() || mainFile == null) return null;
        ProgressManager.checkCanceled();

        Module module = AndroidContext.findModule(project, mainFile);
        if (module == null || module.isDisposed()) return null;

        Module androidModule = null;
        if (isAndroidModule(module)) {
            androidModule = module;
        } else {
            List<Module> candidates = new ArrayList<>();
            for (Module candidate : ModuleManager.getInstance(project).getModules()) {
                if (candidate.equals(module) || candidate.isDisposed()) continue;
                if (!isAndroidModule(candidate)) continue;
                if (candidate.getModuleWithDependenciesScope().isSearchInModuleContent(module)) {
                    candidates.add(candidate);
                }
            }
            if (candidates.isEmpty()) return null;

            candidates.sort((a, b) -> {
                boolean aApp = isAppModule(project, a);
                boolean bApp = isAppModule(project, b);
                if (aApp != bApp) return aApp ? -1 : 1;
                return a.getName().compareTo(b.getName());
            });
            androidModule = candidates.get(0);
        }

        VirtualFile moduleRootVf = AndroidContext.findModuleRoot(androidModule);
        if (moduleRootVf == null) return null;
        Path moduleRoot = Path.of(moduleRootVf.getPath()).toAbsolutePath().normalize();
        String basePath = project.getBasePath();
        Path projectRoot = basePath != null ? Path.of(basePath).toAbsolutePath().normalize() : moduleRoot;

        Path sdkHome = null;
        Integer compileSdk = null;
        String compileTarget = null;
        List<Path> ruleJars = new ArrayList<>();
        List<String> ruleJarFingerprints = new ArrayList<>();
        Set<Path> seenRuleJars = new HashSet<>();

        for (OrderEntry entry : ModuleRootManager.getInstance(androidModule).getOrderEntries()) {
            ProgressManager.checkCanceled();
            if (!(entry instanceof LibraryOrderEntry lib) || lib.getLibrary() == null) continue;
            for (String url : lib.getLibrary().getUrls(OrderRootType.CLASSES)) {
                String pathStr = VfsUtilCore.urlToPath(url);
                int sep = pathStr.indexOf("!/");
                if (sep >= 0) pathStr = pathStr.substring(0, sep);
                Path path;
                try {
                    path = Path.of(pathStr).toAbsolutePath().normalize();
                } catch (Exception e) {
                    continue;
                }

                if (path.getFileName() != null && path.getFileName().toString().equals("android.jar")) {
                    Path platformDir = path.getParent();
                    if (platformDir != null) {
                        Path platformsDir = platformDir.getParent();
                        if (platformsDir != null && platformsDir.getFileName() != null && platformsDir.getFileName().toString().equals("platforms")) {
                            sdkHome = platformsDir.getParent();
                        }
                        Path sourceProps = platformDir.resolve("source.properties");
                        AndroidSources.observeCompiledArchive(sourceProps);
                        if (Files.isRegularFile(sourceProps)) {
                            try (InputStream in = Files.newInputStream(sourceProps)) {
                                Properties props = new Properties();
                                props.load(in);
                                String apiLevelStr = props.getProperty("AndroidVersion.ApiLevel");
                                if (apiLevelStr != null) {
                                    Matcher m = Pattern.compile("^(\\d+)").matcher(apiLevelStr.trim());
                                    if (m.find()) {
                                        compileSdk = Integer.parseInt(m.group(1));
                                    }
                                }
                            } catch (IOException ignored) {
                            }
                        }
                        String platformName = platformDir.getFileName().toString();
                        if (platformName.startsWith("android-")) {
                            compileTarget = platformName;
                            if (compileSdk == null) {
                                Matcher m = Pattern.compile("^android-(\\d+)").matcher(platformName);
                                if (m.find()) compileSdk = Integer.parseInt(m.group(1));
                            }
                        }
                    }
                }

                if (path.getFileName() != null && path.getFileName().toString().equals("classes.jar")) {
                    Path parent = path.getParent();
                    if (parent != null && parent.getFileName() != null && parent.getFileName().toString().equals("jars")) {
                        Path lintJar = parent.resolve("lint.jar");
                        AndroidSources.observeCompiledArchive(lintJar);
                        if (Files.isRegularFile(lintJar) && seenRuleJars.add(lintJar)) {
                            ruleJars.add(lintJar);
                            try {
                                long size = Files.size(lintJar);
                                long mtime = Files.getLastModifiedTime(lintJar).toMillis();
                                ruleJarFingerprints.add(lintJar.toString() + ":" + size + ":" + mtime);
                            } catch (IOException ignored) {
                            }
                        }
                    }
                }
            }
        }

        String variant = AndroidContext.resolveVariant(androidModule, moduleRootVf);
        if (variant == null) {
            String name = androidModule.getName();
            int dot = name.lastIndexOf('.');
            if (dot >= 0 && dot + 1 < name.length()) {
                String suffix = name.substring(dot + 1);
                if (!Set.of("main", "unitTest", "androidTest", "test").contains(suffix)) {
                    variant = suffix;
                }
            }
        }

        LintModelModule lintModelModule = null;
        LintModelVariant lintModelVariant = null;
        Integer minSdk = null;
        Integer targetSdk = null;
        String namespace = null;
        boolean isLibrary = false;
        boolean minSdkPremiseMissing = false;

        Path lintReportBase = moduleRoot.resolve("build/intermediates/lint_report_lint_model");
        Path incrementalBase = moduleRoot.resolve("build/intermediates/incremental");
        AndroidSources.observeCompiledArchive(lintReportBase);
        AndroidSources.observeCompiledArchive(incrementalBase);

        List<Path> candidateDirs = new ArrayList<>();
        if (variant != null) {
            String capVariant = Character.toUpperCase(variant.charAt(0)) + variant.substring(1);
            candidateDirs.add(lintReportBase.resolve(variant).resolve("generate" + capVariant + "LintReportModel"));
            candidateDirs.add(incrementalBase.resolve("lintAnalyze" + capVariant));
        } else if (Files.isDirectory(lintReportBase)) {
            List<Path> varDirs = new ArrayList<>();
            try (var stream = Files.list(lintReportBase)) {
                for (Path p : stream.toList()) {
                    if (Files.isDirectory(p)) varDirs.add(p);
                }
            } catch (IOException ignored) {
            }
            if (varDirs.size() == 1) {
                String singleVar = varDirs.get(0).getFileName().toString();
                String capSingleVar = Character.toUpperCase(singleVar.charAt(0)) + singleVar.substring(1);
                candidateDirs.add(varDirs.get(0).resolve("generate" + capSingleVar + "LintReportModel"));
            }
        }

        Path foundModelDir = null;
        List<Path> candidateXmls = new ArrayList<>();
        for (Path cDir : candidateDirs) {
            AndroidSources.observeCompiledArchive(cDir);
            Path moduleXml = cDir.resolve("module.xml");
            candidateXmls.add(moduleXml);
            AndroidSources.observeCompiledArchive(moduleXml);
            if (variant != null) {
                Path variantXml = cDir.resolve(variant + ".xml");
                Path depsXml = cDir.resolve(variant + "-main-dependencies.xml");
                Path libsXml = cDir.resolve(variant + "-main-libraries.xml");
                candidateXmls.add(variantXml);
                candidateXmls.add(depsXml);
                candidateXmls.add(libsXml);
                AndroidSources.observeCompiledArchive(variantXml);
                AndroidSources.observeCompiledArchive(depsXml);
                AndroidSources.observeCompiledArchive(libsXml);
            }
            if (foundModelDir == null && Files.isRegularFile(moduleXml)) {
                foundModelDir = cDir;
            }
        }

        List<Path> modelXmlFiles = new ArrayList<>();
        if (foundModelDir != null) {
            try (var stream = Files.list(foundModelDir)) {
                for (Path f : stream.toList()) {
                    if (f.getFileName().toString().endsWith(".xml")) {
                        modelXmlFiles.add(f);
                        AndroidSources.observeCompiledArchive(f);
                    }
                }
            } catch (IOException ignored) {
            }

            LintModelModule loadedModule = null;
            LintModelVariant loadedVariant = null;
            Integer loadedMinSdk = null;
            Integer loadedTargetSdk = null;
            String loadedNamespace = null;
            Boolean loadedIsLibrary = null;
            String loadedCompileTarget = null;
            Integer loadedCompileSdk = null;
            List<Path> loadedRuleJars = new ArrayList<>();
            List<String> loadedRuleJarFingerprints = new ArrayList<>();

            try {
                loadedModule = LintModelSerialization.INSTANCE.readModule(foundModelDir.toFile(), null, true, new PathVariables());
                if (loadedModule == null) {
                    throw new IOException("Null module read from " + foundModelDir);
                }

                if (variant != null) {
                    loadedVariant = loadedModule.findVariant(variant);
                    if (loadedVariant == null) {
                        throw new IllegalStateException("Variant " + variant + " not found in model at " + foundModelDir);
                    }
                } else if (loadedModule.getVariants().size() == 1) {
                    loadedVariant = loadedModule.getVariants().get(0);
                } else {
                    throw new IllegalStateException("Variant is unknown and model at " + foundModelDir + " has " + loadedModule.getVariants().size() + " variants");
                }

                String loadedVariantName = loadedVariant.getName();
                if (loadedVariant.getMinSdkVersion() != null) {
                    loadedMinSdk = loadedVariant.getMinSdkVersion().getApiLevel();
                }
                if (loadedVariant.getTargetSdkVersion() != null) {
                    loadedTargetSdk = loadedVariant.getTargetSdkVersion().getApiLevel();
                }
                loadedNamespace = loadedVariant.getPackage();
                if (loadedNamespace == null) loadedNamespace = loadedModule.getNamespace();
                loadedIsLibrary = loadedModule.getType() == LintModelModuleType.LIBRARY;
                loadedCompileTarget = loadedModule.getCompileTarget();
                if (loadedCompileTarget != null) {
                    Matcher m = Pattern.compile("(\\d+)").matcher(loadedCompileTarget);
                    if (m.find()) loadedCompileSdk = Integer.parseInt(m.group(1));
                }

                if (loadedVariant.getMainArtifact() != null && loadedVariant.getMainArtifact().getDependencies() != null) {
                    for (LintModelLibrary lib : loadedVariant.getMainArtifact().getDependencies().getAll()) {
                        File lintJarFile = lib.getLintJar();
                        if (lintJarFile != null) {
                            Path p = lintJarFile.toPath().toAbsolutePath().normalize();
                            AndroidSources.observeCompiledArchive(p);
                            if (Files.isRegularFile(p)) {
                                loadedRuleJars.add(p);
                                loadedRuleJarFingerprints.add(p.toString() + ":" + Files.size(p) + ":" + Files.getLastModifiedTime(p).toMillis());
                            }
                        }
                    }
                }
                for (File jarFile : loadedModule.getLintRuleJars()) {
                    if (jarFile != null) {
                        Path p = jarFile.toPath().toAbsolutePath().normalize();
                        AndroidSources.observeCompiledArchive(p);
                        if (Files.isRegularFile(p)) {
                            loadedRuleJars.add(p);
                            loadedRuleJarFingerprints.add(p.toString() + ":" + Files.size(p) + ":" + Files.getLastModifiedTime(p).toMillis());
                        }
                    }
                }

                lintModelModule = loadedModule;
                lintModelVariant = loadedVariant;
                variant = loadedVariantName;
                minSdk = loadedMinSdk;
                targetSdk = loadedTargetSdk;
                namespace = loadedNamespace;
                isLibrary = loadedIsLibrary;
                if (compileTarget == null) compileTarget = loadedCompileTarget;
                if (compileSdk == null) compileSdk = loadedCompileSdk;
                for (Path p : loadedRuleJars) {
                    if (seenRuleJars.add(p)) ruleJars.add(p);
                }
                ruleJarFingerprints.addAll(loadedRuleJarFingerprints);
                minSdkPremiseMissing = (minSdk == null);
            } catch (Throwable t) {
                if (t instanceof ProcessCanceledException || t instanceof CancellationException) {
                    throw (RuntimeException) t;
                }
                LOG.debug("Failed to load official lint model from " + foundModelDir + ", falling back to clean AST", t);
                lintModelModule = null;
                lintModelVariant = null;
                minSdk = null;
                targetSdk = null;
                namespace = null;
                isLibrary = false;
                minSdkPremiseMissing = false;
            }
        }

        if (lintModelModule == null) {
            PsiFile script = AndroidSources.kotlinScript(project, moduleRootVf);
            CleanAstResult ast = null;
            if (script instanceof KtFile ktFile) {
                ast = parseCleanAst(ktFile);
                if (compileSdk == null && ast.compileSdk() != null) {
                    compileSdk = ast.compileSdk();
                    if (compileTarget == null) compileTarget = ast.compileTarget();
                }
                if (ast.minSdk() != null) {
                    minSdk = ast.minSdk();
                    minSdkPremiseMissing = false;
                } else if (ast.minSdkUnsafe()) {
                    minSdk = null;
                    minSdkPremiseMissing = true;
                }
                if (targetSdk == null) targetSdk = ast.targetSdk();
                if (namespace == null) namespace = ast.namespace();
                if (ast.isLibrary() != null) isLibrary = ast.isLibrary();
            }

            boolean allowManifestFallback = (ast == null || !ast.minSdkUnsafe());
            Path manifestPath = moduleRoot.resolve("src/main/AndroidManifest.xml");
            if ((minSdk == null && allowManifestFallback) || targetSdk == null || namespace == null) {
                XmlFile xmlFile = AndroidSources.xml(project, manifestPath);
                if (xmlFile != null && xmlFile.getRootTag() != null) {
                    XmlTag rootTag = xmlFile.getRootTag();
                    XmlTag usesSdk = rootTag.findFirstSubTag("uses-sdk");
                    if (usesSdk != null) {
                        if (minSdk == null && allowManifestFallback) {
                            String minAttr = usesSdk.getAttributeValue("minSdkVersion", AndroidContext.ANDROID_NS);
                            if (minAttr == null) minAttr = usesSdk.getAttributeValue("android:minSdkVersion");
                            if (minAttr != null && minAttr.matches("^\\d+$")) {
                                try {
                                    minSdk = Integer.parseInt(minAttr);
                                    minSdkPremiseMissing = false;
                                } catch (NumberFormatException overflow) {
                                    minSdk = null;
                                    minSdkPremiseMissing = true;
                                }
                            }
                        }
                        if (targetSdk == null) {
                            String targetAttr = usesSdk.getAttributeValue("targetSdkVersion", AndroidContext.ANDROID_NS);
                            if (targetAttr == null) targetAttr = usesSdk.getAttributeValue("android:targetSdkVersion");
                            if (targetAttr != null && targetAttr.matches("^\\d+$")) {
                                try {
                                    targetSdk = Integer.parseInt(targetAttr);
                                } catch (NumberFormatException overflow) {
                                    targetSdk = null;
                                }
                            }
                        }
                    }
                    if (namespace == null) {
                        String pkg = rootTag.getAttributeValue("package");
                        if (pkg != null && !pkg.isBlank()) namespace = pkg;
                    }
                }
            }

            if (namespace == null) {
                namespace = AndroidContext.resolveNamespace(project, androidModule);
            }
            if (minSdk == null) {
                minSdkPremiseMissing = true;
            }
        }

        if (compileTarget == null && compileSdk != null) {
            compileTarget = "android-" + compileSdk;
        }

        Path projectLintXml = projectRoot.resolve("lint.xml");
        Path moduleLintXml = moduleRoot.resolve("lint.xml");
        String rootLintXmlText = AndroidSources.memoryText(project, projectLintXml);
        String moduleLintXmlText = projectLintXml.equals(moduleLintXml) ? null : AndroidSources.memoryText(project, moduleLintXml);
        String lintXmlFingerprint = computeLintXmlFingerprint(rootLintXmlText, moduleLintXmlText);

        List<Path> trackedXmls = new ArrayList<>(candidateXmls);
        for (Path f : modelXmlFiles) {
            if (!trackedXmls.contains(f)) trackedXmls.add(f);
        }

        String fingerprint = computeModelFingerprint(
                module.getName(),
                androidModule.getName(),
                moduleRoot.toString(),
                projectRoot.toString(),
                variant,
                compileSdk,
                compileTarget,
                minSdk,
                targetSdk,
                namespace,
                isLibrary,
                minSdkPremiseMissing,
                lintModelModule != null,
                trackedXmls
        );

        return new AndroidLintModel(
                module,
                androidModule,
                moduleRoot,
                projectRoot,
                variant,
                sdkHome,
                compileSdk,
                compileTarget,
                minSdk,
                targetSdk,
                namespace,
                isLibrary,
                minSdkPremiseMissing,
                lintModelModule,
                lintModelVariant,
                ruleJars,
                ruleJarFingerprints,
                fingerprint,
                lintXmlFingerprint
        );
    }

    public static CleanAstResult parseCleanAst(KtFile ktFile) {
        if (ktFile == null) {
            return new CleanAstResult(null, null, null, null, null, null, true, true);
        }

        Boolean isApp = detectAppPlugin(ktFile);
        Boolean isLibrary = isApp != null ? !isApp : null;

        List<KtCallExpression> androidBlocks = new ArrayList<>();
        for (KtExpression stmt : topLevelStatements(ktFile)) {
            stmt = unwrap(stmt);
            if (stmt instanceof KtCallExpression call && name(call).equals("android") && body(call) != null) {
                androidBlocks.add(call);
            }
        }

        if (androidBlocks.isEmpty()) {
            return new CleanAstResult(null, null, null, null, null, isLibrary, true, false);
        }

        boolean hasProductFlavors = false;
        boolean buildTypesOverridesMinSdk = false;

        for (KtCallExpression block : androidBlocks) {
            KtBlockExpression body = body(block);
            if (body == null) continue;
            for (KtExpression stmt : body.getStatements()) {
                stmt = unwrap(stmt);
                if (stmt instanceof KtCallExpression call) {
                    String cName = name(call);
                    if (cName.equals("productFlavors") && body(call) != null) {
                        hasProductFlavors = true;
                    } else if (cName.equals("buildTypes") && body(call) != null) {
                        KtBlockExpression btBody = body(call);
                        if (btBody != null) {
                            for (PsiElement elem : PsiTreeUtil.collectElements(btBody, e -> true)) {
                                String text = elem.getText();
                                if (text.equals("minSdk") || text.equals("minSdkVersion") || text.equals("minSdkPreview")) {
                                    buildTypesOverridesMinSdk = true;
                                    break;
                                }
                            }
                        }
                    }
                }
            }
        }

        Integer compileSdk = null;
        String compileTarget = null;
        String namespace = null;

        for (KtCallExpression block : androidBlocks) {
            KtBlockExpression body = body(block);
            if (body == null) continue;
            for (KtExpression statement : body.getStatements()) {
                ProgressManager.checkCanceled();
                statement = unwrap(statement);
                if (statement instanceof KtBinaryExpression binary && binary.getOperationReference().getText().equals("=")) {
                    String left = binary.getLeft() != null ? binary.getLeft().getText() : "";
                    if (left.equals("compileSdk") || left.equals("compileSdkVersion")) {
                        Integer val = parseDecimalInteger(binary.getRight());
                        compileSdk = val;
                        compileTarget = val != null ? "android-" + val : null;
                    } else if (left.equals("namespace")) {
                        String val = literal(binary.getRight());
                        namespace = (val != null && !val.isBlank()) ? val : null;
                    }
                } else if (statement instanceof KtCallExpression call) {
                    String cName = name(call);
                    if (cName.equals("compileSdk") || cName.equals("compileSdkVersion")) {
                        if (call.getValueArguments().size() == 1) {
                            Integer val = parseDecimalInteger(call.getValueArguments().get(0).getArgumentExpression());
                            compileSdk = val;
                            compileTarget = val != null ? "android-" + val : null;
                        } else {
                            KtBlockExpression csBody = body(call);
                            if (csBody != null) {
                                Integer val = null;
                                for (KtCallExpression inner : PsiTreeUtil.collectElementsOfType(csBody, KtCallExpression.class)) {
                                    if (name(inner).equals("release") && inner.getValueArguments().size() == 1) {
                                        val = parseDecimalInteger(inner.getValueArguments().get(0).getArgumentExpression());
                                    }
                                }
                                compileSdk = val;
                                compileTarget = val != null ? "android-" + val : null;
                            }
                        }
                    } else if (cName.equals("namespace")) {
                        if (call.getValueArguments().size() == 1) {
                            String val = literal(call.getValueArguments().get(0).getArgumentExpression());
                            namespace = (val != null && !val.isBlank()) ? val : null;
                        }
                    }
                }
            }
        }

        Integer minSdk = null;
        Integer targetSdk = null;
        boolean minSdkFound = false;
        boolean minSdkDynamic = false;

        for (KtCallExpression block : androidBlocks) {
            KtBlockExpression body = body(block);
            if (body == null) continue;
            for (KtExpression stmt : body.getStatements()) {
                stmt = unwrap(stmt);
                if (stmt instanceof KtCallExpression call && name(call).equals("defaultConfig") && body(call) != null) {
                    KtBlockExpression dfBody = body(call);
                    for (KtExpression dfStatement : dfBody.getStatements()) {
                        ProgressManager.checkCanceled();
                        dfStatement = unwrap(dfStatement);
                        if (dfStatement instanceof KtBinaryExpression binary && binary.getOperationReference().getText().equals("=")) {
                            String left = binary.getLeft() != null ? binary.getLeft().getText() : "";
                            if (left.equals("minSdk") || left.equals("minSdkVersion")) {
                                minSdkFound = true;
                                Integer val = parseDecimalInteger(binary.getRight());
                                if (val != null && !minSdkDynamic) {
                                    minSdk = val;
                                } else {
                                    minSdkDynamic = true;
                                    minSdk = null;
                                }
                            } else if (left.equals("minSdkPreview")) {
                                minSdkDynamic = true;
                                minSdk = null;
                            } else if (left.equals("targetSdk") || left.equals("targetSdkVersion")) {
                                targetSdk = parseDecimalInteger(binary.getRight());
                            }
                        } else if (dfStatement instanceof KtCallExpression callExpr) {
                            String cName = name(callExpr);
                            if (cName.equals("minSdk") || cName.equals("minSdkVersion")) {
                                minSdkFound = true;
                                if (callExpr.getValueArguments().size() == 1) {
                                    Integer val = parseDecimalInteger(callExpr.getValueArguments().get(0).getArgumentExpression());
                                    if (val != null && !minSdkDynamic) {
                                        minSdk = val;
                                    } else {
                                        minSdkDynamic = true;
                                        minSdk = null;
                                    }
                                } else {
                                    minSdkDynamic = true;
                                    minSdk = null;
                                }
                            } else if (cName.equals("minSdkPreview")) {
                                minSdkDynamic = true;
                                minSdk = null;
                            } else if (cName.equals("targetSdk") || cName.equals("targetSdkVersion")) {
                                if (callExpr.getValueArguments().size() == 1) {
                                    targetSdk = parseDecimalInteger(callExpr.getValueArguments().get(0).getArgumentExpression());
                                } else {
                                    targetSdk = null;
                                }
                            }
                        }
                    }
                }
            }
        }

        boolean minSdkUnsafe = hasProductFlavors || buildTypesOverridesMinSdk || minSdkDynamic;
        if (minSdkUnsafe) minSdk = null;
        boolean minSdkPremiseMissing = minSdkUnsafe || !minSdkFound || (minSdk == null);

        return new CleanAstResult(
                minSdk,
                targetSdk,
                compileSdk,
                compileTarget,
                namespace,
                isLibrary,
                minSdkPremiseMissing,
                minSdkUnsafe
        );
    }

    private static List<KtExpression> topLevelStatements(KtFile ktFile) {
        List<KtExpression> raw = new ArrayList<>();
        if (ktFile.getScript() != null && ktFile.getScript().getBlockExpression() != null) {
            raw.addAll(ktFile.getScript().getBlockExpression().getStatements());
        } else {
            for (PsiElement child : ktFile.getChildren()) {
                if (child instanceof KtScript script && script.getBlockExpression() != null) {
                    raw.addAll(script.getBlockExpression().getStatements());
                } else if (child instanceof KtExpression expr) {
                    raw.add(expr);
                }
            }
        }
        List<KtExpression> statements = new ArrayList<>();
        for (KtExpression expr : raw) {
            KtExpression unwrapped = unwrap(expr);
            if (unwrapped != null) {
                statements.add(unwrapped);
            }
        }
        return statements;
    }

    private static KtExpression unwrap(KtExpression expr) {
        if (expr instanceof KtScriptInitializer init) {
            return init.getBody();
        }
        if (expr instanceof KtAnonymousInitializer init) {
            return init.getBody();
        }
        return expr;
    }

    private static Boolean detectAppPlugin(KtFile ktFile) {
        if (ktFile == null) return null;
        for (KtExpression stmt : topLevelStatements(ktFile)) {
            stmt = unwrap(stmt);
            if (stmt instanceof KtCallExpression call && name(call).equals("plugins")) {
                KtBlockExpression body = body(call);
                if (body != null) {
                    for (KtExpression pStmt : body.getStatements()) {
                        pStmt = unwrap(pStmt);
                        if (pStmt instanceof KtCallExpression pCall) {
                            String pName = name(pCall);
                            if (pName.equals("id") && pCall.getValueArguments().size() == 1) {
                                String id = literal(pCall.getValueArguments().get(0).getArgumentExpression());
                                if ("com.android.application".equals(id)) return Boolean.TRUE;
                                if ("com.android.library".equals(id)) return Boolean.FALSE;
                            } else if (pName.equals("alias") && pCall.getValueArguments().size() == 1) {
                                KtExpression arg = pCall.getValueArguments().get(0).getArgumentExpression();
                                if (arg != null) {
                                    String text = arg.getText();
                                    if (text.equals("libs.plugins.android.application") || text.endsWith(".android.application")) {
                                        return Boolean.TRUE;
                                    }
                                    if (text.equals("libs.plugins.android.library") || text.endsWith(".android.library")) {
                                        return Boolean.FALSE;
                                    }
                                }
                            }
                        }
                    }
                }
            } else if (stmt instanceof KtCallExpression call && name(call).equals("apply")) {
                for (KtValueArgument arg : call.getValueArguments()) {
                    KtExpression argExpr = arg.getArgumentExpression();
                    if (argExpr != null) {
                        String lit = literal(argExpr);
                        if ("com.android.application".equals(lit)) return Boolean.TRUE;
                        if ("com.android.library".equals(lit)) return Boolean.FALSE;
                    }
                }
            }
        }
        return null;
    }

    private static boolean isAndroidModule(Module module) {
        if (module == null || module.isDisposed()) return false;
        if (AndroidContext.isAndroidModule(module)) return true;
        for (OrderEntry entry : ModuleRootManager.getInstance(module).getOrderEntries()) {
            if (entry instanceof LibraryOrderEntry lib && lib.getLibrary() != null) {
                for (String url : lib.getLibrary().getUrls(OrderRootType.CLASSES)) {
                    String path = VfsUtilCore.urlToPath(url);
                    int sep = path.indexOf("!/");
                    if (sep >= 0) path = path.substring(0, sep);
                    if (path.contains("platforms/android-") && (path.endsWith("/android.jar") || path.endsWith("\\android.jar") || path.equals("android.jar"))) {
                        return true;
                    }
                }
            }
        }
        return false;
    }

    private static boolean isAppModule(Project project, Module module) {
        if (module == null || module.isDisposed()) return false;
        VirtualFile root = AndroidContext.findModuleRoot(module);
        if (root == null) return false;
        PsiFile script = AndroidSources.kotlinScript(project, root);
        if (script instanceof KtFile ktFile) {
            Boolean isApp = detectAppPlugin(ktFile);
            if (isApp != null) return isApp;
        }
        return false;
    }

    private static String name(KtCallExpression call) {
        return call.getCalleeExpression() == null ? "" : call.getCalleeExpression().getText().trim();
    }

    private static KtBlockExpression body(KtCallExpression call) {
        List<KtLambdaArgument> arguments = call.getLambdaArguments();
        if (!arguments.isEmpty()) {
            KtLambdaExpression lambda = arguments.get(0).getLambdaExpression();
            return lambda == null ? null : lambda.getBodyExpression();
        }
        for (KtValueArgument arg : call.getValueArguments()) {
            KtExpression expr = arg.getArgumentExpression();
            if (expr instanceof KtLambdaExpression lambda) {
                return lambda.getBodyExpression();
            }
        }
        return null;
    }

    private static Integer parseDecimalInteger(KtExpression expr) {
        if (!(expr instanceof KtConstantExpression)) return null;
        String text = expr.getText();
        if (text != null && text.matches("^\\d+$")) {
            try {
                return Integer.parseInt(text);
            } catch (NumberFormatException ignored) {
            }
        }
        return null;
    }

    private static String literal(KtExpression expression) {
        if (!(expression instanceof KtStringTemplateExpression string) || string.hasInterpolation()) return null;
        StringBuilder value = new StringBuilder();
        for (KtStringTemplateEntry entry : string.getEntries()) {
            if (entry instanceof KtEscapeStringTemplateEntry escape) value.append(escape.getUnescapedValue());
            else value.append(entry.getText());
        }
        return value.toString();
    }

    private static String computeLintXmlFingerprint(String rootText, String moduleText) {
        if (rootText == null && moduleText == null) return "absent";
        StringBuilder sb = new StringBuilder();
        sb.append("root:").append(rootText != null ? sha256(rootText) : "none");
        if (moduleText != null) {
            sb.append(";module:").append(sha256(moduleText));
        }
        return sha256(sb.toString());
    }

    private static String computeModelFingerprint(
            String moduleName,
            String androidModuleName,
            String moduleRoot,
            String projectRoot,
            String variant,
            Integer compileSdk,
            String compileTarget,
            Integer minSdk,
            Integer targetSdk,
            String namespace,
            boolean isLibrary,
            boolean minSdkPremiseMissing,
            boolean isBuilt,
            List<Path> trackedXmls) {
        StringBuilder sb = new StringBuilder();
        sb.append(moduleName).append(';')
                .append(androidModuleName).append(';')
                .append(moduleRoot).append(';')
                .append(projectRoot).append(';')
                .append(variant).append(';')
                .append(compileSdk).append(';')
                .append(compileTarget).append(';')
                .append(minSdk).append(';')
                .append(targetSdk).append(';')
                .append(namespace).append(';')
                .append(isLibrary).append(';')
                .append(minSdkPremiseMissing).append(';')
                .append(isBuilt ? "built" : "clean");
        for (Path p : trackedXmls) {
            if (Files.isRegularFile(p)) {
                try {
                    sb.append(';').append(p).append(":size=").append(Files.size(p))
                            .append(":mtime=").append(Files.getLastModifiedTime(p).toMillis())
                            .append(":content=").append(sha256(Files.readString(p)));
                } catch (IOException e) {
                    sb.append(';').append(p).append(":read_error");
                }
            } else {
                sb.append(';').append(p).append(":absent");
            }
        }
        return sha256(sb.toString());
    }

    private static String sha256(String text) {
        if (text == null) return "null";
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] bytes = md.digest(text.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder(bytes.length * 2);
            for (byte b : bytes) {
                sb.append(Character.forDigit((b >> 4) & 0xF, 16));
                sb.append(Character.forDigit(b & 0xF, 16));
            }
            return sb.toString();
        } catch (NoSuchAlgorithmException e) {
            throw new RuntimeException(e);
        }
    }
}
