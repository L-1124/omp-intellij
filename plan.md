# Android 语言服务与调试增强计划

## 1. 目标、状态和边界

在 `omp-intellij` 中补齐 Android XML 符号、XML 到 Java/Kotlin 引用查询、Compose 命名检查适配、内嵌官方 Android/Compose Lint 实时诊断和设备端 JDWP 编排。复用 IntelliJ 的 PSI、K2 UAST、索引和调试器，参考 Android 官方插件的资源身份、作用域、规则装载和会话所有权设计。

本文区分探针实测、生产实现和验收要求。临时探针未安装到共享服务，MyHook 生产源码未修改。阶段 A、阶段 B 与既有 Android definition 已迁入 `271.2085.0` 的 JVM 扩展并通过隔离实测，旧 TS XML/Gradle 解析链与 `saxes` 已删除；阶段 C/D/E/H 按各自章节继续推进。

### 1.1 交付项

| 阶段 | 交付                                                                                                          | 当前状态                                                                 |
| ---- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| A    | Android values XML、Manifest 的 `textDocument/documentSymbol`                                                 | **已完成**（`271.2085.0` JVM 生产实现 + 双模块/MyHook 实测通过）         |
| B    | Manifest 类属性触发 `textDocument/references`（含既有 Android `definition` 迁移与旧 TS 解析链删除）           | **已完成**（`271.2085.0` JVM 生产实现 + 源码集合等价/并发取消实测通过）  |
| C    | 资源 XML 声明触发 Java/Kotlin 语义引用查询，与导航共用 JVM 查询服务                                           | 待实施（共享 `AndroidContext` / `ResourceResolver` / `AndroidRequests`） |
| D    | 语义确认的 Composable 函数命名检查豁免                                                                        | 待实施（263 探针已验证，待迁入 271 JVM 扩展并重跑矩阵）                  |
| E    | 独立 Android `prepare-attach` / `cleanup` 编排入口，与原生 DAP 组合                                           | 待实施（原生 Android DAP 双场景已验证）                                  |
| F    | 断连清理、新会话恢复及多工程隔离验收；仅修复复现的缺陷                                                        | **A/B 与 definition 路径已完成**；待随 C/D/E/H 增量合入                  |
| G    | 开启 intellijExtensions 协议扩展支持，完整支持 ModCommand QuickFix，不新增 Bridge 黑名单                      | **已完成**                                                               |
| H    | 同进程内嵌官方 Android Lint 与 AAR Compose 规则，经 `LSDiagnosticProvider` 接入原生 `textDocument/diagnostic` | 待实施（263 探针与 6 JAR 依赖集已验证，待 271 生产集成与验收）           |

### 1.2 边界

- 架构遵循原生优先梯次（Native-First Precedence）与能力发现门禁：
  1. 标准 LSP 优先：优先利用标准 LSP 方法（`textDocument/*`、`workspace/*`、标准 LSP 3.17 的 `notebookDocumentSync`），严格区分带 ID 的 `$/` 请求与单向 `$/` 通知（服务端 capabilities 并非所有自定义 RPC 的穷尽清单）；
  2. 已广告私有命令与 MCP 工具优先：通过 `capabilities` 发现 `list-mcp-tools`，读取 `inputSchema` 并通过 `run-mcp-tool`（或底层 `request`）直接调用；Agent 具备自主能力发现与 schema 调用机制，无需客户端或 Bridge 硬编码专有工具封装，严禁为已可通过 `xd://lsp` / `request` 调用的功能重复发明自定义工具；
  3. 仅在原生 LSP / MCP 存在已验证语义缺口时，才通过独立 JVM Provider 接入补齐 Android 语义（阶段 A–H），复用当前工程的 XML PSI、K2 UAST 与 Gradle 模块模型；严禁倒退回 TS XML 自定义解析（如 `saxes`），在未验证明确缺口前不新增自定义 projectView 或工程树解析工具。
- 能力广告与执行验收分别记录：模块概览不等于 Android 完整模型；`lint_files` 的通用 Inspection 描述不能证明已加载 Android Lint 规则、SDK API 数据或 AAR Compose 规则。按目标工程和实际规则结果判定缺口，不预设所有原生工具均可用或均不可用。
- `exportWorkspace` 导出工作区模型，不是 AST 或包树。输出体积、耗时、生成目录识别覆盖率和 token 收益均须测量，不设未经验证的固定承诺。
- `263.7084.0` 与 `271.2085.0`（Open VSX `1.0.86`）均不含独立的 `android.lsp`。本次完整扩展以 `271.2085.0` 为目标；263 的实测结果（Compose 命名抑制、Lint、资源搜索）严格作为历史基线，不能直接算作 271 验收通过。
- 不移植整个 Android Studio、`AndroidFacet`、`ResourceRepository`、VFS 或 Light R 系统。
- 不新增 Android rename、XML completion、Compose Preview、Profiler、native LLDB 或混合调试；阶段 H 仅执行源码级 UAST 规则（内置 `NewApi` 等与随 AAR 分发的 Jetpack Compose 规则），不等同于全项目跨 XML/资源合并的 Gradle `lintDebug` 任务。
- 复用 `intellij-server` 内置的 `com.jetbrains.ls.imports.gradle.model.builder.android.AndroidProjectModelBuilder`，消费已导入的模块、变体、SDK 和依赖库。模型中的 `R.jar` 路径不代表文件实际存在；namespace、自定义 Manifest 和 `res` 根不能假定已导入，见 §4.2。
- XML 结构与位置使用服务端当前 `XmlFile` / `XmlTag` / `XmlAttributeValue`；引用查询使用 PSI 语义搜索。XML 到 XML 的全项目资源引用另行设计。
- 导航查询与诊断不触发 Gradle 同步或构建；首次工程导入可能执行 AGP 准备任务。大纲不要求 R.jar，资源字段搜索需要真实字段及来源证据，缺失时明确报错。设备附加不自动构建、安装、启动、重启或结束目标应用。
- DAP 调试保持原始物理栈帧透传：不在 `dap-proxy` 中删改或伪造折叠帧，避免破坏 `stackFrame.id` 与闭包捕获变量求值；需要限制栈深时使用标准 DAP `levels` 参数。
- 不接受新 EULA、不修改全局设备调试设置、不关闭其他调试器、不因一次连接失败重启共享 ILS。
- 非 Android 请求沿用原生行为。支持节点的前提失败返回明确错误，不用空结果掩盖失败。

## 2. 已完成研究与实测基线

研究日期：2026-11-04 至 2026-11-05。环境包括 ILS `263.7084.0`、`271.2085.0`，JBR `25.0.4.1`、AGP `9.4.1`、Gradle `9.8.0`。271 的 Android 导入实验使用 MyHook 临时副本，排除 `build/`、`.gradle`、`.idea` 等目录。

### 2.1 确定结论

| 项目                      | 已观察结果                                                                                                                                                                                                                                                                  | 实施决定                                                                                                                 |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| XML 路由                  | OMP 的 fileTypes 缺少 `.xml`；补齐并 reload 后 XML 请求到达 ILS                                                                                                                                                                                                             | 安装/路由问题已有结论；保留 `.xml` 声明                                                                                  |
| 原生 XML 导航             | 263 的 strings.xml definition、references 返回 `[]`，XML resolveLaunch 返回 `-32803 No file found`；271 已导入 Android 工程的 Manifest definition/references 和两类 XML 大纲也返回 `[]`                                                                                     | 在 JVM 补 XML Provider 与 Android 目标解析，不以空结果推断 XML PSI 不可用                                                |
| R 反编译位置              | 两个 R 字节码候选的 references 在 true/false 下均为空；didOpen 反编译文本后仍为空                                                                                                                                                                                           | 不使用反编译坐标转发资源 references                                                                                      |
| 直接字段搜索              | 当前分析上下文内取得 `ClsFieldImpl`，找到 nav_settings 三处真实源码引用                                                                                                                                                                                                     | 使用直接 `PsiField` 和 `ReferencesSearch`                                                                                |
| 资源命令                  | `omp.findResourceFieldReferences` 在 263 命令广告中出现，实际返回三处引用                                                                                                                                                                                                   | 保留显式字段查询入口；标准 XML references 与它调用同一 JVM 查询服务，不经 Bridge 二次 RPC                                |
| 合法零引用                | app_name 的字段解析成功，Java/Kotlin 引用为零                                                                                                                                                                                                                               | 成功 `[]` 与解析失败分别处理                                                                                             |
| 取消                      | 探针等待阶段取消返回 `-32800`，执行 CANCELLED_EXIT / FINALLY_EXIT；并发正常请求仍返回三处                                                                                                                                                                                   | 接通端到端取消；搜索遍历中途取消用内存多文件沙箱做生产验收                                                               |
| XML PSI 与范围            | 271 的 Manifest、values 均为 `XmlFileImpl`；CRLF、emoji、实体、单引号、多行属性的范围已实测                                                                                                                                                                                 | 使用 PSI 原始范围和当前 Document，替代 TS `parseXml`                                                                     |
| 未保存 XML                | `didChange` 后 PSI 与大纲 Provider 均返回新名称和新增组件，磁盘未改；探针中的文档均已提交                                                                                                                                                                                   | 复用原生文档同步；不复制未触发的手工 `commitDocument` 分支                                                               |
| 不完整 XML                | 271 PSI 在 EOF 未闭合、错配结束标签两种用例中保留了部分节点，并报告局部错误                                                                                                                                                                                                 | 大纲可保留范围有效的节点；语义查询不能使用身份不完整的节点，不外推任意损坏 XML 均可恢复                                  |
| XML 大纲 Provider         | 自有 `LSDocumentSymbolProviderPsiBase` 经 SPI 加载，标准请求返回正式 Android XML 符号树，已完成全部 10 类 SymbolKind 与原始 selectionRange 验收                                                                                                                         | 阶段 A 已由原生 Provider 交付                                                                                            |
| 层级能力                  | 271 在客户端声明 `hierarchicalDocumentSymbolSupport=false` 时仍返回树；Provider 返回类型固定为 `Flow<DocumentSymbol>`                                                                                                                                                       | Bridge 仅对该协议结果做平面转换，不解析 XML                                                                              |
| Compose 命名豁免          | 单次 explicit 注册后，七项真实诊断正反用例通过；EP-only 注册未进入检查调用链                                                                                                                                                                                                | 独立 JVM 模块内采用服务端生命周期单次注册                                                                                |
| 原生诊断挂载入口          | `LSConfigurationPiece.entries` 注册 `LSDiagnosticProvider`（按 `LSLanguage.lspName` 匹配 `"java"` / `"kotlin"`），ILS 用 `Flow` 并发合并返回                                                                                                                                | 采用 `LSDiagnosticProvider` 直通 `textDocument/diagnostic`，无需 TS 层拦截拼装                                           |
| 内嵌 Lint 与 Compose 规则 | 同进程复用 `DefaultUastParser` 与 K2 `KotlinUFile`，`NewApi`（Java/Kotlin 12 用例）与 Compose `UnrememberedMutableState`（正反例、抑制、同文件并发）全部通过，单次耗时 6–39ms                                                                                               | 正式纳入阶段 H；在 `OmpLintClient.createUrlClassLoader` 屏蔽 Windows 提前 `close()`                                      |
| Lint 运行依赖集           | 从 43 个 JAR（43.94 MB）逐项剔除实测，5 JAR 组合在 `NewApi`/`UnrememberedMutableState` 上通过；因 `DefaultJavaEvaluator.getDependencies()` 等字节码依赖，完整 androidx 规则集需 6 个核心 JAR（新增 `tools.lint-model`，共 11,362,788 字节 / 10.84 MiB），0 日志错误、0 崩溃 | 随插件 `lib/` 目录固定分发这 6 个核心 JAR（缩减 74.1% 体积），不打包 `lint-psi` 或重复编译器；若收窄规则集才可回退 5 JAR |
| Lint 模型与 AAR 发现      | 263 库表中的 83 个 AAR 共发现 24 个同级 `jars/lint.jar`（含 13 个 Compose 模块）；`build.gradle.kts` 未 `didOpen` 时通过 `KtPsiFactory` 构造 `KtFile` PSI 读取 namespace、minSdk、targetSdk 字面量                                                                   | Lint 优先消费已导入模型；动态 DSL 与 flavor 覆盖另行验证，不把字面量读取等同完整 Gradle 求值                             |
| Android DAP               | API 36.1 x86_64 的运行进程和等待调试进程，均通过原生 debug 工具命中断点、读取变量、单步、detach                                                                                                                                                                             | 开发设备编排，保留现有调试引擎，保持物理栈帧透传                                                                         |
| 恢复                      | 隔离服务退出后旧 Bridge 退出，新 Bridge 自动启动新服务并恢复真实 definition                                                                                                                                                                                                 | 新会话重建；不重用旧 Socket 会话                                                                                         |
| QuickFix                  | 早期 RenameFix 的 fixes=[]、codeAction 无 Rename，Create method 正常；后续启用协议扩展后 Rename 正常，见 §11                                                                                                                                                                | 保持已完成修复，不新增过滤代码                                                                                           |

### 2.2 资源与模型的具体证据

- `nav_settings` 三处源码位置为 `MyHookBottomBar.kt:53`、`:56`、`SettingsScreen.kt:73`，此处行号从 1 开始。
- 源引用 resolve 与 `JavaPsiFacade` 在该源文件 resolveScope 查类，两路取得同一字段；在此 MyHook 场景下 effectiveScope、projectScope、allScope 三种搜索都返回上述三处。
- 内存文档实验覆盖 Kotlin import 别名、Java 显式 static import、限定引用和同名局部变量遮蔽。直接字段搜索找到真实引用，排除了同名局部变量。
- 从 Kotlin 别名使用点直接发原生 references 返回空；从原字段入口能找到别名使用点。因此 XML 路线直接查询原字段。
- MyHook 当前编译期 `compile_r_class_jar/debug/generateDebugRFile/R.jar` 为 1 个包、6 个类；打包期 `compile_and_runtime_r_class_jar/debug/processDebugResources/R.jar` 为 101 个包、277 个类。两者用途和资源来源分别记录。
- 既有 AGP 隔离实验中，两模块使用相同 namespace 均能生成 R 类；同时依赖时出现字段的 classpath 遮蔽。不同 namespace 的同名资源分别生成各自字段；非传递 R 和 merger 的覆盖来源也已验证。
- 原生导出模型的 app/debug/unitTest/androidTest 可以共享 `externalProjectId=:app`；选择必须结合精确模块名、contentRoot、sourceSet/variant，不能仅靠 Gradle projectId。
- 旧 TS `parseModules` 只保留 module 依赖。迁移后直接读取服务端模块和库表，保留 library 依赖与类根来源，不再经 TS 导出/重建查询上下文。
- `package-aware-r.txt` 是首行 package、后续 type/name 两列；不能用三列格式解析。
- 资源 definition 的现有来源校验已返回 strings.xml 的 `nav_settings` 声明，LSP 零基范围 `56:18–30`。

补充二进制多模块实测：独立 `jarA.jar`、`jarB.jar` 都含 `com.probe.samens.R.string.test_field`，consumerA 依赖 A，consumerA2 通过 consumerA 传递依赖 A，consumerB 只依赖 B。真实原生 definition 分别定位到 A/A/B；从 consumerA 发原生 references 只返回 A、A2 两处，从 consumerB 发请求只返回 B 一处。原生语义在这个场景已正确隔离，没有“projectScope 已被证明串模块”的结论。

该实验的实际入口为原生 LSP workspace/symbol、definition、references，未执行直接 SPI 的两种 scope 对照。MyHook 的两个 R 候选也来自原生符号/definition；底层 `findClasses` 枚举和生产模块范围收缩作为明确实现及验收项。纯 binary 库是模型中的 library，不是可直接调用 moduleWithDependentsScope 的 Module。

