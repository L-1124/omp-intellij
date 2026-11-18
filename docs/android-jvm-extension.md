# Android JVM 扩展架构与语义支持技术指南

## 核心结论

1. **原生导入与 Android 语义扩展分工**：ILS `271.2085.0` 负责 Gradle Android 模型导入和 Java/Kotlin 编译诊断。`android.lsp` 插件通过 `language-server.api.features.impl.android` 内容模块中的 `LanguageServerExtension` SPI 补齐 XML 大纲、Manifest 类及资源声明的引用、`R.*` 源码优先导航、K2 `@Composable` 命名抑制，以及标准 `textDocument/diagnostic` 中的 `android-lint` 诊断。
2. **插件 ID 与互斥目标**：保留官方 Android 插件 ID `org.jetbrains.android`，有意不支持与官方完整 Android 插件共存。主描述符声明内容模块；SPI、实现类及使用这些类的扩展声明放在实现模块中。
3. **工程化与构建体系**：使用 `jvm/intellij-android/` 标准 Gradle 9.8.0 Kotlin/JVM 工程。目标 ILS 版本从 `src/server/bundle-metadata.ts` 读取，编译工具链使用该 ILS 的 JBR 25（classfile 69）；`gradle.lockfile` 和 `verification-metadata.xml` 锁定依赖及摘要。`stageExtension` 生成 manifest 与 `.sha256`，运行时复用 `verifyExtensionDirectory` 验证清单、ABI、字节大小和哈希，不再依赖独立 `check-assets` 脚本。
4. **源码审查优先于反编译推测**：本地实测横评 4 款现代反编译器（`jcdc`、`javajive`、`abyssflower`、`vinylite`）表明：`jcdc` 对 Java 21+ 语法（Sealed 类、Record、TWR、模式匹配）和内部类折叠还原度最高；`abyssflower` 凭借 `@Metadata` Protobuf 解析在 Kotlin 语法还原上断层领先；但任何反编译器在字节码脱糖、泛型擦除和架构设计意图上均存在不可逆失真。核心方案必须以官方开源仓库（`JetBrains/intellij-community`、`JetBrains/android` 提交 `544c9ef8`、AOSP `platform/tools/base`）作为第一权威依据，杜绝盲目依靠反编译黑盒猜解协议。

### JVM 包结构

`org.jetbrains.android` 根包仅保留 SPI 入口 `AndroidExtension`，其余实现按职责分包：

| 子包         | 职责                                                    |
| ------------ | ------------------------------------------------------- |
| `context`    | 模块环境、文件角色、请求上下文与查询异常                |
| `xml`        | XML 属性解析与文档大纲                                  |
| `navigation` | 定义、引用、Manifest 目标与资源直达导航                 |
| `resource`   | 资源解析、源集目录、布局与源码读取                      |
| `compose`    | Compose 命名检查抑制                                    |
| `lint`       | 官方源码级 Lint、模块模型、依赖规则与诊断缓存           |
| `debug`      | 核心 JDWP 资源、监听器与字段过滤；可选模块中的 DAP 会话 |
| `dap`        | 可选 Run/DAP SPI 入口                                   |
| `run`        | 参数、AGP 模型、产物、安装与应用所有权                  |

类和成员按调用边界使用 `public`、`internal` 或 `private`，不依赖 Java 的包级可见性。核心 SPI 为 `org.jetbrains.android.AndroidExtension`，可选 Run/DAP SPI 为 `org.jetbrains.android.dap.AndroidDapExtension`，各自发布自己的服务声明。

内容模块仅声明宿主允许跨插件使用的依赖。ILS 271 中的 `language-server.analyzer.xml` 与 `language-server.api.features.impl.common` 为私有模块；跨插件依赖会使实现模块被拒绝加载，进而阻止声明式调试监听器运行。`AndroidDocumentSymbols` 直接实现公开的 `LSDocumentSymbolProvider`，通过 `supportedLanguages` 声明语言，复用公开的 `mapDeclaration` 映射。验收同时覆盖 SPI 功能与声明式扩展的实际加载。

---

## 踩坑记录与根因分析

### 1. 扩展注册时机过早导致 `ApplicationManager.getApplication()` 为 null

- **问题现象**：在最初实现中，`ComposeSuppressor.registerOnce()` 在 `AndroidExtension.getConfiguration()` 中直接调用，运行时抛出 `NullPointerException` 或直接导致语言服务进程崩溃。
- **根因排查**：`LanguageServerExtension.getConfiguration()` 在 ILS 启动阶段的 SPI 扫描期间执行，此时 IntelliJ 底层的核心组件容器和 `Application` 单例尚未初始化完成（`ApplicationManager.getApplication()` 返回 `null`）。而 `LanguageInspectionSuppressors.INSTANCE.addExplicitExtension` 强依赖 Application 级别的扩展点容器（`ExtensionPoint`）。
- **解决方案**：将注册操作延迟到 Application 容器就绪阶段。在 `AndroidExtension` 中暴露实现了 `WorkspaceComponentEntry` 的 `ComposeSuppressor.Entry`，内部绑定 `WorkspaceComponent` 单例；在平台生命周期回调 `registerInApplicationContainer(builder, application, state, kind, continuation)` 被调用时（此时 Application 已完全就绪），再执行 `ComposeSuppressor.registerOnce()`，并在 `plugin.xml` 声明 `<lang.inspectionSuppressor language="kotlin" implementationClass="org.jetbrains.android.compose.ComposeSuppressor"/>` 双重保底。
- **实测对比**：修复前服务启动直接报 NPE 无法提供任何 Android 功能；修复后扩展在 Application 阶段无感注入，0 报错正常启动。

