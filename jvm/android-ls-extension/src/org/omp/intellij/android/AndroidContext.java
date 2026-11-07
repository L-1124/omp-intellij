package org.omp.intellij.android;

import com.intellij.openapi.externalSystem.util.ExternalSystemApiUtil;
import com.intellij.openapi.module.Module;
import com.intellij.openapi.module.ModuleManager;
import com.intellij.openapi.progress.ProgressManager;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.roots.LibraryOrderEntry;
import com.intellij.openapi.roots.ModuleRootManager;
import com.intellij.openapi.roots.OrderRootType;
import com.intellij.openapi.roots.ProjectFileIndex;
import com.intellij.openapi.vfs.VfsUtilCore;
import com.intellij.openapi.vfs.VirtualFile;
import com.intellij.openapi.vfs.VirtualFileManager;
import com.intellij.psi.PsiFile;
import com.intellij.psi.xml.XmlFile;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Pattern;

public final class AndroidContext {
    public static final String ANDROID_NS = "http://schemas.android.com/apk/res/android";
    private static final Set<String> RESOURCE_TYPES = Set.of("anim", "animator", "color", "drawable", "font", "interpolator", "layout", "menu", "mipmap", "navigation", "raw", "transition", "xml");
    private static final Pattern PACKAGE = Pattern.compile("[A-Za-z_][A-Za-z0-9_]*(?:\\.[A-Za-z_][A-Za-z0-9_]*)*");

    private AndroidContext() {
    }

    public static AndroidFileInfo identify(PsiFile file) {
        ProgressManager.checkCanceled();
        if (file == null || file.getVirtualFile() == null || !file.isValid()) return AndroidFileInfo.nonAndroid();
        VirtualFile virtualFile = file.getVirtualFile();
        Module module = findModule(file.getProject(), virtualFile);
        if (module != null && isAndroidModule(module)) return identify(file, module);
        // Explicit custom roots can lie outside all imported content roots.
        AndroidFileInfo selected = null;
        for (Module candidate : ModuleManager.getInstance(file.getProject()).getModules()) {
            if (!isAndroidModule(candidate)) continue;
            AndroidFileInfo info = identify(file, candidate);
            if (!info.isAndroidFile()) continue;
            if (selected != null) return AndroidFileInfo.nonAndroid();
            selected = info;
        }
        return selected == null ? AndroidFileInfo.nonAndroid() : selected;
    }

    private static AndroidFileInfo identify(PsiFile file, Module module) {
        VirtualFile root = findModuleRoot(module);
        if (root == null) return AndroidFileInfo.nonAndroid();
        AndroidLayout layout = layout(module);
        Path path = Path.of(file.getVirtualFile().getPath()).toAbsolutePath().normalize();
        AndroidFileRole role = AndroidFileRole.NOT_ANDROID;
        if (file instanceof XmlFile xml && xml.getRootTag() != null) {
            String name = xml.getRootTag().getName();
            if (name.equals("manifest") && layout.manifests.contains(path)) role = AndroidFileRole.MANIFEST;
            else if (path.getParent() != null && path.getParent().getParent() != null && layout.resources.contains(path.getParent().getParent())) {
                String folder = path.getParent().getFileName().toString();
                if (name.equals("resources") && AndroidFolders.isValues(folder)) role = AndroidFileRole.VALUES_XML;
                else if (RESOURCE_TYPES.contains(folder.split("-", 2)[0])) role = AndroidFileRole.RESOURCE_XML;
            }
        } else if (file.getName().endsWith(".java") || file.getName().endsWith(".kt")) {
            if (module == ProjectFileIndex.getInstance(file.getProject()).getModuleForFile(file.getVirtualFile()))
                role = AndroidFileRole.KOTLIN_OR_JAVA;
        }
        if (role == AndroidFileRole.NOT_ANDROID) return AndroidFileInfo.nonAndroid();
        return new AndroidFileInfo(role, module, root, resolveVariant(module, root), resolveNamespace(file.getProject(), module), true);
    }

    public static boolean isSupportedXml(XmlFile file) {
        AndroidFileRole role = identify(file).role();
        return role == AndroidFileRole.MANIFEST || role == AndroidFileRole.VALUES_XML;
    }