### 2.3 原生 Manifest references 基线

下表是直接从类源码发出的原生请求，尚未加入当前 XML 属性。行号从 1 开始。

| 类                   | 声明行                     | false | true | 结果内容                                                          |
| -------------------- | -------------------------- | ----- | ---- | ----------------------------------------------------------------- |
| MainActivity         | MainActivity.kt:34         | 2     | 3    | McpForegroundService.kt:22 的 import、:171 的类使用；true 加声明  |
| HookLogProvider      | HookLogProvider.kt:35      | 1     | 2    | QimeiRepository.kt:41 的 KDoc 符号链接；true 加声明               |
| McpForegroundService | McpForegroundService.kt:38 | 8     | 9    | 本类 3 处、SettingsViewModel 3 处、MainActivity 2 处；true 加声明 |

HookLogProvider 的执行代码调用数为零，KDoc 链接仍是合法语义引用。生产保留该结果，不按注释文本过滤。

### 2.4 原生 Android DAP 与恢复、QuickFix 证据

- 调试 fixture 为一次性 `com.example.dapfixture` APK，打包 MyHook 现有 `JceHead.java`，保留调试信息，目标 API 34。MyHook 工程用于真实源码映射，未修改其源码。
- 普通运行进程 PID 4628，经动态端口 50558 建立原生 `debug-2`；断点 `JceHead.java:11` verified 并命中，读到 `type=64/tag=1192`；单步到第 12 行后 `this.type` 从 0 变成 64。
- `am start -D` 的等待进程 PID 4791，经端口 51169 建立原生 `debug-3`；同一断点命中，读到 `type=9/tag=1009`，完成单步和 detach。
- 两次 detach 后目标均继续输出日志；本次 forward、fixture APK 和本次启动的模拟器已清理。此结论覆盖本次 API 36.1 x86_64 环境。
- 无效 PID 999999 的 ADB forward 仍创建成功，本地 TCP connect 成功但 JDWP 握手立即 EOF。正式流程只由真正调试器完成握手。
- 恢复实验中两个工程连接同一隔离服务 PID 42148；关闭 A 后 B 的 definition 正常，重建 A 沿用该 PID。终止本次隔离服务后，两 Bridge 在约 1032ms 内退出；新 Bridge 启动 PID 41080 并返回正确源码 definition。
- 新 LSP 连接没有旧连接的未保存文本；新 DAP 会话须重新申请调试服务。当前未证明 OMP 管理器会透明重建已退出的旧客户端。
- Java `class UseApp<T> { <T> void hide(T value) {} }` 的 `TypeParameterHidesVisibleType`：实测证实开启 `intellijExtensions` 与 `lazyIntentions` 后，`diagnostic.data.fixes` 正常包含 Rename，`codeAction` 正常返回 `[quickfix] Rename`，执行 `applyModCommand` 服务端正常下发 `editor.action.rename` 命令；关闭时该指令被服务端丢弃。

### 2.5 271 的 XML 与 Android 导入实验

- 干净 MyHook 副本导入成功，导出 `MyHook.app.debug`、`debugAndroidTest`、`debugUnitTest` 和 155 个库。导入执行了 Debug、Release 的 BuildConfig 生成任务；未生成资源 R.jar。
- 库表声明 `Gradle: android:r:null`，但对应 R.jar 在导入后仍不存在。`sourceRoots` 包含 Java 与 `src/main/resources`，不包含 Android `res/`；字节码检查显示导入器未提取完整 namespace、自定义 Manifest 和资源根信息。
- 271 XML 配置注册了语法诊断、Inspection、QuickFix、批处理检查和通用 definition，未注册 XML documentSymbol/references Provider。插件可向既有 XML 语言追加 Provider；不得重复注册 `"xml"` 语言。多个 `LSDefinitionProvider` 采用流式并集聚合，因此 `R.*` 源码优先改用平台 `DirectNavigationProvider`（见 §2.7）。
- 用 `javap` 比较的八个核心 XML PSI 接口在 263、271 的公共签名一致；模块位置与插件依赖有变化。这不是整个扩展跨版本兼容的证明。
- 早期探针证据见 §13.4；正式生产实现已在 `jvm/android-ls-extension/` 完成并通过 271 验收。
### 2.6 实测原生能力、MCP 发现与 xd://lsp 映射基线

- **实测 MCP 能力广告**：基于真实 `xd://lsp` 在包含 `pom.xml` 的工程环境中实测验证，服务端在 `initialize` capabilities 中广告了 `list-mcp-tools` 与 `run-mcp-tool`；调用 `list-mcp-tools` 成功返回 22 个内置工具的描述与 `inputSchema`。
- **真实工具调用与可用性验证**：
  - 调用 `run-mcp-tool` 传入 `[{tool:'get_project_modules', arguments:{}}]` 成功返回 `structuredContent.modules: [{name: 'omp-intellij-root', type: 'JAVA_MODULE'}]`。实测证实：模块信息仅包含模块名称与基础类型，并不暴露源码根（source roots）、content roots、包命名空间（namespace）或 AGP 构建变体（variant），不能替代 Android 工程上下文；
  - 调用 `get_project_dependencies` 在临时 marker Maven 工程上返回 `dependencies: []`，这仅是对照工程结果，不构成 Android 依赖解析证据，亦无完整依赖图保证；
  - 调用 `list_directory_tree` 即使传入 `projectPath` 仍报错 `'The project directory cannot be determined.'`，直接证实广告能力不等于端到端操作可用（advertisement != operational proof）。
- **Android 等价性待验收**：上述调用没有验证 Android XML 语义或 Android/Compose Lint 规则是否可用。`lint_files`、`get_file_problems` 的 schema 只描述通用检查入口；须在目标 Android 工程用具体规则正反例核对，不能仅凭工具名称判断已满足或无法满足阶段 H。
- **协议语义与清单边界**：
  - LSP `capabilities` 并非服务端所有自定义 RPC 的穷尽清单；
  - `notebookDocumentSync` 属于 LSP 3.17 标准能力，非 IntelliJ 私有扩展；
  - 必须严格区分带 ID 的 `$/` 请求（Request，需包含 client id 并返回响应）与单向 `$/` 通知（Notification，单向且无 id，如 `$/cancelRequest`）。
- **澄清早期不实宣称**：
  - 澄清“10–50MB 导出 AST/哈希、100% 自动生成正确性、毫秒级执行、未实测的 token 节省”等推论均属不实或缺乏实测证据；
  - `exportWorkspace` 导出的是工作区与模块结构模型（Workspace Model），绝非语法树（AST）或包结构树。
- **历史版本界限**：
  - ILS 263 的实测结果（Compose 命名抑制、Lint 探针、资源字段搜索等）严格标记为历史基线，不得作为 271 验收依据。

### 2.7 271.2085.0 阶段 A/B 与 Definition 迁移实测经验（供阶段 C/D/H 复用）

1. **`R.*` 源码优先级的平台挂载点（`DirectNavigationProvider` vs `LSDefinitionProvider`）**：
   - ILS `271.2085.0` 对同一语言的多个 `LSDefinitionProvider` 采用流式并集（union）聚合；若仅在 Kotlin/Java 上追加 `LSDefinitionProvider`，`R.string.*` 会同时返回 XML 声明与 `R.jar!/.../R.class` 字节码。
   - 在 `META-INF/plugin.xml` 注册 `<directNavigationProvider implementation="org.omp.intellij.android.AndroidResourceNavigation"/>` 后，平台对 `R` 类 `PsiField` 调用 `getNavigationElement()` 时直接替换为指向真实 XML 范围的 `FakePsiElement`，从而在源头取代 `R.jar`；当 AGP 来源缺失、声明改名/删除或存在未构建覆盖时返回 `null`，无缝回退原生 `R.jar` 目标。
2. **Manifest 完整 FQN 类属性的原生 XML 命中去重**：
   - 当 Manifest 组件属性书写完整 FQN（如 `android:name="com.app.myhook.MainActivity"`）时，`FindUsagesManager` / `KotlinFindUsagesHandler` 会额外将该 `XmlAttributeValue` 作为引用返回，且其范围**包含外层引号**（`"com.app.myhook.MainActivity"`）；相对名（`.MainActivity`）则不会触发该 XML 命中。
   - 若直接追加无引号的当前属性范围，会产生“带引号 + 无引号”两条重复位置。生产实现统一在 `AndroidNavigationService` 中过滤 `reference.getContainingFile() instanceof XmlFile` 的命中，仅保留纯代码/KDoc 语义引用，再追加一次无引号当前属性范围。
3. **RocksDB 快照隔离下的在途 `didChange` 失效检测（`LSDocuments.getVersion`）**：
   - 字节码与实测确认：ILS `271.2085.0` 的 `server.withAnalysisContext` 运行在 `RetainedResource` 持有的独立 `AnalyzerContext` 快照上。在途请求执行期间，客户端发来的 `textDocument/didChange` 会通过 `Workspace.write` 更新 `TransientState` 中的 `DocumentsState.versionByFileUrl` 并创建新 `AnalysisContext`，但**在途旧快照内的 `Document.getModificationStamp()` 保持不变**。
   - 因此仅检查 `Document.getModificationStamp()` 无法感知在途 `didChange`。`AndroidSources.Scope` 通过 `MethodHandles` 调用 `LSDocuments` 的真实字节码方法 `getVersion-XfNk_NE(Ljava/lang/String;)Ljava/lang/Integer;`（Kotlin `URI` 内联类编译签名），在进入请求与提交结果前比对所有已访问打开文档的版本号及磁盘文件 `BasicFileAttributes`，在途编辑立即返回 `-32801 content_modified`。阶段 C/D/H 直接复用 `AndroidRequests.query` 与 `AndroidSources.Scope`。
4. **海量引用搜索的去重复杂度（避免 `CommonProcessors.UniqueProcessor<UsageInfo>`）**：
   - `UsageInfo.equals` 在哈希冲突或红黑树查找时每次均调用 `SmartPointerManager.getInstance(project)` 获取容器服务；单文件存在上万处引用（实测 18,000 字段）时，`UniqueProcessor<UsageInfo>` 会引起严重的容器锁竞争。
   - 生产实现不在 `UsageInfo` 层使用 `UniqueProcessor`，而是直接将命中的 `PsiElement` 转换为不可变的 LSP `Location(uri, range)` 后放入 `LinkedHashSet<Location>` 同步去重。
5. **`build.gradle.kts` Kotlin PSI 的尾随 Lambda 参数陷阱**：
   - `KtCallExpression.getValueArguments()` 会将括号外的尾随 Lambda（`KtLambdaArgument`）一并计入返回列表。例如 `sourceSets { getByName("main") { ... } }` 的 `getValueArguments().size()` 为 `2`（`"main"` 与尾随 Lambda），若判断 `size() == 1` 会导致 `getByName("main")` 识别失败、源集被误判为未知。
   - 解析函数圆括号内的实参时必须使用 `call.getValueArgumentList().getArguments()`，与 `call.getLambdaArguments()` 严格区分。
   - 此外，ILS `271.2085.0` 在 `build.gradle.kts` 未经客户端 `textDocument/didOpen` 打开时，默认源码快照**不会将其纳入 `VirtualFileManager` / `PsiManager` 的已索引 `KtFile`**（直接 `PsiManager.findFile` 返回 `null`）。生产实现（`AndroidSources.kotlinScript`）优先取已打开的内存 `PsiFile`，未打开时读取模块根目录下的 `build.gradle.kts` 文本（同步记录 `BasicFileAttributes` 快照）并通过 `new KtPsiFactory(project, false).createFile("build.gradle.kts", text)` 构造 `KtFile` AST。
6. **多命名空间前缀同指 `ANDROID_NS` 的属性查找**：
   - 当同一 XML 同时声明 `xmlns:android` 与自定义前缀 `xmlns:customandroid="http://schemas.android.com/apk/res/android"` 时，`XmlTag.getAttribute("name", ANDROID_NS)` 内部仅按 `getPrefixByNamespace` 取单个前缀匹配，会漏掉第二个前缀的属性。必须遍历 `tag.getAttributes()` 按 `ANDROID_NS.equals(attr.getNamespace()) && "name".equals(attr.getLocalName())` 识别（`AndroidXml.androidName`）。
7. **XML 外部实体零网络访问与 Windows CRLF 行尾归一化**：
   - `XmlAttribute.getDisplayValue()` 在含 `XmlEntityRef` 时可能触发实体解析；`AndroidXml.value` 先检查子元素是否含 `XmlEntityRef`，存在时走不解析外部 DTD 的安全分支（本地 HTTP DTD 探针实测请求数为 `0`）。
   - IntelliJ `Document` 内部始终使用 `\n`；比对内存 `PsiFile.getText()` 与磁盘文本以判断构建脚本或资源 XML 是否存在未保存修改时，磁盘文本必须先经 `StringUtil.convertLineSeparators` 归一化，否则 Windows CRLF 文件会被误判为“已修改未编译”。
