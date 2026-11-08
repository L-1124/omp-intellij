package org.jetbrains.android.resource;

import com.intellij.openapi.progress.ProgressManager;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.vfs.VirtualFile;
import com.intellij.psi.PsiElement;
import com.intellij.psi.PsiFile;
import com.intellij.psi.util.PsiTreeUtil;
import org.jetbrains.kotlin.psi.*;
import java.nio.file.Path;
import java.util.*;

public final class AndroidLayout {
    private static final Set<String> SOURCE_OPERATIONS = Set.of("srcDir", "srcDirs", "setSrcDirs", "srcFile");
    private static final Set<String> LITERAL_COLLECTIONS = Set.of("listOf", "setOf", "arrayOf");
    public final boolean android;
    public final String namespace;
    public final Set<Path> resources;
    public final Set<Path> manifests;

    private record SourceSet(Set<Path> resources, Set<Path> manifests) {
    }

    public AndroidLayout(Project project, VirtualFile root, String variant, Set<String> importedSourceSets) {
        PsiFile script = AndroidSources.kotlinScript(project, root);
        if (!(script instanceof KtFile kotlin)) {
            android = false;
            namespace = null;
            resources = Set.of();
            manifests = Set.of();
            return;
        }
        List<KtCallExpression> blocks = new ArrayList<>();
        for (KtCallExpression call : PsiTreeUtil.collectElementsOfType(kotlin, KtCallExpression.class)) {
            if (name(call).equals("android") && PsiTreeUtil.getParentOfType(call, KtLambdaExpression.class) == null)
                blocks.add(call);
        }
        android = blocks.size() == 1;
        if (!android) {
            namespace = null;
            resources = Set.of();
            manifests = Set.of();
            return;
        }
        KtCallExpression block = blocks.get(0);
        KtBlockExpression body = body(block);
        if (body == null) {
            namespace = null;
            resources = Set.of();
            manifests = Set.of();
            return;
        }
        List<KtExpression> names = new ArrayList<>();
        for (KtExpression statement : body.getStatements()) {
            if (statement instanceof KtBinaryExpression binary && binary.getLeft() != null && binary.getLeft().getText().equals("namespace") && binary.getOperationReference().getText().equals("="))
                names.add(binary.getRight());
            if (statement instanceof KtCallExpression call && name(call).equals("namespace"))
                names.add(call.getValueArguments().size() == 1 ? call.getValueArguments().get(0).getArgumentExpression() : null);
        }
        namespace = names.size() == 1 ? literal(names.get(0)) : null;
        Path directory = Path.of(root.getPath()).toAbsolutePath().normalize();
        Map<String, SourceSet> sourceSets = new LinkedHashMap<>();
        for (String sourceSet : importedSourceSets) sourceSets.put(sourceSet, defaults(directory, sourceSet));
        if (importedSourceSets.contains("main") && variant != null)
            sourceSets.putIfAbsent(variant, defaults(directory, variant));
        boolean resourcesKnown = true, manifestsKnown = true;
        for (KtExpression expression : PsiTreeUtil.collectElementsOfType(body, KtExpression.class)) {
            ProgressManager.checkCanceled();
            KtExpression receiver = null;
            String property = null;
            List<KtExpression> arguments = null;
            boolean replace = false;
            if (expression instanceof KtCallExpression call && call.getParent() instanceof KtDotQualifiedExpression dot && dot.getSelectorExpression() == call) {
                property = name(call);
                if (!SOURCE_OPERATIONS.contains(property)) continue;
                receiver = dot.getReceiverExpression();
                arguments = new ArrayList<>();
                for (KtValueArgument argument : call.getValueArguments())
                    arguments.add(argument.getArgumentExpression());
                replace = property.equals("setSrcDirs") || property.equals("srcFile");
            } else if (expression instanceof KtBinaryExpression binary && binary.getLeft() instanceof KtDotQualifiedExpression dot && binary.getOperationReference().getText().equals("=")) {
                property = dot.getSelectorExpression() == null ? "" : dot.getSelectorExpression().getText();
                if (!property.equals("srcDirs") && !property.equals("srcFile")) continue;
                receiver = dot.getReceiverExpression();
                arguments = new ArrayList<>();
                arguments.add(binary.getRight());
                replace = true;
            }
            if (receiver == null) continue;
            String receiverName = receiver instanceof KtDotQualifiedExpression dot && dot.getSelectorExpression() != null ? dot.getSelectorExpression().getText() : receiver.getText();
            boolean res = receiverName.equals("res"), manifest = receiverName.equals("manifest");
            if (!res && !manifest) continue;
            String sourceSet = sourceSet(expression, receiver);
            if (sourceSet == null) {
                if (res) resourcesKnown = false;
                else manifestsKnown = false;
                continue;
            }
            SourceSet target = sourceSets.get(sourceSet);
            if (target == null) continue;
            List<String> paths = literals(arguments);
            if (paths == null || manifest && paths.size() != 1) {
                if (res) resourcesKnown = false;
                else manifestsKnown = false;
                continue;
            }
            Set<Path> destinations = res ? target.resources : target.manifests;
            if (replace) destinations.clear();
            for (String path : paths) destinations.add(directory.resolve(path).normalize());
        }
        Set<Path> res = new LinkedHashSet<>(), manifest = new LinkedHashSet<>();
        for (SourceSet sourceSet : sourceSets.values()) {
            res.addAll(sourceSet.resources);
            manifest.addAll(sourceSet.manifests);
        }
        resources = resourcesKnown ? Set.copyOf(res) : Set.of();
        manifests = manifestsKnown ? Set.copyOf(manifest) : Set.of();
    }

