package org.jetbrains.android.lint;

import com.android.tools.lint.detector.api.Incident;
import com.android.tools.lint.detector.api.Severity;
import com.intellij.lang.java.JavaLanguage;
import com.intellij.openapi.editor.Document;
import com.intellij.openapi.fileEditor.FileDocumentManager;
import com.intellij.openapi.progress.ProgressManager;
import com.intellij.openapi.vfs.VfsUtilCore;
import com.intellij.openapi.vfs.VirtualFileManager;
import com.jetbrains.ls.api.core.LSServer;
import com.jetbrains.ls.api.core.util.PositionKt;
import com.jetbrains.ls.api.features.diagnostics.LSDiagnosticProvider;
import com.jetbrains.ls.api.features.language.LSLanguage;
import com.jetbrains.lsp.implementation.LspHandlerContext;
import com.jetbrains.lsp.protocol.*;
import kotlinx.coroutines.flow.Flow;
import kotlinx.serialization.json.*;
import org.jetbrains.android.context.AndroidRequests;
import org.jetbrains.android.resource.AndroidLocations;
import org.jetbrains.android.resource.AndroidSources;
import org.jetbrains.kotlin.idea.KotlinLanguage;

import java.lang.invoke.MethodHandle;
import java.lang.invoke.MethodHandles;
import java.lang.invoke.MethodType;
import java.nio.file.Path;
import java.util.*;

public final class AndroidLintProvider implements LSDiagnosticProvider {
    private static final MethodHandle DIAGNOSTIC;

    static {
        try {
            DIAGNOSTIC = MethodHandles.publicLookup().findConstructor(Diagnostic.class,
                    MethodType.methodType(void.class, Range.class, DiagnosticSeverity.class, JsonPrimitive.class,
                            CodeDescription.class, String.class, String.class, List.class, List.class,
                            JsonElement.class, kotlin.jvm.internal.DefaultConstructorMarker.class));
        } catch (ReflectiveOperationException error) {
            throw new ExceptionInInitializerError(error);
        }
    }

    private record CacheKey(String projectLocationHash, String fileUri, Integer lspDocVersion,
                            long documentModificationStamp, com.android.tools.lint.detector.api.Scope scope,
                            String modelFingerprint,
                            List<String> ruleJarFingerprints, String lintXmlFingerprint, String contentFingerprint) {
    }

    private final Map<CacheKey, List<Diagnostic>> cache = Collections.synchronizedMap(
            new LinkedHashMap<>(64, 0.75f, true) {
                @Override
                protected boolean removeEldestEntry(Map.Entry<CacheKey, List<Diagnostic>> eldest) {
                    return size() > 64;
                }
            });

    @Override
    public Set<LSLanguage> getSupportedLanguages() {
        return Set.of(new LSLanguage("java", JavaLanguage.INSTANCE, List.of("java")),
                new LSLanguage("kotlin", KotlinLanguage.INSTANCE, List.of("kt", "kts")),
                org.jetbrains.android.AndroidExtension.XML);
    }

    @Override
    public Flow<Diagnostic> getDiagnostics(LSServer server, LspHandlerContext context, DocumentDiagnosticParams params) {
        return AndroidRequests.diagnosticQuery(server, params.getTextDocument(), (project, file, document) -> {
            boolean xml = file instanceof com.intellij.psi.xml.XmlFile;
            if (!xml && !file.getName().endsWith(".java") && !file.getName().endsWith(".kt"))
                return new AndroidRequests.DiagnosticResult<>(List.of());
            if (xml && !java.nio.file.Files.isRegularFile(file.getVirtualFile().toNioPath()))
                return new AndroidRequests.DiagnosticResult<>(List.of());
            AndroidLintModel model = AndroidLintModelResolver.resolve(project, file.getVirtualFile());
            if (model == null) return new AndroidRequests.DiagnosticResult<>(List.of());
            var scope = xml ? AndroidLintResources.scope(model, file.getVirtualFile().toNioPath())
                    : com.android.tools.lint.detector.api.Scope.JAVA_FILE;
            if (scope == null) return new AndroidRequests.DiagnosticResult<>(List.of());
            String uri = PositionKt.getUri(file.getVirtualFile());
            CacheKey key = new CacheKey(project.getLocationHash(), uri, AndroidSources.version(server, uri),
                    document.getModificationStamp(), scope, model.fingerprint(), model.ruleJarFingerprints(), model.lintXmlFingerprint(),
                    com.google.common.hash.Hashing.sha256().hashUnencodedChars(document.getImmutableCharSequence()).toString());
            List<Diagnostic> existing = cache.get(key);
            if (existing != null) {
                com.intellij.openapi.diagnostic.Logger.getInstance(AndroidLintProvider.class).debug("Android lint cache hit: " + uri);
                return new AndroidRequests.DiagnosticResult<>(List.copyOf(existing));
            }
            var client = new AndroidLintClient(model, file, document.getText(), scope);
            List<Incident> incidents = client.analyze();
            List<Diagnostic> values = diagnostics(incidents, document);
            return new AndroidRequests.DiagnosticResult<>(values, () -> {
                if (client.isAnalysisComplete()) cache.put(key, values);
            });
        });
    }