8. **ILS `999.SNAPSHOT` 兼容构建号与 Windows `-Dplugin.path` 规范**：
   - ILS `271.2085.0` 运行时将 `idea.plugins.compatible.build` 设为 `999.SNAPSHOT`，若 `plugin.xml` 设置 `until-build="271.*"` 会被平台拒绝加载；因此 `plugin.xml` 仅写 `<idea-version since-build="271"/>`，精确版本锁（`build.txt === 271.2085.0`、classfile 69、SHA-256）由 `src/server/android-extension.ts` 强制执行。
   - Windows 下 `IJ_JAVA_OPTIONS` 中的路径若含反斜杠 `\` 会被参数解析器吞掉转义字符，必须统一转为 `/` 并支持合并已有逗号/分号分隔的 `-Dplugin.path`。
9. **ILS 271 自带 JBR25 工具链缺失 `jar` / `jdk.jartool`**：
   - 实测 ILS `271.2085.0` 自带的 `jbr/bin` 包含 `javac.exe`（`25.0.4.1`），但**未包含 `jar.exe` / `javap.exe`，且裁剪了 `jdk.jartool` 模块**。
   - 因此 `build.mjs` 编译固定优先使用发行包自带 `jbr/bin/javac --release 25`，归档优先探测 `jdk.jartool`，缺失时回退至 `JAVA_HOME` 或系统 PATH 中的 JDK 25 `jar` 工具；而 `check-assets.mjs` 采用纯 Node 直接解析无压缩 ZIP Local File Header 与 classfile 字节码头部（校验魔数 `0xCAFEBABE` 与 major `69`），使 `npm run prepack` / `check:assets` 完全不依赖外部 JDK 工具。


## 3. 官方实现参照与采用范围

固定 Android 源码基准：`JetBrains/android` 提交 `544c9ef84f8ee3024c1f9779725db34bf5dd38a6` 及 AOSP `platform/tools/base` 的 `lint-api` / `lint-checks`。

| 源码                                                                                                                                                                                                                                                                                                                                                                                                                                      | 采用内容                                                                                       |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| [AndroidResourcesFindUsagesHandlerFactory](https://github.com/JetBrains/android/blob/544c9ef84f8ee3024c1f9779725db34bf5dd38a6/android/src/org/jetbrains/android/AndroidResourcesFindUsagesHandlerFactory.kt)                                                                                                                                                                                                                              | 资源身份、按上下文缩小搜索范围；attr/styleable 需要额外字段搜索，文件资源另有补充路径          |
| [ResourceRepositoryToPsiResolver](https://github.com/JetBrains/android/blob/544c9ef84f8ee3024c1f9779725db34bf5dd38a6/android/src/com/android/tools/idea/res/psi/ResourceRepositoryToPsiResolver.kt)                                                                                                                                                                                                                                       | 声明来源、限定符和 useScope 组合；不把同名资源全局合并                                         |
| [ResourceStructureViewBuilder](https://github.com/JetBrains/android/blob/544c9ef84f8ee3024c1f9779725db34bf5dd38a6/android/src/org/jetbrains/android/dom/structure/resources/ResourceStructureViewBuilder.java)                                                                                                                                                                                                                            | 源码顺序、style/item、declare-styleable/attr 层级                                              |
| [PackageClassConverter](https://github.com/JetBrains/android/blob/544c9ef84f8ee3024c1f9779725db34bf5dd38a6/android/src/org/jetbrains/android/dom/converters/PackageClassConverter.java)                                                                                                                                                                                                                                                   | Manifest base package、模块依赖作用域、相对名和 `$` 内部类规范化                               |
| [ResourceFolderManager](https://github.com/JetBrains/android/blob/544c9ef84f8ee3024c1f9779725db34bf5dd38a6/android/src/org/jetbrains/android/facet/ResourceFolderManager.kt) / [ResourceFolderRegistry](https://github.com/JetBrains/android/blob/544c9ef84f8ee3024c1f9779725db34bf5dd38a6/android/src/com/android/tools/idea/res/ResourceFolderRegistry.kt)                                                                              | 变体资源根、覆盖优先级、工程根和文档变更失效                                                   |
| [ComposeSuppressor](https://github.com/JetBrains/android/blob/544c9ef84f8ee3024c1f9779725db34bf5dd38a6/compose-ide-plugin/src/com/android/tools/compose/ComposeSuppressor.kt)                                                                                                                                                                                                                                                             | 仅豁免语义确认的 Composable 标识符的特定命名检查                                               |
| [GradleAndroidModel](https://github.com/JetBrains/android/blob/544c9ef84f8ee3024c1f9779725db34bf5dd38a6/project-system-gradle/src/com/android/tools/idea/gradle/project/model/GradleAndroidModel.kt)                                                                                                                                                                                                                                      | `minSdkVersion`、`targetSdkVersion`、变体属性优先级与未构建保底规则                            |
| `DefaultUastParser` / `DefaultJavaEvaluator` / `JarFileIssueRegistry`（`tools.lint-api.jar`）                                                                                                                                                                                                                                                                                                                                             | 直接绑定 IntelliJ `Project`、VFS、`PsiManager`、`UastFacade` 与 AAR 自定义 `lint.jar` SPI 装载 |
| [AttachOnWaitForDebuggerMonitor](https://github.com/JetBrains/android/blob/544c9ef84f8ee3024c1f9779725db34bf5dd38a6/android/src/com/android/tools/idea/run/AttachOnWaitForDebuggerMonitor.kt)                                                                                                                                                                                                                                             | 以真实进程/JDWP 状态为依据，避免重复附加                                                       |
| [AndroidConnectDebugger](https://github.com/JetBrains/android/blob/544c9ef84f8ee3024c1f9779725db34bf5dd38a6/execution/common/src/com/android/tools/idea/execution/common/debug/utils/AndroidConnectDebugger.kt) / [StartJavaDebuggerSession](https://github.com/JetBrains/android/blob/544c9ef84f8ee3024c1f9779725db34bf5dd38a6/execution/common/src/com/android/tools/idea/execution/common/debug/impl/java/StartJavaDebuggerSession.kt) | 会话归属、调试器完成握手、分离和新建会话分别处理                                               |

采用机制，不复制 Studio 整套依赖。协程读操作遵循 [IntelliJ Coroutine Read Actions](https://plugins.jetbrains.com/docs/intellij/coroutine-read-actions.html)；协议遵循 [LSP 3.17](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/) 和 [DAP](https://microsoft.github.io/debug-adapter-protocol/specification)。

## 4. 架构与共享约定

### 4.0 原生优先梯次、能力发现门禁与 xd://lsp 映射

为最大化复用 IntelliJ LSP 原生能力并杜绝冗余自定义解析，系统严格实行三级梯次调用原则：

1. **第一梯次：原生 LSP 接口与 `xd://lsp` 14 项标准化动作优先**
   所有针对通用代码智能的请求，优先通过标准 LSP 方法与 `xd://lsp` 原生动作执行：

   | `xd://lsp` 动作   | 对应 LSP 方法 / 协议机制                                    | 语义与映射约束                                                                                                                                                  |
   | :---------------- | :---------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `diagnostics`     | 宿主诊断动作，支持文件、glob 或 `file: "*"`                 | 实际使用 pull、已有诊断还是宿主项目检查取决于适配器；不能把工具动作直接等同为 `workspace/diagnostic`。ILS 的 `workspaceDiagnostics: false` 不禁止多文件逐一拉取 |
   | `definition`      | `textDocument/definition`                                   | 代码符号声明跳转，优先于任何上层文本检索                                                                                                                        |
   | `references`      | `textDocument/references`                                   | 语义引用查询；受 `context.includeDeclaration` 控制                                                                                                              |
   | `hover`           | `textDocument/hover`                                        | 悬停文档、类型推断与签名提示                                                                                                                                    |
   | `symbols`         | `file` -> 文档符号；`file: "*"` + `query` -> 工作区符号搜索 | JSON-RPC 大纲结果为 DocumentSymbol[] 或 SymbolInformation[]；Flow 仅是 ILS 内部 Provider 类型。按真实客户端能力验收格式                                         |
   | `rename`          | `textDocument/rename`                                       | 跨文件安全重命名（默认直接应用，`apply: false` 预览）                                                                                                           |
   | `rename_file`     | `workspace/willRenameFiles`                                 | 文件重命名并同步重写项目所有引用与导入语句                                                                                                                      |
   | `code_actions`    | `textDocument/codeAction`                                   | 查询并应用 QuickFix（包括 ModCommand）                                                                                                                          |
   | `type_definition` | `textDocument/typeDefinition`                               | 跳转至类型定义位置                                                                                                                                              |
   | `implementation`  | `textDocument/implementation`                               | 跳转至接口实现或抽象重写位置                                                                                                                                    |
   | `status`          | 宿主管理的语言服务状态                                      | 区分 ready 与 configured/not started；不把它单独当作工程已导入、索引已完成或全部请求健康的证明                                                                  |
   | `reload`          | 宿主重载操作                                                | 指定文件重载相关服务；`file: "*"` 重载全部并重读配置；不是 LSP 标准 RPC，也不等于工程 workspace reload                                                          |
   | `capabilities`    | `initialize` 响应解析                                       | 检查服务端所声明的全部 capabilities 与扩展能力                                                                                                                  |
   | `request`         | 原始 JSON-RPC 请求通道                                      | 底层透传通道，`query` 为方法名，`payload` 为 JSON 参数字符串                                                                                                    |

2. **第二梯次：标准扩展方法与已广告 MCP 工具（经 `xd://lsp:request`）**
   - **标准扩展 LSP 方法**：通过 `request` 动作直接调用服务端已广告的标准扩展协议，如调用层次结构（`textDocument/prepareCallHierarchy`、`callHierarchy/incomingCalls`、`callHierarchy/outgoingCalls`）、类型层次结构（`textDocument/prepareTypeHierarchy`、`typeHierarchy/supertypes`、`typeHierarchy/subtypes`）、语义高亮（`textDocument/semanticTokens/full`）、代码格式化（`textDocument/formatting`、`textDocument/rangeFormatting`）等；
   - **已广告 MCP 工具发现与执行**：服务端广告 `list-mcp-tools` 与 `run-mcp-tool` 时，经 `request` 调用前者读取当前工具的 description/inputSchema，再按 `{"command":"run-mcp-tool","arguments":[{"tool":"工具名","arguments":{}}]}` 封装调用后者。22 项仅是本次观察数量，不固定为契约。已有能力无需在 Bridge 或客户端再复制成专用工具。

3. **第三梯次：独立 JVM 扩展补齐缺失的 Android 语义（阶段 A–D/H）**
   - 仅在第一、第二梯次经过实测证实存在明确语义缺口时，才由独立 JVM 扩展（`jvm/android-ls-extension/`）挂载：基于 IntelliJ 内部 XML PSI、K2 UAST 和已导入 Gradle 模块模型补齐 Android 语义；
   - 严禁倒退回在 TS 端自定义 XML 解析器（如 `saxes`）；严禁在未验证明确缺口前新增自定义 projectView 或工程树解析工具；
   - 尊重已验证的 XML PSI 与 JVM 回退设计，保持 A–H 既定交付边界。

### 4.1 模块分工

| 文件/模块                                                        | 职责                                                                                                                                                           |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `jvm/android-ls-extension/` 的工程上下文                         | 从当前 Project 的模块、SDK、依赖和源码取得 Android 上下文，供导航、引用与 Lint 共用                                                                            |
| JVM XML 大纲 Provider                                            | 基于当前 XML PSI 实现阶段 A，注册到既有 `"xml"` 语言                                                                                                           |
| JVM definition/references Provider 与查询服务                    | 识别 Manifest 类属性、资源声明和代码 R 引用，解析目标、校验来源、执行语义搜索                                                                                  |
| 同一 JVM 模块的 Compose suppressor、`OmpLintDiagnosticProvider`  | 阶段 D/H，保持现有范围                                                                                                                                         |
| `src/shared/document-symbols.ts`、`src/bridge.ts`                | 通用文档/请求生命周期及客户端不支持层级符号时的 DFS 展平；已删除 `navigation-relay.ts` 的 Android 拦截，不解析 XML，不推导 Android 身份                        |
| 旧 `src/android/xml.ts`、`navigation.ts`、`resource-resolver.ts` | 已迁移至 JVM 并连同 `types.ts`、旧测试和 `saxes` 依赖一并删除                                                                                                  |
| `src/android/debug-attach.ts`、`debug-attach-cli.ts`             | ADB 设备、PID、forward 和租约管理，仍放在 TS                                                                                                                   |
| `src/debug/dap-proxy.ts`                                         | 超时单位、异步 attach/关闭钩子和物理栈帧透传，不导入 ADB 业务                                                                                                  |
| `src/plugin.ts`、发布配置、服务启动层                            | 精确版本的 JAR 资产、runtime hash 与加载参数                                                                                                                   |

修改导出接口前查询 references，迁移所有调用方，不保留旧签名或探针兼容路径。迁移包含已有 definition，不只新增 A/B 后继续保留两套解析逻辑。

### 4.2 工程上下文与缺失信息

- 在请求的 `server.withAnalysisContext` 中访问 Project、ModuleManager、ProjectFileIndex 和库表，不从全局任取第一个工程。直接消费 AndroidProjectModelBuilder 的导入结果，不在查询时重新导入、调用 Gradle 或经 TS 重建模型。
- 使用精确模块、contentRoot、依赖和已确认变体；同一 `externalProjectId` 下可有多个生产/测试模块，不能只按 `:app` 选择。
- `android.jar`、AAR 和 R.jar 的模型路径分别验证物理存在与可见范围；不存在的 R.jar 不能作为字段已解析的证据。
- 导入模型未提供的 namespace、Manifest 和资源根需要单独证明。从变体模块 `contentRoots` 向上定位唯一包含 `build.gradle.kts` / `build.gradle` 的模块根目录（或回退 `ExternalSystemApiUtil.getExternalProjectPath`），通过已打开 PSI 或 `KtPsiFactory` 构造的 `KtFile` 提取确定字面量；变量、外部脚本、动态 DSL、flavor 覆盖和无法确认源集的 `res.srcDirs` 不能按默认目录补猜。模型不足时，结构查询不接管；已识别的语义查询返回具体错误。
- 迁移保留现有资源来源和覆盖校验。需要 merger/符号产物的查询仍检查快照；使用 PSI 不等于解除所有构建依赖。大纲和能够确认目标的 Manifest 类查询不应被 R.jar 缺失阻断。

### 4.3 路由与结果

- A/B/C 通过标准 LSP Provider 输出；definition 同时迁移现有资源和 Manifest 跳转。阶段 C 的显式字段命令保留，直接调用同一 JVM 查询服务，不作为 XML 标准请求的二次 RPC。
- 非 Android 文件和未支持节点不输出扩展结果，保留原生 Provider 行为。原生 Provider 按上游规则聚合；不再在 Bridge 收到空结果后补做 Android 查询。重复位置在查询服务内去重，升级时验收与原生结果并存的情况。
- 支持节点的查询失败返回 RequestFailed；合法零引用返回 `[]`，不把解析失败混入空结果。实测证实追加 `LSDefinitionProvider` 为并集聚合、不会抑制原生 `R.jar` 字节码目标；生产采用平台 `<directNavigationProvider>`（`AndroidResourceNavigation`）替换 `R` 字段的 `getNavigationElement()` 实现源码优先，并在 AGP 来源缺失或失效时返回 `null` 回退原生 `R.jar`，XML 内部 `@string/...` 与 Manifest 类属性则由 XML `LSDefinitionProvider` 处理。
- references 使用请求中的 `context.includeDeclaration`；大纲能力及平面结果适配见 §5.3。诊断继续由原生 `LSDiagnostic` 聚合，Bridge 不改写诊断流。
- 使用同一次会话已同步的文档和 PSI。失同步时不回读旧磁盘文本；不另开连接查询，不在读操作中自行补调 `commitDocument`。
- 扩展加载与精确版本不匹配在启动/状态层明确报告。未加载 Provider 时，原生 XML 可能仍返回空结果，不能承诺由不存在的 Provider 返回逐请求错误，也不能静默恢复旧 TS 解析路径。

### 4.4 取消、版本和错误

1. **Bridge 取消、ID 与版本一致性**：严格关联客户端 JSON-RPC `id`；区分带 ID 的 `$/` 请求（Request，必须匹配客户端 ID 并返回响应）与单向 `$/` 通知（Notification，单向且无 id，如 `$/cancelRequest`）；追踪 `TextDocumentItem.version` 并在内容变更时失效过期请求。严禁用简单的 `AbortController` 粗暴替代标准的 LSP 请求生命周期与取消协议。
2. **原生分析上下文与取消传播**：使用原生 Provider 的分析上下文、读操作和取消机制，不为 A/B/C 建 Bridge 父子 RPC 链。确有内部 RPC 的通用路径仍须关联客户端 ID、取消子请求并吞掉内部迟到响应。
3. **协程读操作与写重试**：在平台 suspend `readAction` 中访问 PSI，循环检查取消；写操作引起重试时每次独立收集结果。读锁外不保存 PSI、KaSession 或引用对象；Project 不跨请求缓存。
4. **快照一致性与复核**：由于 ILS 271 的 `withAnalysisContext` 基于独立 RocksDB 快照，单次读操作内的 `Document.getModificationStamp()` 不会随并发 `didChange` 改变；必须在进入请求和返回前同时复核 `LSDocuments.getVersion-XfNk_NE(uri)`（已打开文档版本号）与磁盘文件 `BasicFileAttributes`（`AndroidSources.Scope`）。修改、重载、断连或取消后立即返回 `-32801` / `-32800`，不提交旧结果、不回填失效缓存。
5. **并发与错误保留**：不在 Bridge 的串行 `fromClient` 中等待业务查询。每个请求只响应一次；保留原生错误，不用 catch-all 隐藏取消和平台错误。
6. **URI 与范围规范化**：URI 按规范本地路径比较和去重，保留 jar entry 身份。引用范围由真实 `PsiReference` 和当前 Document 换算，不缩成最后一个标识符。

| 条件                                  | 外部结果                                                              |
| ------------------------------------- | --------------------------------------------------------------------- |
| 查询成功，无引用                      | `result: []`                                                          |
| 资源查询缺少/过期构建来源             | `-32803`，`missing_snapshot` / `stale_snapshot`                       |
| 模块、变体、目标或来源歧义            | `-32803`，具体 reason 和已核实候选                                    |
| 已识别声明找不到类/字段或目标不可解析 | `-32803`，`class_not_found` / `field_not_found` / `target_unresolved` |
| 显式命令协议不匹配                    | `-32803 protocol_mismatch`；非法参数用 `-32602`                       |
| 文档改变                              | `-32801 Content modified`                                             |
| 客户端取消                            | `-32800 Request cancelled`                                            |
| 查询到期                              | `-32803 timeout`，结束相关工作                                        |
| 不支持的文件/节点                     | 扩展不输出结果，沿用原生处理                                          |

