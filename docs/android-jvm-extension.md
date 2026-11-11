# Android JVM 扩展架构与语义支持技术指南

## 核心结论

1. **原生导入与 Android 语义扩展分工**：ILS `271.2085.0` 负责 Gradle Android 模型导入和 Java/Kotlin 编译诊断。`android.lsp` 插件通过 `language-server.api.features.impl.android` 内容模块中的 `LanguageServerExtension` SPI 补齐 XML 大纲、Manifest 类及资源声明的引用、`R.*` 源码优先导航、K2 `@Composable` 命名抑制，以及标准 `textDocument/diagnostic` 中的 `android-lint` 诊断。
2. **插件 ID 与互斥目标**：保留官方 Android 插件 ID `org.jetbrains.android`，有意不支持与官方完整 Android 插件共存。主描述符声明内容模块；SPI、实现类及使用这些类的扩展声明放在实现模块中。
3. **工程化与构建体系**：使用 `jvm/intellij-android/` 标准 Gradle 9.8.0 Java 工程。目标 ILS 版本从 `src/server/bundle-metadata.ts` 读取，编译工具链使用该 ILS 的 JBR 25（classfile 69）；`gradle.lockfile` 和 `verification-metadata.xml` 锁定依赖及摘要。`stageExtension` 生成 manifest 与 `.sha256`，运行时复用 `verifyExtensionDirectory` 验证清单、ABI、字节大小和哈希，不再依赖独立 `check-assets` 脚本。
4. **源码审查优先于反编译推测**：本地实测横评 4 款现代反编译器（`jcdc`、`javajive`、`abyssflower`、`vinylite`）表明：`jcdc` 对 Java 21+ 语法（Sealed 类、Record、TWR、模式匹配）和内部类折叠还原度最高；`abyssflower` 凭借 `@Metadata` Protobuf 解析在 Kotlin 语法还原上断层领先；但任何反编译器在字节码脱糖、泛型擦除和架构设计意图上均存在不可逆失真。核心方案必须以官方开源仓库（`JetBrains/intellij-community`、`JetBrains/android` 提交 `544c9ef8`、AOSP `platform/tools/base`）作为第一权威依据，杜绝盲目依靠反编译黑盒猜解协议。

### JVM 包结构

`org.jetbrains.android` 根包仅保留 SPI 入口 `AndroidExtension`，其余实现按职责分包：

| 子包         | 职责                                     |
| ------------ | ---------------------------------------- |
| `context`    | 模块环境、文件角色、请求上下文与查询异常 |
| `xml`        | XML 属性解析与文档大纲                   |
| `navigation` | 定义、引用、Manifest 目标与资源直达导航  |
| `resource`   | 资源解析、源集目录、布局与源码读取       |
| `compose`    | Compose 命名检查抑制                     |
| `lint`       | 官方源码级 Lint、模块模型、依赖规则与诊断缓存 |
| `debug`      | JDWP 附加、调试命令、监听器与字段过滤    |

跨包调用的类和成员显式公开；包内辅助方法保留包级可见性。SPI 名称仍为 `org.jetbrains.android.AndroidExtension`。`plugin.xml` 使用迁移后的入口路径。

---

## 踩坑记录与根因分析

### 1. 扩展注册时机过早导致 `ApplicationManager.getApplication()` 为 null

- **问题现象**：在最初实现中，`ComposeSuppressor.registerOnce()` 在 `AndroidExtension.getConfiguration()` 中直接调用，运行时抛出 `NullPointerException` 或直接导致语言服务进程崩溃。
- **根因排查**：`LanguageServerExtension.getConfiguration()` 在 ILS 启动阶段的 SPI 扫描期间执行，此时 IntelliJ 底层的核心组件容器和 `Application` 单例尚未初始化完成（`ApplicationManager.getApplication()` 返回 `null`）。而 `LanguageInspectionSuppressors.INSTANCE.addExplicitExtension` 强依赖 Application 级别的扩展点容器（`ExtensionPoint`）。
- **解决方案**：将注册操作延迟到 Application 容器就绪阶段。在 `AndroidExtension` 中暴露实现了 `WorkspaceComponentEntry` 的 `ComposeSuppressor.Entry`，内部绑定 `WorkspaceComponent` 单例；在平台生命周期回调 `registerInApplicationContainer(builder, application, state, kind, continuation)` 被调用时（此时 Application 已完全就绪），再执行 `ComposeSuppressor.registerOnce()`，并在 `plugin.xml` 声明 `<lang.inspectionSuppressor language="kotlin" implementationClass="org.jetbrains.android.compose.ComposeSuppressor"/>` 双重保底。
- **实测对比**：修复前服务启动直接报 NPE 无法提供任何 Android 功能；修复后扩展在 Application 阶段无感注入，0 报错正常启动。

### 2. K2 Analysis API 在 271 版本下的 API 废弃与编译器警告

- **问题现象**：在将扩展编译目标切至 ILS 271.2085.0 时，`javac -Xlint:deprecation` 抛出过时 API 警告：

  ```text
  warning: [deprecation] analyze(KtElement,Function1) in AnalyzeKt has been deprecated
  warning: [deprecation] getPartiallyAppliedSymbol() in KaFunctionCall has been deprecated
  ```
- **根因排查**：
  1. Kotlin Analysis API（K2）在 IntelliJ 2024.3 / 2025.1（对应 271 构建号）进行了包结构收敛，原顶层入口 `org.jetbrains.kotlin.analysis.api.AnalyzeKt.analyze` 已标记废弃，要求统一迁移至 `org.jetbrains.kotlin.analysis.api.session.AnalyzeKt.analyze`。
  2. `KaFunctionCall.getPartiallyAppliedSymbol()` 带有内部 `@SubclassOptInRequired` 限制，且在 K2 新版中要求直接从函数调用的签名中获取目标符号。
- **解决方案**：
  1. 将导入包切换为 `org.jetbrains.kotlin.analysis.api.session.AnalyzeKt.analyze`。
  2. 简化符号提取路径：当 `session.resolveSymbol(entry)` 为空时，通过 `session.resolveToCall(entry)` 解析为 `KaCallInfo`，调用 `KaCallInfoKt.successfulConstructorCallOrNull(callInfo)` 获得 `KaFunctionCall<KaConstructorSymbol>`，并直接读取 `call.getSignature().getSymbol()`，避免经由 `partiallyAppliedSymbol` 的间接调用。
- **实测对比**：在 `javac --release 25` 下实现 **0 错误、0 警告** 洁净编译，完全对齐 K2 Analysis API 271 规范。

