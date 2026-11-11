package org.jetbrains.android.resource

import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.psi.PsiElement
import com.intellij.psi.PsiFile
import com.intellij.psi.util.PsiTreeUtil
import org.codehaus.groovy.ast.CodeVisitorSupport
import org.codehaus.groovy.ast.ModuleNode
import org.codehaus.groovy.ast.expr.ArgumentListExpression
import org.codehaus.groovy.ast.expr.BinaryExpression
import org.codehaus.groovy.ast.expr.ClosureExpression
import org.codehaus.groovy.ast.expr.ConstantExpression
import org.codehaus.groovy.ast.expr.Expression
import org.codehaus.groovy.ast.expr.ListExpression
import org.codehaus.groovy.ast.expr.MethodCallExpression
import org.codehaus.groovy.ast.expr.PropertyExpression
import org.codehaus.groovy.ast.expr.TupleExpression
import org.codehaus.groovy.ast.stmt.BlockStatement
import org.codehaus.groovy.ast.stmt.ExpressionStatement
import org.codehaus.groovy.ast.stmt.Statement
import org.jetbrains.kotlin.psi.KtArrayAccessExpression
import org.jetbrains.kotlin.psi.KtBinaryExpression
import org.jetbrains.kotlin.psi.KtBlockExpression
import org.jetbrains.kotlin.psi.KtCallExpression
import org.jetbrains.kotlin.psi.KtCollectionLiteralExpression
import org.jetbrains.kotlin.psi.KtDotQualifiedExpression
import org.jetbrains.kotlin.psi.KtEscapeStringTemplateEntry
import org.jetbrains.kotlin.psi.KtExpression
import org.jetbrains.kotlin.psi.KtFile
import org.jetbrains.kotlin.psi.KtLambdaExpression
import org.jetbrains.kotlin.psi.KtStringTemplateEntry
import org.jetbrains.kotlin.psi.KtStringTemplateExpression
import org.jetbrains.kotlin.psi.KtValueArgument
import org.jetbrains.kotlin.psi.KtValueArgumentList
import java.nio.file.Path
import java.util.ArrayDeque
import java.util.Deque