## 5. A：Android XML DocumentSymbol

### 5.1 文件识别和解析

- 在 JVM 确认文件角色：Manifest 属于已确认 Android 源集且根为 manifest；values XML 位于已证明的资源根下、目录限定符合法且根为 resources。
- 复用 §4.2 的工程上下文。自定义根须有模型或来源证据，不递归扫描任意 XML；身份无法确认时 Provider 不输出结果。符号生成不要求 R.jar。
- 使用当前 `XmlFile`、`XmlTag`、`XmlAttributeValue`，不新增 TS 解析器，也不复制 Studio 资源仓库。实体处理沿用平台安全设置，不启用外部实体读取。
- 对含 `PsiErrorElement` 的文档，只输出名称和范围仍有效的节点；不把不完整节点用于类/资源身份解析，未加引号或未闭合属性值不生成符号。
- selectionRange 使用名称属性的原始值范围；range 覆盖元素，selectionRange 必须位于其中。通过当前 Document 换算行列，不用实体解码后的字符串长度计算。

### 5.2 符号树规则

| 节点                                        | name                        | kind                     | 层级/说明                             |
| ------------------------------------------- | --------------------------- | ------------------------ | ------------------------------------- |
| string                                      | 资源名                      | String(15)               | values 顶层                           |
| color、dimen                                | 资源名                      | Constant(14)             | detail 保留实际类型                   |
| bool / integer                              | 资源名                      | Boolean(17) / Number(16) | 不根据内容猜类型                      |
| array、string-array、integer-array、plurals | 资源名                      | Array(18)                | 不为匿名 item 虚构资源名              |
| style                                       | 资源名                      | Class(5)                 | 有名称的 item 为 Property(7) 子节点   |
| declare-styleable                           | 资源名                      | Interface(11)            | attr 为 Property(7) 子节点            |
| attr                                        | 资源名                      | Property(7)              | 独立或位于 declare-styleable          |
| id                                          | 资源名                      | Variable(13)             | 包括相应 item 声明                    |
| `item type=T name=N`                        | N                           | T 对应 kind              | 仅识别实际资源声明                    |
| manifest                                    | package 或 manifest         | Namespace(3)             | application、instrumentation 的父节点 |
| application                                 | android:name 或 application | Module(2)                | 组件父节点                            |
| activity/service/provider/receiver          | android:name 原文           | Class(5)                 | 必须位于 application 下               |
| activity-alias                              | android:name 原文           | Interface(11)            | name 为别名标识符                     |
| instrumentation                             | android:name 原文           | Class(5)                 | 位于 manifest 根下                    |

values 的 resources 容器不虚构为资源符号。匿名 Manifest 容器的 selectionRange 使用标签名；具名节点使用名称属性。保持源码顺序，未知节点、注释及缺名资源跳过。

### 5.3 能力与验收

- 通过 `LanguageServerExtension` 的 `LSConfigurationPiece.entries` 注册 `LSDocumentSymbolProviderPsiBase`，使用 `LSDocumentSymbolCustomizer` 遍历 PSI；复用基类的分析上下文与读操作。`languages` 列表传空，不重复注册 `"xml"`。
- 271 的 Provider 返回 `Flow<DocumentSymbol>`，上游不会按客户端能力自动展平。Bridge 读取实际 initialize 能力：支持层级则透传，否则仅将结果 DFS 转为带 uri/containerName 的 SymbolInformation[]，不解析 XML。
- 安装后读取真实客户端能力，不硬编码所有 OMP 客户端都支持层级。只接入 documentSymbol，不声明 XML workspace/symbol。
- 验收 MyHook strings.xml、Manifest 的正式名称、SymbolKind、range 与 selectionRange；覆盖未保存改名、CRLF、emoji、实体、单引号、多行属性、错误 XML 和非 Android XML。探针中的统一 Class 类型及整标签 selectionRange 不进入生产。
- 单独验收不支持层级的客户端、Provider 加载失败和多 Provider 并存；Java/Kotlin 原生大纲不变。

## 6. B：Manifest 类属性 references

### 6.1 支持的节点

- application/activity/service/provider/receiver 的 android:name，根 instrumentation 的 android:name，以及 activity-alias 的 android:targetActivity。
- 校验 Android namespace URI 和 DOM 层级；activity-alias 的 android:name 仅为结构符号，不当作类。
- permission/action/category、未解析 `${...}` 属性不接管。

### 6.2 目标和结果

1. 在 JVM 当前 XML PSI 中取得属性、namespace 与原始范围，使用 §4.2 的已导入模块上下文；definition 与 references 共用类目标解析服务。
2. base package 来自已确认 Manifest/模块信息；不把 applicationId 后缀当 namespace，不正则解析 build.gradle。动态 DSL 或缺少 namespace 时不能猜包名。
3. 按 PackageClassConverter 的相对名候选和 `$` 到 `.` 规则规范化，在当前模块依赖作用域内验证完整类身份。使用 Java/Kotlin PSI 解析服务定位唯一声明，不按 simpleName 取第一项；未消歧返回 `ambiguous_target`。
4. 通过 XML `LSReferencesProvider` 调用共享语义搜索服务（`FindUsagesManager`），直接查询目标类，原样处理 `includeDeclaration` 并保留 KDoc 链接；不转成 Bridge 发起的源码 references 子请求。
5. 过滤掉平台对完整 FQN 属性产生的带引号 `XmlFile` 命中，仅保留代码语义引用，再追加一次无引号的当前 XML 属性位置并以 `LinkedHashSet<Location>` 去重（不使用高开销的 `UniqueProcessor<UsageInfo>`）。`false` 包含当前属性但不含类声明；`true` 另含真实类声明。不得拿不精确的符号容器范围制造声明位置。
6. 不扫描全仓 Manifest/XML，不把结果描述成完整跨 XML Find Usages。库字节码无可解析目标时返回 `target_unresolved`，不当作合法零引用。

§2.3 的 263 历史基线加当前 XML 属性后，MainActivity false/true 为 3/4、HookLogProvider 为 2/3、McpForegroundService 为 9/10。271 按同一身份和范围核对实际位置集合，不把版本差异直接判为回归。

### 6.3 验收

逐项核对三个组件；覆盖相对名、完整名、内部类、同名不同包、依赖模块、别名目标、placeholder 和 namespace 前缀变换。验证 false/true、当前属性去重、取消和编辑失效；同一类的 XML definition 与 references 入口必须解析到相同目标。

## 7. C：资源 XML 声明到代码 references

### 7.1 身份与快照

- 在当前 XML PSI 中识别声明；逻辑身份包含 namespace、resource type、原始名称，字段查询另含精确模块/变体、编译来源和实际 R 字段名。
- 需要构建来源的资源查询继续检查 AGP 来源/merger，证明声明属于当前选定构建。缺少真实 R 字段或快照时报错，不因库表列出路径就跳过校验。
- 分别保留声明来源、可见编译字段和最终覆盖来源。限定符声明共享逻辑身份，返回声明仍以当前 XML 位置为准。
- 复用 §4.2 的模块上下文。多个变体同样匹配且无唯一证据时返回 `ambiguous_variant`，不默认 debug。
- 类型/名称转换与真实字段及可用符号清单核对；点号 style、array 等名称不靠字符串猜测。标准 references Provider 和显式字段命令调用同一服务。
- 未保存 XML 声明改名使旧构建快照失效；只编辑 Java/Kotlin 使用点时，在同会话当前 PSI 上查询。

### 7.2 显式字段查询命令

保留 `omp.findResourceFieldReferences` 作为已知字段的显式查询入口；它不负责从 URI 识别 XML，也不要求 Bridge 持有 XML 身份。标准 XML references Provider 在 JVM 内调用同一查询服务，不绕行 executeCommand。下列协议 v1 的字段结构保留，探针固定默认值、delayMs 和手工 JSON 删除。

```json
{
  "protocolVersion": 1,
  "moduleName": "MyHook.app.debug",
  "namespace": "com.app.myhook",
  "type": "string",
  "name": "nav_settings",
  "classOrigins": [
    "file:///F:/source/MyHook/app/build/intermediates/compile_and_runtime_r_class_jar/debug/processDebugResources/R.jar",
    "file:///F:/source/MyHook/app/build/intermediates/compile_app_classes_jar/debug/bundleDebugClassesToCompileJar/classes.jar"
  ]
}
```

type/name 是已核对的 R 类型和字段名。classOrigins 是调用方提供、服务端根据已导入模型与 AGP 来源复核的物理编译产物集合，只包含本次资源 owner/变体；标准 XML Provider 自行在 JVM 构造相同查询上下文。值为规范 file URI，不能把所有依赖 jar 都放入。参数缺失、非法类型用 `-32602 Invalid params`，协议版本不匹配用 `-32803 protocol_mismatch`；不能回退到第一个模块/allScope。

成功响应采用结构化序列化：

```json
{
  "protocolVersion": 1,
  "fieldResolved": true,
  "references": [],
  "origin": {
    "moduleName": "MyHook.app.debug",
    "namespace": "com.app.myhook",
    "classOrigins": [
      "file:///F:/source/MyHook/app/build/intermediates/compile_and_runtime_r_class_jar/debug/processDebugResources/R.jar"
    ]
  }
}
```

references 为标准 Location[]；origin.classOrigins 记录实际参与查询的物理类来源，服务端确认它们属于本次 owner/快照。`references: []` 表示字段已解析但零引用；nav_settings 的 263 基线为三处。失败返回 JSON-RPC error，不保留 status + 空数组失败格式。未知命令的历史原生响应为 `-32600`；显式调用前检查命令广告，保留实际原生错误。

### 7.3 服务端执行

1. XML references 注册 `LSReferencesProvider`；显式命令由 `LSCommandDescriptorProvider` 注册，构造器顺序为 `LSCommandDescriptor(title, name, executor)`。两入口调用同一查询服务，不互相发送 RPC。
2. 由 `server.withAnalysisContext` 获取本次 `ctx.project`，在读操作内取得当前 XML PSI、模块和查询身份；不在进入上下文前访问 VFS，不静态缓存 Project/PsiField，不使用 ProjectManager 第一个工程。
3. 先确定资源 owner 模块及下游消费模块。类定位使用这些模块的 dependencies-and-libraries scope；用 `JavaPsiFacade.findClasses` 枚举，而非把 projectScope 用于查编译库。
4. 按请求证明的 classOrigins 过滤物理 archive/entry，区分同 owner 的编译副本与独立同 FQN 库。对同 owner 且当前可见的字段副本逐一做语义搜索并去重；独立库不因名称相同而合并。候选多于一个本身不等于冲突，归属无法证明时报告 `ambiguous_target`，关键候选查询失败不返回部分集合。
5. 本地资源的源码范围采用 ownerModule.getModuleWithDependentsScope() 与 projectScope 的交集，保留真实 PSI 身份判定。此范围收缩是保守设计，不是已复现的原生搜索 bug；新增直接命令验收须确认不遗漏传递消费方。纯 binary 库 owner 必须来自模型，缺失则报告 `owner_unresolved`，不能任取调用方。
6. 使用平台 suspend `readAction`，循环内每步调用 `ProgressManager.checkCanceled()`；不在普通 `ReadAction.compute` 中阻塞长搜索，不吞 CancellationException/ProcessCanceledException。Java 实现直接将原生 Continuation 传给挂起 API 并返回其结果，不用普通 finally 跨挂起点模拟生命周期。
7. 读操作可能被写操作取消后重试；每次尝试内部收集结果，结束后才返回纯 Location 数据，避免重试重复追加。
8. `element.textRange.startOffset + reference.rangeInElement` 计算真实范围；在读操作内取当前 Document 的行列。读锁外不保存 PSI 对象。

### 7.4 支持范围与 includeDeclaration

| 范围                                                                 | 生产计划                                                                               |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| string                                                               | 已有字段搜索、身份和取消探针；接入标准 XML 请求                                        |
| color/dimen/bool/integer/array/plurals/id/style 等普通 values 声明   | 按真实符号清单映射 R 字段，逐类型验收                                                  |
| drawable/mipmap/layout/anim/animator/raw/xml 等文件资源              | 保留独立文件资源处理，按现有来源映射和真实字段逐类型验收；不把文件任意位置当成资源名称 |
| declare-styleable/attr 派生字段、`@+id` 的跨布局声明                 | 官方另有扩展搜索路径，本次不冒充已实现；保留原生行为并在支持说明列明                   |
| Android 框架、AAR 外部 XML 声明、未解析 placeholder、XML 到 XML 搜索 | 不由本阶段接管                                                                         |

DocumentSymbol 的结构支持与 references 的字段搜索支持分别声明。false 只返回约定范围内的 Java/Kotlin 语义引用，不返回 R 字段声明；true 在此基础上增加当前查询 XML 声明，不加入所有限定符声明或字节码字段。

### 7.5 验收

- MyHook nav_settings 的三个位置；app_name false 为 `[]`、true 仅当前声明。
- 同 namespace 独立模块、不同 namespace 同名资源、相同 owner 的 R 副本、传递依赖及当前变体隔离。
- Kotlin 别名/wildcard、Java static import/限定调用、同名局部变量、URI 编码去重。
- 缺失/过期来源、资源覆盖、多限定符、未保存使用点及声明改名。
- 真实搜索遍历中途取消验收：不在生产代码中保留任何 `delayMs` 睡眠后门；在集成测试沙箱中通过 LSP `didOpen` 动态注入 50–100 个含多处 `R.string.nav_settings` 引用的内存 Kotlin 文件以拉长真实 PSI 搜索耗时，在 20–50ms 处发送 `$/cancelRequest`，确认服务端通过 `ProgressManager.checkCanceled()` 立即退出并返回 `-32800`、无迟到成功响应、并发与后续查询正常。

## 8. D：Compose 命名检查适配

### 8.1 已确定入口和规则

- 使用同一独立 JVM 模块中的无状态 `InspectionSuppressor`；不挂载整个 Android/Compose 插件。
- toolId 仅 `FunctionName` / `TestFunctionName`，元素必须是 Kotlin 的函数名称 IDENTIFIER，父节点为 KtNamedFunction。
- 在 K2 分析会话中解析注解构造符号，核对 `KaConstructorSymbol.containingClassId` 精确等于 `androidx.compose.runtime.Composable`。
- 探针使用 resolveSymbol，空值时 resolveToCall；已验证该组合的正反行为，未对成功分支分别打标。生产保留空值语义解析路径，不捕获 Throwable 来掩盖取消或链接问题。
- 不做注解短名后缀过滤；真实别名应生效，同名伪注解必须保留命名检查。
- getSuppressActions 返回空，不新增 UI 抑制动作；Bridge 不删除诊断。

### 8.2 注册与生命周期

- ILS `263.7084.0` 中仅 builder 注册 inspectionSuppressor 返回成功，但检查不调用它；因此不采用 EP-only 方案。
- 在 `WorkspaceComponent.registerInApplicationContainer` 中，调用 `LanguageInspectionSuppressors.INSTANCE.addExplicitExtension`。以插件 classloader/服务端生命周期单次注册。
- 生产使用同步 once：持锁检查 registered，执行 add，成功后置 true。避免探针 CAS 提前置位的失败/并发窗口。
- 实测 79 次分析上下文构建只 add 一次。suppressor 不持有 Project、PSI、KaSession 或文档缓存；不在每次诊断/每个工程重复注册。
- 插件 XML 依赖 `com.intellij.modules.platform` 和 `org.jetbrains.ls.plugin.kotlin`；缺少后者时已实际遇到 KotlinLanguage 类加载失败。
- 升级用安全的进程 stop/start，不做运行中替换和新旧 suppressor 并存。