### 3. Manifest 类属性引用反查出现 XML 双引号与重复命中

- **问题现象**：在 `AndroidManifest.xml` 中对 `<activity android:name="com.example.MainActivity">` 发起 `textDocument/references` 时，返回的引用列表中出现了两次当前属性，且其中一项带有外层 XML 双引号（范围为 `"com.example.MainActivity"`，包含两端 `"` 字符）。
- **根因排查**：底层调用 `FindUsagesManager` 与 `FindUsagesHandler.processElementUsages` 时，IntelliJ 默认的全局文本/标识符搜索策略会把 XML 文件中的属性值也当成文本匹配（Text Occurrence）直接打包成引用，而原生未过滤 `XmlFile`，且原生范围直接取了整个属性值节点的 TextRange（包含定界引号）。随后扩展逻辑又手工追加了一次当前属性，导致重复和引号污染。
- **解决方案**：
  1. 在 `FindUsagesOptions` 中显式设置 `options.isSearchForTextOccurrences = false`。
  2. 在 `handler.processElementUsages` 回调中，拦截并过滤所有来自 `XmlFile` 的引用：

     ```java
     if (reference != null && !(reference.getContainingFile() instanceof XmlFile)) {
         Location location = PositionKt.getLspLocationForDefinition(reference);
         if (location != null) synchronized (result) { result.add(location); }
     }
     ```
  3. 过滤后，仅由扩展使用 `target.sourceValueRange()`（通过 `value.getValueTextRange()` 剥离首尾引号后的精确偏移）追加一次当前属性位置，保证引用集合无重复且无引号。
- **实测对比**：针对 `TargetActivity` 的反查实测，修复前返回 2 处 XML 命中（含引号）；修复后精准返回 1 处 XML 精确范围加上所有 Java/Kotlin 真实代码引用。

### 4. Manifest 类名解析规则与官方候选顺序偏离

- **问题现象**：在未声明 `package` 属性但通过 Gradle 配置了 `namespace` 的新版工程中，或者类名未写 `.` 前缀但属于当前模块包名的场景（如 `<activity android:name="MainActivity">`），引用反查抛出 `-32803 target_unresolved` 错误。
- **根因排查**：最初简单的实现仅通过 `raw.indexOf('.') < 0` 判断是否拼接包名，未严格遵循 Android 官方的类名解析候选顺序。
- **解决方案**：对照官方 `JetBrains/android` 中 `PackageClassConverter.java` 的实现，重构 `ManifestTarget.classNames(String raw, String base)`：

  ```java
  private static List<String> classNames(String raw, String base) {
      String name = raw.replace('$', '.');
      if (name.startsWith("."))
          return base == null || base.isBlank() ? List.of() : List.of(base + name);
      if (base == null || base.isBlank())
          return name.indexOf('.') < 0 ? List.of() : List.of(name);
      // 官方候选顺序：优先尝试拼接 Manifest/namespace 前缀，其次尝试完整类名
      return List.of(base + "." + name, name);
  }
  ```
- **实测对比**：在 `android-xml` 集成测试夹具中，覆盖了全名（FQN）、相对点（`.MainActivity`）、无点类名（`MainActivity`）、跨模块别名（`activity-alias`）以及内部类（`$`），全部精准解析无遗漏。

### 5. Node.js 手工编译脚本的不可控与工程化缺陷

- **问题现象**：早期使用 `build.mjs` 配合本地 Node.js 脚本直接查找 JAR、调用系统 `javac` 打包。当需要引入 `adblib:9.4.1` 和 `adblib-tools:9.4.1` 时，面临无依赖传递解析、无依赖版本锁定、无法运行 JUnit 单元测试、无法在 IDE 中正常获得符号索引的问题。
- **根因排查**：手写构建脚本违背了标准 JVM 工程规范，在面对多依赖、安全签名验证和多环境分发时不可维护。
- **解决方案**：重构成标准 Gradle 9.8.0 Java 工程（`jvm/intellij-android/`），引入 `gradle.lockfile` 严格锁定所有配置的直接依赖与传递依赖；引入 `gradle/verification-metadata.xml` 校验依赖的 SHA-256；编写定制任务 `stageExtension` 完成构建归档与资产原子替换。
- **实测对比**：CI/本地构建完全可复现，且通过 `node scripts/setup-dev-env.mjs` 准备 `local.properties` 后直接调用标准 Gradle Wrapper 执行，摆脱了宿主环境配置差异与命令行外部包装。

---

## 关键协议与运行时契约

### 1. ILS JVM 扩展加载与 SPI 契约

ILS 平台通过 Java 标准 SPI 机制发现语言服务扩展。

- **SPI 服务声明**：
  在 `lib/modules/language-server.api.features.impl.android.jar` 的 `META-INF/services/com.jetbrains.ls.api.features.LanguageServerExtension` 文件中声明实现类全限定名：

  ```text
  org.jetbrains.android.AndroidExtension
  ```
- **接口定义与返回值**：
  `AndroidExtension` 实现 `LanguageServerExtension`，通过 `getConfiguration()` 返回 XML 符号、引用、定义、资源命令、Compose 抑制、Lint 与 Android 调试命令的提供者。实现类由内容模块加载，类加载器返回 `ContentModuleDescriptor`；使用其 `parent` 向 `LSConfigurationPiece` 提供主插件的 `PluginMainDescriptor`。
- **运行时环境调优契约**：
  在 `getConfiguration()` 加载入口处，针对 Android 调试与运行时特征注入关键注册表项，防止调试挂死：
  1. `Registry.get("debugger.batch.evaluation").setValue(false)` 与 `debugger.batch.evaluation.force` 置为 `false`：防止 Android ART 虚拟机尝试加载宿主 JVM 特有的 `BatchEvaluatorServer.class` 导致类加载异常。
  2. `NodeRendererSettings.getInstance().getToStringRenderer().setEnabled(false)`：禁用对象的默认 `toString()` 自动渲染，避免 Android UI 主线程对象（如 `MainActivity` 实例）在断点停顿时因跨 JDWP 调用 `toString()` 导致调试器与主线程死锁。
  3. `XDebuggerSettingsManager.getDataViewSettings().setAutoExpressions(false)`：关闭自动表达式求值，降低 ART 调试开销。

### 2. 插件元数据与互斥原则（`plugin.xml`）