    private static SourceSet defaults(Path root, String sourceSet) {
        return new SourceSet(new LinkedHashSet<>(Set.of(root.resolve("src").resolve(sourceSet).resolve("res"))),
                new LinkedHashSet<>(Set.of(root.resolve("src").resolve(sourceSet).resolve("AndroidManifest.xml"))));
    }

    private static String sourceSet(PsiElement element, KtExpression receiver) {
        for (KtArrayAccessExpression array : PsiTreeUtil.collectElementsOfType(receiver, KtArrayAccessExpression.class)) {
            if (array.getArrayExpression() != null && array.getArrayExpression().getText().equals("sourceSets") && array.getIndexExpressions().size() == 1)
                return literal(array.getIndexExpressions().get(0));
        }
        for (PsiElement ancestor = element.getParent(); ancestor != null; ancestor = ancestor.getParent()) {
            if (!(ancestor instanceof KtCallExpression call) || body(call) == null) continue;
            String name = name(call);
            if (name.equals("getByName") || name.equals("named") || name.equals("create")) {
                KtValueArgumentList arguments = call.getValueArgumentList();
                if (arguments == null || arguments.getArguments().size() != 1) return null;
                return literal(arguments.getArguments().get(0).getArgumentExpression());
            }
            if (name.equals("main") || name.equals("debug") || name.equals("release") || name.equals("androidTest") || name.equals("test"))
                return name;
            if (!name.equals("sourceSets") && !name.equals("android")) return null;
        }
        return null;
    }

    private static List<String> literals(List<KtExpression> expressions) {
        List<String> result = new ArrayList<>();
        for (KtExpression expression : expressions) {
            String value = literal(expression);
            if (value != null) {
                result.add(value);
                continue;
            }
            List<KtExpression> nested = new ArrayList<>();
            if (expression instanceof KtCallExpression call && LITERAL_COLLECTIONS.contains(name(call))) {
                for (KtValueArgument argument : call.getValueArguments()) nested.add(argument.getArgumentExpression());
            } else if (expression instanceof KtCollectionLiteralExpression collection)
                nested.addAll(collection.getInnerExpressions());
            else return null;
            List<String> values = literals(nested);
            if (values == null) return null;
            result.addAll(values);
        }
        return result;
    }

    private static String name(KtCallExpression call) {
        return call.getCalleeExpression() == null ? "" : call.getCalleeExpression().getText();
    }

    private static KtBlockExpression body(KtCallExpression call) {
        if (call.getLambdaArguments().size() != 1) return null;
        KtLambdaExpression lambda = call.getLambdaArguments().get(0).getLambdaExpression();
        return lambda == null ? null : lambda.getBodyExpression();
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
}