    private record Mapped(Diagnostic diagnostic, String code) {
    }

    static List<Diagnostic> diagnostics(List<Incident> incidents, Document document) {
        List<Mapped> values = new ArrayList<>();
        for (Incident incident : incidents) {
            ProgressManager.checkCanceled();
            var location = incident.getLocation();
            if (incident.getSeverity() == Severity.IGNORE || location == null || location.getStart() == null || location.getEnd() == null)
                continue;
            Range range = range(document, location.getStart().getOffset(), location.getEnd().getOffset());
            if (range == null) continue;
            String code = incident.getIssue().getId();
            DiagnosticSeverity severity = switch (incident.getSeverity()) {
                case FATAL, ERROR -> DiagnosticSeverity.Error;
                case WARNING -> DiagnosticSeverity.Warning;
                default -> DiagnosticSeverity.Information;
            };
            List<DiagnosticRelatedInformation> related = new ArrayList<>();
            Set<com.android.tools.lint.detector.api.Location> seen = Collections.newSetFromMap(new IdentityHashMap<>());
            for (var secondary = location.getSecondary(); secondary != null && seen.add(secondary); secondary = secondary.getSecondary()) {
                if (secondary.getStart() == null || secondary.getEnd() == null) continue;
                Path path = secondary.getFile().toPath().toAbsolutePath().normalize();
                var vf = VirtualFileManager.getInstance().findFileByUrl(VfsUtilCore.pathToUrl(path.toString()));
                if (vf == null) continue;
                AndroidSources.observeCompiledArchive(path);
                AndroidSources.observe(vf);
                Document secondaryDocument = FileDocumentManager.getInstance().getDocument(vf);
                if (secondaryDocument == null) continue;
                Range secondaryRange = range(secondaryDocument, secondary.getStart().getOffset(), secondary.getEnd().getOffset());
                if (secondaryRange == null) continue;
                related.add(new DiagnosticRelatedInformation(AndroidLocations.at(path, secondaryRange),
                        secondary.getMessage() == null ? code : secondary.getMessage()));
            }
            JsonObject data = new JsonObject(Map.of("issueId", JsonElementKt.JsonPrimitive(code),
                    "source", JsonElementKt.JsonPrimitive("android-lint")));
            try {
                Diagnostic diagnostic = (Diagnostic) DIAGNOSTIC.invokeExact(range, severity, JsonElementKt.JsonPrimitive(code),
                        (CodeDescription) null, "android-lint", incident.getMessage(), (List) null,
                        (List) (related.isEmpty() ? null : List.copyOf(related)), (JsonElement) data,
                        (kotlin.jvm.internal.DefaultConstructorMarker) null);
                values.add(new Mapped(diagnostic, code));
            } catch (RuntimeException | Error error) {
                throw error;
            } catch (Throwable error) {
                throw new IllegalStateException(error);
            }
        }
        values.sort(Comparator.comparingInt((Mapped value) -> value.diagnostic().getRange().getStart().getLine())
                .thenComparingInt(value -> value.diagnostic().getRange().getStart().getCharacter())
                .thenComparingInt(value -> value.diagnostic().getRange().getEnd().getLine())
                .thenComparingInt(value -> value.diagnostic().getRange().getEnd().getCharacter())
                .thenComparing(Mapped::code).thenComparing(value -> value.diagnostic().getMessage()));
        List<Diagnostic> result = new ArrayList<>();
        Mapped previous = null;
        for (Mapped value : values) {
            if (previous == null || !previous.code().equals(value.code()) ||
                    !previous.diagnostic().getRange().equals(value.diagnostic().getRange()) ||
                    !previous.diagnostic().getMessage().equals(value.diagnostic().getMessage()))
                result.add(value.diagnostic());
            previous = value;
        }
        return List.copyOf(result);
    }

    static Range range(Document document, int start, int end) {
        if (start < 0 || end <= start) return null;
        int length = document.getTextLength();
        start = Math.min(start, length);
        end = Math.min(end, length);
        if (start >= end) return null;
        return new Range(position(document, start), position(document, end));
    }

    private static Position position(Document document, int offset) {
        int line = document.getLineNumber(offset);
        return new Position(line, offset - document.getLineStartOffset(line));
    }
}