- **主描述符**：`src/main/resources/META-INF/plugin.xml` 定义插件 ID、版本与宿主插件依赖，并通过 `<content>` 声明实现模块 `language-server.api.features.impl.android`。发布到描述符 JAR。
- **模块描述符**：`src/main/resources/language-server.api.features.impl.android.xml` 声明实现模块的依赖、服务、监听器与扩展点。与实现类、SPI 声明一起发布到模块 JAR，使注册项使用模块类加载器。
- **版本区间契约**：仅声明 `since-build="271"`，**绝对不设** `until-build`。因为 ILS 运行时的内部构建号固定为 `999.SNAPSHOT`（`idea.plugins.compatible.build=999.SNAPSHOT`），设置 `until-build` 会直接导致插件被平台标记为不兼容而被静默忽略。版本锁定统一交由外部启动层（`detectServerVersion`）精确校验 `271.2085.0`。
- **插件 ID 互斥原则**：声明 `<id>org.jetbrains.android</id>`。IntelliJ 平台对插件 ID 保证全局唯一单例加载。当前 ILS 纯净无官方 Android 插件，使用该 ID 占位；若环境混入官方 Android 插件，平台会直接触发单插件实例互斥抛出加载异常，杜绝双重注入导致的扩展点与 ClassLoader 混乱。

### 3. Android XML DocumentSymbols 协议映射

实现 `LSDocumentSymbolProviderPsiBase`，通过 `LSDocumentSymbolCustomizer<PsiElement>` 遍历 XML PSI 树生成符号：

| 语义节点         | XML 标签条件                                                               | LSP `SymbolKind` | 名称提取来源            | 说明                      |
| ---------------- | -------------------------------------------------------------------------- | ---------------- | ----------------------- | ------------------------- |
| Manifest 根      | `<manifest>`                                                               | `Namespace` (3)  | `package` 属性值        | 大纲顶层根节点            |
| 应用程序         | `<application>`                                                            | `Module` (2)     | `android:name` 或标签名 | 顶级容器                  |
| Android 四大组件 | `<activity>`, `<service>`, `<provider>`, `<receiver>`, `<instrumentation>` | `Class` (5)      | `android:name` 属性值   | 组件定义                  |
| 别名组件         | `<activity-alias>`                                                         | `Interface` (11) | `android:name` 属性值   | 目标指向 `targetActivity` |
| 字符串资源       | `<string>`                                                                 | `String` (15)    | `name` 属性值           | Values 资源               |
| 颜色 / 尺寸资源  | `<color>`, `<dimen>`                                                       | `Constant` (14)  | `name` 属性值           | Values 资源               |
| 布尔资源         | `<bool>`                                                                   | `Boolean` (17)   | `name` 属性值           | Values 资源               |
| 整数资源         | `<integer>`                                                                | `Number` (16)    | `name` 属性值           | Values 资源               |
| 数组资源         | `<array>`, `<string-array>`, `<integer-array>`, `<plurals>`                | `Array` (18)     | `name` 属性值           | Values 资源               |
| 样式定义         | `<style>`                                                                  | `Class` (5)      | `name` 属性值           | 容器节点                  |
| 样式属性项       | `<style>` 下的 `<item>`                                                    | `Property` (7)   | `name` 属性值           | Detail 取 `type` 或标签名 |
| 自定义属性集     | `<declare-styleable>`                                                      | `Interface` (11) | `name` 属性值           | 容器节点                  |
| 属性定义         | `<attr>`                                                                   | `Property` (7)   | `name` 属性值           | 独立或嵌套属性            |
| ID 资源          | `<item type="id">` 或 `<id>`                                               | `Variable` (13)  | `name` 属性值           | Values 资源               |

- **选区范围规范（`selectionRange`）**：必须精确指向 `attribute.getValueElement().getValueTextRange()`（剥离单双引号），若无属性值则回退为标签名称的 TextRange，严禁把包含引号或整个 XML 标签范围作为选区。
- **降级兼容**：ILS 服务端仅输出层级 `DocumentSymbol[]`。当客户端在初始化能力中显式声明 `hierarchicalDocumentSymbolSupport: false` 时，TypeScript 桥接层自动调用 `flattenDocumentSymbols` 将树形结构 DFS 展平为平铺的 `SymbolInformation[]`，并注入 `containerName`。

### 4. Manifest、资源声明引用与 R 资源跳转契约

- **Manifest 类属性 references 查询**：
  - 触发条件：光标位于 `AndroidManifest.xml` 中 `<activity>`, `<service>`, `<provider>`, `<receiver>`, `<instrumentation>`, `<application>`, `<activity-alias>` 的 `android:name` 或 `android:targetActivity` 属性值内。
  - 目标解析：基于当前模块的 `GlobalSearchScope`，通过 `JavaPsiFacade.getInstance(project).findClasses` 查找 Java / Kotlin PSI 类。
  - 异常响应：若类未定义，返回错误码 `-32803`，错误信息包含 `target_unresolved: <类全限定名>`；若存在多重冲突声明，返回 `ambiguous_target: <类全限定名>`。
  - 引用反查结果：通过 `FindUsagesManager` 检索所有 Kotlin/Java 代码引用（过滤 XML 来源），追加剥离引号后的当前属性位置。若客户端请求带 `context.includeDeclaration: true`，同步追加目标类的源码声明定义位置。
- **资源 XML 声明 references 查询**：
  - 标准 XML 请求与 `omp.findResourceFieldReferences` 在 JVM 内共用字段查询，不在 Bridge 转发第二次 RPC。显式命令协议 v1 校验精确模块、namespace、R 字段和物理编译来源。
  - 按当前模块、变体与 AGP merger 证明声明身份和编译字段；同名、同 FQN 的独立模块不能仅因名称相同而合并。声明来源缺失或失效返回具体错误，合法零引用返回 `[]`。
  - 官方对照：`ProjectLightResourceClassService.getLightRClassesContainingModuleResources` 枚举 owner 及依赖它的消费模块中的 R 表示；`AndroidResourcesFindUsagesHandlerFactory` 再按资源上下文收缩范围。ILS 适配同样先证明 owner/依赖关系，再枚举真实编译字段副本，不能只搜索 owner 的一个字段或仅按 namespace 扫全工程。
  - `includeDeclaration: false` 仅返回 Java/Kotlin 的真实语义引用；`true` 额外加入当前 XML 声明，不加入其他限定符副本、字节码字段或 XML 使用点。
  - 使用当前 PSI 的引用范围及 UTF-16 行列；在原生挂起读操作内搜索，复用请求取消和 `AndroidSources.Scope` 的文档版本、磁盘来源校验。显式命令与标准请求使用相同边界。
  - `attr`、`declare-styleable` 派生字段、布局 `@+id` 扩展搜索及 XML 到 XML 引用保持阶段 C 的既定边界，不能把普通字段搜索视为这些路径已实现。
  - 271 验收：隔离真实导入集成 27/27，通过 `core -> lib -> app`（含未打开的同包 Java）、同 namespace 独立模块、各 values/文件类型、限定符跳转、缺失/过时来源、严格命令参数，以及 12,002 引用工作负载的取消 `-32800`、并发编辑 `-32801` 和恢复。MyHook 只读查询 `nav_settings`，三入口一致返回 `MyHookBottomBar.kt` 两处及 `SettingsScreen.kt` 一处。
  - H 的原生无扩展控制组与历史缺口记录见 [协议与生命周期专题](ils-protocol-and-lifecycle.md)。当前扩展通过 `AndroidLintProvider` 增加官方源码规则与工程依赖 AAR 规则，保留原生编译诊断。
