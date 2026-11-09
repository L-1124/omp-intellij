package org.jetbrains.android.navigation;

import com.intellij.openapi.application.CoroutinesKt;
import com.intellij.openapi.progress.ProgressManager;
import com.intellij.openapi.project.Project;
import com.jetbrains.ls.api.core.LSServer;
import com.jetbrains.ls.api.features.commands.LSCommandDescriptor;
import com.jetbrains.ls.api.features.commands.LSCommandDescriptorProvider;
import com.jetbrains.ls.api.features.commands.LSCommandExecutor;
import com.jetbrains.lsp.implementation.LspHandlerContext;
import com.jetbrains.lsp.implementation.LspResponseErrorException;
import kotlin.coroutines.Continuation;
import kotlinx.serialization.json.*;
import org.jetbrains.android.context.AndroidQueryException;
import org.jetbrains.android.context.AndroidRequests;
import org.jetbrains.android.resource.AndroidSources;

import java.net.URI;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

public final class AndroidResourceCommands implements LSCommandDescriptorProvider {
    public static final String COMMAND_FIND_RESOURCE_FIELD_REFERENCES = "omp.findResourceFieldReferences";

    public static final int LSP_ERROR_CODE_INVALID_PARAMS = -32602;
    public static final int LSP_ERROR_CODE_REQUEST_FAILED = -32803;

    @Override
    public List<LSCommandDescriptor> getCommandDescriptors() {
        return List.of(
                new LSCommandDescriptor(
                        "Find Resource Field References",
                        COMMAND_FIND_RESOURCE_FIELD_REFERENCES,
                        createFindResourceFieldReferencesExecutor()
                )
        );
    }

    private LSCommandExecutor createFindResourceFieldReferencesExecutor() {
        return (LSServer server, LspHandlerContext context, List<? extends JsonElement> arguments, Continuation<? super JsonElement> continuation) -> {
            ParsedArgs parsed;
            try {
                parsed = parseArguments(arguments);
            } catch (LspResponseErrorException e) {
                return AndroidRequests.<RuntimeException, Object>raise(e);
            }

            return server.withAnalysisContext((analysisContext, scope, result) ->
                    CoroutinesKt.readAction(() -> {
                        ProgressManager.checkCanceled();
                        Project project = analysisContext.getProject();
                        try (var sources = new AndroidSources.Scope(server, null)) {
                            JsonElement response = AndroidNavigationService.getInstance().findResourceFieldReferencesCommand(
                                    project,
                                    parsed.moduleName,
                                    parsed.namespace,
                                    parsed.type,
                                    parsed.name,
                                    parsed.classOrigins
                            );
                            sources.verify();
                            return response;
                        } catch (AndroidQueryException error) {
                            return AndroidRequests.<RuntimeException, JsonElement>raise(error.toLspResponseErrorException());
                        }
                    }, result), continuation);
        };
    }

    private record ParsedArgs(
            String moduleName,
            String namespace,
            String type,
            String name,
            List<Path> classOrigins
    ) {}

    private ParsedArgs parseArguments(List<? extends JsonElement> arguments) throws LspResponseErrorException {
        if (arguments == null || arguments.size() != 1 || !(arguments.get(0) instanceof JsonObject args)) {
            throw new LspResponseErrorException("Expected single JsonObject argument", LSP_ERROR_CODE_INVALID_PARAMS, null, null);
        }

        JsonElement pvEl = args.get("protocolVersion");
        if (pvEl == null) {
            throw new LspResponseErrorException("Missing protocolVersion parameter", LSP_ERROR_CODE_INVALID_PARAMS, null, null);
        }
        if (!(pvEl instanceof JsonPrimitive prim) || prim.isString()) {
            throw new LspResponseErrorException("protocolVersion must be a JSON number", LSP_ERROR_CODE_INVALID_PARAMS, null, null);
        }
        Integer pv = JsonElementKt.getIntOrNull(prim);
        if (pv == null) {
            throw new LspResponseErrorException("protocolVersion must be an integer", LSP_ERROR_CODE_INVALID_PARAMS, null, null);
        }
        if (pv != 1) {
            throw new LspResponseErrorException("protocol_mismatch: protocolVersion must be 1", LSP_ERROR_CODE_REQUEST_FAILED, null, null);
        }

        String moduleName = getStringParam(args, "moduleName");
        String namespace = getStringParam(args, "namespace");
        String type = getStringParam(args, "type");
        String name = getStringParam(args, "name");

        JsonElement coEl = args.get("classOrigins");
        if (!(coEl instanceof JsonArray coArray) || coArray.isEmpty()) {
            throw new LspResponseErrorException("classOrigins must be a non-empty array of file URIs", LSP_ERROR_CODE_INVALID_PARAMS, null, null);
        }
        List<Path> classOrigins = new ArrayList<>();
        for (JsonElement item : coArray) {
            if (item instanceof JsonPrimitive origin && origin.isString()) {
                String uriStr = origin.getContent();
                try {
                    URI uri = URI.create(uriStr);
                    if (!"file".equalsIgnoreCase(uri.getScheme())) {
                        throw new LspResponseErrorException("classOrigins entries must be file URIs: " + uriStr, LSP_ERROR_CODE_INVALID_PARAMS, null, null);
                    }
                    classOrigins.add(Path.of(uri).toAbsolutePath().normalize());
                } catch (IllegalArgumentException e) {
                    throw new LspResponseErrorException("Invalid file URI in classOrigins: " + uriStr, LSP_ERROR_CODE_INVALID_PARAMS, null, null);
                }
            } else {
                throw new LspResponseErrorException("classOrigins entries must be string file URIs", LSP_ERROR_CODE_INVALID_PARAMS, null, null);
            }
        }

        return new ParsedArgs(moduleName, namespace, type, name, classOrigins);
    }

    private static String getStringParam(JsonObject args, String key) throws LspResponseErrorException {
        JsonElement el = args.get(key);
        if (el instanceof JsonPrimitive prim && prim.isString() && !prim.getContent().isBlank()) {
            return prim.getContent();
        }
        throw new LspResponseErrorException("Missing or invalid string parameter: " + key, LSP_ERROR_CODE_INVALID_PARAMS, null, null);
    }
}
