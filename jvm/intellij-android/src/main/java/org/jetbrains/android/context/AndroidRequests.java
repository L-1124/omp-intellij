package org.jetbrains.android.context;

import com.intellij.openapi.application.CoroutinesKt;
import com.intellij.openapi.editor.Document;
import com.intellij.openapi.progress.ProgressManager;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.vfs.VirtualFile;
import com.intellij.psi.PsiDocumentManager;
import com.intellij.psi.PsiFile;
import com.intellij.psi.PsiManager;
import com.jetbrains.ls.api.core.LSServer;
import com.jetbrains.ls.api.core.util.PositionKt;
import com.jetbrains.lsp.protocol.Position;
import com.jetbrains.lsp.protocol.TextDocumentIdentifier;
import kotlinx.coroutines.flow.Flow;
import kotlinx.coroutines.flow.FlowKt;
import org.jetbrains.android.resource.AndroidSources;
import java.util.List;


public final class AndroidRequests {
    private AndroidRequests() {
    }

    public interface Query<T> {
        List<T> run(Project project, PsiFile file, int offset);
    }

    public static <T> Flow<T> query(LSServer server, TextDocumentIdentifier identifier, Position position, Query<T> query) {
        Flow<List<T>> batches = FlowKt.flow((collector, continuation) ->
                AndroidRequests.<List<T>>chain(next -> server.withAnalysisContext((context, scope, result) ->
                                CoroutinesKt.readAction(() -> {
                                    ProgressManager.checkCanceled();
                                    Project project = context.getProject();
                                    VirtualFile virtualFile = PositionKt.findVirtualFile(identifier);
                                    PsiFile file = virtualFile == null ? null : PsiManager.getInstance(project).findFile(virtualFile);
                                    if (file == null) return List.<T>of();
                                    Document document = PsiDocumentManager.getInstance(project).getDocument(file);
                                    if (document == null) return List.<T>of();
                                    int line = position.getLine();
                                    if (line < 0 || line >= document.getLineCount()) return List.<T>of();
                                    int character = position.getCharacter();
                                    if (character < 0 || character > document.getLineEndOffset(line) - document.getLineStartOffset(line))
                                        return List.<T>of();
                                    long stamp = document.getModificationStamp();
                                    List<T> values;
                                    try (var sources = new AndroidSources.Scope(server, virtualFile)) {
                                        values = query.run(project, file, document.getLineStartOffset(line) + character);
                                        sources.verify();
                                    } catch (AndroidQueryException error) {
                                        return AndroidRequests.<RuntimeException, List<T>>raise(new com.jetbrains.lsp.implementation.LspResponseErrorException(error.getMessage(), error.getErrorCode(), null, error));
                                    }
                                    ProgressManager.checkCanceled();
                                    if (stamp != document.getModificationStamp())
                                        return AndroidRequests.<RuntimeException, List<T>>raise(new com.jetbrains.lsp.implementation.LspResponseErrorException("content_modified", -32801, null, null));
                                    return values;
                                }, result), next),
                        values -> collector.emit(values, continuation), continuation));
        return FlowKt.flatMapConcat(batches, (values, continuation) -> FlowKt.asFlow(values));
    }

    interface Suspension<T> {
        Object run(kotlin.coroutines.Continuation<? super T> continuation);
    }

    private static <T> Object chain(Suspension<T> operation, java.util.function.Function<T, Object> next,
                                    kotlin.coroutines.Continuation<? super kotlin.Unit> continuation) {
        Object suspended = kotlin.coroutines.intrinsics.IntrinsicsKt.getCOROUTINE_SUSPENDED();
        Object value = operation.run(new kotlin.coroutines.Continuation<T>() {
            public kotlin.coroutines.CoroutineContext getContext() {
                return continuation.getContext();
            }

            @SuppressWarnings("unchecked")
            public void resumeWith(Object value) {
                try {
                    kotlin.ResultKt.throwOnFailure(value);
                    Object result = next.apply((T) value);
                    if (result != suspended) continuation.resumeWith(result);
                } catch (Throwable error) {
                    continuation.resumeWith(kotlin.ResultKt.createFailure(error));
                }
            }
        });
        if (value == suspended) return suspended;
        @SuppressWarnings("unchecked") T result = (T) value;
        return next.apply(result);
    }

    @SuppressWarnings("unchecked")
    private static <E extends Throwable, T> T raise(Throwable error) throws E {
        throw (E) error;
    }

}