- **`R.*` 资源的 `DirectNavigationProvider` 契约**：
  - 原生缺陷：Kotlin / Java 中跳转 `R.string.xxx` 时，ILS 原生仅返回 AGP 生成的 `R.jar` 字节码反编译类（`R$string.class`）。
  - 源码优先机制：实现 `com.intellij.navigation.DirectNavigationProvider`（`AndroidResourceNavigation`）。当导航元素为 `*.R` 内的 `PsiField` 且来源为 JAR 时，提取模块资源索引，解析 AGP 资源来源，优先构造指向 XML 源码具体声明的虚拟 PSI 元素（`Declaration extends FakePsiElement`）；若源码映射失效，则返回 `null`，保留原生字节码导航。

### 5. 基于 K2 Analysis API 的 Compose 命名抑制契约

- **抑制目标**：Kotlin 检查项 `FunctionName` 与 `TestFunctionName`。
- **判断契约**：

  ```java
  public boolean isSuppressedFor(PsiElement element, String toolId) {
      if (!"FunctionName".equals(toolId) && !"TestFunctionName".equals(toolId)) return false;
      if (element == null) return false;
      PsiElement parent = element.getParent();
      if (!(parent instanceof KtNamedFunction function)) return false;
      if (function.getNameIdentifier() != element) return false;
      if (function.getAnnotationEntries().isEmpty()) return false;
      ProgressManager.checkCanceled();
      Boolean isComposable = AnalyzeKt.analyze(function, session -> {
          for (KtAnnotationEntry entry : function.getAnnotationEntries()) {
              ProgressManager.checkCanceled();
              KaConstructorSymbol constructor = session.resolveSymbol(entry);
              if (constructor == null) {
                  KaCallInfo callInfo = session.resolveToCall(entry);
                  KaFunctionCall<KaConstructorSymbol> call = KaCallInfoKt.successfulConstructorCallOrNull(callInfo);
                  if (call != null && call.getSignature() != null) {
                      constructor = call.getSignature().getSymbol();
                  }
              }
              if (constructor != null) {
                  ClassId classId = constructor.getContainingClassId();
                  if (classId != null && COMPOSABLE_CLASS_ID.equals(classId)) {
                      return Boolean.TRUE;
                  }
              }
          }
          return Boolean.FALSE;
      });
      return isComposable != null && isComposable;
  }
  ```
- **契约约束**：
  1. 仅当待检查元素为函数名标识符（`function.getNameIdentifier() == element`）时介入；
  2. 严格核验注解 ClassId 必须等于 `androidx.compose.runtime.Composable`；普通大写函数（如没有 `@Composable` 的大写函数）严禁放行，继续由原生检查报出警告。

### 6. 构建资产清单与安全替换契约

发布目录为 `resources/ils/271.2085.0/android.lsp/`，共 14 个 JAR，每个 JAR 都有同目录的 `.sha256`。描述符与第三方依赖位于 `lib/`，实现模块位于 `lib/modules/`：

| 依赖 | 固定文件名 |
| --- | --- |
| 插件描述符 | `lib/language-server-plugins-android-lsp.jar` |
| 实现模块 | `lib/modules/language-server.api.features.impl.android.jar` |
| ADB | `adblib-9.4.1.jar`、`adblib-tools-9.4.1.jar` |
| Lint | `lint-api-32.4.1.jar`、`lint-checks-32.4.1.jar`、`lint-model-32.4.1.jar` |
| Manifest 来源映射 | `manifest-merger-32.4.1.jar` |
| Android 工具 API | `common-32.4.1.jar`、`sdklib-32.4.1.jar`、`sdk-common-32.4.1.jar` |
| 资源类型 API | `layoutlib-api-32.4.1.jar` |
| XML pull parser | `kxml2-2.3.0.jar` |
| Groovy 语法 AST | `groovy-4.0.29.jar` |

所有 Maven 运行依赖均关闭传递解析；不分发 `lint-psi`、UAST 或 standalone Kotlin 编译器。ILS 未提供资源仓库类型，`sdk-common` 与 `layoutlib-api` 共同支撑资源仓库接口与值类型，不能只放在编译 classpath。

依赖校验覆盖二进制、POM、Gradle module metadata、BOM 和 IDE 下载的源码包。新增依赖时，使用 `--write-verification-metadata sha256` 生成候选摘要，再核对官方仓库发布的摘要或签名；普通构建和 IDE 同步保持只校验，不自动接受新摘要。CLI 构建通过后，还需实际导入此 JVM 工程，覆盖 ILS 的模型与源码解析路径。

宿主库存在于 ILS 安装目录不代表插件类加载器可访问。主描述符与实现模块描述符都显式声明 `intellij.libraries.asm`、`intellij.libraries.asm.tools` 与 `intellij.libraries.guava`。`lib/` 中的 Lint JAR 由主插件加载，主插件需要直接访问这些宿主库；只给子模块声明依赖，无法让主插件反向访问。ASM Tree 的 `AbstractInsnNode` 位于 `asm.tools`，Lint 的 `Detector` 和内置规则仍引用它，单文件 Scope 过滤不会消除类链接依赖；继续使用宿主模块，不复制宿主 JAR。

`manifest.json` 记录 ILS 版本、插件 ID、Java/classfile 版本、工具链，以及全部资产的名称、相对路径、SHA-256 和大小。实际发布清单见 [manifest.json](../resources/ils/271.2085.0/android.lsp/manifest.json)；Node 校验同时核对固定路径白名单与上游摘要，拒绝缺失、多余或被替换的文件，包括嵌套模块资产。
- **替换与回滚契约**：Gradle `stageExtension` 先在任务临时目录的 `work-<uuid>/staging/` 中生成全部资产，并将现有文件备份到同级 `rollback/`。逐文件替换时优先使用原子移动，文件系统不支持时使用普通替换；移除过期文件后，最后替换 `manifest.json`。替换失败会恢复备份；回滚失败时保留临时目录供恢复，因此这不是整个目录的一次性原子切换。