### 2. K2 Analysis API 的 Kotlin 调用边界

Java 的 JVM facade 类名与 Kotlin 可导入声明并不等价。Kotlin 实现直接使用顶层函数、扩展与会话 receiver；不导入 `AnalyzeKt`、`KaCallInfoKt` 等 facade。符号通过调用签名获取，不使用已废弃的 `partiallyAppliedSymbol`。

`ComposeSuppressor` 从原生 `analyze` 的 context 参数取得 `KaSession`，在该 receiver 上解析注解。文件级 `@OptIn(KaExperimentalApi::class)` 接受公开 API 的实验性契约，不绕过 Kotlin 的 `internal` 可见性。实际调用和空值边界以锁定 ILS 的 Kotlin 声明为准。

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
  `AndroidExtension` 返回 XML 符号、引用、定义、资源命令、Compose 抑制与 Lint 提供者。`AndroidDapExtension` 独立注册运行调试命令与 `DapPluginsProvider(listOf(module.parent))`。实现类由各自内容模块加载；同插件模块通过显式依赖共享核心 JDWP 单例，禁止 `makePlugin` 构造虚拟插件或依赖跨加载器静态副本。
- **运行时环境调优契约**：
  在 `getConfiguration()` 加载入口处，针对 Android 调试与运行时特征注入关键注册表项，防止调试挂死：
  1. `Registry.get("debugger.batch.evaluation").setValue(false)` 与 `debugger.batch.evaluation.force` 置为 `false`：防止 Android ART 虚拟机尝试加载宿主 JVM 特有的 `BatchEvaluatorServer.class` 导致类加载异常。
  2. `NodeRendererSettings.getInstance().getToStringRenderer().setEnabled(false)`：禁用对象的默认 `toString()` 自动渲染，避免 Android UI 主线程对象（如 `MainActivity` 实例）在断点停顿时因跨 JDWP 调用 `toString()` 导致调试器与主线程死锁。
  3. `XDebuggerSettingsManager.getDataViewSettings().setAutoExpressions(false)`：关闭自动表达式求值，降低 ART 调试开销。

### 2. 插件元数据与互斥原则（`plugin.xml`）

- **主描述符**：`src/main/resources/META-INF/plugin.xml` 在 `<content namespace="jetbrains">` 中声明必选 `language-server.api.features.impl.android`（`loading="required"`）和可选 `language-server.api.features.impl.android.dap`（省略 loading）。根依赖不绑定 DAP 或 Kotlin 导入插件，精简分析集合仍可加载核心模块。
- **模块描述符**：核心 `src/main/resources/language-server.api.features.impl.android.xml` 拥有 LSP/Lint/XML、JDWP 资源及监听器。`src/dap/resources/language-server.api.features.impl.android.dap.xml` 使用 `visibility="internal"`，依赖核心模块、`org.jetbrains.ls.dap.jvm`、`org.jetbrains.ls.feature.kotlin` 和明确的 DAP/IO/Tooling 宿主模块；SPI 随各自 JAR 发布。固定版原生工厂虽为 public，带有 `VisibleForTesting`，升级 SDK 必须通过真实单端点兼容性门禁。
- **版本区间契约**：仅声明 `since-build="271"`，**绝对不设** `until-build`。因为 ILS 运行时的内部构建号固定为 `999.SNAPSHOT`（`idea.plugins.compatible.build=999.SNAPSHOT`），设置 `until-build` 会直接导致插件被平台标记为不兼容而被静默忽略。版本锁定统一交由外部启动层（`detectServerVersion`）精确校验 `271.2085.0`。
- **插件 ID 互斥原则**：声明 `<id>org.jetbrains.android</id>`。IntelliJ 平台对插件 ID 保证全局唯一单例加载。当前 ILS 纯净无官方 Android 插件，使用该 ID 占位；若环境混入官方 Android 插件，平台会直接触发单插件实例互斥抛出加载异常，杜绝双重注入导致的扩展点与 ClassLoader 混乱。

### 3. Android XML DocumentSymbols 协议映射

