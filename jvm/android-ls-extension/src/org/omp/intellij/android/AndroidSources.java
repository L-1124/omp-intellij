package org.omp.intellij.android;

import com.intellij.ide.highlighter.XmlFileType;
import com.intellij.openapi.progress.ProgressManager;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.vfs.VfsUtilCore;
import com.intellij.openapi.vfs.VirtualFile;
import com.intellij.openapi.vfs.VirtualFileManager;
import com.intellij.psi.PsiFile;
import com.intellij.psi.PsiManager;
import com.intellij.psi.xml.XmlFile;
import org.jetbrains.kotlin.psi.KtPsiFactory;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.HashMap;
import java.util.Map;
import java.util.Objects;

final class AndroidSources {
    private static final ThreadLocal<Scope> CURRENT = new ThreadLocal<>();
    private static final java.lang.invoke.MethodHandle DOCUMENT_VERSION;

    static {
        try {
            DOCUMENT_VERSION = java.lang.invoke.MethodHandles.publicLookup().findVirtual(
                    com.jetbrains.ls.api.core.LSDocuments.class, "getVersion-XfNk_NE",
                    java.lang.invoke.MethodType.methodType(Integer.class, String.class));
        } catch (ReflectiveOperationException error) {
            throw new ExceptionInInitializerError(error);
        }
    }

    private AndroidSources() {
    }

    static final class Scope implements AutoCloseable {
        private final com.jetbrains.ls.api.core.LSServer server;
        private final Map<String, Integer> versions = new HashMap<>();
        private final Map<Path, Stamp> stamps = new HashMap<>();
        private final Map<Path, PsiFile> files = new HashMap<>();
        private final Map<Path, String> texts = new HashMap<>();
        final Map<com.intellij.openapi.module.Module, AndroidLayout> layouts = new HashMap<>();

        Scope(com.jetbrains.ls.api.core.LSServer server, VirtualFile file) {
            if (CURRENT.get() != null) throw new IllegalStateException("Nested Android source scope");
            this.server = server;
            CURRENT.set(this);
            observe(file);
        }

        void verify() {
            ProgressManager.checkCanceled();
            for (var entry : versions.entrySet()) {
                if (!Objects.equals(entry.getValue(), version(server, entry.getKey())))
                    throw new AndroidQueryException("content_modified", -32801);
            }
            for (var entry : stamps.entrySet()) {
                if (!Objects.equals(entry.getValue(), stamp(entry.getKey())))
                    throw new AndroidQueryException("content_modified", -32801);
            }
        }

        @Override
        public void close() {
            CURRENT.remove();
        }
    }

    static Scope scope() {
        Scope scope = CURRENT.get();
        if (scope == null) throw new IllegalStateException("Android model reads require a request scope");
        return scope;
    }

    static void track(Path path) {
        path = path.toAbsolutePath().normalize();
        Scope scope = CURRENT.get();
        if (!scope.stamps.containsKey(path)) scope.stamps.put(path, stamp(path));
    }

    static boolean modifiedAfter(Path path, java.nio.file.attribute.FileTime time) {
        path = path.toAbsolutePath().normalize();
        track(path);
        Stamp stamp = scope().stamps.get(path);
        return stamp != null && stamp.modified().compareTo(time) > 0;
    }

    private record Stamp(long size, java.nio.file.attribute.FileTime modified, Object key) {
    }

    private static Stamp stamp(Path path) {
        try {
            BasicFileAttributes value = Files.readAttributes(path, BasicFileAttributes.class);
            return new Stamp(value.size(), value.lastModifiedTime(), value.fileKey());
        } catch (java.nio.file.NoSuchFileException missing) {
            return null;
        } catch (IOException error) {
            throw AndroidQueryException.modelUnavailable("Cannot stat source: " + path);
        }
    }

    static String text(Path path) {
        path = path.toAbsolutePath().normalize();
        Scope scope = CURRENT.get();
        if (scope == null) throw new IllegalStateException("Android source reads require a request scope");
        if (scope.texts.containsKey(path)) return scope.texts.get(path);
        ProgressManager.checkCanceled();
        Stamp before = stamp(path);
        scope.stamps.put(path, before);
        if (before == null) {
            scope.texts.put(path, null);
            return null;
        }
        try {
            String text = Files.readString(path);
            if (!Objects.equals(before, stamp(path))) throw new AndroidQueryException("content_modified", -32801);
            scope.texts.put(path, text);
            return text;
        } catch (IOException error) {
            throw AndroidQueryException.modelUnavailable("Cannot read source: " + path);
        }
    }