服务端版本升级后，先更新精确绑定的 ILS/VSIX 元数据，再执行 `npm run build:jvm`，最后运行 `npm run update-bundle -- --sync-marketplace --check`。检查失败即保留错误，不能只更新目录名或 manifest 来绕过 ABI 和第三方资产摘要。

当前 Windows ILS `271.2085.0` 官方归档直接在根目录包含 `build.txt` 和 `bin/intellij-server.exe`，开发安装脚本的直铺验证与本次发行包一致。未来归档改变布局时，应重新验证开发脚本与正常安装器的归档规范化契约。

### 7. Android Lint 单文件诊断

阶段 H 的 Java/Kotlin 与阶段 I 的资源 XML/Manifest 诊断均已通过真实 ILS 271 验收。完整运行包含原生无扩展对照，并保留既有 Java/Kotlin/Compose 和导航回归。

- `AndroidRequests.diagnosticQuery` 在分析前记录打开文档版本，在挂起读操作内读取快照；发布前重新进入分析上下文，逐字符核对当前未保存内容，并复核版本与关联磁盘输入。缓存只在复核通过后写入。过期返回 `-32801`，取消传播为 `-32800`。
- `AndroidLintModelResolver` 先读取当前变体的官方 LintModel XML，再回退到 Gradle 脚本字面量与主 Manifest：优先 `build.gradle.kts` 的 Kotlin PSI，不存在时读取 `build.gradle` 的 Groovy AST。动态 `minSdk`、flavor 或 buildType 覆盖保持前提缺失，不虚构 `minSdk=1`；此时只跳过 `ApiDetector`，其余规则继续运行。
- `AndroidLintIssueRegistry` 按官方 `Implementation.isAdequate` 选择单文件规则，并保留 `NewApi`。`AndroidLintClient` 将编辑器 PSI 转换为 UAST，使用真实模块解析作用域与语言级别；资源查询按当前变体和仓库范围解析，仍不等同于 Gradle 全项目 Lint。
- AAR 规则跟随当前模块已导入依赖：发现同级 `jars/lint.jar`，按内容摘要复制到缓存后加载。不设 Maven 前缀白名单，不扫描全局规则目录，不联网获取规则。加载失败跳过单个 JAR；复合执行故障时按 Registry 隔离重试，每次使用独立的 Lint 项目状态，失败批次不进入结果。
- Lint 32.4.1 会吞下 Detector 异常，累计崩溃超过 20 次后连 `client.log` 也会跳过。客户端在官方 `runReadAction` 回调入口记录本次运行的异常，并在 `analyze` 返回后复核，确保日志限流后仍触发 Registry 隔离；取消直接传播，不读写全局崩溃计数。
- 部分源码规则即使在 IDE 全局模式也调用 `getPartialResults`。客户端按官方实现为每个 Issue 保存 `PartialResult`，返回绑定当前项目的视图；每次隔离重试清空状态，不持久化或加载其他模块的分析产物。
- 从项目根到模块根的 `lint.xml` 按目录层级覆盖，Built 态同时使用官方 `lintOptions`。诊断使用 UTF-16 闭开区间、原始纯文本消息、规则 ID 和 `source: android-lint`，并保留有效次要位置。
- Provider 使用线程安全的 64 条目 LRU。键包含工程、文件、文档版本、修改戳、主文档内容摘要、模块模型、规则 JAR 和配置指纹；关闭再打开文件时，版本和修改戳可能复用，内容摘要防止误命中旧结果。每次拉取仍重新解析并校验关联输入，缓存命中也不跳过快照复核。

#### 实施注意事项

- Kotlin PSI 将脚本顶层表达式包装为 `KtScriptInitializer`，读取 `android {}` 前先解包。`minSdk`、`targetSdk`、`compileSdk` 的动态判定具有粘性，后续字面量不覆盖先前的歧义；`minSdk`、`targetSdk` 未声明时可检查主 Manifest，动态表达式或变体覆盖则禁止该回退。
- ILS 271 未捆绑 Groovy PSI。扩展使用官方 Groovy 4.0.29，依次调用 `SourceUnit.parse()`、`completePhase()`、`convert()`，仅生成语法 AST，不进入语义分析或 AST 变换，不执行脚本和 `@Grab`。解析结果缓存在请求级 `AndroidSources.Scope`；资源目录、namespace 和 SDK 配置遵守相同的保存态边界。
- `source.properties` 的 API 值可能是 `37.0`。规则使用整数 API 级别，平台目标保留完整标识，例如 `android-37.0`。正式版、预览版与 Add-on 目标通过官方 `AndroidTargetHash` 解析，不从目标字符串手动截取或猜测 API。
- `AndroidSources.text` 保留磁盘读取语义，供关联资源、配置和产物来源校验使用；当前诊断文件使用请求的 PSI/Document 快照。缓存指纹与分析必须读取同一来源，避免关联编辑器内容掩盖磁盘更新。
- ILS 271 的 `ProcessCanceledException` 继承 `CancellationException`。捕获、反射调用和规则隔离均须保留取消，不能把取消当成坏规则或成功空结果。
- AAR 规则复制到 `${java.io.tmpdir}/android-lint-cache/aar/`，文件名使用内容摘要，再通过宿主 `UrlClassLoader` 加载并关闭 JAR 锁定。复制失败不回退到直接加载 Gradle 缓存原件；模块级弱引用缓存最多保留 32 项，键包含复制路径、原文件大小和修改时间。

### 8. XML/Manifest Lint（阶段 I）

复用现有 `AndroidLintProvider`，按文件归属选择 `RESOURCE_FILE` 或 `MANIFEST`，保留原生 XML 语法诊断。真实独立 ILS 271 完整矩阵通过，覆盖目录、抑制、API、资源刷新、隔离，以及实际 AGP 合并来源和 Clean→Built 缓存切换。

独立 JVM 探针已跑通 `ContentDescription`、`HardcodedText`、`HardcodedDebugMode`、祖先 `tools:ignore` 和内存修复，并复现未落盘文件被跳过、默认 merged Manifest 忽略内存修改、多行属性值结束行号错误。探针显式提供项目和规则，结果不等同于真实 ILS 接入或完整资源模型验收。