    public static boolean isAndroidModule(Module module) {
        if (module == null || module.isDisposed() || findModuleRoot(module) == null) return false;
        boolean imported = false;
        for (var entry : ModuleRootManager.getInstance(module).getOrderEntries()) {
            if (entry instanceof LibraryOrderEntry library && library.getLibrary() != null && "Gradle: android:r:null".equals(library.getLibrary().getName()))
                imported = true;
        }
        return imported && layout(module).android;
    }

    public static Module findModule(Project project, VirtualFile file) {
        return ProjectFileIndex.getInstance(project).getModuleForFile(file);
    }

    public static VirtualFile findModuleRoot(Module module) {
        if (module == null || module.isDisposed()) return null;
        Set<Path> candidates = new LinkedHashSet<>();
        for (VirtualFile content : ModuleRootManager.getInstance(module).getContentRoots()) {
            Path path = Path.of(content.getPath()).toAbsolutePath().normalize();
            for (Path current = path; current != null; current = current.getParent()) {
                if (Files.isRegularFile(current.resolve("build.gradle.kts")) || Files.isRegularFile(current.resolve("build.gradle"))) {
                    candidates.add(current);
                    break;
                }
            }
        }
        if (candidates.isEmpty()) {
            String imported = ExternalSystemApiUtil.getExternalProjectPath(module);
            if (imported != null) candidates.add(Path.of(imported).toAbsolutePath().normalize());
        }
        if (candidates.size() != 1) return null;
        return VirtualFileManager.getInstance().findFileByUrl(VfsUtilCore.pathToUrl(candidates.iterator().next().toString()));
    }

    public static String resolveVariant(Module module, VirtualFile root) {
        if (module == null || root == null) return null;
        Set<String> variants = new LinkedHashSet<>();
        Path directory = Path.of(root.getPath()).toAbsolutePath().normalize().resolve("build/intermediates");
        for (var entry : ModuleRootManager.getInstance(module).getOrderEntries()) {
            if (!(entry instanceof LibraryOrderEntry library) || library.getLibrary() == null) continue;
            for (String url : library.getLibrary().getUrls(OrderRootType.CLASSES)) {
                String value = VfsUtilCore.urlToPath(url);
                int separator = value.indexOf("!/");
                Path path;
                try {
                    path = Path.of(separator < 0 ? value : value.substring(0, separator)).toAbsolutePath().normalize();
                } catch (java.nio.file.InvalidPathException error) {
                    continue;
                }
                if (!path.startsWith(directory)) continue;
                Path relative = directory.relativize(path);
                if (relative.getNameCount() >= 3 && Set.of("compile_and_runtime_r_class_jar", "compile_r_class_jar", "compile_and_runtime_not_namespaced_r_class_jar").contains(relative.getName(0).toString()))
                    variants.add(relative.getName(1).toString());
            }
        }
        return variants.size() == 1 ? variants.iterator().next() : null;
    }

    public static String resolveNamespace(Project project, Module module) {
        if (module == null || findModuleRoot(module) == null) return null;
        String namespace = layout(module).namespace;
        return namespace != null && PACKAGE.matcher(namespace).matches() ? namespace : null;
    }

    public static List<VirtualFile> findResourceRoots(Project project, Module module) {
        if (!isAndroidModule(module)) return List.of();
        List<VirtualFile> roots = new ArrayList<>();
        for (Path path : layout(module).resources) {
            VirtualFile file = VirtualFileManager.getInstance().findFileByUrl(VfsUtilCore.pathToUrl(path.toString()));
            if (file != null) roots.add(file);
        }
        return roots;
    }

    private static AndroidLayout layout(Module module) {
        return AndroidSources.scope().layouts.computeIfAbsent(module, ignored -> {
            VirtualFile root = findModuleRoot(module);
            Set<String> sources = new LinkedHashSet<>();
            Path sourceRoot = Path.of(root.getPath()).toAbsolutePath().normalize().resolve("src");
            for (String url : ModuleRootManager.getInstance(module).getSourceRootUrls()) {
                Path path = Path.of(VfsUtilCore.urlToPath(url)).toAbsolutePath().normalize();
                if (path.startsWith(sourceRoot) && path.getNameCount() > sourceRoot.getNameCount())
                    sources.add(sourceRoot.relativize(path).getName(0).toString());
            }
            return new AndroidLayout(module.getProject(), root, resolveVariant(module, root), sources);
        });
    }
}