### 8.3 已通过的矩阵与生产验收

真实 Composable、真实 import alias、真实全限定注解的 FunctionName 消失；普通大写函数、伪注解别名、直接短名伪 `@Composable` 保留 FunctionName；RETURN_TYPE_MISMATCH 保留。重复诊断结果稳定。

生产包重跑上述七项，另覆盖 TestFunctionName、解析不完整文档、搜索/诊断取消、多工程及注册失败后再尝试。检查门控失败返回“不豁免”，平台取消和错误不能吞掉。

## 9. E：Android Java/JDWP Attach 编排

### 9.1 实际工具边界

`xd://debug` 提供宿主机 pid、host、port、以秒计的 timeout，没有 deviceId/packageName 参数。DAP 本身允许扩展 arguments，当前工具入口和本项目 attach 解析链尚未提供 Android selectors。

采用两阶段：独立 prepare 返回现有 debug attach 参数，原生工具执行 attach，生命周期清理本次 forward。交付不声称原生工具已新增 Android 参数。

### 9.2 拟新增命令和输入输出

实现后的 CLI 示例：

```sh
node dist/android/debug-attach-cli.js prepare --package com.app.myhook --device emulator-5554 --timeout-ms 10000
node dist/android/debug-attach-cli.js cleanup --key <prepare返回的cleanupKey>
```

1. **参数规则**：
   - `packageName` 与正整数 `pid` 二选一；`deviceId` 可省略，但仅允许恰好一台 online 且已授权设备。
   - `packageName` 对应多个可调试进程时返回候选 PID/名称列表，要求显式传入 `pid`；不默认截取第一个。
   - 超时控制：支持 `--timeout-ms <毫秒>` 与 `--timeout <秒>`（内部转为毫秒）。
2. **输入输出与退出码契约**：
   - stdout **仅输出单行结构化 JSON**，诊断/调试日志输出至 stderr。
   - 退出码契约：
     - `prepare`：成功返回 `0`；设备/进程/端口/超时等任意阶段失败返回 `1`，参数非法返回 `2`；
     - `cleanup`（**严格幂等**）：指定 `cleanupKey` 的租约存在时，执行 `adb forward --remove` 并删除租约，返回 `0`（`{ success: true, cleaned: true }`）；若租约已不存在（已由 DAP 代理回收或重复调用），**同样返回 `0`**（`{ success: true, cleaned: false, reason: "already_cleaned" }`）；仅在参数缺失或非法时返回非零。
   - `prepare` 成功输出结构：

     ```json
     {
       "success": true,
       "cleanupKey": "uuid-v4",
       "deviceId": "emulator-5554",
       "pid": 4628,
       "processName": "com.app.myhook",
       "host": "127.0.0.1",
       "port": 50558,
       "jdwpTarget": "jdwp:4628",
       "debug": {
         "action": "attach",
         "adapter": "intellij",
         "host": "127.0.0.1",
         "port": 50558,
         "timeout": 10
       }
     }
     ```

### 9.3 状态判定、进程匹配与错误码全集

1. **ADB 解析顺序**：
   - 独立模块按 `--adb` 显式路径、`ANDROID_HOME/platform-tools`、`ANDROID_SDK_ROOT/platform-tools`、`PATH` 顺序解析，使用实测可执行文件调用。
2. **设备状态判定依据**：
   - 解析 `adb devices -l` 输出行，依据第二列严格区分：`device`（就绪在线）、`unauthorized`（未授权）、`offline`（离线）；不依赖易产生单点失效的 `adb get-state`。
3. **进程匹配依据**：
   - 优先执行 `adb -s <serial> shell ps -A -o PID,PPID,NAME`（Toybox 标准列格式：第 0 列 PID、第 1 列 PPID、第 2 列进程名）；
   - 若低版本设备不支持 `-o` 参数，回退至 `adb -s <serial> shell ps -A`，按首行表头动态解析 `PID` 与 `NAME`/`CMD` 列索引；
   - 进程名匹配：在宿主机进行全词比对 `NAME === targetPackage` 或子进程前缀比对 `NAME.startsWith(targetPackage + ":")`。
   - 核对目标 PID 存在于 `adb -s <serial> jdwp` 输出集合中；不向 forward 端口发送独立预检 JDWP 探针，防止单次握手通道被消费。
4. **错误码全集（4 大类 13 项）**：

| 类别     | 错误码 (`error.code`)       | 说明与恢复建议                                          |
| -------- | --------------------------- | ------------------------------------------------------- |
| **环境** | `adb_not_found`             | 未找到 ADB 可执行文件；检查 ANDROID_HOME 或指定 `--adb` |
|          | `no_device`                 | 未发现已连接设备                                        |
|          | `ambiguous_device`          | 存在多台已连接设备但未指定 `--device`                   |
|          | `unauthorized_device`       | 设备未在屏幕上接受 USB 调试授权                         |
|          | `device_offline`            | 设备处于 offline 状态                                   |
| **目标** | `process_not_found`         | 指定包名无运行中进程，或目标未启用 debuggable           |
|          | `ambiguous_process`         | 目标包名存在多个运行进程，需显式指定 `--pid`            |
|          | `not_jdwp`                  | 进程存在但不在 `adb jdwp` 列表中（未开启调试支持）      |
|          | `target_changed`            | 在准备与建立期间目标 PID/进程名发生变动                 |
| **租约** | `forward_failed`            | `adb forward tcp:0 jdwp:<pid>` 执行失败或退出码非 0     |
|          | `lease_conflict`            | 目标进程在当前设备上已存在活动且未过期的租约            |
|          | `lease_not_found`           | 指定的 cleanupKey 格式非法或未记录                      |
| **协议** | `attach_failed` / `timeout` | 后续 DAP 阶段握手失败或超时                             |

### 9.4 租约落盘契约与 DAP Proxy Finalizer 组合

1. **落盘位置与原子写入**：
   - 复用 `src/project/metadata.ts` 与 `settings.systemPath` 约定，统一存放在：

     ```text
     <settings.systemPath>/plugin-metadata/android-attach/<cleanupKey>.json
     ```
   - 采用 `writeAtomicJson`（写入 `${cleanupKey}.${randomUUID()}.tmp` 后原子 `rename`）。
   - 租约结构：

     ```ts
     export interface AndroidAttachLease {
       cleanupKey: string;
       createdAt: number;
       ownerPid: number;
       ownerStartTime: number;
       deviceId: string;
       targetPid: number;
       targetPackage: string;
       localPort: number;
       jdwpTarget: string;
       state: 'prepared' | 'attached';
     }
     ```

2. **PID 复用与孤儿租约清理**：
   - 每次 `prepare` 或 `cleanup` 时扫描该目录：
     - **热路径快速判定**：调用 Node.js `process.kill(ownerPid, 0)`（耗时 <0.1ms）；若抛出 `ESRCH`，说明创建者进程已消亡，判定为孤儿租约；
     - **冷路径防复用**：若 `process.kill` 返回存活但怀疑 PID 被系统回收，调用 `getProcessInfo(ownerPid)` 比对 `startTime === ownerStartTime`；
     - 对确认孤儿的租约，自动执行 `adb -s <deviceId> forward --remove tcp:<localPort>` 并删除租约文件。
3. **DAP Proxy 窄钩子解耦（`beforeAttach` 与 `onFinalize`）**：
   - `DapProxyOptions` 仅增加两个可选异步钩子，通用代理绝不导入或直接执行 ADB：
     - `beforeAttach?: (target: { host: string; port: number }) => Promise<void>`：当收到 DAP `attach` 请求且 `host` 为回环地址时，原子检索并认领 `localPort === target.port` 且 `state === 'prepared'` 的租约，将其状态置为 `attached` 并记录清理上下文；普通 JVM attach 端口无匹配租约时直接跳过；
     - `onFinalize?: () => Promise<void> | void`：挂载进入 DAP proxy 既有的幂等 `shutdown` promise，在正常 detach、attach 失败、超时、EOF 或 SIGTERM 时执行 `adb forward --remove` 与租约删除。
   - 退出语义：DAP `disconnect` 保持 `terminateDebuggee: false`，绝不向设备发送 `am force-stop`，保持应用存活。
   - 栈帧透传：`dap-proxy` 对 `stackTrace` 响应原样透传（仅经 `normalizeSourcePaths` 路径规范化），不删减、不伪造折叠栈帧，确保 `stackFrame.id`、局部变量作用域与求值句柄完全准确。

### 9.5 超时规范与实测契约

1. **超时归一化契约（受 `test/dap-proxy.test.ts:615` 保护）**：
   - IntelliJ 后端 DAP 的 `intellij_jvm` attach 请求严格要求**毫秒（ms）**，默认值 `30000`（30 秒）。
   - OMP 原生 `xd://debug` 工具 schema 参数单位为**秒**（如 `timeout: 60`）。
   - `dap-proxy.ts` 保持既有归一化规则：`args.timeout <= 300 ? Math.round(args.timeout * 1000) : Math.round(args.timeout)`；此契约受现有回归测试锁定，保证外部传入秒级或毫秒级均能安全映射至后端的毫秒参数。
   - `debug-attach-cli` 内部对 ADB 轮询与进程发现采用显式毫秒超时（`--timeout-ms`）。
2. **验收场景**：
   - 运行中普通进程（PID 4628）与 `am start -D` 等待进程均通过原生 debug 工具命中断点、读取变量、单步、detach 后应用存活。
   - 负例覆盖：ADB 未安装、设备离线/未授权、目标退出/重启、多进程未加 PID、端口被占冲突、DAP proxy 被强制终止后的孤儿回收。

## 10. F：断连恢复和健壮性

### 10.1 分层与采用语义

| 故障层                         | 处理                                                                 |
| ------------------------------ | -------------------------------------------------------------------- |
| OMP 未发现 LSP/插件安装链      | 查本地 marketplace、生成配置和 fileTypes；不重启健康服务             |
| Bridge/socket 结束，服务端健康 | 结束旧请求，释放本连接租约；新客户端重新初始化                       |
| 已验证拥有的服务进程退出       | 现有生命周期锁/owner 检查清理旧状态，新客户端启动新服务              |
| 服务端存活但无响应/索引停滞    | 截止时间失败并报告阶段；不盲目 kill/restart                          |
| DAP 结束                       | 清理本次会话及 forward；新会话重新配置断点/线程，不继续旧 session ID |

现有恢复行为已有实际正例，暂不新增心跳、无限重连或跨会话状态重放。LSP 新会话重新 initialize、导入及同步当前文档；客户端负责重新发送所需文档。

### 10.2 生产验收

既有实验已覆盖双工程隔离、关闭一个连接不影响另一个、服务进程退出及新 Bridge 启动后真实 definition。新增路径还需覆盖初始化、索引等待、JVM 导航/引用搜索、显式资源命令和暂停 DAP 时断连，核对请求、forward 与租约释放。

安装缓存中的 OMP 原生客户端须完成新会话真实查询。若 OMP 管理器未重建已退出客户端，定位并报告该层证据；Bridge 不假装透明恢复。

## 11. G：QuickFix 处理决定

RenameFix 曾出现的丢失现象已查明根因并解决：服务端在转换包含剪贴板或重命名等交互指令的 `ModCommand` 时，若客户端未在 `initializationOptions` 声明 `intellijExtensions: true` 与 `lazyIntentions: true`，服务端会将该指令整体置为 `null` 导致整条修复被丢弃。

现已在 `src/bridge.ts` 与 `.omp-plugin/marketplace.json` 默认开启上述选项，实测 `Rename` QuickFix 正常生成，执行 `applyModCommand` 时服务端正常下发 `intellij/runEditorCommand {"command": "editor.action.rename"}`。不新增针对特定 Java 类名的 Bridge 黑名单或过滤代码。

## 12. 独立 JVM 模块、打包和版本

### 12.1 构建与内容

- 独立目录 `jvm/android-ls-extension/`，以当前 ILS 发行包作为 compileOnly SDK。Java 25 / classfile 69，与实测服务端运行时一致。
- 自有 JAR（`android-ls-extension.jar`）只含自有类、`META-INF/plugin.xml`、SPI services（`META-INF/services/com.jetbrains.ls.api.features.LanguageServerExtension`）和版本元数据；不 shade ILS、Kotlin、协程或 Android Studio 的二进制。
- `plugin.xml` 声明 `org.jetbrains.ls.core`、`com.intellij.modules.platform`、`com.intellij.modules.java`、`org.jetbrains.ls.plugin.kotlin`、`org.jetbrains.ls.feature.xml` 及 `<directNavigationProvider implementation="org.omp.intellij.android.AndroidResourceNavigation"/>`；`<idea-version since-build="271"/>` 不设 `until-build`（因 ILS 运行时 `idea.plugins.compatible.build=999.SNAPSHOT`），由启动层锁定 `271.2085.0`。
- 编译 classpath 取自同一 ILS 发行包的 core、analysis、projectModel、UAST、language-server API/analyzer、Java PSI/UAST、Kotlin 分析 API，以及 `plugins/xml/lib/modules/` 中的 XML PSI/parser/DOM 和 Provider 基类所在模块。以实际插件描述符和 JAR 校验依赖，不沿用 263 的根 lib 布局；Lint 另加 §14.2 的 6 个核心 JAR。
- 编译优先使用该精确发行包自带 `jbr/bin/javac`（`--release 25`）；因发行包 JBR 裁剪了 `jar` 与 `jdk.jartool`，打包优先探测 `jdk.jartool`，缺失时回退至 `JAVA_HOME` 或系统 PATH 中的 JDK 25 `jar` 工具。`jvm/android-ls-extension/build.mjs` 通过 `--no-compress` 与固定时间戳产出确定性单 JAR，跨盘 staging 后原子落盘，并在任意失败分支清理临时目录。
- `package.json` 配置调整：
  - **保留 `dist/` 契约**：`"files"` 列表保留 `"dist/"`，以满足 `"main": "dist/index.js"`、`"types": "dist/index.d.ts"` 与 `"bin": {"omp-intellij-lsp": "./dist/bridge.js", "omp-intellij-dap": "./dist/debug/dap-proxy.js"}` 的入口契约；列表为：`["dist/", "src/", "jvm/android-ls-extension/", "resources/ils/", "scripts/clean-runtime.mjs", "settings.json", ".omp-plugin/marketplace.json", "README.md"]`；
  - `"scripts"` 包含 `"build:jvm": "node jvm/android-ls-extension/build.mjs"`、`"check:assets": "node jvm/android-ls-extension/check-assets.mjs"`、`"clean:runtime": "node scripts/clean-runtime.mjs"` 与维护命令 `"update-bundle": "npm run build && node scripts/update-server-bundle.mjs"`；
  - `"prepack"` 脚本为 `"npm run build && npm run check:assets"`（校验当前阶段发布的精确版本 JAR、ABI、体积、清单与 `.sha256` 旁挂文件，不强求打包机存在 JDK25/ILS 编译环境）。
- 复制 Apache-2.0 参考代码及分发 Apache-2.0 Lint 运行库时保留必要版权与许可证声明；整个 ILS/Kotlin 发行包继续沿用既有下载和 EULA 流程。

### 12.2 安装资产链与插件目录布局