| 官方机制 | 本项目适配 |
| --- | --- |
| `Implementation.isAdequate` 判定单文件分析范围 | 不扩大为全项目 Scope，Java/Kotlin 保持原有入口 |
| PSI-backed W3C DOM 与原始节点范围 | 复用当前文档快照；DOM 元数据独立于只读 PSI，不能因“只读”拒绝 Lint 的 `setUserData` |
| 按范围查询资源仓库 | 当前模块、项目依赖、AAR、framework 分开组织；模型无法确认时返回明确错误 |
| `BlameFile` 与 Manifest Merger 节点键 | 增加同版本官方 `manifest-merger:32.4.1`，校验变体与输入有效性；Clean 态保留源文件检查，不自行拼接合并清单 |

用户确认的保存边界：当前拉取文件的未保存内容即时参与诊断；关联资源、配置和其他清单按磁盘读取，保存后刷新；新文件首次保存后检查。输出前在新分析上下文中复核当前文档内容，避免上下文外访问快照 Document。

编辑期保留这一边界，不调用 `ManifestMerger2` 临时合并。完整合并由 AGP 提供；输入模型缺失或产物过期时，继续执行源文件检查，避免把不完整输入的合并结果当作有效产物。

已修复的适配差异：
- 自定义 Manifest 按同一 Gradle 模块中的实际源集归属选择生产模块，避免用聚合模块解析类及变体。
- 无命名空间节点返回 W3C 规定的 `null`，限定属性同时支持 QName 和 namespace URI 查询；官方 Merger 的节点键与源文件保持一致。
- 合并节点无法映射时不返回源文件位置；源文件未保存或晚于合并产物时回退到当前源 DOM。
- 资源、关联 Gradle 脚本及配置读取保存态；指纹覆盖依赖文件内容、中间层 `lint.xml`，以及合并清单/merger 日志的存在性、内容和时间戳。生成合并产物后，即使主文档未改动，也会重新运行检查。
- 资源字符串解码复用 `ValueXmlHelper.unescapeResourceString`，attr 格式与 enum/flag 元数据复用 `AttributeFormat`；资源引用复用 `ResourceUrl.parse` 和官方名称校验。只将无 namespace 的模块自有 `@+id` 收入声明表，避免 `@+android:id` 污染 framework 或模块资源。


---

## 最佳实践与操作指引

### 1. 编译构建与资产打桩

通过 `scripts/setup-dev-env.mjs` 自动检测已安装的 ILS 并生成 `local.properties`（未安装时自动从官方 CDN 下载保底）；随后直接运行 Gradle Wrapper：

```bash
# 1. 一键准备本地开发环境并写入 jvm/intellij-android/local.properties
node scripts/setup-dev-env.mjs

# 2. 直接在子项目运行标准 Gradle 构建（或运行 npm run build:jvm）
cd jvm/intellij-android
./gradlew stageExtension --no-daemon
```

构建流程自动完成：
1. `build.gradle.kts` 从 `local.properties` 读取 `ils.home`，并在配置阶段容错；
2. 自动绑定 `jbr/bin/java` 与 Java 25 toolchain；
3. 分别生成 STORED（零压缩）的插件描述符 JAR、实现模块 JAR，以及全部资产的 `.sha256` 旁挂文件。

