# Android 语言服务与调试增强计划

## 1. 目标、状态和边界

在 `omp-intellij` 中补齐 Android XML 符号、XML 到 Java/Kotlin 引用查询、Compose 命名检查适配、内嵌官方 Android/Compose Lint 实时诊断和设备端 JDWP 编排。复用 IntelliJ 的 PSI、K2 UAST、索引和调试器，参考 Android 官方插件的资源身份、作用域、规则装载和会话所有权设计。

本文是实施规格。隔离沙箱已经验证的能力、拟新增的生产接口、实施后的验收条件分别列出；当前没有把临时探针安装进共享服务，也没有修改 MyHook 生产源码。

### 1.1 交付项

| 阶段 | 交付 |
| --- | --- |
| A | Android values XML、Manifest 的 `textDocument/documentSymbol` |
| B | Manifest 类属性触发 `textDocument/references` |
| C | 资源 XML 声明触发 Java/Kotlin 语义引用查询，独立 JVM 查询模块 |
| D | 语义确认的 Composable 函数命名检查豁免 |
| E | 独立 Android `prepare-attach` / `cleanup` 编排入口，与原生 DAP 组合 |
| F | 断连清理、新会话恢复及多工程隔离验收；仅修复复现的缺陷 |
| G | 开启 intellijExtensions 协议扩展支持，完整支持 ModCommand QuickFix，不新增 Bridge 黑名单 |
| H | 同进程内嵌官方 Android Lint 与 AAR Compose 规则，经 `LSDiagnosticProvider` 接入原生 `textDocument/diagnostic` |

### 1.2 边界

- 不移植整个 Android Studio、`AndroidFacet`、`ResourceRepository`、VFS 或 Light R 系统。
- 不新增 Android rename、XML completion、Compose Preview、Profiler、native LLDB 或混合调试；阶段 H 仅执行源码级 UAST 规则（内置 `NewApi` 等与随 AAR 分发的 Jetpack Compose 规则），不等同于全项目跨 XML/资源合并的 Gradle `lintDebug` 任务。
- 上游服务端基线：`263.7084.0` 与 `271.2085.0`（Open VSX `1.0.86`）均不含独立的 `android.lsp`；上游 `xml.lsp`、`yaml.lsp`、`properties.lsp`、`spring.lsp`、`bazel.lsp` 与 Android 扩展正交兼容，`271.2085.0` 的 EULA SHA-256 前 16 位仍为 `cd82e6cdaf2790f1`。
- 复用 `intellij-server` 内置的 `com.jetbrains.ls.imports.gradle.model.builder.android.AndroidProjectModelBuilder`：直接消费已导入 `ProjectLibraryTable` 的变体模块（如 `MyHook.app.debug`）、`Gradle: android:android-sdk:null`（`android.jar`）、编译期 `R.jar` 以及解包后的 AAR `jars/classes.jar` 路径。
- 引用查询采用 PSI 语义搜索；XML 到 XML 的全项目资源引用另行设计。
- 查询与诊断不触发 Gradle 同步或构建；支持未构建（`clean`）状态下通过已导入模型、源码 `AndroidManifest.xml` 与 `build.gradle.kts` 的 `KtFile` PSI 工作。设备附加不自动构建、安装、启动、重启或结束目标应用。
- DAP 调试保持原始物理栈帧透传：不在 `dap-proxy` 中删改或伪造折叠帧，避免破坏 `stackFrame.id` 与闭包捕获变量求值；需要限制栈深时使用标准 DAP `levels` 参数。
- 不接受新 EULA、不修改全局设备调试设置、不关闭其他调试器、不因一次连接失败重启共享 ILS。
- 非 Android 请求沿用原生行为。支持节点的前提失败返回明确错误，不用空结果掩盖失败。

## 2. 已完成研究与实测基线

研究日期：2026-11-04 至 2026-11-05。主要环境：ILS `263.7084.0`（及上游 `271.2085.0` 归档逆向）、JBR `25.0.4.1`、AGP `9.4.1`、Gradle `9.8.0`、Android 工程 `F:/source/MyHook`。

### 2.1 确定结论

| 项目 | 已观察结果 | 实施决定 |
| --- | --- | --- |
| XML 路由 | OMP 的 fileTypes 缺少 `.xml`；补齐并 reload 后 XML 请求到达 ILS | 安装/路由问题已有结论；保留 `.xml` 声明 |
| 原生 XML 导航 | strings.xml 的原生 definition、references 返回 `[]`；XML URI 调用 resolveLaunch 返回 `-32803 No file found` | TS 解析 XML，按精确模块名调用独立 JVM 命令 |
| R 反编译位置 | 两个 R 字节码候选的 references 在 true/false 下均为空；didOpen 反编译文本后仍为空 | 不使用反编译坐标转发资源 references |
| 直接字段搜索 | 当前分析上下文内取得 `ClsFieldImpl`，找到 nav_settings 三处真实源码引用 | 使用直接 `PsiField` 和 `ReferencesSearch` |
| 资源命令 | `omp.findResourceFieldReferences` 出现在 initialize 的命令广告中，实际返回三处引用 | 沿用此命令入口，生产增加严格版本及参数契约 |
| 合法零引用 | app_name 的字段解析成功，Java/Kotlin 引用为零 | 成功 `[]` 与解析失败分别处理 |
| 取消 | 探针等待阶段取消返回 `-32800`，执行 CANCELLED_EXIT / FINALLY_EXIT；并发正常请求仍返回三处 | 接通端到端取消；搜索遍历中途取消用内存多文件沙箱做生产验收 |
| XML 范围 | CRLF、emoji、实体、单引号、多行属性、style/attr 层级均通过现有解析器实测 | 复用 XML 解析和 UTF-16 范围 |
| 不完整 XML | 未闭合、未加引号属性、错配结束标签均抛异常，不保留部分树 | 保守保留原生结果；不新增正则或容错解析器 |
| Compose 命名豁免 | 单次 explicit 注册后，七项真实诊断正反用例通过；EP-only 注册未进入检查调用链 | 独立 JVM 模块内采用服务端生命周期单次注册 |
| 原生诊断挂载入口 | `LSConfigurationPiece.entries` 注册 `LSDiagnosticProvider`（按 `LSLanguage.lspName` 匹配 `"java"` / `"kotlin"`），ILS 用 `Flow` 并发合并返回 | 采用 `LSDiagnosticProvider` 直通 `textDocument/diagnostic`，无需 TS 层拦截拼装 |
| 内嵌 Lint 与 Compose 规则 | 同进程复用 `DefaultUastParser` 与 K2 `KotlinUFile`，`NewApi`（Java/Kotlin 12 用例）与 Compose `UnrememberedMutableState`（正反例、抑制、同文件并发）全部通过，单次耗时 6–39ms | 正式纳入阶段 H；在 `OmpLintClient.createUrlClassLoader` 屏蔽 Windows 提前 `close()` |
| Lint 运行依赖集 | 从 43 个 JAR（43.94 MB）逐项剔除实测，5 JAR 组合在 `NewApi`/`UnrememberedMutableState` 上通过；因 `DefaultJavaEvaluator.getDependencies()` 等字节码依赖，完整 androidx 规则集需 6 个核心 JAR（新增 `tools.lint-model`，共 11,362,788 字节 / 10.84 MiB），0 日志错误、0 崩溃 | 随插件 `lib/` 目录固定分发这 6 个核心 JAR（缩减 74.1% 体积），不打包 `lint-psi` 或重复编译器；若收窄规则集才可回退 5 JAR |
| 零构建模型与 AAR 发现 | `ProjectLibraryTable` 中 83 个 AAR 的 `jars/classes.jar` 同级目录 100% 发现 24 个 `jars/lint.jar`（含 13 个 Compose 模块）；`build.gradle.kts` 的 `KtFile` PSI 可直接读取 `namespace`、`minSdk`、`targetSdk` | 优先使用已导入库表与内存 PSI，已构建产物（`lint_report_lint_model` / `merged_manifest`）作为补充校验，彻底解除对 `build/` 的前置依赖 |
| Android DAP | API 36.1 x86_64 的运行进程和等待调试进程，均通过原生 debug 工具命中断点、读取变量、单步、detach | 开发设备编排，保留现有调试引擎，保持物理栈帧透传 |
| 恢复 | 隔离服务退出后旧 Bridge 退出，新 Bridge 自动启动新服务并恢复真实 definition | 新会话重建；不重用旧 Socket 会话 |
| QuickFix | 实际 RenameFix warning 对应的诊断 fixes=[]，codeAction 无 Rename；Create method 对照正常 | 当前无新增过滤代码的依据 |

### 2.2 资源与模型的具体证据