    static PsiFile current(Project project, Path path) {
        track(path);
        VirtualFile file = VirtualFileManager.getInstance().findFileByUrl(VfsUtilCore.pathToUrl(path.toAbsolutePath().normalize().toString()));
        observe(file);
        return file == null ? null : PsiManager.getInstance(project).findFile(file);
    }

    static Scope open(VirtualFile file) {
        return new Scope(null, file);
    }

    private static void observe(VirtualFile file) {
        Scope scope = CURRENT.get();
        if (file == null || scope == null || scope.server == null) return;
        String uri = com.jetbrains.ls.api.core.util.PositionKt.getUri(file);
        if (!scope.versions.containsKey(uri)) scope.versions.put(uri, version(scope.server, uri));
    }

    private static Integer version(com.jetbrains.ls.api.core.LSServer server, String uri) {
        if (server == null) return null;
        try {
            return (Integer) DOCUMENT_VERSION.invokeExact(server.getDocuments(), uri);
        } catch (RuntimeException | Error error) {
            throw error;
        } catch (Throwable error) {
            throw new IllegalStateException(error);
        }
    }


    static PsiFile kotlinScript(Project project, VirtualFile root) {
        Path path = Path.of(root.getPath(), "build.gradle.kts").toAbsolutePath().normalize();
        PsiFile current = current(project, path);
        if (current != null) return current;
        Scope scope = CURRENT.get();
        if (scope.files.containsKey(path)) return scope.files.get(path);
        // ILS omits Gradle scripts from its source snapshot until didOpen.
        String text = text(path);
        PsiFile file = text == null ? null : new KtPsiFactory(project, false).createFile("build.gradle.kts", text);
        scope.files.put(path, file);
        return file;
    }

    static XmlFile xml(Project project, Path path) {
        path = path.toAbsolutePath().normalize();
        PsiFile current = current(project, path);
        if (current != null) return current instanceof XmlFile xml ? xml : null;
        Scope scope = CURRENT.get();
        if (scope.files.containsKey(path)) return (XmlFile) scope.files.get(path);
        String text = text(path);
        XmlFile file = null;
        if (text != null) {
            var virtualFile = virtualFile(path, XmlFileType.INSTANCE, com.intellij.openapi.util.text.StringUtil.convertLineSeparators(text));
            com.intellij.psi.SingleRootFileViewProvider.doNotCheckFileSizeLimit(virtualFile);
            var provider = new com.intellij.psi.SingleRootFileViewProvider(PsiManager.getInstance(project), virtualFile, false, XmlFileType.INSTANCE);
            file = (XmlFile) provider.getPsi(com.intellij.lang.xml.XMLLanguage.INSTANCE);
            if (file == null) throw AndroidQueryException.modelUnavailable("Native XML parser unavailable");
        }
        scope.files.put(path, file);
        return file;
    }

    static PsiFile navigationFile(Project project, Path path) {
        if (path.toString().endsWith(".xml")) return xml(project, path);
        track(path);
        PsiFile current = current(project, path);
        if (current != null) return current;
        var file = virtualFile(path, com.intellij.openapi.fileTypes.PlainTextFileType.INSTANCE, "");
        var provider = new com.intellij.psi.SingleRootFileViewProvider(PsiManager.getInstance(project), file, false, com.intellij.openapi.fileTypes.PlainTextFileType.INSTANCE);
        return provider.getPsi(com.intellij.openapi.fileTypes.PlainTextLanguage.INSTANCE);
    }

    private static com.intellij.testFramework.LightVirtualFile virtualFile(Path source, com.intellij.openapi.fileTypes.FileType type, String text) {
        return new com.intellij.testFramework.LightVirtualFile(source.getFileName().toString(), type, text) {
            @Override
            public String getPath() {
                return source.toString().replace('\\', '/');
            }

            @Override
            public String getUrl() {
                return VfsUtilCore.pathToUrl(getPath());
            }
        };
    }
}