1. 发布目录为 `resources/ils/271.2085.0/android-ls-extension/lib/`。当前 A/B 与 definition 交付仅包含自有 `android-ls-extension.jar`（`145970` 字节，SHA-256 `04083921499f260a4d238abcd64cbee8fb0be314eff5a4e770a275f7ca4d8bf4`）、`manifest.json` 和 `.sha256` 校验文件；阶段 H 验收后再按 §14.2 纳入 6 个 Lint 依赖 JAR。
2. 通过 `npm pack --dry-run --json --ignore-scripts` 检查包清单，确认 `dist/` 编译产物、JVM 扩展源码/脚本与已启用 JAR 资产均在发布归档内。
3. `src/plugin.ts` 二进制与文本分流资产链：
   - 文本资产（`settings.json`、`marketplace.json`、`package.json`）按 `utf8` 字符串参与 hash 与复制；
   - 二进制资产（`resources/ils/**/*.jar`）通过 `readFile` 直接作为 `Buffer` 读取，二进制字节注入 SHA-256，随后在 staging 阶段以 `writeFile` 字节原样复制至 `.runtime/<hash>/resources/...`，严禁经过 UTF-8 解码；
   - 任意 JAR 字节改变必须产生新 runtime hash。
4. `.runtime/` 目录生命周期与治理：
   - 遵循 `settings.json` 中 `cachePolicy.automaticDeletion = false` 的原则，启动时不静默批量删除历史目录（避免误删并行会话正在使用的旧 runtime）；
   - 启动时不自动删除 `.runtime/` 下的历史目录或 `.tmp` 目录；
   - 提供显式 `npm run clean:runtime` 预览及关闭消费者后的 `node scripts/clean-runtime.mjs --apply` 清理不使用的历史 hash 目录与超过 1 小时的 `.tmp` 孤儿目录。
5. 通用服务启动层接收版本匹配的扩展目录路径，通过 `mergeIjJavaOptions` 注入 `-Dplugin.path="<插件目录>"`（使自有 JAR 与后续同目录 `lib/` 下的 6 个 Lint JAR 处于同一个 `PluginClassLoader` 中）；保留用户其他带空格引号的 JVM options，支持合并已有的逗号/平台分隔符（`;` / `:`）`-Dplugin.path`，并在 Windows 下统一转为正斜杠 `/`、按大小写无关去重。
6. 现有服务已经运行时不热塞新 JAR；遵循租约/debug session/owner 校验及显式安全重启，不能杀共享用户会话。
7. 缺少精确版本资产时不加载其他版本 JAR，也不恢复 TS XML 实现；在启动/状态层报告扩展不可用，原生 Java/Kotlin LSP 与 DAP 保留。Android A–D/H 不宣称可用；§4.3 说明未加载 Provider 时的请求行为。

### 12.3 本地 marketplace 和上游更新

开发安装的前提是 marketplace list 的来源为 `F:/source/omp-intellij`。使用真实本地市场安装链：

```sh
omp plugin marketplace update omp-intellij
omp plugin install --force omp-intellij@omp-intellij
```

核对安装缓存中 `.runtime`、`.lsp.json`、`.dap.json`、JAR 资产目录和源码属于同一次版本；核对原生 LSP/DAP 发现、命令广告及 `textDocument/diagnostic` 返回，不能以扩展工具可调用代替验证。

版本与验收范围分别记录：
1. **目标版本 `271.2085.0`**：默认安装版本已更新并在 `src/server/bundle-metadata.ts` 中锁定；上游源实测存在分歧：GitHub Lua（`server_bundles.lua`）实际解析为 `263.7084.0`，而 Open VSX `1.0.86` 指向 `271.2085.0`，并非“解析一致”。六个平台归档的 SHA-256 与体积已按 CDN 旁挂文件与 Content-Length 实测核验并锁定在生成元数据中。**阶段 A、阶段 B、既有 Android definition 迁移及 JVM 扩展构建/加载链已在 `271.2085.0` 完成生产实现并通过双模块 Fixture 与 MyHook 隔离验收**；阶段 C/D/H 待在 271 上继续实施与验收。
2. **历史版本 `263.7084.0`**：资源字段命令、Compose suppressor、诊断 Provider 与 Lint 矩阵在此版本验证。八个 XML PSI 接口签名一致不能证明整个扩展可直接用于 271；263 结果严格标记为历史基线，不得代替 271 生产验收。

维护工具与加载要求：
- **上游版本探测迁入开发工具**：运行时不再执行远程版本探测或 `latestServerVersion()`，`/intellij install` 始终安装锁定的内置版本 `271.2085.0`。上游版本更新已迁移为开发维护工具 `scripts/update-server-bundle.mjs`，执行命令为 `npm run update-bundle -- --version <build|latest> [--check]`；`--check` 仅对比元数据差异而不改写文件。
- 首个完整生产包面向 271，不承诺同时支持 263。不得因 263 的 Lint 探针通过就发布 271 资产；先重跑 §5–8 和 §14 的矩阵，再生成 `resources/ils/271.2085.0/`。
- 若以后支持其他 ILS 版本，分别校验 SPI、Provider、插件依赖、Kotlin/UAST 与 Lint ABI，再用 JVM 构建链生成精确版本资产。`update-server-bundle.mjs` 只更新下载元数据，不构建 JAR 或证明 ABI 兼容；不使用兼容别名或 TS 备用解析器。
- **`server.port` 格式属版本契约**：`263.7084.0` 只写端口号，`271.2085.0` 写三行（端口、服务端 PID、`ILS-<build>`）。读取方一律只取首行并校验 `1–65535`（`parsePortFile`），不得对整个文件做数值转换，否则连接地址变为 `NaN`，表现为“启动超时”而实际服务已在 1 秒级就绪。
- `271.2085.0` 启动日志实测：`License gate: Licensed`，可用语言扩展为 `projectview, java, kotlin, properties, xml, yaml`，构建工具为 `bazel, bazelCheckout, json, maven, gradle, jps, java`，`plugins/` 内仍无 `android.lsp`。
- 升级校验：通过 `npm run update-bundle` 对照上游清单，升级时严格核对 SPI/命令/容器/Kotlin API、`LSDiagnosticProvider`、AGP 来源格式及官方 Android 路径，再运行同一验收矩阵。上游已完整替代某项时删除对应拦截与重复实现，保留通用取消/清理修复，不保留兼容开关。

## 13. 实施顺序、验证和完成条件

### 13.1 顺序

1. **原生入口验收**：先按 §4.0 发现标准能力及 MCP schema，再在 271 Android 隔离工程执行 §5–8、§14 的对应正反例，记录具体 URI、范围与规则结果。完整满足契约的项目直接使用原生实现；不满足的项目执行下述 JVM 补齐规格。是否进入补齐分支由同一验收集合决定，不重新选择架构，不以非空响应或工具名称判断完成。
2. **缺口的 JVM 上下文与 A/B、definition 切换（已完成）**：已建立 271 的构建/加载与版本校验，直接读取模块/SDK/依赖及当前 XML PSI；完成原生目标并存、`DirectNavigationProvider` 源码优先级和错误传播验收，一次性切换并删除了 `src/android/navigation.ts`、`resource-resolver.ts`、`xml.ts`、`types.ts`、`src/shared/navigation-relay.ts` 及 `saxes`。
3. **阶段 C/D**：仅对原生验收未满足的项实施 §7/§8；资源 references Provider 与字段命令共用 JVM 服务，Compose 抑制复用原生检查扩展机制。已通过原生验收的项不重复注册 Provider/suppressor。
4. **阶段 H 与发布资产**：按 §14 正反例判定现有诊断是否完整。原生满足时不加载重复 Lint；缺口分支使用下文 6 JAR 及 OmpLint Provider 规格，在 271 全矩阵通过后发布。未构建模型与构建产物来源分别验收；资产数量按实际启用的自有模块记录，不为了凑固定 JAR 数量重复分发上游实现。
5. **阶段 E**：独立 `prepare`/`cleanup`、窄 DAP 生命周期组合、明确超时单位。
6. **阶段 F 和 G**：把新增路径纳入故障矩阵，按复现修复；G 保持现状。

### 13.2 回归组织

- 复用 `android-extension`、`document-symbols`、`dap-proxy` 和隔离集成模式（`test/integration/android-xml.test.ts`）；已将依赖旧 TS 解析器的测试迁移到真实 JVM/ILS 行为验收并删除旧测试，不保留两套业务预期。
- 覆盖精确符号范围、Android 文件身份、模块/资源来源、false/true、错误与合法空集合、原生诊断与 Android/Compose Lint 共存、取消/迟到结果、forward 所有权和版本资产失效。
- 不写源码文本断言、仅验证转发或 mock 回声的测试。临时探针不成为生产依赖。
- JVM/ILS 真实集成复用现有隔离 sandbox 和已有 EULA（`cd82e6cdaf2790f1`）；禁止为了测试自动接受新条款。
- 验证修改范围的 typecheck/相关测试/build/受影响文件 Biome，最终全量 Node 测试；真实 ILS 集成按需运行并独立记录。

现有命令：

```sh
npm run pretest
node --test --test-timeout=30000 dist-test/test/android-extension.test.js dist-test/test/document-symbols.test.js dist-test/test/dap-proxy.test.js
npm run build
npm test
npm run test:integration
npm pack --dry-run --json --ignore-scripts
```

新模块构建命令随模块构建脚本一并落地，包构建/发布必须包含它；不能只有手工编译出的本机 JAR。

### 13.3 最终验收矩阵

| 阶段              | 完成条件                                                                                                                                                                                                  | 当前状态                                                                                     |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| A                 | 真实安装链的标准 documentSymbol 返回 §5 的正式符号树；优先采用原生，原生不满足时才加载自有 JVM Provider。范围、未保存内容、层级/平面、错误 XML 和非 Android 行为均通过                                    | **已完成**（`271.2085.0` 实测通过）                                                          |
| B/definition 迁移 | 三组件 false/true 精确到位置，包含当前属性且无无关类；KDoc 和别名语义保持；原有 R/XML 与 Manifest definition 无回归；TS XML 业务链已删除                                                                  | **已完成**（`271.2085.0` 实测通过，旧 TS 链与 `saxes` 已删除）                               |
| C                 | 三处 nav_settings、合法零引用、限定符/变体/模块隔离、来源失效、内存多文件真实搜索中取消全部通过                                                                                                           | 待实施                                                                                       |
| D                 | 七项正反例及 TestFunctionName、注册生命周期和取消通过，无普通诊断回归                                                                                                                                     | 待实施（263 探针已通过，待迁入 271）                                                         |
| E                 | 实际设备双场景断点、栈、变量、单步、detach、forward 所有权和失败清理通过                                                                                                                                  | 待实施（原生 DAP 双场景已验证）                                                              |
| F                 | 故障后旧请求结束、资源释放，新会话真实语义查询可用，其他工程不受影响                                                                                                                                      | **A/B 与 definition 路径已验证通过**（含在途取消 `-32800`、在途编辑 `-32801`、跨工程隔离）   |
| G                 | 默认开启 intellijExtensions 协议扩展，Rename 与 ModCommand 正常生成与执行；不新增 Bridge 黑名单                                                                                                           | **已完成**                                                                                   |
| H                 | 标准 textDocument/diagnostic 满足原生编译诊断、Java/Kotlin NewApi 及 Compose 规则正反例；缺口分支另验 6 JAR、模型前提、lint.xml、故障隔离和缓存。MCP 多文件检查不代替标准请求验收，不重复加载已存在的规则 | 待实施（263 探针与 6 JAR 依赖集已验证，待 271 集成）                                         |
| 发布              | npm 入口与实际启用的版本资产完整；自有 JAR 字节改变使 runtime hash 改变；本地安装发现与精确 ABI 验收通过。只有采用自有 Lint 分支时分发对应 6 个依赖 JAR                                                   | **A/B 单 JAR 资产链已完成并验收**（`145970` 字节，classfile 69）；阶段 H 6 JAR 待启用时并入 |

生产完成后更新 README 并清除临时产物；不自动提交或覆盖远端。文档包含：
1. **能力与环境**：A–H 的 LSP 方法、DAP 指令、CLI 命令和已验收环境；
2. **两阶段调试用法**：`debug-attach-cli prepare` 与 `cleanup` 的参数、返回 JSON 结构与配合原生 DAP 工具的用法；
3. **13 项错误码与排查**：环境、目标、租约、协议的状态及恢复建议；
4. **Android Lint 边界**：单文件 pull 诊断、`Scope.JAVA_FILE` 源码规则、第三方规则白名单；
5. **AGP 兼容范围**：区分 MyHook AGP `9.4.1` 的实测、其他版本待验收项，以及动态 DSL、flavor 和自定义资源根的限制；
6. **资产清单**：记录目标版本 `resources/ils/271.2085.0/` 下当前发布的 `android-ls-extension.jar` 及后续阶段 H 启用时的 6 个 Lint 依赖 JAR 的版本、体积与 SHA-256。

### 13.4 研究证据索引

会话工件用于复现来源，不是生产运行时依赖：

- `local://probe-rpc-cancellation.md`：实际字段命令、取消及并发探针。
- `local://probe-xml-manifest-resources.md`：XML 解析原始输出、组件原生 references、AGP 产物和模块作用域。
- `local://probe-compose-matrix.md`：最小源码、EP-only 对照、单次注册及真实诊断矩阵。
- `local://android-dap-evidence.md`：原生 Android DAP 双场景完整请求、断点、变量和清理。
- `local://complete-plan-parent-evidence.json`：双工程恢复、服务退出/自启和 QuickFix 请求/日志关联输出。
- `local://embedded-android-lint-evidence.json`：同进程内嵌官方 `ApiDetector` 十二项正反例实测证据。
- `local://native-xml-271-evidence.json`：Maven 对照工程的原生 XML 与 Java 大纲结果。
- `local://android-import-271-evidence.json`：干净 MyHook 副本的模块/库导出、导入任务、缺失 R.jar 和原生 XML 请求结果。
- `local://xml-psi-271-evidence.json`、`local://xml-psi-271-source.java`：七组 XML PSI 实验、未保存文本、范围和局部错误恢复；手工提交文档分支未触发，不复制到生产。
- `local://xml-provider-271-evidence.json`：原生 XML 大纲 Provider 的完整双向协议记录及核心 XML API 签名比较。
- `local://ProbeXmlDocumentSymbolProvider.java`、`local://ProbeSymbolExtension.java`、`local://probe-plugin.xml`：实际加载的 271 大纲探针；符号类型、文件识别和 selectionRange 仍需按 §5 实现。

## 14. H：内嵌官方 Android Lint 与 Jetpack Compose 规则诊断

### 14.1 实测基线

在 ILS `263.7084.0`（JBR 25）同进程内运行官方 Android Lint（`ApiDetector`）与随 Jetpack Compose AAR 分发的 `UnrememberedStateDetector`，直接复用当前请求的 `ctx.project`、内存未保存 PSI（`PsiJavaFileImpl` / `KtFile`）与 K2 FIR UAST（`JavaUFile` / `KotlinUFile`），不启动外部 CLI 进程，不加载 `lint-psi` 替代编译器。

#### 1. 系统级规则（`NewApi`）Java / Kotlin 十二项正反例基线（`minSdk=21, compileSdk=37`）

| 用例（内存 `didOpen` / `didChange`，磁盘文件未改动）                      | Java 的 NewApi 数 | Kotlin 的 NewApi 数 |
| ------------------------------------------------------------------------- | ----------------- | ------------------- |
| 一个未保护 `NotificationChannel`（API 26）、一个 `SDK_INT >= 26` 保护调用 | 1                 | 1                   |
| 两个调用均由 `SDK_INT >= 26` 检查保护                                     | 0                 | 0                   |
| 两个调用仅由 `SDK_INT >= 25` 检查保护                                     | 2                 | 2                   |
| 未保护函数增加 `@android.annotation.TargetApi(26)`                        | 0                 | 0                   |
| 未保护函数增加 `@SuppressWarnings("NewApi")` / `@Suppress("NewApi")`      | 0                 | 0                   |
| 未保存文本恢复为未保护调用                                                | 1                 | 1                   |

#### 2. AAR Compose 规则（`UnrememberedMutableState`）与多规则同文件并发基线