- `nav_settings` 三处源码位置为 `MyHookBottomBar.kt:53`、`:56`、`SettingsScreen.kt:73`，此处行号从 1 开始。
- 源引用 resolve 与 `JavaPsiFacade` 在该源文件 resolveScope 查类，两路取得同一字段；在此 MyHook 场景下 effectiveScope、projectScope、allScope 三种搜索都返回上述三处。
- 内存文档实验覆盖 Kotlin import 别名、Java 显式 static import、限定引用和同名局部变量遮蔽。直接字段搜索找到真实引用，排除了同名局部变量。
- 从 Kotlin 别名使用点直接发原生 references 返回空；从原字段入口能找到别名使用点。因此 XML 路线直接查询原字段。
- MyHook 当前编译期 `compile_r_class_jar/debug/generateDebugRFile/R.jar` 为 1 个包、6 个类；打包期 `compile_and_runtime_r_class_jar/debug/processDebugResources/R.jar` 为 101 个包、277 个类。两者用途和资源来源分别记录。
- 既有 AGP 隔离实验中，两模块使用相同 namespace 均能生成 R 类；同时依赖时出现字段的 classpath 遮蔽。不同 namespace 的同名资源分别生成各自字段；非传递 R 和 merger 的覆盖来源也已验证。
- 原生导出模型的 app/debug/unitTest/androidTest 可以共享 `externalProjectId=:app`；选择必须结合精确模块名、contentRoot、sourceSet/variant，不能仅靠 Gradle projectId。
- 当前 `parseModules` 保留 module 依赖；生产查询需要同时保留原始 library 依赖及类根来源。
- `package-aware-r.txt` 是首行 package、后续 type/name 两列；不能用三列格式解析。
- 资源 definition 的现有来源校验已返回 strings.xml 的 `nav_settings` 声明，LSP 零基范围 `56:18–30`。

补充二进制多模块实测：独立 `jarA.jar`、`jarB.jar` 都含 `com.probe.samens.R.string.test_field`，consumerA 依赖 A，consumerA2 通过 consumerA 传递依赖 A，consumerB 只依赖 B。真实原生 definition 分别定位到 A/A/B；从 consumerA 发原生 references 只返回 A、A2 两处，从 consumerB 发请求只返回 B 一处。原生语义在这个场景已正确隔离，没有“projectScope 已被证明串模块”的结论。

该实验的实际入口为原生 LSP workspace/symbol、definition、references，未执行直接 SPI 的两种 scope 对照。MyHook 的两个 R 候选也来自原生符号/definition；底层 `findClasses` 枚举和生产模块范围收缩作为明确实现及验收项。纯 binary 库是模型中的 library，不是可直接调用 moduleWithDependentsScope 的 Module。

### 2.3 原生 Manifest references 基线

下表是直接从类源码发出的原生请求，尚未加入当前 XML 属性。行号从 1 开始。

| 类 | 声明行 | false | true | 结果内容 |
| --- | --- | --- | --- | --- |
| MainActivity | MainActivity.kt:34 | 2 | 3 | McpForegroundService.kt:22 的 import、:171 的类使用；true 加声明 |
| HookLogProvider | HookLogProvider.kt:35 | 1 | 2 | QimeiRepository.kt:41 的 KDoc 符号链接；true 加声明 |
| McpForegroundService | McpForegroundService.kt:38 | 8 | 9 | 本类 3 处、SettingsViewModel 3 处、MainActivity 2 处；true 加声明 |

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

## 3. 官方实现参照与采用范围

固定 Android 源码基准：`JetBrains/android` 提交 `544c9ef84f8ee3024c1f9779725db34bf5dd38a6` 及 AOSP `platform/tools/base` 的 `lint-api` / `lint-checks`。