class AndroidLayout(
    project: Project,
    root: VirtualFile,
    variant: String?,
    importedSourceSets: Set<String>
) {
    @JvmField
    val android: Boolean

    @JvmField
    val namespace: String?

    @JvmField
    val resources: Set<Path>

    @JvmField
    val manifests: Set<Path>

    private data class SourceSet(val resources: MutableSet<Path>, val manifests: MutableSet<Path>)

    private data class GroovyLayoutData(
        val android: Boolean,
        val namespace: String?,
        val resources: Set<Path>,
        val manifests: Set<Path>
    )

    init {
        val script: PsiFile? = AndroidSources.gradleScript(project, root)
        if (script !is KtFile) {
            val groovy: ModuleNode? = AndroidSources.groovyAst(project, root)
            if (groovy != null) {
                val directory = Path.of(root.path).toAbsolutePath().normalize()
                val data = parseGroovyLayout(groovy, directory, variant, importedSourceSets)
                android = data.android
                namespace = data.namespace
                resources = data.resources
                manifests = data.manifests
            } else {
                android = false
                namespace = null
                resources = emptySet()
                manifests = emptySet()
            }
        } else {
            val blocks = mutableListOf<KtCallExpression>()
            for (call in PsiTreeUtil.collectElementsOfType(script, KtCallExpression::class.java)) {
                if (name(call) == "android" && PsiTreeUtil.getParentOfType(
                        call,
                        KtLambdaExpression::class.java
                    ) == null
                ) {
                    blocks.add(call)
                }
            }
            android = blocks.size == 1
            if (!android) {
                namespace = null
                resources = emptySet()
                manifests = emptySet()
            } else {
                val block = blocks[0]
                val body = body(block)
                if (body == null) {
                    namespace = null
                    resources = emptySet()
                    manifests = emptySet()
                } else {
                    val names = mutableListOf<KtExpression?>()
                    for (statement in body.statements) {
                        if (statement is KtBinaryExpression) {
                            val left = statement.left
                            if (left != null && left.text == "namespace" && statement.operationReference.text == "=") {
                                names.add(statement.right)
                            }
                        }
                        if (statement is KtCallExpression && name(statement) == "namespace") {
                            names.add(if (statement.valueArguments.size == 1) statement.valueArguments[0].getArgumentExpression() else null)
                        }
                    }
                    namespace = if (names.size == 1) names[0]?.let { literal(it) } else null
                    val directory = Path.of(root.path).toAbsolutePath().normalize()
                    val sourceSets = LinkedHashMap<String, SourceSet>()
                    for (sourceSet in importedSourceSets) {
                        sourceSets[sourceSet] = defaults(directory, sourceSet)
                    }
                    if (importedSourceSets.contains("main") && variant != null) {
                        sourceSets.putIfAbsent(variant, defaults(directory, variant))
                    }
                    var resourcesKnown = true
                    var manifestsKnown = true
                    for (expression in PsiTreeUtil.collectElementsOfType(body, KtExpression::class.java)) {
                        ProgressManager.checkCanceled()
                        var receiver: KtExpression? = null
                        var property: String? = null
                        var arguments: MutableList<KtExpression?>? = null
                        var replace = false
                        val parent = expression.parent
                        if (expression is KtCallExpression && parent is KtDotQualifiedExpression && parent.selectorExpression == expression) {
                            property = name(expression)
                            if (!SOURCE_OPERATIONS.contains(property)) continue
                            receiver = parent.receiverExpression
                            arguments = ArrayList()
                            for (argument in expression.valueArguments) {
                                arguments.add(argument.getArgumentExpression())
                            }
                            replace = property == "setSrcDirs" || property == "srcFile"
                        } else if (expression is KtBinaryExpression && expression.left is KtDotQualifiedExpression && expression.operationReference.text == "=") {
                            val dot = expression.left as KtDotQualifiedExpression
                            property = if (dot.selectorExpression == null) "" else dot.selectorExpression!!.text
                            if (property != "srcDirs" && property != "srcFile") continue
                            receiver = dot.receiverExpression
                            arguments = ArrayList()
                            arguments.add(expression.right)
                            replace = true
                        }
                        if (receiver == null) continue
                        val receiverName =
                            if (receiver is KtDotQualifiedExpression && receiver.selectorExpression != null) {
                                receiver.selectorExpression!!.text
                            } else {
                                receiver.text
                            }
                        val res = receiverName == "res"
                        val manifest = receiverName == "manifest"
                        if (!res && !manifest) continue
                        val sourceSet = sourceSet(expression, receiver)
                        if (sourceSet == null) {
                            if (res) resourcesKnown = false else manifestsKnown = false
                            continue
                        }
                        val target = sourceSets[sourceSet] ?: continue
                        val paths = literals(arguments)
                        if (paths == null || (manifest && paths.size != 1)) {
                            if (res) resourcesKnown = false else manifestsKnown = false
                            continue
                        }
                        val destinations = if (res) target.resources else target.manifests
                        if (replace) destinations.clear()
                        for (path in paths) {
                            destinations.add(directory.resolve(path).normalize())
                        }
                    }
                    val res = LinkedHashSet<Path>()
                    val manifest = LinkedHashSet<Path>()
                    for (sourceSet in sourceSets.values) {
                        res.addAll(sourceSet.resources)
                        manifest.addAll(sourceSet.manifests)
                    }
                    resources = if (resourcesKnown) java.util.Set.copyOf(res) else emptySet()
                    manifests = if (manifestsKnown) java.util.Set.copyOf(manifest) else emptySet()
                }
            }
        }
    }

    companion object {
        private val SOURCE_OPERATIONS = setOf("srcDir", "srcDirs", "setSrcDirs", "srcFile")
        private val LITERAL_COLLECTIONS = setOf("listOf", "setOf", "arrayOf")

        private fun defaults(root: Path, sourceSet: String): SourceSet {
            return SourceSet(
                LinkedHashSet(setOf(root.resolve("src").resolve(sourceSet).resolve("res"))),
                LinkedHashSet(setOf(root.resolve("src").resolve(sourceSet).resolve("AndroidManifest.xml")))
            )
        }

        private fun sourceSet(element: PsiElement, receiver: KtExpression): String? {
            for (array in PsiTreeUtil.collectElementsOfType(receiver, KtArrayAccessExpression::class.java)) {
                val arrayExpr = array.arrayExpression
                if (arrayExpr != null && arrayExpr.text == "sourceSets" && array.indexExpressions.size == 1) {
                    return literal(array.indexExpressions[0])
                }
            }
            var ancestor = element.parent
            while (ancestor != null) {
                if (ancestor !is KtCallExpression || body(ancestor) == null) {
                    ancestor = ancestor.parent
                    continue
                }
                val name = name(ancestor)
                if (name == "getByName" || name == "named" || name == "create") {
                    val arguments: KtValueArgumentList? = ancestor.valueArgumentList
                    if (arguments == null || arguments.arguments.size != 1) return null
                    val argExpr = arguments.arguments[0].getArgumentExpression() ?: return null
                    return literal(argExpr)
                }
                if (name == "main" || name == "debug" || name == "release" || name == "androidTest" || name == "test") {
                    return name
                }
                if (name != "sourceSets" && name != "android") return null
                ancestor = ancestor.parent
            }
            return null
        }

        private fun literals(expressions: List<KtExpression?>?): List<String>? {
            if (expressions == null) return null
            val result = mutableListOf<String>()
            for (expression in expressions) {
                if (expression == null) return null
                val value = literal(expression)
                if (value != null) {
                    result.add(value)
                    continue
                }
                val nested = mutableListOf<KtExpression>()
                if (expression is KtCallExpression && LITERAL_COLLECTIONS.contains(name(expression))) {
                    for (argument in expression.valueArguments) {
                        val argExpr = argument.getArgumentExpression()
                        if (argExpr != null) nested.add(argExpr)
                    }
                } else if (expression is KtCollectionLiteralExpression) {
                    nested.addAll(expression.getInnerExpressions())
                } else {
                    return null
                }
                val values = literals(nested) ?: return null
                result.addAll(values)
            }
            return result
        }

        private fun name(call: KtCallExpression): String {
            val callee = call.calleeExpression
            return callee?.text ?: ""
        }

        private fun body(call: KtCallExpression): KtBlockExpression? {
            if (call.lambdaArguments.size != 1) return null
            val lambda: KtLambdaExpression? = call.lambdaArguments[0].getLambdaExpression()
            return lambda?.bodyExpression
        }

        private fun literal(expression: KtExpression): String? {
            if (expression !is KtStringTemplateExpression || expression.hasInterpolation()) return null
            val value = java.lang.StringBuilder()
            for (entry in expression.entries) {
                if (entry is KtEscapeStringTemplateEntry) {
                    value.append(entry.unescapedValue)
                } else {
                    value.append(entry.text)
                }
            }
            return value.toString()
        }

        @JvmStatic
        private fun parseGroovyLayout(
            ast: ModuleNode?,
            directory: Path,
            variant: String?,
            importedSourceSets: Set<String>
        ): GroovyLayoutData {
            if (ast == null || ast.statementBlock == null) {
                return GroovyLayoutData(false, null, emptySet(), emptySet())
            }
            val androidBlocks = mutableListOf<MethodCallExpression>()
            for (s: Statement in ast.statementBlock.statements) {
                if (s is ExpressionStatement && s.expression is MethodCallExpression) {
                    val mc = s.expression as MethodCallExpression
                    if ("android" == mc.methodAsString && getClosure(mc) != null) {
                        androidBlocks.add(mc)
                    }
                }
            }
            if (androidBlocks.size != 1) {
                return GroovyLayoutData(false, null, emptySet(), emptySet())
            }

            val androidCall = androidBlocks[0]
            val closure = getClosure(androidCall)
            if (closure == null || closure.code !is BlockStatement) {
                return GroovyLayoutData(true, null, emptySet(), emptySet())
            }
            val body = closure.code as BlockStatement

            val namespaces = mutableListOf<String>()
            for (s: Statement in body.statements) {
                if (s is ExpressionStatement) {
                    val expr = s.expression
                    if (expr is MethodCallExpression && "namespace" == expr.methodAsString) {
                        val value = getLiteral(expr.arguments)
                        if (value != null && !value.isBlank()) namespaces.add(value)
                    } else if (expr is BinaryExpression && "=" == expr.operation.text) {
                        if ("namespace" == expr.leftExpression.text) {
                            val value = getLiteral(expr.rightExpression)
                            if (value != null && !value.isBlank()) namespaces.add(value)
                        }
                    }
                }
            }
            val namespace = if (namespaces.size == 1) namespaces[0] else null

            val sourceSets = LinkedHashMap<String, SourceSet>()
            for (sourceSet in importedSourceSets) {
                sourceSets[sourceSet] = defaults(directory, sourceSet)
            }
            if (importedSourceSets.contains("main") && variant != null) {
                sourceSets.putIfAbsent(variant, defaults(directory, variant))
            }

            val known = booleanArrayOf(true, true) // [resourcesKnown, manifestsKnown]

            body.visit(object : CodeVisitorSupport() {
                private val scopeStack: Deque<String> = ArrayDeque()

                override fun visitMethodCallExpression(call: MethodCallExpression) {
                    ProgressManager.checkCanceled()
                    val methodName = call.methodAsString
                    val nestedClosure = getClosure(call)
                    if (nestedClosure != null) {
                        var scopeName = methodName
                        if ("getByName" == methodName || "named" == methodName || "create" == methodName) {
                            val args = call.arguments
                            if (args is ArgumentListExpression && args.expressions.isNotEmpty()) {
                                val arg = getLiteral(args.expressions[0])
                                if (arg != null) scopeName = arg
                            }
                        }
                        scopeStack.push(scopeName)
                        try {
                            nestedClosure.code.visit(this)
                        } finally {
                            scopeStack.pop()
                        }
                        return
                    }

                    if (SOURCE_OPERATIONS.contains(methodName)) {
                        handleSourceOperation(
                            call.objectExpression,
                            methodName,
                            call.arguments,
                            false,
                            scopeStack,
                            sourceSets,
                            directory,
                            known
                        )
                    }
                    super.visitMethodCallExpression(call)
                }

                override fun visitBinaryExpression(expression: BinaryExpression) {
                    ProgressManager.checkCanceled()
                    if ("=" == expression.operation.text) {
                        val left = expression.leftExpression
                        if (left is PropertyExpression) {
                            val prop = left.propertyAsString
                            if ("srcDirs" == prop || "srcFile" == prop) {
                                handleSourceOperation(
                                    left.objectExpression,
                                    prop,
                                    expression.rightExpression,
                                    true,
                                    scopeStack,
                                    sourceSets,
                                    directory,
                                    known
                                )
                            }
                        }
                    }
                    super.visitBinaryExpression(expression)
                }
            })

            val res = LinkedHashSet<Path>()
            val manifest = LinkedHashSet<Path>()
            for (s in sourceSets.values) {
                res.addAll(s.resources)
                manifest.addAll(s.manifests)
            }

            return GroovyLayoutData(
                true,
                namespace,
                if (known[0]) java.util.Set.copyOf(res) else emptySet(),
                if (known[1]) java.util.Set.copyOf(manifest) else emptySet()
            )
        }

        private fun handleSourceOperation(
            receiver: Expression,
            operation: String,
            valueExpr: Expression,
            isAssignment: Boolean,
            scopeStack: Deque<String>,
            sourceSets: MutableMap<String, SourceSet>,
            directory: Path,
            known: BooleanArray
        ) {
            val receiverText = receiver.text
            val isRes = receiverText.endsWith("res") || "res" == receiverText
            val isManifest = receiverText.endsWith("manifest") || "manifest" == receiverText
            if (!isRes && !isManifest) return

            val sourceSetName = determineSourceSet(receiver, scopeStack)
            if (sourceSetName == null) {
                if (isRes) known[0] = false else known[1] = false
                return
            }

            val target = sourceSets[sourceSetName] ?: return

            val paths = getLiterals(valueExpr)
            if (paths == null || (isManifest && paths.size != 1)) {
                if (isRes) known[0] = false else known[1] = false
                return
            }

            val destinations = if (isRes) target.resources else target.manifests
            val replace = isAssignment || operation == "setSrcDirs" || operation == "srcFile"
            if (replace) destinations.clear()
            for (p in paths) {
                destinations.add(directory.resolve(p).normalize())
            }
        }

        private fun determineSourceSet(receiver: Expression, stack: Deque<String>): String? {
            if (receiver is PropertyExpression) {
                val obj = receiver.objectExpression
                if (obj is PropertyExpression) {
                    if ("sourceSets" == obj.objectExpression.text) {
                        return obj.propertyAsString
                    }
                } else if (obj is BinaryExpression && "[" == obj.operation.text) {
                    if ("sourceSets" == obj.leftExpression.text) {
                        return getLiteral(obj.rightExpression)
                    }
                }
            }
            for (s in stack) {
                if (s != "sourceSets" && s != "android") {
                    return s
                }
            }
            return null
        }

        private fun getLiterals(expr: Expression): List<String>? {
            if (expr is ArgumentListExpression) {
                val list = mutableListOf<String>()
                for (e in expr.expressions) {
                    val sub = getLiterals(e) ?: return null
                    list.addAll(sub)
                }
                return list
            }
            if (expr is TupleExpression) {
                val list = mutableListOf<String>()
                for (e in expr.expressions) {
                    val sub = getLiterals(e) ?: return null
                    list.addAll(sub)
                }
                return list
            }
            if (expr is ListExpression) {
                val list = mutableListOf<String>()
                for (e in expr.expressions) {
                    val s = getLiteral(e) ?: return null
                    list.add(s)
                }
                return list
            }
            val s = getLiteral(expr)
            if (s != null) return listOf(s)
            return null
        }

        private fun getLiteral(expr: Expression): String? {
            if (expr is ArgumentListExpression) {
                if (expr.expressions.size == 1) return getLiteral(expr.expressions[0])
                return null
            }
            if (expr is ConstantExpression) {
                val value = expr.value
                if (value is String) return value
            }
            return null
        }

        private fun getClosure(mc: MethodCallExpression): ClosureExpression? {
            val args = mc.arguments
            if (args is ArgumentListExpression) {
                for (e in args.expressions) {
                    if (e is ClosureExpression) return e
                }
            }
            return null
        }
    }
}