从 `MyHook.app.debug` 已导入依赖缓存装载 `androidx.compose.runtime:runtime-android` 的 `transformed/runtime/jars/lint.jar`（含 `RuntimeIssueRegistry` 16 项规则），与 `ApiDetector` 合并为 `CompositeIssueRegistry` 后对 `MainActivity.kt` 实测：

| 用例                                                                 | K2 FIR 符号解析                                                    | 返回 Incident                                                         | 耗时           |
| -------------------------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------- | -------------- |
| `@Composable fun Bad() { val s = mutableStateOf(0) }`                | `mutableStateOf -> androidx.compose.runtime.SnapshotStateKt`       | 1 项：`UnrememberedMutableState` (`192..206`)                         | 298 ms（首次） |
| `@Composable fun Good() { val s = remember { mutableStateOf(0) } }`  | `remember -> ComposablesKt`<br>`mutableStateOf -> SnapshotStateKt` | 0 项（`[]`）                                                          | 39 ms          |
| `@Suppress("UnrememberedMutableState") @Composable fun Suppressed()` | `mutableStateOf -> SnapshotStateKt`                                | 0 项（`[]`）                                                          | 16 ms          |
| 同文件含未保护 `NotificationChannel` + 未 remember `mutableStateOf`  | 同时解析 Android SDK 与 Compose Runtime                            | 2 项：`NewApi` (`243..262`) + `UnrememberedMutableState` (`439..453`) | 31 ms          |
| `JceHead.java` 对照（5 JAR 子集）                                    | `new NotificationChannel -> android.app.NotificationChannel`       | 1 项：`NewApi` (`152..175`)                                           | 6 ms           |

全部用例 `logs == []`、`crashCount == 0`，执行后原生 `textDocument/definition` 仍正常定位到 `android.jar` 内部类。

### 14.2 运行依赖集（6 个 JAR / 10.84 MiB）与构建锁定

经 `jdeps` 静态分析与沙箱实测，排除 `cli.jar`、`external/lint-psi`、`layoutlib-api`、`lint-checks-proto`、`sdk-common`（仅启用 `Scope.JAVA_FILE` 时）及与 ILS 重复的 Kotlin/Guava/ASM/Gson/Protobuf 库。

5 个 JAR 的子集仅覆盖 `ApiDetector` 与 `UnrememberedStateDetector`；完整 `androidx.*` 规则集依赖 `tools.lint-model.jar`：
- `DefaultJavaEvaluator.getDependencies()` 调用 `Project.getBuildVariant()` → `LintModelVariant.getArtifact().getDependencies()`；
- `tools.lint-checks.jar` 内 32 个类引用 `com/android/tools/lint/model/`；
- AAR 侧 `androidx.activity` 的 `ActivityResultFragmentVersionDetector` 引用 `LintModelDependencies` / `LintModelAndroidLibrary` / `LintModelMavenName`。

运行依赖集固定为 **6 个 JAR（共 11,362,788 字节 / 10.84 MiB，较初始 43.94 MB 缩减 74.1%）**：

| #        | JAR 文件名              | SDK `cmdline-tools;23.0` 相对路径                      | 字节数         | SHA-256                                                            | 用途                                                                                                       |
| -------- | ----------------------- | ------------------------------------------------------ | -------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| 1        | `tools.lint-checks.jar` | `lib/lint/tools.lint-checks.jar`                       | 7,256,470      | `61e6b0a90d6fe8a5ac5d4d8519fb1134fd064fbba12525dcfc08ce4b43ffd0ae` | 官方内置规则集与 `BuiltinIssueRegistry`                                                                    |
| 2        | `tools.sdklib.jar`      | `lib/sdklib/tools.sdklib.jar`                          | 1,909,475      | `d0bbe0e03155a7bdd9bac03567b6b26797f81a778f55d5eadc3e71e7a0a27434` | `AndroidVersion`、`SdkVersionInfo`、`IAndroidTarget`                                                       |
| 3        | `tools.lint-api.jar`    | `lib/lint/tools.lint-api.jar`                          | 1,417,813      | `e6a6e0244b5a9a325580c0a8901b94e1a8b37e0cca7030f5fcb06186f7f46b61` | `LintDriver`、`LintClient`、`DefaultUastParser`、`JarFileIssueRegistry`                                    |
| 4        | `tools.common.jar`      | `lib/common/tools.common.jar`                          | 570,290        | `ed2fea24fd74c82cac6ca964b8a3f5b33f7aa8f675bd6fb51ee78772f49995f2` | `XmlUtils`、`PositionXmlParser`、`ResourceFolderType`、`SdkConstants`                                      |
| 5        | `kxml2-2.3.0.jar`       | `lib/external/net/sf/kxml/kxml2/2.3.0/kxml2-2.3.0.jar` | 43,858         | `f264dd9f79a1fde10ce5ecc53221eff24be4c9331c830b7d52f2f08a7b633de2` | `ApiLookup` 解析 SDK `data/api-versions.xml` 所需 `KXmlParser`                                             |
| 6        | `tools.lint-model.jar`  | `lib/lint/tools.lint-model.jar`                        | 164,882        | `81ac1f03f390f0aa8308d389a8bbe4238f9bd843ff705556f68564f6ee257cf1` | `LintModelVariant` / `LintModelDependencies`，支撑 `DefaultJavaEvaluator.getDependencies()` 与依赖感知规则 |
| **合计** | **6 个 JAR**            | —                                                      | **11,362,788** | —                                                                  | —                                                                                                          |

获取与构建锁定规则：
1. 构建脚本按 `--android-sdk`、`ANDROID_HOME`、`ANDROID_SDK_ROOT` 顺序定位 `cmdline-tools`（校验 `source.properties` 的 `Pkg.Revision=23.0` 及上表 6 个文件的 SHA-256），或从 Google Maven（`https://dl.google.com/dl/android/maven2/`）下载固定版本并校验 SHA-256。
2. 在 271 重跑兼容矩阵后，将 6 个 JAR 复制到 `resources/ils/271.2085.0/android-ls-extension/lib/`，与自有 JAR 同级；哈希不匹配或文件缺失时构建失败。
3. 将来若启用 `Scope.RESOURCE_FILE` / `Scope.CLASS_FILE` 规则或实现 `getResources` 返回非空仓库，需追加 `tools.sdk-common.jar`（提供 `com.android.ide.common.resources.ResourceRepository`）并重跑兼容矩阵。

### 14.3 原生诊断挂载与 LSP 协议契约

直接实现 ILS 原生诊断接口 `com.jetbrains.ls.api.features.diagnostics.LSDiagnosticProvider`：

1. **接口与语言注册**：
   - `LanguageServerExtension.getConfiguration()` 返回 `new LSConfigurationPiece(entries, Collections.emptyList(), Collections.emptyList())`。
   - `entries` 包含 XML 大纲、definition/references Provider（阶段 A–C）、显式字段命令、`WorkspaceComponentEntry`（阶段 D）与 `OmpLintDiagnosticProvider`（阶段 H）。
   - `LSConfigurationPiece` 第三个参数 `languages` 传空列表，避免与内置 XML、Java/Kotlin 插件重复注册语言描述。
   - `OmpLintDiagnosticProvider.getSupportedLanguages()` 返回 `new LSLanguage("java", Language.ANY, Set.of("java"))` 与 `new LSLanguage("kotlin", Language.ANY, Set.of("kt"))`（`LSLanguage.equals/hashCode` 仅比对 `lspName`）。
2. **并发执行与 `Diagnostic` 字段映射**：
   - 客户端请求 `textDocument/diagnostic` 时，ILS 的 `LSDiagnostic.getDiagnostics` 并发调用内置编译器诊断提供器与 `OmpLintDiagnosticProvider.getDiagnostics(server, handlerContext, params)`，合并为 `Flow<Diagnostic>`。
   - 当前文件不属于 Android 模块（所在模块依赖中无 `android.jar`）时，直接返回空 `Flow`。
   - `Incident` 到 `com.jetbrains.lsp.protocol.Diagnostic` 的字段映射：
     - `range`：由当前已同步 `Document` 将 `incident.getStartOffset()` / `incident.getEndOffset()` 换算为零基 UTF-16 行列；
     - `severity`：`ERROR` / `FATAL` → `DiagnosticSeverity.Error(1)`，`WARNING` → `Warning(2)`，`INFORMATIONAL` → `Information(3)`；
     - `code`：`incident.getIssue().getId()`（如 `"NewApi"`、`"UnrememberedMutableState"`）；
     - `source`：`"android-lint"`；
     - `relatedInformation`：沿 `incident.getLocation().getSecondary()` 链表提取具备有效文件与正长度区间的次要位置及 `Location.getMessage()`；
     - `data`：写入结构化 `{ "issueId": ..., "source": "android-lint" }`，供后续 `LSCodeActionProvider` 关联；
     - `codeDescription` / `tags`：当前 `Issue` 二进制无 URL 访问器且无确定 `DiagnosticTag` 映射，保持 `null`，不编造文档链接或标签。
   - 丢弃 `incident.getLocation() == Location.NONE` 或起止偏移相等的无位置事件。
   - 丢弃 `incident.getSeverity() == Severity.IGNORE` 的已禁用规则事件。
3. **执行上下文与版本复核**：
   - `getDiagnostics` 在 `server.withAnalysisContext` 的平台读操作（`readAction`）内访问 PSI/UAST，`Flow` 在 IO 调度器上收集，不阻塞 LSP 主调度线程。
   - 分析前通过 `AndroidSources.Scope` 记录目标与关联打开文档的 `LSDocuments.getVersion-XfNk_NE(uri)` 版本号及磁盘 `BasicFileAttributes`，输出前再次复核；若分析期间文档已变更，丢弃过期结果并返回 `-32801`。
4. **`XmlParser`、`Configuration` 与配置通道**：
   - 配置通道边界：不假定未验证的动态 LSP RPC 配置通道。规则启用状态与严重级别按工程本地 `lint.xml`（通过 `LintXmlConfiguration` / `PositionXmlParser` 解析），并配合静态规则白名单（内置规则 + Compose 规则）。
   - `lint.xml` 由 Lint 自身配置 API 读取：`LintClient.getXmlParser()` → `XmlParser.parseXml(File)` / `getLocation(File, Node)`。`OmpLintClient` 委托 `tools.common.jar` 的 `PositionXmlParser`，开启 secure processing 并禁用外部实体。它只服务 Lint 配置，不是另建 Android 导航 XML AST。
   - `Configuration` 通过 `LintClient.getConfiguration(project, driver)` 获取，支持项目 `lint.xml` 的 enable/disable、severity 覆盖与 `Severity.IGNORE` 过滤。
   - `getGradleVisitor()` 与 `getResources(project, scope)` 在仅启用 `Scope.JAVA_FILE` 时抛出 `UnsupportedOperationException`，并由 `Scope` 过滤确保不实例化 Gradle 或资源作用域规则。
5. **结果缓存、容量上限与多根隔离**：
   - ILS `LSDiagnostic.getDiagnostics` 将多路 provider 输出合并为单个 `DocumentDiagnosticReport(kind="full")`，不透传单 provider 的 `resultId` / `unchanged`；`OmpLintDiagnosticProvider` 始终返回完整 `Diagnostic` 流。
   - 内部缓存采用定长 LRU 映射（上限 64 个文档条目），以 `(project.locationHash, uri, LSDocuments.getVersion / document.modificationStamp, 模型指纹[compileSdk/minSdk/namespace/变体], 已启用 Issue 集合, 规则 JAR 集合指纹)` 隔离存储。
   - 失效时机：`didChange` 失效当前条目；`didClose` 立即从缓存中移除并释放内存；`workspace/didChangeWatchedFiles`（`lint.xml` 或构建脚本变更）清空对应项目缓存。
   - 同一 ILS 进程内共享一个 `OmpLintDiagnosticProvider`，缓存按 `project.locationHash` 分区；多工程隔离须通过验收。
6. **拉取模式约束**：
   - ILS `263.7084.0` 仅在 `fleet.lsp.protocol` 中包含 `publishDiagnostics` 协议常量，无主动推送实现；阶段 H 诊断通过 `textDocument/diagnostic` 拉取返回，验收时须确认客户端声明 `textDocument.diagnostic` 能力且服务端广告 `diagnosticProvider`。
   - `271.2085.0` 已记录 initialize 能力：`diagnosticProvider = { interFileDependencies: true, workspaceDiagnostics: false, workDoneProgress: false }`、`documentSymbolProvider = true`；历史探针的 `textDocument/diagnostic` 返回 `kind: "full"`。`workspaceDiagnostics: false` 表示不支持该 Provider 的 `workspace/diagnostic`，不禁止逐文件拉取或 MCP `lint_files`。是否包含 Android/Compose 规则以目标工程的规则正反例为准，不能仅靠 schema 或能力广告替代验收。

### 14.4 未构建（Clean）与已构建双态模型解析及 AAR `lint.jar` 发现

在 `server.withAnalysisContext` 读操作内先读取当前变体的已导入模型、SDK、库表与 PSI。已导入模型中有明确属性时直接采用，不再解析构建脚本。下表是模型确实缺字段时的补充来源；263 探针只证明列出的字面量/产物可读，不证明动态 DSL 求值完整。每个属性记录来源、变体与快照；无法唯一确认则标记前提缺失，不猜默认值。

| 属性                          | 第一优先级（导入后的内存模型/源码）                                                                                                                                                             | 第二优先级（已构建产物补充）                                                            | 第三优先级（保底）                                                                                     |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| **所属 `Module`**             | `ProjectFileIndex.getInstance(project).getModuleForFile(virtualFile)`（如 `MyHook.app.debug`）                                                                                                  | —                                                                                       | 无模块则跳过 Android Lint                                                                              |
| **SDK 根目录与 `compileSdk`** | 从模块依赖库表定位 `Gradle: android:android-sdk:null` 的 `platforms/android-<ver>/android.jar`，推导 `sdkHome` 并读取同目录 `source.properties` 的 `AndroidVersion.ApiLevel`（如 `37.0`）       | `build/intermediates/lint_report_lint_model/<variant>/.../module.xml` (`compileTarget`) | —                                                                                                      |
| **AAR `lint.jar` 列表**       | 遍历模块 `OrderEnumerator.orderEntries(module).librariesOnly()` 中所有 `.../transformed/<lib>/jars/classes.jar`，收集存在的同级 `jars/lint.jar`（MyHook 中共 24 个 JAR，含 13 个 Compose 模块） | `debug-artifact-libraries.xml` 中的 `lintJar`                                           | —                                                                                                      |
| **namespace**                 | 当前变体导入模型的明确 namespace 字段；模型缺失时读取所属 KtFile 中已确认且无覆盖歧义的字面量                                                                                                   | 具备明确 namespace 语义且快照一致的构建模型字段                                         | 源码 Manifest package 仅在已确认与 namespace 一致时采用；否则保留缺失，merged package 不替代 namespace |
| **minSdkVersion**             | 当前变体导入模型的明确 minSdk；模型缺失时只接受已证明无动态/flavor 覆盖歧义的 KtFile 字面量                                                                                                     | 当前变体有效 lint model / merged Manifest                                               | 源码 uses-sdk 仅在已确认有效时采用；无法确认则报告模型前提缺失，跳过依赖 minSdk 的规则，不虚构 1       |
| **targetSdkVersion**          | 当前变体导入模型的明确 targetSdk；模型缺失时只接受已证明无覆盖歧义的 KtFile 字面量                                                                                                              | 当前变体有效 lint model / merged Manifest                                               | 无可靠值则报告模型前提缺失并跳过依赖规则，不虚构 compileSdk                                            |