| 源码 | 采用内容 |
| --- | --- |
| [AndroidResourcesFindUsagesHandlerFactory](https://github.com/JetBrains/android/blob/544c9ef84f8ee3024c1f9779725db34bf5dd38a6/android/src/org/jetbrains/android/AndroidResourcesFindUsagesHandlerFactory.kt) | 资源身份、按上下文缩小搜索范围；attr/styleable 需要额外字段搜索，文件资源另有补充路径 |
| [ResourceRepositoryToPsiResolver](https://github.com/JetBrains/android/blob/544c9ef84f8ee3024c1f9779725db34bf5dd38a6/android/src/com/android/tools/idea/res/psi/ResourceRepositoryToPsiResolver.kt) | 声明来源、限定符和 useScope 组合；不把同名资源全局合并 |
| [ResourceStructureViewBuilder](https://github.com/JetBrains/android/blob/544c9ef84f8ee3024c1f9779725db34bf5dd38a6/android/src/org/jetbrains/android/dom/structure/resources/ResourceStructureViewBuilder.java) | 源码顺序、style/item、declare-styleable/attr 层级 |
| [PackageClassConverter](https://github.com/JetBrains/android/blob/544c9ef84f8ee3024c1f9779725db34bf5dd38a6/android/src/org/jetbrains/android/dom/converters/PackageClassConverter.java) | Manifest base package、模块依赖作用域、相对名和 `$` 内部类规范化 |
| [ResourceFolderManager](https://github.com/JetBrains/android/blob/544c9ef84f8ee3024c1f9779725db34bf5dd38a6/android/src/org/jetbrains/android/facet/ResourceFolderManager.kt) / [ResourceFolderRegistry](https://github.com/JetBrains/android/blob/544c9ef84f8ee3024c1f9779725db34bf5dd38a6/android/src/com/android/tools/idea/res/ResourceFolderRegistry.kt) | 变体资源根、覆盖优先级、工程根和文档变更失效 |
| [ComposeSuppressor](https://github.com/JetBrains/android/blob/544c9ef84f8ee3024c1f9779725db34bf5dd38a6/compose-ide-plugin/src/com/android/tools/compose/ComposeSuppressor.kt) | 仅豁免语义确认的 Composable 标识符的特定命名检查 |
| [GradleAndroidModel](https://github.com/JetBrains/android/blob/544c9ef84f8ee3024c1f9779725db34bf5dd38a6/project-system-gradle/src/com/android/tools/idea/gradle/project/model/GradleAndroidModel.kt) | `minSdkVersion`、`targetSdkVersion`、变体属性优先级与未构建保底规则 |
| `DefaultUastParser` / `DefaultJavaEvaluator` / `JarFileIssueRegistry`（`tools.lint-api.jar`） | 直接绑定 IntelliJ `Project`、VFS、`PsiManager`、`UastFacade` 与 AAR 自定义 `lint.jar` SPI 装载 |
| [AttachOnWaitForDebuggerMonitor](https://github.com/JetBrains/android/blob/544c9ef84f8ee3024c1f9779725db34bf5dd38a6/android/src/com/android/tools/idea/run/AttachOnWaitForDebuggerMonitor.kt) | 以真实进程/JDWP 状态为依据，避免重复附加 |
| [AndroidConnectDebugger](https://github.com/JetBrains/android/blob/544c9ef84f8ee3024c1f9779725db34bf5dd38a6/execution/common/src/com/android/tools/idea/execution/common/debug/utils/AndroidConnectDebugger.kt) / [StartJavaDebuggerSession](https://github.com/JetBrains/android/blob/544c9ef84f8ee3024c1f9779725db34bf5dd38a6/execution/common/src/com/android/tools/idea/execution/common/debug/impl/java/StartJavaDebuggerSession.kt) | 会话归属、调试器完成握手、分离和新建会话分别处理 |

采用机制，不复制 Studio 整套依赖。协程读操作遵循 [IntelliJ Coroutine Read Actions](https://plugins.jetbrains.com/docs/intellij/coroutine-read-actions.html)；协议遵循 [LSP 3.17](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/) 和 [DAP](https://microsoft.github.io/debug-adapter-protocol/specification)。

## 4. 架构、文件和共享协议

### 4.1 模块分工

| 文件/模块 | 职责和改动 |
| --- | --- |
| `src/android/xml.ts`、`types.ts` | 复用解析、属性原始范围和 UTF-16 转换；只增加共享类型 |
| `src/android/navigation.ts` | 复用模型/namespace/Manifest 类身份；抽出可共享上下文，保持现有 definition 契约 |
| `src/android/resource-resolver.ts` | 复用 AGP 资源来源、覆盖和快照校验 |
| 新 `src/android/document-symbols.ts` | Android XML 本地符号树，不依赖 JVM 搜索或新增 Gradle 调用 |
| 新 `src/android/references.ts` | XML 请求识别、身份校验、原生类请求/JVM 资源命令及结果组合 |
| `src/shared/navigation-relay.ts` | 方法区分、版本、父子请求、取消和一次响应；不解析 Android 业务 |
| 新 `jvm/android-ls-extension/` | 独立 PSI 资源命令、Compose suppressor 与 `OmpLintDiagnosticProvider`（`LSDiagnosticProvider`）；不依赖 TS 实现 |
| 新 `src/android/debug-attach.ts`、`debug-attach-cli.ts` | ADB 设备/PID/forward 与所拥有映射的生命周期 |
| `src/debug/dap-proxy.ts` | 毫秒超时统一、窄的异步 attach/关闭生命周期钩子；不导入 ADB 业务，保持栈帧原样透传 |
| `src/plugin.ts`、发布配置、通用服务启动层 | 版本绑定的插件目录资产（自有 JAR + 6 个核心 Lint JAR）、runtime hash 和启动参数；不依赖资源/Compose 逻辑 |

修改导出接口前查询 references，迁移所有调用方，不保留旧签名或探针兼容路径。

### 4.2 路由与返回约定

- 原生错误原样返回；正常非空原生结果优先采用。未支持节点保留原生响应。
- Android references 识别为支持节点后，前提失败返回 RequestFailed；合法零引用返回 `[]`。不再用 `null` 同时表示“不接管”和“查询失败”。
- references 内部采用可区分的 pass / result / error 结果类型；definition 保持原有可选增强语义，不借本次工作全局改变其失败行为。
- references 传入 `context.includeDeclaration`；documentSymbol 读取 initialize 的实际客户端能力和结果类型。
- Java/Kotlin `textDocument/diagnostic` 由 ILS 原生 `LSDiagnostic` 并发聚合内置编译器/Inspection 诊断与 `OmpLintDiagnosticProvider` 返回的 Android/Compose Lint 诊断，Bridge 不二次拦截改写诊断流。
- 请求以当前已同步文档为准；失同步文档不回读旧磁盘内容。
- 同一次 LSP 会话发内部请求，确保使用同一组未保存文档；不另开连接做查询。

### 4.3 取消、失效和并发

1. 客户端 ID 关联本次增强任务及所有内部 ID；内部 ID 不发给客户端。
2. 内部 RPC 延用有界截止时间；客户端取消、超时、didChange、模型失效、shutdown、socket close 均取消关联子请求并释放记录。
3. 原生响应接收后异步调度增强；不能在串行 `fromClient` 处理器里 await 后端命令，否则后续 didChange/cancel 无法被消费。
4. 捕获文档版本和现有模型/构建快照标识；提交前再次核验。未保存 XML 声明改变后，不能继续拿旧 merger 查询新名称。
5. 每个客户端请求只产生一次响应；吞掉已结束任务的内部迟到响应，不吞掉上游原始错误。
6. Windows URI 按规范本地路径比较和去重，保留 jar entry 身份；结果位置按真实 `PsiReference` 区间换算，不擅自缩到最后一个标识符。

| 条件 | 外部协议结果 |
| --- | --- |
| 支持节点且查询成功，无引用 | `result: []` |
| 缺少构建快照 | `-32803`，`data.reason=missing_snapshot` |
| 构建/资源来源过期 | `-32803`，`data.reason=stale_snapshot` |
| 模块/变体、目标或来源歧义 | `-32803`，具体 reason 和已核实候选 |
| 扩展未加载、版本不匹配 | `-32803`，`extension_unavailable` / `unsupported_server_version` / `protocol_mismatch` |
| 已识别声明找不到对应类/字段 | `-32803`，`class_not_found` / `field_not_found` |
| 请求期间文档内容改变 | `-32801 Content modified` |
| 客户端取消 | `-32800 Request cancelled` |
| 增强内部请求到期 | `-32803`，`data.reason=timeout`，同时取消子请求 |
| 不支持的节点/文件 | 原生响应，不产生伪错误 |

## 5. A：Android XML DocumentSymbol

### 5.1 文件识别和解析

- 文件须属于已确认 Android 源集。Manifest 校验根节点和实际文件角色；values 文件位于已知资源根的合法 values 限定符目录，根节点为 resources。
- 优先复用缓存的导出模型和资源根信息。已知源集下的标准资源目录可识别；自定义目录须有模型/来源证据，不能递归扫描任意 XML。
- 符号生成不要求已有 R.jar；文件身份无法确认时保留原生结果。
- 使用当前文档的 `parseXml`。禁用 DTD/外部实体；语法错误 catch 后保留原生结果，不返回残缺树。
- selectionRange 使用属性原始文本范围，不用实体解码后字符串长度计算。range 包含整个元素，selectionRange 必须位于其中。

### 5.2 符号树规则

| 节点 | name | kind | 层级/说明 |
| --- | --- | --- | --- |
| string | 资源名 | String(15) | values 顶层 |
| color、dimen | 资源名 | Constant(14) | detail 保留实际类型 |
| bool / integer | 资源名 | Boolean(17) / Number(16) | 不根据内容猜类型 |
| array、string-array、integer-array、plurals | 资源名 | Array(18) | 不为匿名 item 虚构资源名 |
| style | 资源名 | Class(5) | 有名称的 item 为 Property(7) 子节点 |
| declare-styleable | 资源名 | Interface(11) | attr 为 Property(7) 子节点 |
| attr | 资源名 | Property(7) | 独立或位于 declare-styleable |
| id | 资源名 | Variable(13) | 包括相应 item 声明 |
| `item type=T name=N` | N | T 对应 kind | 仅识别实际资源声明 |
| manifest | package 或 manifest | Namespace(3) | application、instrumentation 的父节点 |
| application | android:name 或 application | Module(2) | 组件父节点 |
| activity/service/provider/receiver | android:name 原文 | Class(5) | 必须位于 application 下 |
| activity-alias | android:name 原文 | Interface(11) | name 为别名标识符 |
| instrumentation | android:name 原文 | Class(5) | 位于 manifest 根下 |

values 的 resources 容器不虚构为资源符号。匿名 Manifest 容器的 selectionRange 使用标签名；具名节点使用名称属性。保持源码顺序，未知节点、注释及缺名资源跳过。

### 5.3 能力与验收

- 读取真实客户端的 `hierarchicalDocumentSymbolSupport`，支持则返回 DocumentSymbol[]，否则 DFS 展平为带 uri/containerName 的 SymbolInformation[]。
- 已核实仓库中的原生运行客户端会广告层级支持；安装后仍读取实际 initialize 数据，不硬编码所有 OMP 客户端都如此。
- 只声明 documentSymbol 能力，不声明 XML workspace/symbol。
- 验收 MyHook strings.xml、Manifest；未保存改名、CRLF、emoji、实体、单引号、多行属性、错误 XML、非 Android XML；精确核对名称和 range，Java/Kotlin 原生行为保持。

## 6. B：Manifest 类属性 references

### 6.1 支持的节点

- application/activity/service/provider/receiver 的 android:name，根 instrumentation 的 android:name，以及 activity-alias 的 android:targetActivity。
- 校验 Android namespace URI 和 DOM 层级；activity-alias 的 android:name 仅为结构符号，不当作类。
- permission/action/category、未解析 `${...}` 属性不接管。

### 6.2 目标和结果

1. 复用现有 Manifest definition 上下文。base package 来自已确认 Manifest/模块模型；不以 applicationId 后缀代替 namespace，不正则解析 build.gradle。
2. 按 PackageClassConverter 的相对名/候选规则和 `$` 到 `.` 规则规范化；在当前模块依赖范围内验证完整类身份。
3. 通过现有原生符号/definition 找唯一声明位置；不按 simpleName 取第一项。多个不同目标未消歧时返回 `ambiguous_target`。
4. 对已确认类位置发原生 references，原样传 includeDeclaration。使用真正的 Kotlin/Java 语义结果，保留 KDoc 链接。
5. 将当前查询 XML 属性范围作为类引用加入，并规范 URI/range 去重。false 仍包含此属性；true 另外包含原生类声明。
6. 不扫描全仓 Manifest/XML，不把当前查询结果描述成完整跨 XML Find Usages。库字节码入口无法解析时明确报 `target_unresolved`，不当作合法零引用。

当前 MyHook 原生基线不含 XML；生产接入后 MainActivity 的 false/true 应为 3/4 项、HookLogProvider 为 2/3 项、McpForegroundService 为 9/10 项，均包含当前查询属性。

### 6.3 验收

逐项核对三个组件；覆盖相对名、完整名、内部类、同名不同包、依赖模块、别名目标、placeholder 和 namespace 前缀变换。验证 false/true、当前属性去重、取消和编辑失效。

## 7. C：资源 XML 声明到代码 references

### 7.1 身份与快照

- 逻辑身份包含 namespace、resource type、原始名称；查询身份另含精确模块/变体、构建来源和实际 R 字段名。
- XML 声明必须通过现有 AGP 来源/merger 校验，证明属于当前选定构建。限定符声明共享逻辑身份，返回声明仍以当前 XML 位置为准。
- 分别保留声明来源、可见编译字段和最终覆盖来源；它们不是同一数据。
- 用精确模块名和最长匹配 contentRoot 选择上下文。多个变体同样匹配且没有唯一当前构建证据时返回 `ambiguous_variant`，不默认 debug。
- 类型/名称转换复用现有资源键规范，并与 package-aware 符号清单及真实字段核对；点号 style、array 等名称不能只靠字符串猜测。
- 未保存 XML 修改资源声明时，旧构建快照失效；只编辑 Java/Kotlin 使用点时，在同会话已同步的 PSI 上查询当前内容。

### 7.2 独立命令的生产契约

命令保持 `omp.findResourceFieldReferences`。通过 `workspace/executeCommand`，arguments 为一个对象；下列为拟新增的生产协议 v1，探针中的固定默认值、delayMs 和手工 JSON 均删除。

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

type/name 是已核对的 R 类型和字段名。classOrigins 是 Bridge 根据当前模型和 AGP 来源确认属于本次资源 owner/变体的物理编译产物集合，不能把所有依赖 jar 都放入；值为规范 file URI，具体可见候选仍由服务端验证。Bridge 保留 XML 原始声明身份与快照。参数缺失、非法类型用 `-32602 Invalid params`；协议版本不匹配使用 `-32803 protocol_mismatch`。服务端不能回退到第一个模块/allScope。

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

references 为标准 Location[]；origin.classOrigins 返回实际参与查询的物理类来源，Bridge 核对其均属于请求证明的 owner/快照。例子展示响应格式，`references: []` 表示合法零引用；nav_settings 在当前基线返回三处。失败为 JSON-RPC error，不保留探针的 status + 空数组失败格式。未知命令当前原生响应为 `-32600`；Bridge 在命令未广告时先报告 `extension_unavailable`，原生真实错误仍原样透传。

### 7.3 服务端执行

1. `LSCommandDescriptorProvider` 作为 LSConfigurationPiece.entries 注册。构造器顺序为 `LSCommandDescriptor(title, name, executor)`。
2. `server.withAnalysisContext` 获取本次 `ctx.project`；不静态缓存 Project/PsiField，不使用 ProjectManager 第一个工程。
3. 先确定资源 owner 模块及下游消费模块。类定位使用这些模块的 dependencies-and-libraries scope；用 `JavaPsiFacade.findClasses` 枚举，而非把 projectScope 用于查编译库。
4. 按请求证明的 classOrigins 过滤物理 archive/entry，区分同 owner 的编译副本与独立同 FQN 库。对同 owner 且当前可见的字段副本逐一做语义搜索并去重；独立库不因名称相同而合并。候选多于一个本身不等于冲突，归属无法证明时报告 `ambiguous_target`，关键候选查询失败不返回部分集合。
5. 本地资源的源码范围采用 ownerModule.getModuleWithDependentsScope() 与 projectScope 的交集，保留真实 PSI 身份判定。此范围收缩是保守设计，不是已复现的原生搜索 bug；新增直接命令验收须确认不遗漏传递消费方。纯 binary 库 owner 必须来自模型，缺失则报告 `owner_unresolved`，不能任取调用方。
6. 使用平台 suspend `readAction`，循环内每步调用 `ProgressManager.checkCanceled()`；不在普通 `ReadAction.compute` 中阻塞长搜索，不吞 CancellationException/ProcessCanceledException。Java 实现直接将原生 Continuation 传给挂起 API 并返回其结果，不用普通 finally 跨挂起点模拟生命周期。
7. 读操作可能被写操作取消后重试；每次尝试内部收集结果，结束后才返回纯 Location 数据，避免重试重复追加。
8. `element.textRange.startOffset + reference.rangeInElement` 计算真实范围；在读操作内取当前 Document 的行列。读锁外不保存 PSI 对象。

### 7.4 支持范围与 includeDeclaration

| 范围 | 生产计划 |
| --- | --- |
| string | 已有字段搜索、身份和取消探针；接入标准 XML 请求 |
| color/dimen/bool/integer/array/plurals/id/style 等普通 values 声明 | 按真实符号清单映射 R 字段，逐类型验收 |
| drawable/mipmap/layout/anim/animator/raw/xml 等文件资源 | 保留独立文件资源处理，按现有来源映射和真实字段逐类型验收；不把文件任意位置当成资源名称 |
| declare-styleable/attr 派生字段、`@+id` 的跨布局声明 | 官方另有扩展搜索路径，本次不冒充已实现；保留原生行为并在支持说明列明 |
| Android 框架、AAR 外部 XML 声明、未解析 placeholder、XML 到 XML 搜索 | 不由本阶段接管 |

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

| 类别 | 错误码 (`error.code`) | 说明与恢复建议 |
| --- | --- | --- |
| **环境** | `adb_not_found` | 未找到 ADB 可执行文件；检查 ANDROID_HOME 或指定 `--adb` |
| | `no_device` | 未发现已连接设备 |
| | `ambiguous_device` | 存在多台已连接设备但未指定 `--device` |
| | `unauthorized_device` | 设备未在屏幕上接受 USB 调试授权 |
| | `device_offline` | 设备处于 offline 状态 |
| **目标** | `process_not_found` | 指定包名无运行中进程，或目标未启用 debuggable |
| | `ambiguous_process` | 目标包名存在多个运行进程，需显式指定 `--pid` |
| | `not_jdwp` | 进程存在但不在 `adb jdwp` 列表中（未开启调试支持） |
| | `target_changed` | 在准备与建立期间目标 PID/进程名发生变动 |
| **租约** | `forward_failed` | `adb forward tcp:0 jdwp:<pid>` 执行失败或退出码非 0 |
| | `lease_conflict` | 目标进程在当前设备上已存在活动且未过期的租约 |
| | `lease_not_found` | 指定的 cleanupKey 格式非法或未记录 |
| **协议** | `attach_failed` / `timeout` | 后续 DAP 阶段握手失败或超时 |

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

| 故障层 | 处理 |
| --- | --- |
| OMP 未发现 LSP/插件安装链 | 查本地 marketplace、生成配置和 fileTypes；不重启健康服务 |
| Bridge/socket 结束，服务端健康 | 结束旧请求，释放本连接租约；新客户端重新初始化 |
| 已验证拥有的服务进程退出 | 现有生命周期锁/owner 检查清理旧状态，新客户端启动新服务 |
| 服务端存活但无响应/索引停滞 | 截止时间失败并报告阶段；不盲目 kill/restart |
| DAP 结束 | 清理本次会话及 forward；新会话重新配置断点/线程，不继续旧 session ID |

现有恢复行为已有实际正例，暂不新增心跳、无限重连或跨会话状态重放。LSP 新会话重新 initialize、导入及同步当前文档；客户端负责重新发送所需文档。

### 10.2 生产验收

既有实验已覆盖双工程隔离、关闭一个连接不影响另一个、服务进程退出及新 Bridge 启动后真实 definition。新增路径还需覆盖初始化、索引等待、内部资源 RPC、暂停 DAP 时断连，核对子请求/forward/租约释放。

安装缓存中的 OMP 原生客户端须完成新会话真实查询。若 OMP 管理器未重建已退出客户端，定位并报告该层证据；Bridge 不假装透明恢复。

## 11. G：QuickFix 处理决定

RenameFix 曾出现的丢失现象已查明根因并解决：服务端在转换包含剪贴板或重命名等交互指令的 `ModCommand` 时，若客户端未在 `initializationOptions` 声明 `intellijExtensions: true` 与 `lazyIntentions: true`，服务端会将该指令整体置为 `null` 导致整条修复被丢弃。

现已在 `src/bridge.ts` 与 `.omp-plugin/marketplace.json` 默认开启上述选项，实测 `Rename` QuickFix 正常生成，执行 `applyModCommand` 时服务端正常下发 `intellij/runEditorCommand {"command": "editor.action.rename"}`。不新增针对特定 Java 类名的 Bridge 黑名单或过滤代码。

## 12. 独立 JVM 模块、打包和版本

### 12.1 构建与内容

- 独立目录 `jvm/android-ls-extension/`，以当前 ILS 发行包作为 compileOnly SDK。Java 25 / classfile 69，与实测服务端运行时一致。
- 自有 JAR（`android-ls-extension.jar`）只含自有类、`META-INF/plugin.xml`、SPI services（`META-INF/services/com.jetbrains.ls.api.features.LanguageServerExtension`）和版本元数据；不 shade ILS、Kotlin、协程或 Android Studio 的二进制。
- `plugin.xml` 依赖声明包含 `org.jetbrains.ls.core`、`com.intellij.modules.platform`、`com.intellij.modules.java` 及 `org.jetbrains.ls.plugin.kotlin`。
- 编译 classpath 取自同一 ILS 发行包（lib 下的 `intellij.platform.core.jar`、`intellij.platform.analysis.jar`、`intellij.platform.projectModel.jar`、`intellij.platform.uast.jar`、`language-server.api.core.jar`、`language-server.api.features.jar`、`language-server.api.impl.analyzer.jar`、`language-server.analyzer.jar`、`intellij.libraries.jetbrains.annotations.jar`、`intellij.libraries.kotlin.reflect.jar`、`intellij.libraries.kotlinx.coroutines.core.jar`，plugins/java/lib 下的 Java PSI/UAST JAR，plugins/kotlin/lib 下的 `intellij.libraries.kotlinc.kotlin.compiler.common.jar`、`intellij.libraries.kotlinc.analysis.api.jar`），再加上第 14.2 节固定的 6 个核心 Android Lint JAR。
- 使用该精确发行包的 JBR25 工具链。新增 `jvm/android-ls-extension/build.mjs`，执行 `npm run build:jvm -- --ils-home <已安装的ILS目录>`，用 javac/JAR 工具构建，固定条目顺序和时间戳。
- `package.json` 配置调整：
  - `"files"` 列表变更为：`["src/", "jvm/android-ls-extension/", "resources/ils/", "settings.json", ".omp-plugin/marketplace.json", "README.md"]`，**彻底移除 `"dist/"`**（因 OMP 插件通过 `src/plugin.ts` 在安装目录即时转译至 `.runtime/`，根目录 `dist/` 仅为本地开发测试临时产物）；
  - `"scripts"` 新增 `"build:jvm": "node jvm/android-ls-extension/build.mjs"` 与 `"check:assets": "node jvm/android-ls-extension/check-assets.mjs"`；
  - `"prepack"` 脚本变更为 `"npm run build && npm run check:assets"`（静态校验 `resources/ils/` 下发布的 7 个 JAR 资产均存在且 SHA-256 吻合，不强求打包机存在 JDK25/ILS 编译环境）。
- 复制 Apache-2.0 参考代码及分发 Apache-2.0 Lint 运行库时保留必要版权与许可证声明；整个 ILS/Kotlin 发行包继续沿用既有下载和 EULA 流程。

### 12.2 安装资产链与插件目录布局

1. 发布资产采用标准 IntelliJ 插件目录布局：`resources/ils/263.7084.0/android-ls-extension/lib/`，内含自有 `android-ls-extension.jar` 与第 14.2 节验证的 6 个运行依赖 JAR（合计约 10.84 MiB），并附带模块协议/编译 ABI 与 SHA-256 清单。
2. 通过 `npm pack --dry-run --json --ignore-scripts` 检查包清单，确认自有 JAR 与 6 个 Lint 依赖 JAR 均在归档内，且根目录 `dist/**` 完全排除。
3. `src/plugin.ts` 二进制与文本分流资产链：
   - 文本资产（`settings.json`、`marketplace.json`、`package.json`）按 `utf8` 字符串参与 hash 与复制；
   - 二进制资产（`resources/ils/**/*.jar`）通过 `readFile` 直接作为 `Buffer` 读取，二进制字节注入 SHA-256，随后在 staging 阶段以 `writeFile` 字节原样复制至 `.runtime/<hash>/resources/...`，严禁经过 UTF-8 解码；
   - 任意 JAR 字节改变必须产生新 runtime hash。
4. `.runtime/` 目录生命周期与治理：
   - 遵循 `settings.json` 中 `cachePolicy.automaticDeletion = false` 的原则，启动时不静默批量删除历史目录（避免误删并行会话正在使用的旧 runtime）；
   - `src/plugin.ts` 启动时仅清理生成时间超过 1 小时的 `.tmp` 暂存孤儿目录（崩溃残留）；
   - 提供显式 `npm run clean:runtime` 命令供开发者或升级通道主动清理不使用的历史 hash 目录。
5. 通用服务启动层接收版本匹配的扩展目录路径，通过已验证的 `IJ_JAVA_OPTIONS=-Dplugin.path=<插件目录>` 机制加载（使自有 JAR 与同目录 `lib/` 下的 6 个 Lint JAR 处于同一个 `PluginClassLoader` 中）；保留用户其他 JVM options，正确处理 Windows 空格和正斜杠路径。
6. 现有服务已经运行时不热塞新 JAR；遵循租约/debug session/owner 校验及显式安全重启，不能杀共享用户会话。
7. 未提供当前 ILS 精确版本的扩展资产时不尝试加载不兼容 ABI；C 与 H 返回明确原因，基础 Java/Kotlin 和无需 JVM 扩展的 A/B 保留。
### 12.3 本地 marketplace 和上游更新

开发安装的前提是 marketplace list 的来源为 `F:/source/omp-intellij`。使用真实本地市场安装链：

```sh
omp plugin marketplace update omp-intellij
omp plugin install --force omp-intellij@omp-intellij
```

核对安装缓存中 `.runtime`、`.lsp.json`、`.dap.json`、JAR 资产目录和源码属于同一次版本；核对原生 LSP/DAP 发现、命令广告及 `textDocument/diagnostic` 返回，不能以扩展工具可调用代替验证。

版本矩阵固定记录两条轨道，二者不互相外推：
1. **默认安装版本 `271.2085.0`**：`DEFAULT_SERVER_VERSION` 已更新；JetBrains manifest 与 Open VSX `1.0.86` 解析结果一致；darwin/linux/win32 × x64/arm64 共 6 个归档的 SHA-256 与体积已按 `.sha256` 旁挂文件实测固定，侧车校验结果与内置常量逐字节一致。
2. **Android 扩展验证基线 `263.7084.0`**：第 5–8、14 节的 PSI 命令、Compose suppressor、`LSDiagnosticProvider` 与 Lint 矩阵全部在该版本实测。

由此产生的锁定关系：
- 自有 JVM 扩展资产继续按 `resources/ils/263.7084.0/` 发布并按精确版本加载；在 `271.2085.0` 上 C/D/H 依 §12.2 第 7 条返回明确“不支持该版本”的原因，A/B 与原生 Java/Kotlin 全部保留；
- 要在 271 启用 JVM 扩展，需先重跑第 14 节完整矩阵（含 `LSDiagnosticProvider`／`LSConfigurationPiece` 签名、`PositionXmlParser`、AAR `lint.jar` 布局），通过后再发布 `resources/ils/271.2085.0/` 资产，不把 263 的结论直接外推到 271。
- 每次升级同时核对 `latestServerVersion()` 的归一化结果与 Open VSX 归档上限；Open VSX 包内 `extension/server-bundle.json` 位于约 13.5 MB 的 VSIX 中，读取上限与超时按实测值固定，不再依赖 10 秒默认超时。
- **`server.port` 格式属版本契约**：`263.7084.0` 只写端口号，`271.2085.0` 写三行（端口、服务端 PID、`ILS-<build>`）。读取方一律只取首行并校验 `1–65535`（`parsePortFile`），不得对整个文件做数值转换，否则连接地址变为 `NaN`，表现为“启动超时”而实际服务已在 1 秒级就绪。
- `271.2085.0` 启动日志实测：`License gate: Licensed`，可用语言扩展为 `projectview, java, kotlin, properties, xml, yaml`，构建工具为 `bazel, bazelCheckout, json, maven, gradle, jps, java`，`plugins/` 内仍无 `android.lsp`。

ILS 更新继续读取现有 [server_bundles.lua](https://github.com/JetBrains/intellij-lsp.nvim/blob/HEAD/lua/intellij-lsp/server_bundles.lua) 与 Open VSX 下载校验链。每次升级对照 SPI/命令/容器/Kotlin API、`LSDiagnosticProvider`、AGP 来源格式及官方 Android 路径，再运行同一验收矩阵。上游已完整替代某项时删除对应拦截与重复实现，保留通用取消/清理修复，不保留兼容开关。

## 13. 实施顺序、验证和完成条件

### 13.1 顺序

1. **阶段 A 和 B**：先实现本地符号树及现有类语义转发，接通通用请求/取消合同。
2. **独立 JVM 模块及资产链**：建立 `jvm/android-ls-extension/` 构建脚本、6 个运行依赖 Lint JAR 资产校验与 `.runtime/<hash>` 二进制复制链。
3. **阶段 C 和 D**：资源命令（`omp.findResourceFieldReferences`）标准接入与精准 `ComposeSuppressor`；二者共享同一 JVM 插件入口，不共享可变业务状态。
4. **阶段 H**：在 JVM 扩展内接入 `OmpLintDiagnosticProvider`（`LSDiagnosticProvider`）与 `OmpLintClient`，打通零构建/已构建模型解析、内置 `NewApi` 与 AAR Compose 规则动态挂载。
5. **阶段 E**：独立 `prepare`/`cleanup`、窄 DAP 生命周期组合、明确超时单位。
6. **阶段 F 和 G**：把新增路径纳入故障矩阵，按复现修复；G 保持现状。

### 13.2 回归组织

- 复用 `test/android-navigation.test.ts`、`navigation-relay.test.ts`、`dap-proxy.test.ts` 及 `test/integration/` 模式。
- 新测试仅覆盖消费可见行为：精确符号范围、模块/资源身份、false/true、错误与合法空集合、原生 `textDocument/diagnostic` 中编译诊断与 Android/Compose Lint 共存、取消/迟到响应、forward 所有权和版本资产失效。
- 不写源码文本断言、仅验证转发或 mock 回声的测试。临时探针不成为生产依赖。
- JVM/ILS 真实集成复用现有隔离 sandbox 和已有 EULA（`cd82e6cdaf2790f1`）；禁止为了测试自动接受新条款。
- 验证修改范围的 typecheck/相关测试/build/受影响文件 Biome，最终全量 Node 测试；真实 ILS 集成按需运行并独立记录。

现有命令：

```sh
npm run pretest
node --test --test-timeout=30000 dist-test/test/android-navigation.test.js dist-test/test/navigation-relay.test.js dist-test/test/dap-proxy.test.js
npm run build
npm test
npm run test:integration
npm pack --dry-run --json --ignore-scripts
```

新模块构建命令随模块构建脚本一并落地，包构建/发布必须包含它；不能只有手工编译出的本机 JAR。

### 13.3 最终验收矩阵

| 阶段 | 完成条件 |
| --- | --- |
| A | 安装缓存 Bridge 返回真实 XML 树；范围、内存版本、能力协商和畸形 XML 行为符合第 5 节 |
| B | 三组件 false/true 精确到位置，包含当前属性且无无关类；KDoc 和别名语义保持 |
| C | 三处 nav_settings、合法零引用、限定符/变体/模块隔离、来源失效、内存多文件真实搜索中取消全部通过 |
| D | 七项正反例及 TestFunctionName、注册生命周期和取消通过，无普通诊断回归 |
| E | 实际设备双场景断点、栈、变量、单步、detach、forward 所有权和失败清理通过 |
| F | 故障后旧请求结束、资源释放，新会话真实语义查询可用，其他工程不受影响 |
| G | 默认开启 intellijExtensions 协议扩展，Rename 与 ModCommand 正常生成与执行；不新增 Bridge 黑名单 |
| H | 客户端声明 `textDocument.diagnostic` 能力且服务端广告 `diagnosticProvider`；原生 `textDocument/diagnostic` 同时返回原生编译诊断、Java/Kotlin `NewApi`（12 用例）与 Compose `UnrememberedMutableState`（正反例与抑制）；未构建与已构建状态模型取值、6 JAR 运行依赖、`lint.xml` 开关/严重级别、单规则组故障隔离与结果缓存全部通过；Windows ClassLoader 保活且不锁 Gradle 缓存 |
| 发布 | npm 包含自有 JAR 与 6 个 Lint 依赖 JAR；二进制变更使 runtime hash 改变；本地市场安装发现正常；精确版本 ABI 校验通过 |

生产完成后更新 README，包含以下 6 项明确可核对的交付内容，并清除临时产物（未要求提交或覆盖远端）：
1. **能力全景矩阵**：明确 A–H 各阶段的协议入口（LSP 方法 / DAP 指令 / CLI 命令）与已验收环境；
2. **两阶段调试用法**：`debug-attach-cli prepare` 与 `cleanup` 的参数、返回 JSON 结构与配合原生 DAP 工具的用法；
3. **13 项错误码全集与排查指引**：涵盖环境层、目标层、租约层与协议层的状态说明与恢复建议；
4. **Android Lint 运行边界说明**：明确诊断为单文件 pull 模式、仅执行 `Scope.JAVA_FILE` 源码规则、第三方规则安全白名单；
5. **AGP 兼容矩阵**：记录已实测支持的 AGP 8.x/9.x、`build.gradle.kts` 解析与 `compileSdk` 推导；
6. **发布资产清单与哈希**：记录 `resources/ils/263.7084.0/` 下 7 个 JAR 资产的版本、体积与 SHA-256。

### 13.4 研究证据索引

会话工件用于复现来源，不是生产运行时依赖：

- `local://probe-rpc-cancellation.md`：实际字段命令、取消及并发探针。
- `local://probe-xml-manifest-resources.md`：XML 解析原始输出、组件原生 references、AGP 产物和模块作用域。
- `local://probe-compose-matrix.md`：最小源码、EP-only 对照、单次注册及真实诊断矩阵。
- `local://android-dap-evidence.md`：原生 Android DAP 双场景完整请求、断点、变量和清理。
- `local://complete-plan-parent-evidence.json`：双工程恢复、服务退出/自启和 QuickFix 请求/日志关联输出。
- `local://embedded-android-lint-evidence.json`：同进程内嵌官方 `ApiDetector` 十二项正反例实测证据。

## 14. H：内嵌官方 Android Lint 与 Jetpack Compose 规则诊断

### 14.1 实测基线

在 ILS `263.7084.0`（JBR 25）同进程内运行官方 Android Lint（`ApiDetector`）与随 Jetpack Compose AAR 分发的 `UnrememberedStateDetector`，直接复用当前请求的 `ctx.project`、内存未保存 PSI（`PsiJavaFileImpl` / `KtFile`）与 K2 FIR UAST（`JavaUFile` / `KotlinUFile`），不启动外部 CLI 进程，不加载 `lint-psi` 替代编译器。

#### 1. 系统级规则（`NewApi`）Java / Kotlin 十二项正反例基线（`minSdk=21, compileSdk=37`）

| 用例（内存 `didOpen` / `didChange`，磁盘文件未改动） | Java 的 NewApi 数 | Kotlin 的 NewApi 数 |
| --- | --- | --- |
| 一个未保护 `NotificationChannel`（API 26）、一个 `SDK_INT >= 26` 保护调用 | 1 | 1 |
| 两个调用均由 `SDK_INT >= 26` 检查保护 | 0 | 0 |
| 两个调用仅由 `SDK_INT >= 25` 检查保护 | 2 | 2 |
| 未保护函数增加 `@android.annotation.TargetApi(26)` | 0 | 0 |
| 未保护函数增加 `@SuppressWarnings("NewApi")` / `@Suppress("NewApi")` | 0 | 0 |
| 未保存文本恢复为未保护调用 | 1 | 1 |

#### 2. AAR Compose 规则（`UnrememberedMutableState`）与多规则同文件并发基线

从 `MyHook.app.debug` 已导入依赖缓存装载 `androidx.compose.runtime:runtime-android` 的 `transformed/runtime/jars/lint.jar`（含 `RuntimeIssueRegistry` 16 项规则），与 `ApiDetector` 合并为 `CompositeIssueRegistry` 后对 `MainActivity.kt` 实测：

| 用例 | K2 FIR 符号解析 | 返回 Incident | 耗时 |
| --- | --- | --- | --- |
| `@Composable fun Bad() { val s = mutableStateOf(0) }` | `mutableStateOf -> androidx.compose.runtime.SnapshotStateKt` | 1 项：`UnrememberedMutableState` (`192..206`) | 298 ms（首次） |
| `@Composable fun Good() { val s = remember { mutableStateOf(0) } }` | `remember -> ComposablesKt`<br>`mutableStateOf -> SnapshotStateKt` | 0 项（`[]`） | 39 ms |
| `@Suppress("UnrememberedMutableState") @Composable fun Suppressed()` | `mutableStateOf -> SnapshotStateKt` | 0 项（`[]`） | 16 ms |
| 同文件含未保护 `NotificationChannel` + 未 remember `mutableStateOf` | 同时解析 Android SDK 与 Compose Runtime | 2 项：`NewApi` (`243..262`) + `UnrememberedMutableState` (`439..453`) | 31 ms |
| `JceHead.java` 对照（5 JAR 子集） | `new NotificationChannel -> android.app.NotificationChannel` | 1 项：`NewApi` (`152..175`) | 6 ms |

全部用例 `logs == []`、`crashCount == 0`，执行后原生 `textDocument/definition` 仍正常定位到 `android.jar` 内部类。

### 14.2 运行依赖集（6 个 JAR / 10.84 MiB）与构建锁定

经 `jdeps` 静态分析与沙箱实测，排除 `cli.jar`、`external/lint-psi`、`layoutlib-api`、`lint-checks-proto`、`sdk-common`（仅启用 `Scope.JAVA_FILE` 时）及与 ILS 重复的 Kotlin/Guava/ASM/Gson/Protobuf 库。

5 个 JAR 的子集仅覆盖 `ApiDetector` 与 `UnrememberedStateDetector`；完整 `androidx.*` 规则集依赖 `tools.lint-model.jar`：
- `DefaultJavaEvaluator.getDependencies()` 调用 `Project.getBuildVariant()` → `LintModelVariant.getArtifact().getDependencies()`；
- `tools.lint-checks.jar` 内 32 个类引用 `com/android/tools/lint/model/`；
- AAR 侧 `androidx.activity` 的 `ActivityResultFragmentVersionDetector` 引用 `LintModelDependencies` / `LintModelAndroidLibrary` / `LintModelMavenName`。

运行依赖集固定为 **6 个 JAR（共 11,362,788 字节 / 10.84 MiB，较初始 43.94 MB 缩减 74.1%）**：

| # | JAR 文件名 | SDK `cmdline-tools;23.0` 相对路径 | 字节数 | SHA-256 | 用途 |
| --- | --- | --- | --- | --- | --- |
| 1 | `tools.lint-checks.jar` | `lib/lint/tools.lint-checks.jar` | 7,256,470 | `61e6b0a90d6fe8a5ac5d4d8519fb1134fd064fbba12525dcfc08ce4b43ffd0ae` | 官方内置规则集与 `BuiltinIssueRegistry` |
| 2 | `tools.sdklib.jar` | `lib/sdklib/tools.sdklib.jar` | 1,909,475 | `d0bbe0e03155a7bdd9bac03567b6b26797f81a778f55d5eadc3e71e7a0a27434` | `AndroidVersion`、`SdkVersionInfo`、`IAndroidTarget` |
| 3 | `tools.lint-api.jar` | `lib/lint/tools.lint-api.jar` | 1,417,813 | `e6a6e0244b5a9a325580c0a8901b94e1a8b37e0cca7030f5fcb06186f7f46b61` | `LintDriver`、`LintClient`、`DefaultUastParser`、`JarFileIssueRegistry` |
| 4 | `tools.common.jar` | `lib/common/tools.common.jar` | 570,290 | `ed2fea24fd74c82cac6ca964b8a3f5b33f7aa8f675bd6fb51ee78772f49995f2` | `XmlUtils`、`PositionXmlParser`、`ResourceFolderType`、`SdkConstants` |
| 5 | `kxml2-2.3.0.jar` | `lib/external/net/sf/kxml/kxml2/2.3.0/kxml2-2.3.0.jar` | 43,858 | `f264dd9f79a1fde10ce5ecc53221eff24be4c9331c830b7d52f2f08a7b633de2` | `ApiLookup` 解析 SDK `data/api-versions.xml` 所需 `KXmlParser` |
| 6 | `tools.lint-model.jar` | `lib/lint/tools.lint-model.jar` | 164,882 | `81ac1f03f390f0aa8308d389a8bbe4238f9bd843ff705556f68564f6ee257cf1` | `LintModelVariant` / `LintModelDependencies`，支撑 `DefaultJavaEvaluator.getDependencies()` 与依赖感知规则 |
| **合计** | **6 个 JAR** | — | **11,362,788** | — | — |

获取与构建锁定规则：
1. 构建脚本按 `--android-sdk`、`ANDROID_HOME`、`ANDROID_SDK_ROOT` 顺序定位 `cmdline-tools`（校验 `source.properties` 的 `Pkg.Revision=23.0` 及上表 6 个文件的 SHA-256），或从 Google Maven（`https://dl.google.com/dl/android/maven2/`）下载固定版本并校验 SHA-256。
2. 构建期将 6 个 JAR 复制到 `resources/ils/263.7084.0/android-ls-extension/lib/`，与 `android-ls-extension.jar` 同级存放；哈希不匹配或文件缺失时构建失败。
3. 将来若启用 `Scope.RESOURCE_FILE` / `Scope.CLASS_FILE` 规则或实现 `getResources` 返回非空仓库，需追加 `tools.sdk-common.jar`（提供 `com.android.ide.common.resources.ResourceRepository`）并重跑兼容矩阵。

### 14.3 原生诊断挂载与 LSP 协议契约

直接实现 ILS 原生诊断接口 `com.jetbrains.ls.api.features.diagnostics.LSDiagnosticProvider`：

1. **接口与语言注册**：
   - `LanguageServerExtension.getConfiguration()` 返回 `new LSConfigurationPiece(entries, Collections.emptyList(), Collections.emptyList())`。
   - `entries` 包含 `LSCommandDescriptorProvider`（阶段 C）、`WorkspaceComponentEntry`（阶段 D）与 `OmpLintDiagnosticProvider`（阶段 H）。
   - `LSConfigurationPiece` 第三个参数 `languages` 传空列表，避免与内置 Java/Kotlin 插件重复注册语言描述。
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
   - 分析前记录目标 `Document` 的版本号/修改戳，输出前再次复核；若分析期间文档已变更，丢弃过期结果。
4. **`XmlParser`、`Configuration` 与配置通道**：
   - 配置通道边界：首版不假定未验证的动态 LSP RPC 配置通道；规则启用状态与严重级别覆盖 100% 遵照工程本地的 `lint.xml`（通过 `LintXmlConfiguration` / `PositionXmlParser` 解析），并配合代码内静态规则白名单（内置规则 + Compose 规则）。
   - `LintXmlConfiguration` 解析 `lint.xml` 时调用 `LintClient.getXmlParser()` → `XmlParser.parseXml(File)` 与 `XmlParser.getLocation(File, Node)`；`OmpLintClient` 委托 `tools.common.jar` 中的 `com.android.utils.PositionXmlParser`（`parse(InputStream/byte[])` + `getPosition(Node)`）实现 `XmlParser`，开启 secure processing 并禁用外部实体。
   - `Configuration` 通过 `LintClient.getConfiguration(project, driver)` 获取，支持项目 `lint.xml` 的 enable/disable、severity 覆盖与 `Severity.IGNORE` 过滤。
   - `getGradleVisitor()` 与 `getResources(project, scope)` 在仅启用 `Scope.JAVA_FILE` 时抛出 `UnsupportedOperationException`，并由 `Scope` 过滤确保不实例化 Gradle 或资源作用域规则。
5. **结果缓存、容量上限与多根隔离**：
   - ILS `LSDiagnostic.getDiagnostics` 将多路 provider 输出合并为单个 `DocumentDiagnosticReport(kind="full")`，不透传单 provider 的 `resultId` / `unchanged`；`OmpLintDiagnosticProvider` 始终返回完整 `Diagnostic` 流。
   - 内部缓存采用定长 LRU 映射（上限 64 个文档条目），以 `(project.locationHash, uri, document.modificationStamp, 模型指纹[compileSdk/minSdk/namespace/变体], 已启用 Issue 集合, 规则 JAR 集合指纹)` 隔离存储。
   - 失效时机：`didChange` 失效当前条目；`didClose` 立即从缓存中移除并释放内存；`workspace/didChangeWatchedFiles`（`lint.xml` 或构建脚本变更）清空对应项目缓存。
   - 单例说明：同一 ILS 进程内所有已导入工程共享一个 `OmpLintDiagnosticProvider` 单例，强制以 `project.locationHash` 保证跨工程多根工作区完全隔离。
6. **拉取模式约束**：
   - ILS `263.7084.0` 仅在 `fleet.lsp.protocol` 中包含 `publishDiagnostics` 协议常量，无主动推送实现；阶段 H 诊断通过 `textDocument/diagnostic` 拉取返回，验收时须确认客户端声明 `textDocument.diagnostic` 能力且服务端广告 `diagnosticProvider`。
   - `271.2085.0` 实测 initialize 能力：`diagnosticProvider = { interFileDependencies: true, workspaceDiagnostics: false, workDoneProgress: false }`、`documentSymbolProvider = true`；`textDocument/diagnostic` 返回 `kind: "full"`。`workspaceDiagnostics: false` 直接证实全项目诊断不在上游能力内，不得为其设计批量入口。

### 14.4 未构建（Clean）与已构建双态模型解析及 AAR `lint.jar` 发现

在 `server.withAnalysisContext` 读操作内，基于 ILS 已导入的 `Project`、`ModuleManager`、`OrderEnumerator` / `ProjectLibraryTable` 与平台 PSI 构建 Lint 模型，不以 `build/` 目录存在作为前置条件：

| 属性 | 第一优先级（未构建 / Gradle Sync 后内存即用） | 第二优先级（已构建产物补充） | 第三优先级（保底） |
| --- | --- | --- | --- |
| **所属 `Module`** | `ProjectFileIndex.getInstance(project).getModuleForFile(virtualFile)`（如 `MyHook.app.debug`） | — | 无模块则跳过 Android Lint |
| **SDK 根目录与 `compileSdk`** | 从模块依赖库表定位 `Gradle: android:android-sdk:null` 的 `platforms/android-<ver>/android.jar`，推导 `sdkHome` 并读取同目录 `source.properties` 的 `AndroidVersion.ApiLevel`（如 `37.0`） | `build/intermediates/lint_report_lint_model/<variant>/.../module.xml` (`compileTarget`) | — |
| **AAR `lint.jar` 列表** | 遍历模块 `OrderEnumerator.orderEntries(module).librariesOnly()` 中所有 `.../transformed/<lib>/jars/classes.jar`，收集存在的同级 `jars/lint.jar`（MyHook 中共 24 个 JAR，含 13 个 Compose 模块） | `debug-artifact-libraries.xml` 中的 `lintJar` | — |
| **`namespace`** | 读取所属 Gradle 项目模块（`MyHook.app`，contentRoot 含 `F:/source/MyHook/app`）根下 `build.gradle.kts` 的 `KtFile` AST，提取 `android { namespace = "..." }` | `debug.xml` 或 `merged_manifest` 的 `package` 属性 | 源码 `src/main/AndroidManifest.xml` 的 `package` 属性 |
| **`minSdkVersion`** | 读取所属 Gradle 项目模块 `build.gradle.kts` 的 `KtFile` AST 中 `defaultConfig { minSdk = ... }` 及变体覆盖值 | `debug.xml` 或 `merged_manifest` 的 `minSdkVersion` | 源码 `src/main/AndroidManifest.xml` 的 `<uses-sdk>`；最终保底为 `1` |
| **`targetSdkVersion`** | 读取所属 Gradle 项目模块 `build.gradle.kts` 的 `KtFile` AST 中 `defaultConfig { targetSdk = ... }` | `debug.xml` 或 `merged_manifest` 的 `targetSdkVersion` | 源码 `src/main/AndroidManifest.xml` 的 `<uses-sdk>`；最终保底为 `compileSdk` |

构建脚本归属与解析约束：
- `MyHook.app.debug` 的 contentRoot 仅包含 `app/src/main`、`app/src/debug` 与 `app/build/generated/source/buildConfig/debug`；`build.gradle.kts` 位于父级 Gradle 项目模块 `MyHook.app` 的 contentRoot（`F:/source/MyHook/app`）。查找构建脚本时须通过相同 `externalProjectId` 或父模块 contentRoot 定位 `MyHook.app`。
- `plugins/kotlin/lib/language-server-plugins-kotlin.jar` 已注册 `extensions="kt;kts"` 为 `KotlinFileType`，`build.gradle.kts` 在 ILS 内直接解析为 `KtFile`；AST 提取仅遍历字面量节点，解析失败或未命中时回退至 Manifest 保底。

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
     - 在无 `build/` 目录的未构建状态下，`compileSdk`、`minSdk`、AAR Compose `lint.jar` 发现与诊断输出保持一致；
     - 在 `lint.xml` 中关闭规则或调整 severity 后，对应诊断按配置隐藏或改变级别；
     - 注入抛异常的规则组时，其余规则正常返回且整次诊断请求成功；
     - 连续两次相同文档版本的 `textDocument/diagnostic` 命中内部结果缓存。

### 14.7 官方插件承载点映射、AGP 兼容矩阵与演进策略

对照 `JetBrains/android`（提交 `544c9ef8`），官方桌面插件采用「`LintExternalAnnotator` 单次分析并缓存 `LintProblemData` → 100+ 个 `AndroidLint<IssueId> extends AndroidLintInspectionBase` 读取缓存生成 `ProblemDescriptor` → `InspectionProfileImpl` 动态注册」的三段式架构，强依赖 `AndroidFacet`、`AndroidModel`/`LintModel` 与 `StudioResourceRepository`。ILS 发行包不含 `org.jetbrains.android` 且诊断出口为 `textDocument/diagnostic`，故按 LSP 承载点分层映射如下：

| 官方能力 | 官方实现 | ILS 承载点 | 实施方案 | 状态 |
| --- | --- | --- | --- | --- |
| 单文件 Lint 诊断 | `LintExternalAnnotator` + `LintProblemData` | `LSDiagnosticProvider`（`Flow<Diagnostic>`） | `OmpLintClient` + `LintDriver` 单次执行 + 内部结果缓存 | 阶段 H 落地 |
| Lint 快速修复 | `LintIdeQuickFix` | `LSCodeActionProvider` / `LSSimpleCodeActionProvider` | 阶段 H 预填 `Diagnostic.data`，修复转换留作独立后续扩展 | 预留接口 |
| 抑制与配置 | `SuppressLintQuickFix`、`lint.xml`、`InspectionProfile` | `LanguageInspectionSuppressors` + `LintXmlConfiguration` | 阶段 D 抑制器 + `PositionXmlParser` 支撑 `lint.xml` | 阶段 D/H 落地 |
| 第三方规则装载 | `ensureInspectionsRegistered` + `LintModel` | `JarFileIssueRegistry` + `CompositeIssueRegistry` | 从 `OrderEnumerator` 库表同级目录扫描 `jars/lint.jar` | 阶段 H 落地 |
| 模型属性解析 | `GradleAndroidModel` / `AndroidModuleSystem` | `ProjectLibraryTable` + `KtFile` PSI + Manifest PSI | 零构建与已构建三级取值链 | 阶段 H 落地 |
| 资源与 Manifest 导航 | `StudioResourceRepository`、`PackageClassConverter` | Bridge 导航中继 + `LSCommandDescriptorProvider` | 阶段 A–C（TS XML 解析 + AGP blame + JVM `ReferencesSearch`） | 阶段 A–C 落地 |
| 全项目跨文件批处理 | `GlobalInspectionTool` / `AndroidLintGlobalInspectionContext` | 无（ILS 未提供 `workspace/diagnostic`） | 不纳入单文件诊断，交由 Gradle `lintDebug` 执行 | 边界外 |

LSP 3.17 协议义务逐项审查（`Diagnostic` 共 9 字段，`DocumentDiagnosticReport` 与请求生命周期）：

| LSP 义务 | 协议依据 | 本文对应条款 | 状态 |
| --- | --- | --- | --- |
| 能力协商：仅声明已实现能力，不广告 `workspace/diagnostic` | `ServerCapabilities.diagnosticProvider` / `textDocument.diagnostic` | §14.3 第 1、6 条；§14.6 第 5 条 | 已覆盖 |
| 诊断字段完整度：`range` / `severity` / `code` / `source` / `message` / `relatedInformation` / `data` | `Diagnostic` 结构 | §14.3 第 2 条 | 已覆盖 |
| 不使用无来源字段：`codeDescription` / `tags` 保持 `null` | `Diagnostic.codeDescription` / `DiagnosticTag` | §14.3 第 2 条 | 已覆盖 |
| 无位置事件过滤：跳过 `Location.NONE` 与零长度区间 | `Diagnostic.range` 语义 | §14.3 第 2 条 | 已覆盖 |
| 已禁用规则过滤：跳过 `Severity.IGNORE` | `Configuration.isEnabled` | §14.3 第 2、4 条 | 已覆盖 |
| 文档版本一致性：输出前复核 `Document` 版本 | `TextDocumentItem.version`、`ContentModified(-32801)` | §14.3 第 3 条 | 已覆盖 |
| 取消传播：`$/cancelRequest` → `-32800` | `RequestCancelled(-32800)` | §14.6 第 3 条；§7.5 取消验收 | 已覆盖 |
| 非阻塞调度：读操作内访问 PSI，`Flow` 在 IO 调度器收集 | LSP 请求并发语义 | §14.3 第 3 条 | 已覆盖 |
| 报告类型约束：合并报告固定 `full`，不用 `resultId` / `unchanged` | `DocumentDiagnosticReport.kind` | §14.3 第 5 条 | 已覆盖 |
| 多根隔离：缓存以 `project.locationHash` 分区 | `workspaceFolders` 语义 | §14.3 第 5 条 | 已覆盖 |
| 错误码映射：`RequestFailed(-32803)` / `ProtocolMismatch` | JSON-RPC error 语义 | §4.3 错误表；§7.2 协议版本 | 已覆盖 |
| 快速修复通道：`textDocument/codeAction` + `WorkspaceEdit` | `CodeAction` / `WorkspaceEdit` | §14.7 承载点表（预留 `LSCodeActionProvider`） | **未纳入本次交付** |
| 全工作区诊断：`workspace/diagnostic` | `WorkspaceDiagnosticReport` | 无 ILS 承载点 | **不可得** |

AGP 兼容矩阵：

| AGP 场景 | 处理方式 | 状态 |
| --- | --- | --- |
| AGP 8.x/9.x + `build.gradle.kts`（MyHook `AGP 9.4.1`） | transform 布局 `transforms/<hash>/transformed/<lib>/jars/{classes.jar,lint.jar}`；`compileSdk` 由 `android.jar` 路径反推；`minSdk` 由 `KtFile` AST 读取 | 已实测（24 个 `lint.jar` 全部命中） |
| `compileSdk { version = release(37) }`（AGP 9 DSL） | 直接读取 `android.jar` 所在平台目录与 `source.properties` | 已实测 |
| 多模块 `build.gradle.kts` 归属 | 经 `externalProjectId` / 父 contentRoot 定位 `MyHook.app` 模块 | 已实测 |
| 规则包 API 版本校验 | 复用官方 `JarFileIssueRegistry` 的 `Lint-Revision` / API 级别校验 | 已实测 |
| AGP 3.x–6.x（无 `transformed/` 前缀） | 依据“`lint.jar` 与 `classes.jar` 同处 `jars/` 目录”判定，与外层路径前缀无关 | 规则兼容，待跨版本验收 |
| 多 flavor 的 `minSdk` 覆盖 | 未构建时仅读取 `defaultConfig`，已构建时可由 `debug.xml` / `merged_manifest` 补充 | 存在未构建 flavor 覆盖缺口 |
| `lintChecks` / `lintPublish` 独立规则 JAR 与 `ANDROID_LINT_JARS` | 不在模块编译 classpath 内，当前库表扫描未覆盖 | 未支持，在文档中列明 |

演进与移除条件：
- `src/android/` 下的 TS XML 解析与资源映射层作为过渡实现保留；待上游 ILS 原生支持按模块、变体将 `R.*` 与 Manifest 组件解析至源码后，移除 TS 适配层及 Bridge 拦截点。
- 若上游后续将 `IntellijLintClient` 与 `AndroidFacet` 解耦为可独立加载的无头模块，则直接切换至官方宿主实现并移除 `OmpLintClient` 的模型重建层。