实现公开的 `LSDocumentSymbolProvider`，通过 `LSDocumentSymbolCustomizer<PsiElement>` 遍历 XML PSI 树，并用公开的 `mapDeclaration` 生成符号：

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
  - 按当前模块、变体与 AGP merger 证明声明身份和编译字段；同名、同 FQN 的独立模块不能仅因名称相同而合并。同一 owner 同时存在 `process<Variant>Resources` 与 `generate<Variant>RFile` 产物时，逐个验证对应 merger 的当前声明身份，存在有效快照即可；仅有过期快照仍返回 `stale_snapshot`，没有快照返回 `missing_snapshot`。多种 R 表示本身不构成 owner 歧义。
  - 官方对照：`ProjectLightResourceClassService.getLightRClassesContainingModuleResources` 枚举 owner 及依赖它的消费模块中的 R 表示；`AndroidResourcesFindUsagesHandlerFactory` 再按资源上下文收缩范围。ILS 适配同样先证明 owner/依赖关系，再枚举真实编译字段副本，不能只搜索 owner 的一个字段或仅按 namespace 扫全工程。
  - `includeDeclaration: false` 仅返回 Java/Kotlin 的真实语义引用；`true` 额外加入当前 XML 声明，不加入其他限定符副本、字节码字段或 XML 使用点。
  - 使用当前 PSI 的引用范围及 UTF-16 行列；在原生挂起读操作内搜索，复用请求取消和 `AndroidSources.Scope` 的文档版本、磁盘来源校验。显式命令与标准请求使用相同边界。
  - `attr`、`declare-styleable` 派生字段、布局 `@+id` 扩展搜索及 XML 到 XML 引用保持阶段 C 的既定边界，不能把普通字段搜索视为这些路径已实现。
  - 271 验收：隔离真实导入集成 27/27，通过 `core -> lib -> app`（含未打开的同包 Java）、同 namespace 独立模块、各 values/文件类型、限定符跳转、缺失/过时来源、严格命令参数，以及 12,002 引用工作负载的取消 `-32800`、并发编辑 `-32801` 和恢复。MyHook 只读查询 `nav_settings`，三入口一致返回 `MyHookBottomBar.kt` 两处及 `SettingsScreen.kt` 一处。
  - H 的原生无扩展控制组与历史缺口记录见 [协议与生命周期专题](ils-protocol-and-lifecycle.md)。当前扩展通过 `AndroidLintProvider` 增加官方源码规则与工程依赖 AAR 规则，保留原生编译诊断。