构建脚本归属与模型前置约束：
- **严禁虚构保底数值**：严禁在缺少证据时虚构 `minSdk=1` 或 `targetSdk=compileSdk` 等分析保底值。虚构 `minSdk=1` 会导致新 API 检查大面积虚报或在条件分支中引发误判与假阴性。当 Gradle 导入模型、KtFile AST 字面量、构建产物与源码 Manifest 均无法确认可靠版本时，必须显式标记模型前置条件缺失，在日志或诊断中说明跳过依赖该属性的规则（如 `NewApi`），不使用虚假数值保底进行分析。
- `MyHook.app.debug` 的 contentRoot 仅包含 `app/src/main`、`app/src/debug` 与 `app/build/generated/source/buildConfig/debug`；定位模块根目录时从 `contentRoots` 向上查找包含 `build.gradle.kts` / `build.gradle` 的唯一父目录（或回退 `ExternalSystemApiUtil.getExternalProjectPath(module)`）。
- `build.gradle.kts` 在未 `didOpen` 时不在 ILS 默认索引 PSI 中，须优先取已打开 `PsiFile`、否则用 `KtPsiFactory(project, false).createFile` 构造 `KtFile`（`AndroidSources.kotlinScript`），且读取圆括号实参须使用 `getValueArgumentList().getArguments()`。只提取可确认的字面量；跨脚本变量、动态表达式及未确认 flavor 覆盖不能当作已支持，§14.7 列出已知限制。

### 14.5 `OmpLintClient`、Windows ClassLoader 保活与故障隔离

1. **Windows 下 `JarFileIssueRegistry` 类加载器保活与缓存复制**：
   - 官方 `JarFileIssueRegistry$Factory.loadAndCloseURLClassLoader` 在 Windows 上仅预加载不含 `$` 的顶层类即调用 `urlClassLoader.close()`，导致 Compose Detector 在遍历 AST 实例化匿名内部类（如 `UnrememberedStateDetector$createUastHandler$1`）时抛出 `NoClassDefFoundError`。
   - `OmpLintClient` 覆写 `createUrlClassLoader(List<? extends File> files, ClassLoader parent)`，返回以插件 ClassLoader 为父加载器、且将 `close()` 置空的 `URLClassLoader`，待缓存条目失效或服务停止时统一释放。
   - 为避免常驻文件句柄锁死 Gradle transform 缓存目录，加载前先将 AAR `lint.jar` 按内容 SHA-256 复制至 `<systemPath>/lint-cache/aar/<sha256>.jar`，从私有缓存加载。
2. **复用官方 PSI / UAST 适配器与内存文本**：
   - 使用 `new DefaultUastParser(lintProject, ideaProject)`（内部创建 `DefaultJavaEvaluator(ideaProject, lintProject)`）。
   - `OmpLintClient.readFile(File)` 优先通过 `StandardFileSystems.local().findFileByPath(...)` 与 `PsiManager.getInstance(ideaProject).findFile(...)` 返回当前内存 `PsiFile.getText()`；仅对 SDK `api-versions.xml` 等非编辑文件读取磁盘。
3. **K2 FIR 分析就绪校验**：
   - `DumbService.isDumb(ideaProject)` 在 ILS 中恒为 `false`。
   - 对 Kotlin 文件，若 `DefaultUastParser.parse(javaContext)` 返回的 `KotlinUFile` 含有 `UCallExpression`，但因 WorkspaceModel 尚未完成库绑定导致首轮 `call.resolve()` 全部返回 `null`，则中止当次分析并返回空流，不缓存未就绪结果。
4. **实例生命周期**：
   - `ApiLookup` 与 SDK 元数据缓存目录指向 `<systemPath>/lint-cache`。
   - `BuiltinIssueRegistry` 单例复用；AAR `JarFileIssueRegistry` 按 `(lintJarPath, lastModified)` 缓存；`LintDriver` 与 `JavaContext` 按单次诊断请求创建。
5. **`Project` 子类化契约**：
   - 通过子类化 `com.android.tools.lint.detector.api.Project`（`protected` 构造器）实例化，调用 `setIdeaProject(ideaProject)`。
   - 覆写 `getMinSdk()`、`getMinSdkVersion()`、`getMinSdkVersions()`（基类默认返回未初始化的 `manifestMinSdks = null`）、`getBuildSdk()`、`getCompileSdkResult()` 与 `getBuildTarget()`；`getBuildVariant()` 保持返回 `null`。
6. **单 Detector 故障隔离**：
   - 按规则来源（内置 `BuiltinIssueRegistry` 与各 AAR `JarFileIssueRegistry`）分组执行 `beforeCheckRootProject`、`UElementVisitor.visitFile` 与 `afterCheckRootProject`，每组独立捕获非取消异常并记录 debug 日志，丢弃故障组结果而保留其余组输出；`CancellationException` 与 `ProcessCanceledException` 原样向上抛出。

### 14.6 安全白名单、作用域隔离与生产验收条件

1. **AAR `lint.jar` 安全白名单**：
   - 默认仅加载 Maven 坐标或缓存路径属于受信任命名空间（`androidx.*`、`com.google.*`、`org.jetbrains.*`）的 AAR `lint.jar`；其余第三方 `lint.jar`（如 `io.github.libxposed:api`、`org.luckypray:dexkit`）默认跳过并记录 debug 日志，提供显式配置项（如 `allowUntrustedRuleJars`）按需启用。
2. **模块作用域隔离**：
   - 覆写 `DefaultJavaEvaluator.findClass(String qualifiedName)`，优先在当前 `module.getModuleWithDependenciesAndLibrariesScope(true)` 内调用 `JavaPsiFacade.findClass`，防止多模块工程中同名类跨模块串扰。
3. **取消与异常传播**：
   - 在 `UElementVisitor` 调度及读操作边界检查 `ProgressManager.checkCanceled()` 与协程 `scope` 状态。
4. **作用域范围与阶段 D 协同**：
   - 阶段 H 仅实例化 `EnumSet.of(Scope.JAVA_FILE)` 的 Detector，执行源码级 UAST 规则；`Scope.CLASS_FILE`、`Scope.RESOURCE_FILE`、`Scope.MANIFEST`、`Scope.GRADLE` 规则不在编辑期执行。
   - 阶段 D 抑制 Kotlin `FunctionName` 对 `@Composable` 函数的误报，阶段 H 的 Compose `ComposableNaming` 规则执行 Compose 命名约定检查，二者叠加后仅保留 `ComposableNaming` 诊断。
5. **阶段 H 生产验收条件**：
   - 在安装缓存的真实 ILS 会话上，确认 initialize 携带 `textDocument.diagnostic` 能力且服务端广告 `diagnosticProvider`，向 Java 与 Kotlin 文件发送标准 `textDocument/diagnostic`：
     - 同时存在编译器语法/类型错误与 `NewApi` / `UnrememberedMutableState` 时，返回 `items` 同时包含两类诊断；
     - 重跑第 14.1 节的全部 12 项 Java/Kotlin `NewApi` 用例与 4 项 Compose `UnrememberedMutableState` 用例全部通过；
     - 使用无既有 build 产物的副本，记录导入任务后再测诊断；SDK/源码字面量可确认的用例中，compileSdk、minSdk、AAR 规则发现与已构建对照一致。不能把导入自动生成的 BuildConfig 目录误判成“测试必须删除所有 build 目录”。
     - 在 `lint.xml` 中关闭规则或调整 severity 后，对应诊断按配置隐藏或改变级别；
     - 注入抛异常的规则组时，其余规则正常返回且整次诊断请求成功；
     - 连续两次相同文档版本的 `textDocument/diagnostic` 命中内部结果缓存。

### 14.7 官方插件承载点映射、AGP 兼容矩阵与演进策略

对照 `JetBrains/android`（提交 `544c9ef8`），官方桌面插件采用「`LintExternalAnnotator` 单次分析并缓存 `LintProblemData` → 100+ 个 `AndroidLint<IssueId> extends AndroidLintInspectionBase` 读取缓存生成 `ProblemDescriptor` → `InspectionProfileImpl` 动态注册」的三段式架构，强依赖 `AndroidFacet`、`AndroidModel`/`LintModel` 与 `StudioResourceRepository`。ILS 发行包不含 `org.jetbrains.android` 且诊断出口为 `textDocument/diagnostic`，故按 LSP 承载点分层映射如下：

| 官方能力             | 官方实现                                                      | ILS 承载点                                                             | 实施方案                                                                                                                                                                                        | 状态                             |
| -------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| 单文件 Lint 诊断     | `LintExternalAnnotator` + `LintProblemData`                   | `LSDiagnosticProvider`（`Flow<Diagnostic>`）                           | `OmpLintClient` + `LintDriver` 单次执行 + 内部结果缓存                                                                                                                                          | 阶段 H 计划；263 探针通过        |
| Lint 快速修复        | `LintIdeQuickFix`                                             | `LSCodeActionProvider` / `LSSimpleCodeActionProvider`                  | 阶段 H 预填 `Diagnostic.data`，修复转换留作独立后续扩展                                                                                                                                         | 未纳入本次交付                   |
| 抑制与配置           | `SuppressLintQuickFix`、`lint.xml`、`InspectionProfile`       | `LanguageInspectionSuppressors` + `LintXmlConfiguration`               | 阶段 D 抑制器 + `PositionXmlParser` 支撑 `lint.xml`                                                                                                                                             | 阶段 D/H 计划                    |
| 第三方规则装载       | `ensureInspectionsRegistered` + `LintModel`                   | `JarFileIssueRegistry` + `CompositeIssueRegistry`                      | 从库表中 classes.jar 的同级目录发现 jars/lint.jar                                                                                                                                               | 阶段 H 计划；263 探针通过        |
| 模型属性解析         | `GradleAndroidModel` / `AndroidModuleSystem`                  | 共享 Android 工程上下文、库表、KtFile 与 Manifest PSI                  | 导入模型优先，源码字面量与已构建产物补充；记录动态 DSL 限制                                                                                                                                     | 阶段 H 计划                      |
| 资源与 Manifest 导航 | `StudioResourceRepository`、`PackageClassConverter`           | XML PSI、原生 definition/references/documentSymbol Provider + `DirectNavigationProvider` | 阶段 A–C 与既有 definition 共用 JVM 服务；保留 AGP 来源校验，删除 TS XML 业务                                                                                                                   | **阶段 A/B 与 definition 已完成（271 实测通过）**；阶段 C 待实施 |
| 全工作区单次请求诊断 | `GlobalInspectionTool` / `AndroidLintGlobalInspectionContext` | 无（ILS 未提供 `workspace/diagnostic`；`workspaceDiagnostics: false`） | 仅代表不支持单次 `workspace/diagnostic` 请求，不禁止多文件并发/批量拉取 `textDocument/diagnostic` 或 MCP `lint_files`，但通用 MCP 不含 Android 规则，跨文件合并分析交由 Gradle `lintDebug` 执行 | 边界外                           |

下表是协议要求与计划条款的对应关系，“已覆盖”指计划已写明，不代表生产验收通过。

| LSP 义务                                                                                             | 协议依据                                                            | 本文对应条款                                                         | 状态               |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------ |
| 能力协商：仅声明已实现能力，不广告 `workspace/diagnostic`                                            | `ServerCapabilities.diagnosticProvider` / `textDocument.diagnostic` | §14.3 第 1、6 条；§14.6 第 5 条                                      | 已覆盖             |
| 诊断字段完整度：`range` / `severity` / `code` / `source` / `message` / `relatedInformation` / `data` | `Diagnostic` 结构                                                   | §14.3 第 2 条                                                        | 已覆盖             |
| 不使用无来源字段：`codeDescription` / `tags` 保持 `null`                                             | `Diagnostic.codeDescription` / `DiagnosticTag`                      | §14.3 第 2 条                                                        | 已覆盖             |
| 无位置事件过滤：跳过 `Location.NONE` 与零长度区间                                                    | `Diagnostic.range` 语义                                             | §14.3 第 2 条                                                        | 已覆盖             |
| 已禁用规则过滤：跳过 `Severity.IGNORE`                                                               | `Configuration.isEnabled`                                           | §14.3 第 2、4 条                                                     | 已覆盖             |
| 文档版本一致性：输出前复核 `Document` 版本                                                           | `TextDocumentItem.version`、`ContentModified(-32801)`               | §14.3 第 3 条                                                        | 已覆盖             |
| 取消传播：`$/cancelRequest` → `-32800`                                                               | `RequestCancelled(-32800)`                                          | §14.6 第 3 条；§7.5 取消验收                                         | 已覆盖             |
| 非阻塞调度：读操作内访问 PSI，`Flow` 在 IO 调度器收集                                                | LSP 请求并发语义                                                    | §14.3 第 3 条                                                        | 已覆盖             |
| 报告类型约束：合并报告固定 `full`，不用 `resultId` / `unchanged`                                     | `DocumentDiagnosticReport.kind`                                     | §14.3 第 5 条                                                        | 已覆盖             |
| 多根隔离：缓存以 `project.locationHash` 分区                                                         | `workspaceFolders` 语义                                             | §14.3 第 5 条                                                        | 已覆盖             |
| 错误码映射：`RequestFailed(-32803)` / `ProtocolMismatch`                                             | JSON-RPC error 语义                                                 | §4.4 错误表；§7.2 协议版本                                           | 已覆盖             |
| 快速修复通道：`textDocument/codeAction` + `WorkspaceEdit`                                            | `CodeAction` / `WorkspaceEdit`                                      | §14.7 承载点表（预留 `LSCodeActionProvider`）                        | **未纳入本次交付** |
| 全工作区单次诊断：`workspace/diagnostic`                                                             | `WorkspaceDiagnosticReport`                                         | 无 ILS 原生承载点（不影响多文件并发/批量 `textDocument/diagnostic`） | 单次请求不可得     |

AGP 兼容矩阵：

| AGP 场景                                                         | 处理方式                                                                                | 状态                                                                  |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| MyHook `AGP 9.4.1` + `build.gradle.kts`                          | `classes.jar`/`lint.jar` 同级发现、SDK 路径取 compileSdk、KtFile 读取已测 minSdk 字面量 | 263 已测 24 个 lint.jar；271 完整 Lint 矩阵及 AGP 8.x/其他 9.x 待验收 |
| `compileSdk { version = release(37) }`（AGP 9 DSL）              | 直接读取 `android.jar` 所在平台目录与 `source.properties`                               | 已实测                                                                |
| 多模块 `build.gradle.kts` 归属                                   | 经 `externalProjectId` / 父 contentRoot 定位 `MyHook.app` 模块                          | 已实测                                                                |
| 规则包 API 版本校验                                              | 复用官方 `JarFileIssueRegistry` 的 `Lint-Revision` / API 级别校验                       | 已实测                                                                |
| AGP 3.x–6.x（无 `transformed/` 前缀）                            | 依据“`lint.jar` 与 `classes.jar` 同处 `jars/` 目录”判定，与外层路径前缀无关             | 规则兼容，待跨版本验收                                                |
| 多 flavor 的 `minSdk` 覆盖                                       | 未构建时仅读取 `defaultConfig`，已构建时可由 `debug.xml` / `merged_manifest` 补充       | 存在未构建 flavor 覆盖缺口                                            |
| `lintChecks` / `lintPublish` 独立规则 JAR 与 `ANDROID_LINT_JARS` | 不在模块编译 classpath 内，当前库表扫描未覆盖                                           | 未支持，在文档中列明                                                  |

演进与移除条件：
- 本次迁移通过真实 ILS 验收后，删除 TS XML 解析、资源映射业务、`saxes` 依赖和 Bridge Android 语义拦截；不等上游完整实现 Android 才清除，也不删除仍承担设备编排的 `src/android/` 文件。通用协议、取消和符号展平适配独立保留。
- 上游若提供等价的 Android Provider，按模块、变体与位置集合验收后删除对应 JVM 实现，避免重复结果。若 `IntellijLintClient` 与 `AndroidFacet` 解耦且可在 ILS 加载，再替换 `OmpLintClient` 模型层。