Kotlin 源码使用 Kotlin JVM 2.4.20，与 Java 一同生成 Java 25 字节码；迁移期间两种源码共存。关闭自动添加标准库，编译与运行使用 ILS 自带的 Kotlin、协程及序列化库，不将它们加入发布资产。编译器依赖单独锁定并校验，插件标记 POM 使用 Gradle Plugin Portal 的发布内容；其余 Kotlin 构建资产已与 Maven Central 的原始文件核对 SHA-256。JVM 目标配置参见 [Kotlin compiler options](https://kotlinlang.org/docs/gradle-compiler-options.html)。

SDK 编译可见性采用目录级限制：平台 `lib/*.jar` 保留，插件仅加入 `java/`、`kotlin/`、`xml/`、`dap-jvm/` 下的 JAR，供 `compileOnly` 与 `testCompileOnly` 共用；`testRuntimeOnly` 仍保留完整 ILS SDK，以满足平台测试的运行时依赖。新增插件 API 依赖须显式扩展该范围并验证构建。此限制用于防止意外引用无关插件，不保证所用内部 API 稳定，也不改变 `plugin.xml` 依赖或发布包；兼容性仍由锁定 ILS 版本与真实集成验收保证。配置职责参见 [Gradle Java Plugin](https://docs.gradle.org/current/userguide/java_plugin.html)。

### 2. 构建产物验证

构建产物规范由 Gradle 原生保证：
1. `build.gradle.kts` 的 `options.release.set(25)` 强制保证 classfile 为 Java 25（Major 69）；
2. `entryCompression = ZipEntryCompression.STORED` 保证零压缩；
3. `gradle/verification-metadata.xml` 自动校验上游官方库的 SHA-256；
4. `stageExtension` 任务自动生成 `manifest.json` 与伴随的 `.sha256` 摘要文件。

模块化迁移验证：TypeScript 构建与测试编译、JVM 测试及 `stageExtension` 均通过，暂存 14 项资产；资产解析测试 61/61，独立 ILS 271 的 XML、Compose 与 Lint 集成测试 49/49，无跳过。默认路径解析命中新发行目录；真实 ILS 已注册 Android 调试命令，离线设备探针确认 adblib 可加载并返回预期错误。完整真机 JDWP attach 尚未验证。

集成测试同时隔离原生索引：`initialize.initializationOptions.indexDir` 指向测试沙箱的 `index/`，随沙箱统一回收。仅设置服务端 `systemPath` 仍会使用默认的用户索引缓存；验证资源查询时不能因此向共享缓存写入大量临时工程索引。

### 3. 反编译器选型横评与技术适用边界

在前期调研与逆向探索中，我们针对 4 款低 Star / 现代反编译 CLI 工具（3 款 Rust、1 款 Go）在同一基准测试集上进行了全面实测：

#### 参与实测工具列表

- **`jcdc`** (`ejfkdev/jcdc` 0.1.1, Rust)：纯 Rust 自研引擎，多线程并行，追求完整语义重编译验证（Recompilable）。
- **`javajive`** (`yaklang/javajive` 0.7.0, Go)：纯 Go 零外部依赖单二进制，兼顾 DEX/APK 与序列化数据解析。
- **`abyssflower`** (`K0itoyuu/abyssflower` 0.3.1, Rust)：纯 Rust 引擎，主打 Kotlin 元数据 Protobuf 恢复与 AI MCP 支持。
- **`vinylite`** (0.3.0, Rust)：纯手写零依赖，容错与混淆对抗优先。

#### 基准测试横评矩阵

| 特性 / 维度                 | 测试场景                                  | `jcdc` (Rust)                               | `javajive` (Go)            | `abyssflower` (Rust)                                                | `vinylite` (Rust)          |
| --------------------------- | ----------------------------------------- | ------------------------------------------- | -------------------------- | ------------------------------------------------------------------- | -------------------------- |
| **Java 17+ Sealed 层次**    | `sealed interface ... permits A, B`       | **唯一完整恢复 permits**                    | 丢失 permits 声明          | 丢失 permits 声明                                                   | 语法解析失败               |
| **Java 16+ Record**         | `record Person(String name, int age)`     | **紧凑头部完美恢复**                        | 紧凑头部恢复正常           | 展开为 `extends Record`，暴露 invokedynamic                         | 展开为普通 Class           |
| **Java 21 Switch 模式匹配** | `switch (shape) { case Circle c -> ... }` | **语法结构完全准确**                        | 降级转译为三元运算符       | 暴露底层 `/*invokedynamic*/ typeSwitch`                             | 分支逻辑降级失真           |
| **Try-with-resources**      | `try (BufferedReader r = ...) { ... }`    | **干净折叠，无脱糖噪音**                    | 带有大量防御性冗余括号     | 未折叠，展开为显式 finally                                          | 展开为嵌套 try             |
| **生产级内部类合并**        | `core-common` 6 个内部类合并              | **唯一合并回单一源文件**（9 类压为 3 文件） | 每个内部类独立为文件       | 每个内部类独立为文件                                                | 每个内部类独立为文件       |
| **吞吐效率**                | JDK 8 `rt.jar`（12,609 类）               | **18 核 2.3 秒**                            | 毫秒级单包解析             | 约 4.8 秒                                                           | 约 3.5 秒                  |
| **Kotlin 语法还原**         | `ClientTransportState.class`              | 仅转为 Java 字节码胶水代码                  | 仅转为 Java 字节码胶水代码 | **断层领先：直接还原原生 Kotlin 语法**（利用 `@Metadata` Protobuf） | 仅转为 Java 字节码胶水代码 |

#### 选型推荐

1. **现代 Java（Java 17/21+）复杂语法与生产 JAR 反编译**：首选 **`jcdc`**。它是目前对新版字节码控制流与内部类合并处理最优秀的轻量级引擎。
2. **纯 Go / 安全分析 / 零依赖单文件**：首选 **`javajive`**，兼顾 DEX 转换且无运行时依赖。
3. **Kotlin 产物分析与 AI 自动化**：首选 **`abyssflower`**（需加 `--kotlin` 参数），唯一能够直接看懂 Kotlin 高级语法的工具。

### 4. 官方源码核验流程与规范

实现先对照官方 Android 插件源码与 Community 插件开发文档；涉及 ILS 私有协议、模型导入或快照的版本差异，再用当前发行包的定向反编译核对。文档示例不能替代 271 的运行验收，反编译结果也不作为可直接复制的源码。

- **IntelliJ 平台核心与 LSP API**：
  查阅 [JetBrains/intellij-community](https://github.com/JetBrains/intellij-community)：
  - `platform/lang-impl/src/com/intellij/find/findUsages/`：查阅 `FindUsagesManager` 与 `FindUsagesHandler` 选项生命周期。
  - `platform/core-api/src/com/intellij/navigation/DirectNavigationProvider.java`：查阅源码导航优先判定顺序。
  - [PSI References](https://plugins.jetbrains.com/docs/intellij/psi-references.html)：使用真实 `PsiReference.resolve()`、`ReferencesSearch` 与显式 scope；不可用文本同名匹配代替目标身份。
  - [Coroutine Read Actions](https://plugins.jetbrains.com/docs/intellij/coroutine-read-actions.html)：采用允许写操作的挂起读操作，在遍历中调用 `ProgressManager.checkCanceled()`，不手动抛取消异常或跨重试保存 PSI 结果。
  - [Workspace Model](https://plugins.jetbrains.com/docs/intellij/workspace-model.html)：不可变模型快照、模块与库实体及 Project Model 互操作；模型缺失应在明确的导入/模型扩展边界补齐，查询期不偷偷修改全局 classpath。
- **Android 官方语义与 Lint 实现**：
  查阅 [JetBrains/android](https://github.com/JetBrains/android)（参考提交 `544c9ef8`）：
  - [LintIdeClient](https://github.com/JetBrains/android/blob/544c9ef84f8ee3024c1f9779725db34bf5dd38a6/lint/src/com/android/tools/idea/lint/common/LintIdeClient.java)：空资源仓库、LintOptions 配置工厂、IDE UAST evaluator 与 JAR classloader。
  - [LintIdeIssueRegistry](https://github.com/JetBrains/android/blob/544c9ef84f8ee3024c1f9779725db34bf5dd38a6/lint/src/com/android/tools/idea/lint/common/LintIdeIssueRegistry.java) 与 [AndroidLintIdeIssueRegistry](https://github.com/JetBrains/android/blob/544c9ef84f8ee3024c1f9779725db34bf5dd38a6/android-lint/src/com/android/tools/idea/lint/AndroidLintIdeIssueRegistry.java)：编辑期作用域过滤、ApiDetector 特判及原生重复检查排除。
  - 相对官方外部标注器，本扩展只适配 ILS pull 请求、无 AndroidFacet 的模型来源与 LSP 映射；依赖规则加载增加故障隔离。当前空资源仓库不提供 Android Studio 的完整资源语义。
  - `android/src/org/jetbrains/android/dom/converters/PackageClassConverter.java`：核验 Manifest 类名解析与候选顺序。
  - `android/src/org/jetbrains/android/dom/structure/resources/ResourceStructureViewBuilder.java`：核验资源 XML 标签与大纲属性层级。
  - [AndroidResourcesFindUsagesHandlerFactory.kt](https://github.com/JetBrains/android/blob/544c9ef84f8ee3024c1f9779725db34bf5dd38a6/android/src/org/jetbrains/android/AndroidResourcesFindUsagesHandlerFactory.kt)：资源身份与上下文 scope 交集、文件资源和 attr/styleable 的独立搜索路径。
  - [AndroidResolveScopeEnlarger.kt](https://github.com/JetBrains/android/blob/544c9ef84f8ee3024c1f9779725db34bf5dd38a6/android/src/org/jetbrains/android/AndroidResolveScopeEnlarger.kt)：R 类查找器必须配套模块依赖限定的 resolve scope；只注册 Finder 无法保证同包 `R.string` 绑定。ILS 适配保留真实 JAR PSI，仅将 owner 和已导入依赖的当前变体归档加入解析范围。
  - [ResourceRepositoryToPsiResolver.kt](https://github.com/JetBrains/android/blob/544c9ef84f8ee3024c1f9779725db34bf5dd38a6/android/src/com/android/tools/idea/res/psi/ResourceRepositoryToPsiResolver.kt)：按真实声明的 use scope 合并资源搜索范围；本项目按已导入模块及来源落实对应隔离，不移植完整 AndroidFacet/ResourceRepository。
  - [AndroidResourceClassPsiElementFinder.kt](https://github.com/JetBrains/android/blob/544c9ef84f8ee3024c1f9779725db34bf5dd38a6/android/src/com/android/tools/idea/res/AndroidResourceClassPsiElementFinder.kt)：官方 R 类由 `LightResourceClassService` 按 scope 提供，依赖完整 Android 模型。本扩展保留真实编译 R 字段契约，不能用临时合成同名类掩盖 ILS 导入缺项。
  - [ProjectLightResourceClassService.kt](https://github.com/JetBrains/android/blob/544c9ef84f8ee3024c1f9779725db34bf5dd38a6/android/src/com/android/tools/idea/res/ProjectLightResourceClassService.kt)：`getLightRClassesAccessibleFromModule` 与 `getLightRClassesContainingModuleResources` 分别表达“消费方能访问哪些 R”和“哪些 R 包含 owner 的资源”，两者不能混用。
  - [Android light classes 开发文档](https://github.com/JetBrains/android/blob/544c9ef84f8ee3024c1f9779725db34bf5dd38a6/android/docs/android-light-classes.md)：`PsiElementFinder`、Java/Kotlin resolve scope 与导航需协同验证；找到一个 `PsiClass` 不能证明消费代码已能绑定它，必须检查真实引用结果。
  - [MergingLogPersistUtil.java](https://android.googlesource.com/platform/tools/base/+/refs/heads/mirror-goog-studio-main/sdk-common/src/main/java/com/android/ide/common/blame/MergingLogPersistUtil.java)：同时核验 AGP 9.4.1 对应 `sdk-common:32.4.1` 的 sources JAR。`multi-v2` 在目标与来源坐标相同时省略 `to`；省略的结束坐标继承起始坐标。限定符声明映射必须按该协议还原。
  - `compose-ide-plugin/src/com/android/tools/compose/ComposeSuppressor.kt`：核验 Composable 函数命名检查抑制逻辑。
- **Android Studio 调试与 ADB 链路**：
  查阅 Google AOSP `platform/tools/base`（分支 `mirror-goog-studio-main`）：
  - `adblib` / `adblib-tools`：查阅 `AdbSession`、`ConnectedDevicesTracker`、`JdwpProcessTracker` 和 JDWP proxy loopback 的协程生命周期与关闭释放规则，杜绝自行手写 ADB forward 导致的端口泄漏。

## 验收记录（2026-11-09）

- `jvm/intellij-android/gradlew.bat -p jvm/intellij-android test stageExtension --rerun-tasks --no-daemon`：通过，包含字面量/动态/变体前提、XML 配置、规则隔离、UTF-16 映射和空资源仓库测试，生成 11 项资产。
- `npm test`：549 项通过，包含全部上游资产的固定摘要、防替换与多余文件拒绝校验。
- `npm pack --dry-run --json --ignore-scripts`：11 个 JAR、11 个伴生 SHA-256 与 `manifest.json` 均在发布清单中。
- 最终客户端命名为 `AndroidLintClient`，重新执行 `test --tests org.jetbrains.android.lint.AndroidLintProviderTest stageExtension --no-daemon` 通过；资产门禁单独回归通过。
- 真实 ILS `271.2085.0`：`Android Lint diagnostics integration` 全部通过，无跳过。覆盖 Java/Kotlin 编译诊断共存、12 项 `NewApi` 矩阵、真实 Compose 规则、Clean/Built 模型切换、`lint.xml`、损坏 AAR 与非 AndroidX 规则、缓存命中、取消 `-32800` 及并发编辑复核。
- 移除临时故障日志后，`tsc -p tsconfig.test.json --noEmit` 通过。根目录 `README.md` 未修改。
- Lint 工程、规则注册表、XML 解析器及内部 UAST 解析器、Java evaluator 均统一使用 `Android` 前缀，缓存目录为 `${java.io.tmpdir}/android-lint-cache`。命名调整后 JVM Lint 测试与 `stageExtension` 通过，已核对发布 JAR 的类名及源码、测试、文档中的旧名前缀残留。

## 验收记录（2026-11-10）

- 定向 JVM 回归通过，覆盖调试租约、SDK 前提、Groovy 模型、Lint 资源与 Manifest；移除测试专用空守卫后，使用真实 Project 夹具重测 Groovy 模型并重新执行 `stageExtension`。
- 发布资产、摘要防替换与服务生命周期回归通过。`npm pack --dry-run --json --ignore-scripts` 包含 13 个 JAR、对应 SHA-256 和 `manifest.json`。
- 真实 ILS `271.2085.0` 的 `android-xml.test.js` 全部通过，覆盖 Java/Kotlin 编译诊断、Compose、XML/Manifest 规则、资源导航及合并来源回退。
- 独立 Groovy 工程实测：保存的 `minSdk 21` 触发 API 26 的 `NewApi`；未保存缓冲区改为 26 后诊断保留，落盘并发送 `didSave` 后消失。自定义资源根与自定义 Manifest 生效，默认 Manifest 被排除。真实服务的 `owner.pluginPaths` 记录预期的绝对扩展目录；验证后已关闭客户端并清理沙箱。
- 额外执行的 `engineering.test.js` 中，Gradle 子项目调试通过；两项工程模型用例在 `model.classpath` 断言处失败。ILS 271 未广告 `intellij.java.resolveLaunch`，`exportWorkspace` 回退只提供工程模型，不提供运行 classpath。本轮保留该能力边界，未伪造 classpath 或放宽断言。
- 当前 JVM 工程的真实导入验证已通过：Groovy BOM 的 `.pom`、`.module` 及 Groovy 源码包摘要与 Maven Central 发布值一致，补齐后执行工作区重导入，原连接恢复 `ready`。严格依赖校验保持启用。