- **`R.*` 资源的 `DirectNavigationProvider` 契约**：
  - 原生缺陷：Kotlin / Java 中跳转 `R.string.xxx` 时，ILS 原生仅返回 AGP 生成的 `R.jar` 字节码反编译类（`R$string.class`）。
  - 源码优先机制：实现 `com.intellij.navigation.DirectNavigationProvider`（`AndroidResourceNavigation`）。当导航元素为 `*.R` 内的 `PsiField` 且来源为 JAR 时，按模块、依赖关系、namespace 与编译来源限定资源源目录，通过资源 repository 枚举声明，再用当前 PSI 核验声明及范围。首个声明存在于原生 PSI 快照时由直接导航提供；否则 definition provider 保留该声明，并补齐其余限定符。声明定位不依赖变体或 AGP merger/blame 快照；缓冲区改名或文件移走后只返回仍有效的声明，全部消失时保留平台原生字节码导航。尚未落盘的新文件不参与 repository 枚举。资源 references 仍按上节校验编译字段与快照，缺失或过期时明确报错。
  - XML 资源属性（含 Manifest）复用同一资源解析入口；类属性仍由 Manifest 类导航处理。资源身份及文件类型复用 SDK `ResourceSet`、`ResourceMergerItem.isFileBased`。values 和 `@+id` 跳到名称声明，文件型资源跳到文件：XML 使用根标签名称范围，图片及其他非 XML 资源使用文件起点 `(0, 0)`；保留限定符副本。
  - 官方语义依据：[资源仓库层级](https://android.googlesource.com/platform/tools/adt/idea/+/HEAD/android/src/com/android/tools/idea/res/README.md)定义模块、依赖和源集归属；[light classes](https://android.googlesource.com/platform/tools/adt/idea/+/HEAD/android/docs/android-light-classes.md)将生成的 R 类作为该模型的表示，而非独立资源 owner。

### 5. 基于 K2 Analysis API 的 Compose 命名抑制契约

- **抑制目标**：Kotlin 检查项 `FunctionName` 与 `TestFunctionName`。
- **判断契约**：

  使用 Kotlin 顶层 `analyze(function) { ... }` 进入 K2 会话，逐个注解调用 `entry.resolveSymbol()`；无法直接获得构造符号时，通过 `entry.resolveToCall()?.successfulConstructorCallOrNull()` 读取签名符号。仅当 `KaConstructorSymbol.containingClassId` 等于 `androidx.compose.runtime.Composable` 时返回 `true`。检查入口与注解遍历均调用 `ProgressManager.checkCanceled()`，保留原生取消传播。
- **契约约束**：
  1. 仅当待检查元素为函数名标识符（`function.getNameIdentifier() == element`）时介入；
  2. 严格核验注解 ClassId 必须等于 `androidx.compose.runtime.Composable`；普通大写函数（如没有 `@Composable` 的大写函数）严禁放行，继续由原生检查报出警告。

### 6. 构建资产清单与安全替换契约

发布目录为 `resources/ils/271.2085.0/android.lsp/`，共 16 个 JAR，每个 JAR 都有同目录的 `.sha256`。描述符与第三方依赖位于 `lib/`，两个实现模块位于 `lib/modules/`：

| 依赖              | 固定文件名                                                               |
| ----------------- | ------------------------------------------------------------------------ |
| 插件描述符        | `lib/language-server-plugins-android-lsp.jar`                            |
| 实现模块          | `lib/modules/language-server.api.features.impl.android.jar`              |
| 可选 Run/DAP 模块 | `lib/modules/language-server.api.features.impl.android.dap.jar`          |
| AGP 模型          | `builder-model-9.4.1.jar`                                                |
| ADB               | `adblib-9.4.1.jar`、`adblib-tools-9.4.1.jar`                             |
| Lint              | `lint-api-32.4.1.jar`、`lint-checks-32.4.1.jar`、`lint-model-32.4.1.jar` |
| Manifest 来源映射 | `manifest-merger-32.4.1.jar`                                             |
| Android 工具 API  | `common-32.4.1.jar`、`sdklib-32.4.1.jar`、`sdk-common-32.4.1.jar`        |
| 资源类型 API      | `layoutlib-api-32.4.1.jar`                                               |
| XML pull parser   | `kxml2-2.3.0.jar`                                                        |
| Groovy 语法 AST   | `groovy-4.0.29.jar`                                                      |

所有 Maven 运行依赖均关闭传递解析；不分发 `lint-psi`、UAST 或 standalone Kotlin 编译器。ILS 未提供资源仓库类型，`sdk-common` 与 `layoutlib-api` 共同支撑资源仓库接口与值类型，不能只放在编译 classpath。

依赖校验覆盖二进制、POM、Gradle module metadata、BOM 和 IDE 下载的源码包。新增依赖时，使用 `--write-verification-metadata sha256` 生成候选摘要，再核对官方仓库发布的摘要或签名；普通构建和 IDE 同步保持只校验，不自动接受新摘要。CLI 构建通过后，还需实际导入此 JVM 工程，覆盖 ILS 的模型与源码解析路径。

宿主库存在于 ILS 安装目录不代表插件类加载器可访问。主描述符与实现模块描述符都显式声明 `intellij.libraries.asm`、`intellij.libraries.asm.tools` 与 `intellij.libraries.guava`。`lib/` 中的 Lint JAR 由主插件加载，主插件需要直接访问这些宿主库；只给子模块声明依赖，无法让主插件反向访问。ASM Tree 的 `AbstractInsnNode` 位于 `asm.tools`，Lint 的 `Detector` 和内置规则仍引用它，单文件 Scope 过滤不会消除类链接依赖；继续使用宿主模块，不复制宿主 JAR。

`manifest.json` 记录 ILS 版本、插件 ID、Java/classfile 版本、工具链，以及全部资产的名称、相对路径、SHA-256 和大小。实际发布清单见 [manifest.json](../resources/ils/271.2085.0/android.lsp/manifest.json)；Node 校验同时核对固定路径白名单与上游摘要，拒绝缺失、多余或被替换的文件，包括嵌套模块资产。
- **替换与回滚契约**：Gradle `stageExtension` 先在任务临时目录的 `work-<uuid>/staging/` 中生成全部资产，并将现有文件备份到同级 `rollback/`。逐文件替换时优先使用原子移动，文件系统不支持时使用普通替换；移除过期文件后，最后替换 `manifest.json`。替换失败会恢复备份；回滚失败时保留临时目录供恢复，因此这不是整个目录的一次性原子切换。

服务端版本升级后，先更新精确绑定的 ILS/VSIX 元数据，再执行 `npm run build:jvm`，最后运行 `npm run update-bundle -- --sync-marketplace --check`。检查失败即保留错误，不能只更新目录名或 manifest 来绕过 ABI 和第三方资产摘要。

当前 Windows ILS `271.2085.0` 官方归档直接在根目录包含 `build.txt` 和 `bin/intellij-server.exe`，开发安装脚本的直铺验证与本次发行包一致。未来归档改变布局时，应重新验证开发脚本与正常安装器的归档规范化契约。

### 7. Android Lint 单文件诊断

阶段 H 的 Java/Kotlin 与阶段 I 的资源 XML/Manifest 诊断保留真实 ILS 271 验收，覆盖 Java/Kotlin/Compose、导航、原生编译诊断与 Lint 共存。无扩展控制组保留为历史研究证据；持续门禁只运行当前扩展的可观察行为，避免重复构建工程来验证上游服务自身。

- `AndroidRequests.diagnosticQuery` 在分析前记录打开文档版本，在挂起读操作内读取快照；发布前重新进入分析上下文，逐字符核对当前未保存内容，并复核版本与关联磁盘输入。缓存只在复核通过后写入。过期返回 `-32801`，取消传播为 `-32800`。
- `AndroidLintModelResolver` 先读取当前变体的官方 LintModel XML，再回退到 Gradle 脚本字面量与主 Manifest：优先 `build.gradle.kts` 的 Kotlin PSI，不存在时读取 `build.gradle` 的 Groovy AST。动态 `minSdk`、flavor 或 buildType 覆盖保持前提缺失，不虚构 `minSdk=1`；此时只跳过 `ApiDetector`，其余规则继续运行。
- 官方模型读取成功后一次性提交模块、变体和 SDK 字段；读取失败清空本次候选，再走 AST 回退。desugaring、`resValues` 和 ProGuard 输入优先取真实变体，模型不可用时才取脚本或空值；IDE 对跨 `try/catch` 赋值的恒空提示不能作为删除模型分支的依据。
- 固定 ILS 271 的 Gradle 导入可能保留 `-jvm-target` 参数却遗漏 Kotlin facet 的 `targetPlatform`，使 FIR 的 `@JvmRecord` 检查回退到 JVM 1.8。此时以 Gradle 实际编译结果判断产物目标；该导入缺陷仍会产生 IDE 诊断。扩展不通过降目标、压制诊断或改写共享工程配置规避它，修复应由上游导入器按模块写入平台。
- 模块根优先从内容根定位构建脚本；无内容根时从当前 `WorkspaceModel` 的模块实体读取 `exModuleOptions.linkedProjectPath`。该路径保留真实导入信息，核心查询不依赖可选的外部系统 IDE 工厂服务。
- `AndroidLintIssueRegistry` 按官方 `Implementation.isAdequate` 选择单文件规则，并保留 `NewApi`。`AndroidLintClient` 将编辑器 PSI 转换为 UAST，使用真实模块解析作用域与语言级别；资源查询按当前变体和仓库范围解析，仍不等同于 Gradle 全项目 Lint。
- AAR 规则跟随当前模块已导入依赖：发现同级 `jars/lint.jar`，按内容摘要复制到缓存后加载。不设 Maven 前缀白名单，不扫描全局规则目录，不联网获取规则。加载失败跳过单个 JAR；复合执行故障时按 Registry 隔离重试，每次使用独立的 Lint 项目状态，失败批次不进入结果。
- Lint 32.4.1 会吞下 Detector 异常，累计崩溃超过 20 次后连 `client.log` 也会跳过。客户端在官方 `runReadAction` 回调入口记录本次运行的异常，并在 `analyze` 返回后复核，确保日志限流后仍触发 Registry 隔离；取消直接传播，不读写全局崩溃计数。
- 部分源码规则即使在 IDE 全局模式也调用 `getPartialResults`。客户端按官方实现为每个 Issue 保存 `PartialResult`，返回绑定当前项目的视图；每次隔离重试清空状态，不持久化或加载其他模块的分析产物。
- 从项目根到模块根的 `lint.xml` 按目录层级覆盖，Built 态同时使用官方 `lintOptions`。诊断使用 UTF-16 闭开区间、原始纯文本消息、规则 ID 和 `source: android-lint`，并保留有效次要位置。
- Provider 使用线程安全的 64 条目 LRU。键包含工程、文件、文档版本、修改戳、主文档内容摘要、模块模型、规则 JAR 和配置指纹；关闭再打开文件时，版本和修改戳可能复用，内容摘要防止误命中旧结果。每次拉取仍重新解析并校验关联输入，缓存命中也不跳过快照复核。

#### 实施注意事项

- Kotlin PSI 将脚本顶层表达式包装为 `KtScriptInitializer`，读取 `android {}` 前先解包。`minSdk`、`targetSdk`、`compileSdk` 的动态判定具有粘性，后续字面量不覆盖先前的歧义；`minSdk`、`targetSdk` 未声明时可检查主 Manifest，动态表达式或变体覆盖则禁止该回退。
- ILS 271 未捆绑 Groovy PSI。扩展使用官方 Groovy 4.0.29，依次调用 `SourceUnit.parse()`、`completePhase()`、`convert()`，仅生成语法 AST，不进入语义分析或 AST 变换，不执行脚本和 `@Grab`。解析结果缓存在请求级 `AndroidSources.Scope`；资源目录、namespace 和 SDK 配置遵守相同的保存态边界。
- Groovy Lint 每个调用只分发一次带 `parentParent` 的新 `checkMethodCall` 回调，由上游默认委托兼容旧检测器。参数和属性值从 AST 的源区间截取，保留引号和数字进制前缀，避免字符串与八进制规则漏报。DSL 属性使用包含 `propertyCookie`、`valueCookie`、`statementCookie` 的新回调；各 cookie 保留真实 AST 节点，供内置规则定位属性名、值与语句，不能改传同一占位节点。
- `source.properties` 的 API 值可能是 `37.0`。规则使用整数 API 级别，平台目标保留完整标识，例如 `android-37.0`。正式版、预览版与 Add-on 目标通过官方 `AndroidTargetHash` 解析，不从目标字符串手动截取或猜测 API。
- `AndroidSources.text` 保留磁盘读取语义，供关联资源、配置和产物来源校验使用；当前诊断文件使用请求的 PSI/Document 快照。缓存指纹与分析必须读取同一来源，避免关联编辑器内容掩盖磁盘更新。
- ILS 271 的 `ProcessCanceledException` 继承 `CancellationException`。捕获、反射调用和规则隔离均须保留取消，不能把取消当成坏规则或成功空结果。
- AAR 规则复制到 `${java.io.tmpdir}/android-lint-cache/aar/`，文件名使用内容摘要，再通过宿主 `UrlClassLoader` 加载并关闭 JAR 锁定。复制失败不回退到直接加载 Gradle 缓存原件；模块级弱引用缓存最多保留 32 项，键包含复制路径、原文件大小和修改时间。

### 8. XML/Manifest Lint（阶段 I）

复用现有 `AndroidLintProvider`，按文件归属选择 `RESOURCE_FILE` 或 `MANIFEST`，保留原生 XML 语法诊断。真实独立 ILS 271 完整矩阵通过，覆盖目录、抑制、API、资源刷新、隔离，以及实际 AGP 合并来源和 Clean→Built 缓存切换。

独立 JVM 探针已跑通 `ContentDescription`、`HardcodedText`、`HardcodedDebugMode`、祖先 `tools:ignore` 和内存修复，并复现未落盘文件被跳过、默认 merged Manifest 忽略内存修改、多行属性值结束行号错误。探针显式提供项目和规则，结果不等同于真实 ILS 接入或完整资源模型验收。

| 官方机制                                       | 本项目适配                                                                                                |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `Implementation.isAdequate` 判定单文件分析范围 | 不扩大为全项目 Scope，Java/Kotlin 保持原有入口                                                            |
| PSI-backed W3C DOM 与原始节点范围              | 复用当前文档快照；DOM 元数据独立于只读 PSI，不能因“只读”拒绝 Lint 的 `setUserData`                        |
| 按范围查询资源仓库                             | 当前模块、项目依赖、AAR、framework 分开组织；模型无法确认时返回明确错误                                   |
| `BlameFile` 与 Manifest Merger 节点键          | 增加同版本官方 `manifest-merger:32.4.1`，校验变体与输入有效性；Clean 态保留源文件检查，不自行拼接合并清单 |

用户确认的保存边界：当前拉取文件的未保存内容即时参与诊断；关联资源、配置和其他清单按磁盘读取，保存后刷新；新文件首次保存后检查。输出前在新分析上下文中复核当前文档内容，避免上下文外访问快照 Document。

`textDocument/codeAction` 复用 `AndroidRequests.diagnosticQuery` 的请求作用域、保存态模型输入和发布前快照复核。即使诊断已缓存，生成 Lint fix 与 `lint.xml` 抑制编辑仍需读取模块模型，不能只给重新分析诊断的路径建立作用域。动作以当前 PSI 和官方 `LintFixPerformer` 计算 `WorkspaceEdit`，保持 [Studio 的 PSI quick-fix 模型](https://github.com/JetBrains/android/blob/master/android-lint/src/com/android/tools/idea/lint/quickFixes/RemoveAttributeQuickFix.kt)与 [LSP code action 范围和编辑契约](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#textDocument_codeAction)；请求本身不修改源文件。

XML 抑制属性与 `xmlns:tools` 插入位置取官方 `XmlTagUtil.getStartTagNameElement(...).textRange.endOffset`。`XmlTag.textOffset` 指向整个标签起点，直接加名称长度会把属性插入标签名内部；生成编辑后必须验证 XML 仍可解析且目标诊断消失。

Lint quickfix 的目标使用可由客户端解码的标准 `file://` URI。`lint.xml` 已存在时编辑现有配置；不存在时由支持资源创建的客户端依次应用 `CreateFile` 和 `TextDocumentEdit`，创建操作不覆盖同名文件。抑制路径相对最终 `lint.xml` 的目录生成，临时配置副本不会改变抑制范围。

Bridge 仅在客户端同时声明 `workspace.workspaceEdit.documentChanges` 和 `resourceOperations: ["create", ...]` 时，向 JVM 会话传递 `initializationOptions.ompAndroidCreateLintXml: true`。直接连接 ILS 的客户端可在声明同等能力时显式传递该选项；默认不提供需要新建 `lint.xml` 的动作，普通 quickfix 和已有配置的编辑仍可用。

编辑期通过官方 `ManifestMerger2` 合并当前源集与已知依赖，使用模型的 namespace、package 和已知 `minSdk`/`targetSdk` 系统属性；`setNamespace` 只负责类名解析，缺少 `package` 的现代清单还需要 `Document.PACKAGE` 注入。合并不改写源文件，并保留未保存内容与来源范围。Built 态优先使用经输入校验的 AGP 产物；模型缺失或合并失败时回退到源文件检查。

显式传给 XML parser 的文本是解析输入；只有文本与源 PSI 一致时才复用 PSI-backed DOM。合并文本与源文件不同时独立解析，避免以未合并的源节点替代合并结果。

已修复的适配差异：
- 自定义 Manifest 按同一 Gradle 模块中的实际源集归属选择生产模块，避免用聚合模块解析类及变体。
- 无命名空间节点返回 W3C 规定的 `null`，限定属性同时支持 QName 和 namespace URI 查询；官方 Merger 的节点键与源文件保持一致。
- 合并节点无法映射时不返回源文件位置；源文件未保存或晚于合并产物时回退到当前源 DOM。
- 资源、关联 Gradle 脚本及配置读取保存态；指纹覆盖依赖文件内容、中间层 `lint.xml`，以及合并清单/merger 日志的存在性、内容和时间戳。生成合并产物后，即使主文档未改动，也会重新运行检查。
- 资源字符串解码复用 `ValueXmlHelper.unescapeResourceString`，attr 格式与 enum/flag 元数据复用 `AttributeFormat`；资源引用复用 `ResourceUrl.parse` 和官方名称校验。只将无 namespace 的模块自有 `@+id` 收入声明表，避免 `@+android:id` 污染 framework 或模块资源。

### 9. 原生批量检查与规则目录

`AndroidLintProvider` 同时实现 `LSDiagnosticProvider` 和 `LSBatchInspectionProvider`，通过原生 `intellij/inspections` 和 `intellij/inspectCode` 暴露规则与逐文件检查。批量入口复用单文件的模型、诊断映射和发布前快照复核；结果流与 `partialResultToken` 由原生 SDK 编排。检查范围仍是请求中的单文件集合。

- 目录使用 `AndroidLint.<IssueId>` 作为主 ID，保留原始 Issue ID 短别名。完整主 ID 精确选择 Android Lint 规则；短别名允许与其他原生 Provider 同名。诊断中的 `code` 保持原始 Issue ID。
- `null` 选择全部适用规则，空集合产生适用但无诊断的结果。非空选择先裁剪 Registry，再通过请求级官方 Configuration override 关闭未选 Issue；同一 Detector 的其他 Issue 也受此门控。已选规则继续遵循项目、Gradle、子目录及文件级配置和抑制。
- 规则目录通过官方 nullable-driver JAR 装载路径枚举，复用同一模型的 Java、资源 XML 和 Manifest 规则装载结果；枚举不创建分析 Driver，也不执行 Detector。AAR 故障保持单 JAR 隔离，部分目录可返回但不写缓存。
- 跨模型目录按模块根、变体及模块名稳定合并，同一主 ID 合并语言集合，元数据采用最后一个模型的代表规则。条目保留官方描述、类别、默认严重级别和默认启用状态。
- 诊断缓存键包含去重排序后的规则选择，区分全部、子集和空集合。目录使用独立有界缓存，仅保存不可变模型指纹与规则元数据；发布和命中均复核项目根、模块身份及关联输入。取消或输入变化传播原生错误，未完成结果不写缓存。

### 10. XML 相关测试候选

XML 专用 `AndroidXmlRelatedTestsProvider` 接入原生 `intellij/relatedTests`，复用官方 `TestFinderHelper` 返回候选测试位置。Java/Kotlin 保持宿主已有 Provider；查询仅发现关联，不执行测试。

请求使用宿主当前文件树中的 XML。SDK 271 对未导入的 `res/` 文件要求先按标准 LSP 生命周期 `didOpen` 并等待分析水位；查询后可 `didClose`。Provider 不自动打开文件、不构造替代 VirtualFile，也不扩展宿主资源索引。

- Manifest 仅解析组件类属性值及 alias 的 `targetActivity`，复用导航的类名解析与模块归属。属性外位置、合法但未解析的类返回空候选。
- Layout/Menu 先确认所属模块、已编译 `R` 字段及 AGP 资源来源，再处理根节点 `tools:context`。有效 context 独占候选选择，即使没有关联测试也保留空结果；缺失或无法解析 context 时才搜索资源字段引用。
- 引用搜索限制在资源所属模块。最近调用名为 `setContentView` 或 `inflate`，且最近宿主类属于 Activity、平台/support/AndroidX Fragment 或 Adapter 时，交给原生 TestFinder；Java 与 Kotlin 共用这条官方候选启发式。
- 同一 URI 与 Range 只返回一次。缺失编译 R 或未引用资源可返回空结果；来源不完整、过期、歧义和分析模型错误保留原生失败。发布前复核 XML 文档、访问过的源码/测试文档及关联磁盘输入，取消与快照变化传播错误。
- 核心实现显式依赖 TestFinder、Kotlin PSI 和 light-class 公共模块；可选 DAP 与 Kotlin 语言服务 feature 保持独立装载边界。

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

生产 Kotlin 源码分别位于 `src/main/kotlin`（核心）和 `src/dap/kotlin`（可选 Run/DAP），主体编译为 Java25；纯 Gradle Action 与 DTO 位于 `src/gradleAction/kotlin`，单独编译为 Java17 字节码并并入同一 DAP JAR，供项目 Gradle daemon 的 JDK 加载。测试位于 `src/test/kotlin`。编译复用宿主 Kotlin 库，不重复分发运行时。

编译 classpath 按 sourceSet 隔离：核心不加入 DAP、kotlinx.io 或 Gradle Tooling；可选 dap 加入明确的宿主 DAP、IO、`kotlin.lsp` Tooling 模块与核心输出。`builder-model:9.4.1` 单独锁定并分发，Gradle 运行时复用宿主 `intellij.libraries.gradle.tooling`，不重复打包。JVM 测试运行时保留完整固定 ILS SDK，但 classpath 可见不能代替真实插件加载门禁。运行协议见 [Android 运行调试契约](android-jdwp-debugging.md)。

Android attach 验证按运行缓存一次真实 APK：缺少缓存时用 fixture 的 Gradle wrapper 执行 `:app:assembleDebug`，不为 APK 准备额外启动 ILS。native Gradle launch 的构建与进程所有权仍由独立真实集成用例覆盖；attach smoke 保留完整断点、变量、单步与 detach/重新 attach 检查。

### 2. 构建产物验证

构建产物规范由 Gradle 原生保证：
1. Kotlin 的 `jvmTarget = JVM_25` 与 Java 编译任务的 `options.release.set(25)` 保证 classfile 为 Java 25（Major 69）；
2. `entryCompression = ZipEntryCompression.STORED` 保证零压缩；
3. `gradle/verification-metadata.xml` 自动校验上游官方库的 SHA-256；
4. `stageExtension` 任务自动生成 `manifest.json` 与伴随的 `.sha256` 摘要文件。

集成测试同时隔离原生索引：共享 LSP 测试驱动默认将 `initialize.initializationOptions.indexDir` 设置为沙箱的 `index/<project-id>/`，保留显式初始化选项；CLI/DAP 创建的会话从沙箱工程配置中读取相同的 `rawInitializationOptions`。不同工程使用独立索引目录，索引随沙箱统一回收。仅设置服务端 `systemPath` 不会改变原生索引位置。Gradle 分发包与依赖缓存从已有缓存复制到沙箱，排除锁与未完成下载；构建、导入和清理始终使用沙箱拥有的 Gradle User Home。

沙箱统一将现有 `OMP_ANDROID_LS_EXTENSION_DIR` 指向本仓库当前暂存的扩展资产，同时覆盖进程内模型查询与 Bridge/DAP 子进程，避免 `dist-test/src` 的相对路径误用 `dist-test/resources`。

精简装载门禁先在独占沙箱中完成真实 AGP 构建与原生导入，按 `shutdown`、`exit`、关闭 Bridge 的顺序释放客户端，再停止该沙箱的 ILS 并保留导入结果。随后使用官方 JBR 启动参数、公开 Analyzer 测试模式及 `workspaceManager`/`session` 生命周期运行精简宿主，排除可选 DAP 和 Kotlin feature，调用核心批量检查与 XML relatedTests。基础 Java/Kotlin PSI 保留，测试进程的完整 classpath 不作为插件可见性证明。

测试启动器先通过 SDK 的公开 `pluginSet` 工厂组装原始描述符的源集合并配置真实 classloader，再安装 `originalDescriptorSupplierForMakePlugin`，最后首次初始化原生 Java/Kotlin/XML Analyzer 描述符与最终分析集合。该顺序避免静态初始化提前固化空来源及类路径；源集合只提供描述符与 loader，不注册其扩展。最终集合保留来源 loader，调用方独立装入隔离 JAR，并校验 core 为 ENABLED、DAP/Kotlin feature 缺席、XML PSI 类可解析。启动器还通过 SDK 公开入口加载安装目录内的 FileWatcher JNI 库，并使用沙箱日志保留原生初始化失败原因。

该测试保留真实 `JUnit` 描述符，为原生 `TestFinderHelper` 提供测试框架识别；只有 Java/Kotlin finder 而缺少框架时，源码与测试 PSI 均可解析，但测试类不会被识别。它不启用依赖 Kotlin feature 的 JVM testing feature，也不替换 finder 或注册模拟框架。Windows 目标 URI 经标准文件路径归一化后比较，保留真实 URI 编码与大小写差异。

原生索引版本取决于已注册的索引扩展；精简集合不能直接复用完整宿主的 RocksDB 索引。启动器只通过公开 `Workspace.readWorkspaceModelCache` 读取真实持久化实体，再用原生反序列化、去重合并及工作区更新 API 导入独立精简索引。源库不创建、不清理版本；不改索引版本号、不复制不兼容的索引数据，所有最终插件集合均保持精简。

### 3. 反编译器选型横评与技术适用边界

查询依赖的 Kotlin 声明、可见性和类型时，优先使用 ILS 原生 `workspace/executeCommand("decompile")`，传入定义查询返回的原始 `jar:` 或 `jrt:` URI；调用方式见 [协议文档](ils-protocol-and-lifecycle.md#5-虚拟源码与当前服务端能力)。返回内容标记为声明 stub 时，只能据此确认 API，不能推断方法实现。确需方法体而原生反编译未提供时，再使用下述 CLI 工具。

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
