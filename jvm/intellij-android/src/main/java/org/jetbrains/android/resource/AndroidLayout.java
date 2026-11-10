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
import org.codehaus.groovy.ast.CodeVisitorSupport;
import org.codehaus.groovy.ast.ModuleNode;
import org.codehaus.groovy.ast.expr.ArgumentListExpression;
import org.codehaus.groovy.ast.expr.BinaryExpression;
import org.codehaus.groovy.ast.expr.ClosureExpression;
import org.codehaus.groovy.ast.expr.ConstantExpression;
import org.codehaus.groovy.ast.expr.Expression;
import org.codehaus.groovy.ast.expr.ListExpression;
import org.codehaus.groovy.ast.expr.MethodCallExpression;
import org.codehaus.groovy.ast.expr.PropertyExpression;
import org.codehaus.groovy.ast.expr.TupleExpression;
import org.codehaus.groovy.ast.stmt.BlockStatement;
import org.codehaus.groovy.ast.stmt.ExpressionStatement;
import org.codehaus.groovy.ast.stmt.Statement;

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
        PsiFile script = AndroidSources.gradleScript(project, root);
        if (!(script instanceof KtFile kotlin)) {
            ModuleNode groovy = AndroidSources.groovyAst(project, root);
            if (groovy != null) {
                Path directory = Path.of(root.getPath()).toAbsolutePath().normalize();
                GroovyLayoutData data = parseGroovyLayout(groovy, directory, variant, importedSourceSets);
                android = data.android();
                namespace = data.namespace();
                resources = data.resources();
                manifests = data.manifests();
                return;
            }
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

    private record GroovyLayoutData(boolean android, String namespace, Set<Path> resources, Set<Path> manifests) {
    }


    static GroovyLayoutData parseGroovyLayout(ModuleNode ast, Path directory, String variant, Set<String> importedSourceSets) {
        if (ast == null || ast.getStatementBlock() == null) {
            return new GroovyLayoutData(false, null, Set.of(), Set.of());
        }
        List<MethodCallExpression> androidBlocks = new ArrayList<>();
        for (Statement s : ast.getStatementBlock().getStatements()) {
            if (s instanceof ExpressionStatement es && es.getExpression() instanceof MethodCallExpression mc) {
                if ("android".equals(mc.getMethodAsString()) && getClosure(mc) != null) {
                    androidBlocks.add(mc);
                }
            }
        }
        if (androidBlocks.size() != 1) {
            return new GroovyLayoutData(false, null, Set.of(), Set.of());
        }

        MethodCallExpression androidCall = androidBlocks.get(0);
        ClosureExpression closure = getClosure(androidCall);
        if (closure == null || !(closure.getCode() instanceof BlockStatement body)) {
            return new GroovyLayoutData(true, null, Set.of(), Set.of());
        }

        List<String> namespaces = new ArrayList<>();
        for (Statement s : body.getStatements()) {
            if (s instanceof ExpressionStatement es) {
                Expression expr = es.getExpression();
                if (expr instanceof MethodCallExpression mc && "namespace".equals(mc.getMethodAsString())) {
                    String val = getLiteral(mc.getArguments());
                    if (val != null && !val.isBlank()) namespaces.add(val);
                } else if (expr instanceof BinaryExpression be && "=".equals(be.getOperation().getText())) {
                    if ("namespace".equals(be.getLeftExpression().getText())) {
                        String val = getLiteral(be.getRightExpression());
                        if (val != null && !val.isBlank()) namespaces.add(val);
                    }
                }
            }
        }
        String namespace = namespaces.size() == 1 ? namespaces.get(0) : null;

        Map<String, SourceSet> sourceSets = new LinkedHashMap<>();
        for (String sourceSet : importedSourceSets) sourceSets.put(sourceSet, defaults(directory, sourceSet));
        if (importedSourceSets.contains("main") && variant != null)
            sourceSets.putIfAbsent(variant, defaults(directory, variant));

        boolean[] known = new boolean[]{true, true}; // [resourcesKnown, manifestsKnown]

        body.visit(new CodeVisitorSupport() {
            private final Deque<String> scopeStack = new ArrayDeque<>();

            @Override
            public void visitMethodCallExpression(MethodCallExpression call) {
                ProgressManager.checkCanceled();
                String methodName = call.getMethodAsString();
                ClosureExpression nestedClosure = getClosure(call);
                if (nestedClosure != null) {
                    String scopeName = methodName;
                    if ("getByName".equals(methodName) || "named".equals(methodName) || "create".equals(methodName)) {
                        if (call.getArguments() instanceof ArgumentListExpression ale && !ale.getExpressions().isEmpty()) {
                            String arg = getLiteral(ale.getExpressions().get(0));
                            if (arg != null) scopeName = arg;
                        }
                    }
                    scopeStack.push(scopeName);
                    try {
                        nestedClosure.getCode().visit(this);
                    } finally {
                        scopeStack.pop();
                    }
                    return;
                }

                if (SOURCE_OPERATIONS.contains(methodName)) {
                    handleSourceOperation(call.getObjectExpression(), methodName, call.getArguments(), false, scopeStack, sourceSets, directory, known);
                }
                super.visitMethodCallExpression(call);
            }

            @Override
            public void visitBinaryExpression(BinaryExpression expression) {
                ProgressManager.checkCanceled();
                if ("=".equals(expression.getOperation().getText())) {
                    Expression left = expression.getLeftExpression();
                    if (left instanceof PropertyExpression pe) {
                        String prop = pe.getPropertyAsString();
                        if ("srcDirs".equals(prop) || "srcFile".equals(prop)) {
                            handleSourceOperation(pe.getObjectExpression(), prop, expression.getRightExpression(), true, scopeStack, sourceSets, directory, known);
                        }
                    }
                }
                super.visitBinaryExpression(expression);
            }
        });

        Set<Path> res = new LinkedHashSet<>(), manifest = new LinkedHashSet<>();
        for (SourceSet s : sourceSets.values()) {
            res.addAll(s.resources);
            manifest.addAll(s.manifests);
        }

        return new GroovyLayoutData(
                true,
                namespace,
                known[0] ? Set.copyOf(res) : Set.of(),
                known[1] ? Set.copyOf(manifest) : Set.of()
        );
    }

    private static void handleSourceOperation(
            Expression receiver,
            String operation,
            Expression valueExpr,
            boolean isAssignment,
            Deque<String> scopeStack,
            Map<String, SourceSet> sourceSets,
            Path directory,
            boolean[] known
    ) {
        String receiverText = receiver.getText();
        boolean isRes = receiverText.endsWith("res") || "res".equals(receiverText);
        boolean isManifest = receiverText.endsWith("manifest") || "manifest".equals(receiverText);
        if (!isRes && !isManifest) return;

        String sourceSetName = determineSourceSet(receiver, scopeStack);
        if (sourceSetName == null) {
            if (isRes) known[0] = false;
            else known[1] = false;
            return;
        }

        SourceSet target = sourceSets.get(sourceSetName);
        if (target == null) return;

        List<String> paths = getLiterals(valueExpr);
        if (paths == null || (isManifest && paths.size() != 1)) {
            if (isRes) known[0] = false;
            else known[1] = false;
            return;
        }

        Set<Path> destinations = isRes ? target.resources : target.manifests;
        boolean replace = isAssignment || operation.equals("setSrcDirs") || operation.equals("srcFile");
        if (replace) destinations.clear();
        for (String p : paths) {
            destinations.add(directory.resolve(p).normalize());
        }
    }

    private static String determineSourceSet(Expression receiver, Deque<String> stack) {
        if (receiver instanceof PropertyExpression pe) {
            Expression obj = pe.getObjectExpression();
            if (obj instanceof PropertyExpression objPe) {
                if ("sourceSets".equals(objPe.getObjectExpression().getText())) {
                    return objPe.getPropertyAsString();
                }
            } else if (obj instanceof BinaryExpression be && "[".equals(be.getOperation().getText())) {
                if ("sourceSets".equals(be.getLeftExpression().getText())) {
                    return getLiteral(be.getRightExpression());
                }
            }
        }
        for (String s : stack) {
            if (!s.equals("sourceSets") && !s.equals("android")) {
                return s;
            }
        }
        return null;
    }

    private static List<String> getLiterals(Expression expr) {
        if (expr instanceof ArgumentListExpression ale) {
            List<String> list = new ArrayList<>();
            for (Expression e : ale.getExpressions()) {
                List<String> sub = getLiterals(e);
                if (sub == null) return null;
                list.addAll(sub);
            }
            return list;
        }
        if (expr instanceof TupleExpression te) {
            List<String> list = new ArrayList<>();
            for (Expression e : te.getExpressions()) {
                List<String> sub = getLiterals(e);
                if (sub == null) return null;
                list.addAll(sub);
            }
            return list;
        }
        if (expr instanceof ListExpression le) {
            List<String> list = new ArrayList<>();
            for (Expression e : le.getExpressions()) {
                String s = getLiteral(e);
                if (s == null) return null;
                list.add(s);
            }
            return list;
        }
        String s = getLiteral(expr);
        if (s != null) return List.of(s);
        return null;
    }

    private static String getLiteral(Expression expr) {
        if (expr instanceof ArgumentListExpression ale) {
            if (ale.getExpressions().size() == 1) return getLiteral(ale.getExpressions().get(0));
            return null;
        }
        if (expr instanceof ConstantExpression ce && ce.getValue() instanceof String s) {
            return s;
        }
        return null;
    }

    private static ClosureExpression getClosure(MethodCallExpression mc) {
        if (mc.getArguments() instanceof ArgumentListExpression ale) {
            for (Expression e : ale.getExpressions()) {
                if (e instanceof ClosureExpression ce) return ce;
            }
        }
        return null;
    }
}
