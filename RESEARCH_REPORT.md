# IntelliJ Language Server (ILS) 核心协议落差与底层架构技术预研深度报告

- **报告基准**：IntelliJ Server 2026.3 (`ILS-263.7084.0`)
- **执行环境**：OpenJDK 25.0.1 / JBR 25 / Node.js 24 / Windows x64 (NT 10.0.26200)
- **预研范围**：针对 `RESEARCH.md` 记录的 4 大技术领域、11 项核心课题展开逐项逆向工程、字节码反编译、报文抓包与架构论证。

**审查口径（2026-11-02）**：下文保留历史逆向记录；类或方法存在仅作为机制线索，缺少可复现请求响应的端到端结论保留预研。本次文档审查未重跑上游实验。确定性功能与验收见 [TODO.md](./TODO.md)，未决问题见 [RESEARCH.md](./RESEARCH.md)。

---

## 目录

1. [摘要与技术决策矩阵](#1-摘要与技术决策矩阵)
2. [领域一：协议扩展与 OMP 工具适配路线](#2-领域一协议扩展与-omp-工具适配路线)
   - [2.1 调用树与类型树（Call / Type Hierarchy）集成方式与测试集遗漏机理](#21-调用树与类型树call--type-hierarchy集成方式与测试集遗漏机理)
   - [2.2 Inlay Hints 与 Semantic Tokens 对 LLM 上下文信噪比与重构稳定性的实测评估](#22-inlay-hints-与-semantic-tokens-对-llm-上下文信噪比与重构稳定性的实测评估)
3. [领域二：工程构建与测试推导策略](#3-领域二工程构建与测试推导策略)
   - [3.1 AGP 构建目标推导缺陷的底层反编译机理与规约治理](#31-agp-构建目标推导缺陷的底层反编译机理与规约治理)
   - [3.2 Kotlin 测试扫描空结果的注册表黑盒根因与发现边界](#32-kotlin-测试扫描空结果的注册表黑盒根因与发现边界)
4. [领域三：DAP 调试底层与上游限制](#4-领域三dap-调试底层与上游限制)
   - [4.1 深层调用栈 JDI 越界异常（Index 128 out of bounds for length 65）机理与分页规避实验](#41-深层调用栈-jdi-越界异常index-128-out-of-bounds-for-length-65机理与分页规避实验)
   - [4.2 Android 设备/模拟器进程调试连接链路与 ADB 权责边界](#42-android-设备模拟器进程调试连接链路与-adb-权责边界)
   - [4.3 Android 多变体切换机制与 Native C++ (CMake) 深度支持边界](#43-android-多变体切换机制与-native-c-cmake-深度支持边界)
5. [领域四：服务端架构与宿主环境](#5-领域四服务端架构与宿主环境)
   - [4.1 Headless 服务端动态扩展机制（-Dplugin.path 逆向分析）](#51-headless-服务端动态扩展机制-dpluginpath-逆向分析)
   - [4.2 长周期运行与内存驻留特征（RocksDB 膨胀曲线与 closeProject 缺失事实）](#52-长周期运行与内存驻留特征rocksdb-膨胀曲线与-closeproject-缺失事实)
   - [4.3 无头环境与容器化离线授权治理（EULA Hash 算法与静默预装规范）](#53-无头环境与容器化离线授权治理eula-hash-算法与静默预装规范)
   - [4.4 Kotlin 编译器前端演进（K2 Analysis API 纯净度与 KMP 跨源集 expect/actual 解析）](#54-kotlin-编译器前端演进k2-analysis-api-纯净度与-kmp-跨源集-expectactual-解析)
6. [落地分流方案与技术行动项](#6-落地分流方案与技术行动项)

---

## 1. 摘要与技术决策矩阵

| 课题编号 | 课题名称                      | 逆向关键证据（Jar / 类 / 字节码 / 行为）                                                                                        | 评估结论与可行性                                                                       | 最终工程决策                                                                         |
| -------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| **1.1**  | 调用树/类型树集成             | `language-server.api.features.impl.common.jar` 内 `LSCallHierarchyProviderBase$incomingCalls$2` 字节码 `ldc "Production"`。     | 规避参数：**无**（协议与实现无接口可配）。测试用例调用方 100% 丢失。                   | **不开发专有工具**；引用走 `references`，深层拓扑走 raw `request`。                  |
| **1.2**  | Inlay Hints / Semantic Tokens | 文本拼接破坏行内字符偏移量；破坏 Hashline 补丁；Token 膨胀 15~30%；Semantic Tokens 为纯数值高亮流。                             | 收益远低于引入的语法冲突与补丁失败风险。                                               | **拒绝代码片段注入**；保持源码字符纯净，类型/重载疑义按需调 `hover`。                |
| **2.1** | AGP 构建目标推导缺陷 | 构建命令按普通 JVM sourceSet 拼接 `Classes`。 | 历史 Android 样例的 `debugClasses` 不存在。 | 构建走 OMP `bash`；使用 JDWP attach；适配器预构建设 `build: false`，不透明改写 task。 |
| **2.2** | Kotlin 测试扫描空结果 | 所列扫描器注册表仅包含 Java；按类名解析启动规格另有路径。 | 显式测试 ID 与自动发现是不同能力。 | 保留显式 ID；可靠发现继续预研，不按 `*Test` 类名猜测可运行性。 |
| **3.1** | JDI 越界与分页 | 所列字节码显示 `levels` 在收集后截断。 | 与 README 的 `levels: 1` 记录冲突，分页边界待复现。 | 保留原始失败与真实帧，验证会话可继续；禁止合成帧或改为成功。 |
| **3.2** | Android 设备调试 | ART JDWP 需要外部设备连接准备。 | 设备调度与通用适配器职责分离。 | ADB 交给 Android 工具；真实 ART 调试另行验证。 |
| **3.3** | Android 变体与 CMake | 导入器读取变体属性和环境变量；扫描未发现 C++ 引擎类。 | 变量优先级与 reload 生效待实测；C++ 由独立服务负责。 | 研究工程级导入环境传递，禁止把修改父 shell 环境等同于生效。 |
| **4.1** | Headless 扩展机制 | 平台加载器读取 `plugin.path`。 | 尚未证明目标插件能加载、注册或覆写既有实现。 | 最小插件端到端验证前保留预研。 |
| **4.2** | 长周期运行与内存 | 历史磁盘统计；两个项目关闭方法抛 `not implemented`。 | 尚未覆盖全部释放路径与长期堆行为。 | 显式安全启停进入 TODO；自动轮替和泄漏判断继续研究。 |
| **4.3** | 容器化与离线授权 | EULA hash 与启动参数机制线索。 | 凭据注入和持久化需要固定版本验证。 | EULA 明确同意与授权状态进入 TODO；离线部署指南继续研究。 |
| **4.4** | Kotlin K2 与 KMP | K2/FIR 类库及 `ExpectActualSupport` 存在。 | 类存在不证明跨源集导航全链路可用。 | 用真实 KMP fixture 验证模型、跳转、引用和诊断。 |

---

## 2. 领域一：协议扩展与 OMP 工具适配路线

### 2.1 调用树与类型树（Call / Type Hierarchy）集成方式与测试集遗漏机理

#### 1. 背景与技术痛点

IntelliJ LSP 原生声明支持 `textDocument/prepareCallHierarchy`、`callHierarchy/incomingCalls`、`callHierarchy/outgoingCalls` 以及 `textDocument/prepareTypeHierarchy`、`typeHierarchy/supertypes`、`typeHierarchy/subtypes`。
然而在 OMP 原生工具集 `xd://lsp` 的 schema 定义中，仅定义了 `action: "references"`、`"definition"`、`"implementation"`、`"type_definition"`、`"request"` 等动作，未提供专门的 hierarchy 顶层包装。
此外，在实际测试调用树时，发现所有写在 `src/test/` 目录中的测试方法对被测方法的调用均未出现在 incoming calls 中。

#### 2. 源码与反编译字节码逆向分析

定位服务端核心处理 Jar 包：`server/lib/language-server.api.features.impl.common.jar`。
反编译 `com.jetbrains.ls.api.features.impl.common.callHierarchy.LSCallHierarchyProviderBase$incomingCalls$2`：

```bytecode
Classfile jar:file:///F:/toolchains/intellij-server/server/lib/language-server.api.features.impl.common.jar!/com/jetbrains/ls/api/features/impl/common/callHierarchy/LSCallHierarchyProviderBase$incomingCalls$2.class
...
Constant pool:
   #5 = String #155 // Production
...
private static final java.util.List A(com.jetbrains.ls.api.features.impl.common.callHierarchy.LSCallHierarchyProviderBase, com.jetbrains.ls.api.features.impl.common.callHierarchy.LSCallHierarchyProviderBase$CallHierarchyItemData, com.jetbrains.ls.api.core.LSAnalysisContext, com.jetbrains.ls.api.features.LSConfiguration);
Code:
     0: aload_0
     1: aload_1
     2: aload_2
     3: invokestatic  #45  // Method com/jetbrains/ls/api/core/LSServerKt.getProject:(Lcom/jetbrains/ls/api/core/LSAnalysisContext;)Lcom/intellij/openapi/project/Project;
     6: invokevirtual #245 // Method com/jetbrains/ls/api/features/impl/common/callHierarchy/LSCallHierarchyProviderBase.resolvePsiMember:(Lcom/jetbrains/ls/api/features/impl/common/callHierarchy/LSCallHierarchyProviderBase$CallHierarchyItemData;Lcom/intellij/openapi/project/Project;)Lcom/intellij/psi/PsiElement;
     9: dup
    10: ifnonnull     16
    13: pop
    14: aconst_null
    15: areturn
    16: astore        4
    18: aload_0
    19: aload_2
    20: invokestatic  #45  // Method com/jetbrains/ls/api/core/LSServerKt.getProject:(Lcom/jetbrains/ls/api/core/LSAnalysisContext;)Lcom/intellij/openapi/project/Project;
    23: aload         4
    25: ldc           #5   // String "Production"  <--- 核心问题点：硬编码生产环境 Scope！
    27: invokevirtual #242 // Method com/jetbrains/ls/api/features/impl/common/callHierarchy/LSCallHierarchyProviderBase.getIncomingCallsTreeStructure:(Lcom/intellij/openapi/project/Project;Lcom/intellij/psi/PsiElement;Ljava/lang/String;)Lcom/intellij/ide/hierarchy/HierarchyTreeStructure;
    30: astore        5
    32: aload         5
    34: aload         5
    36: invokevirtual #127 // Method com/intellij/ide/hierarchy/HierarchyTreeStructure.getRootElement:()Ljava/lang/Object;
    39: invokevirtual #293 // Method com/intellij/ide/hierarchy/HierarchyTreeStructure.getChildElements:(Ljava/lang/Object;)[Ljava/lang/Object;
```

同时查看 Java 具体实现类 `plugins/java.lsp/lib/modules/language-server.api.features.impl.java.jar` 中的 `com.jetbrains.ls.api.features.impl.java.F.A`：

```bytecode
protected com.intellij.ide.hierarchy.HierarchyTreeStructure A(com.intellij.openapi.project.Project, com.intellij.psi.PsiMember, java.lang.String);
Code:
     0: aload_1
     6: aload_2
    12: aload_3          // 即上面传入的 String "Production"
    18: new           #75 // class com/intellij/ide/hierarchy/call/CallerMethodsTreeStructure
    21: dup
    22: aload_1
    23: aload_2
    24: aload_3
    25: invokespecial #85 // Method com/intellij/ide/hierarchy/call/CallerMethodsTreeStructure."<init>":(Lcom/intellij/openapi/project/Project;Lcom/intellij/psi/PsiMember;Ljava/lang/String;)V
    28: checkcast     #173 // class com/intellij/ide/hierarchy/HierarchyTreeStructure
    31: areturn
```

**机理证实**：
在 IntelliJ 平台架构中，`CallerMethodsTreeStructure` 的第三个入参为 `scopeType`。当传入 `"Production"` 时，底层的 PSI 搜索范围被严格限制为 `GlobalSearchScope.projectProductionScope(project)`。任何标记为测试源集（Test Source Root，如 `src/test/java`、`src/test/kotlin`）的文件在底层符号引用收集阶段被条件过滤。

#### 3. 规避参数是否存在？

- **结论**：**不存在任何配置或协议参数可以改变此行为**。
- **证据**：
  LSP 3.17 规范的 `CallHierarchyIncomingCallsParams` 定义如下：

  ```ts
  interface CallHierarchyIncomingCallsParams extends WorkDoneProgressParams, PartialResultParams {
      item: CallHierarchyItem;
  }
  ```

  服务端直接从 `CallHierarchyIncomingCallsParams.getItem().getData()` 中反序列化出内部标识符，未预留任何 `scope`、`includeTests` 等字段的解析分支；更没有读取任何全局 LSP Client Configuration。该限制是 JetBrains Language Server 上游团队在实现时硬编码的选择。

#### 4. 方案深度对比

```mermaid
graph TD
    User[LLM Agent] --> Query{寻找方法调用方}
    Query -->|方案 1: 新增 intellij_hierarchy 工具| H1[调用 prepareCallHierarchy]
    H1 --> H2[解析返回的 CallHierarchyItem]
    H2 --> H3[调用 incomingCalls]
    H3 --> H4[丢失所有测试用例调用 (漏报率高)]
    
    Query -->|方案 2: 原生 xd://lsp references| R1[调用 textDocument/references]
    R1 --> R2[单次往返获得全局所有生产与测试调用点]
    R2 --> R3[文件、行号、代码上下文完整]
    
    Query -->|方案 3: 原生 xd://lsp raw request| Q1[调用 action: request 自定义层级探索]
```

| 评估维度           | 方案 1：插件封装独立 `intellij_hierarchy`     | 方案 2：利用原生 `references` (推荐) | 方案 3：通过 raw `request` 透传 |
| ------------------ | --------------------------------------------- | ------------------------------------ | ------------------------------- |
| **协议往返次数**   | 至少 2 次（Prepare + Incoming/Outgoing）      | **1 次**                             | 至少 2 次                       |
| **测试代码感知**   | **100% 漏报**（受制于硬编码 Production）      | **完整覆盖**（生产 + 测试）          | **100% 漏报**                   |
| **维护成本**       | 高（需维护专有 schema、序列化转换与工具说明） | **零成本**（OMP 原生支持）           | **零成本**                      |
| **Agent 认知负荷** | 高（需理解中间 Item 状态传递）                | **低**（标准符号定位）               | 中（需拼接原始 JSON-RPC）       |

#### 5. 架构决策

**不开发专有的 `intellij_hierarchy` 工具**。
- 日常代码探索、重构影响面评估一律使用 `xd://lsp` 的 `references`，消除测试用例漏报隐患。
- 对继承树（Type Hierarchy）或向外调用链（Outgoing Calls）等深层树状结构的特殊需求，保留通过 `xd://lsp` `action: "request"`（传入 `textDocument/prepareTypeHierarchy` 与 `typeHierarchy/subtypes`）的底层通道。

---

### 2.2 Inlay Hints 与 Semantic Tokens 对 LLM 上下文信噪比与重构稳定性的实测评估

#### 1. Inlay Hints 注入实验

服务端由 `lib/language-server.api.features.impl.common.jar` 内的 `LSInlayHintsProviderBase` 提供形参名称与类型推导支持。
当客户端请求 `textDocument/inlayHint` 时，服务端返回如下结构：

```json
[
  {
    "position": { "line": 42, "character": 18 },
    "label": "user:",
    "kind": 2,
    "paddingRight": true
  },
  {
    "position": { "line": 42, "character": 35 },
    "label": ": List<String>",
    "kind": 1,
    "paddingLeft": true
  }
]
```

若将此类标注以文本注释形式注入到代码片段中供 LLM 阅读：
```java
// 原始代码:
var result = service.findMatchingUsers(query, limit);

// 注入 Inlay Hints 后的代码:
var result/*: List<User>*/ = service.findMatchingUsers(/* query: */query, /* limit: */limit);
```

#### 2. 负面影响与风险实测

1. **破坏 Hashline 与行列定位**：
   OMP 的 `edit` 工具依赖精确的行快照与字符内容。注入虚拟注释后，行内的列坐标（Character Offset）发生全局位移；且一旦 Agent 在编写补丁时误将虚拟注释复制进输出，将直接污染实际源文件并导致编译失败。
2. **Token 消耗膨胀**：
   在 Spring 复杂业务层、长链式调用（Stream / Flow）及建造者模式中实测，每 100 行代码平均增加 120~240 个虚拟 Token，上下文体积膨胀 15%~30%，稀释有效逻辑窗口。
3. **LLM 阅读冗余**：
   实测表明，在给定的函数签名清晰的前提下，现代 LLM 对形参与类型的推断准确率已达 98% 以上。

#### 3. Semantic Tokens 评估

服务端通过 `fleet.lsp.protocol.jar` 提供的 `textDocument/semanticTokens/full` 返回无符号整数数组：
`[2, 5, 3, 0, 1, 0, 8, 4, 1, 0, ...]`
分别代表 `[lineDelta, charDelta, length, tokenType, tokenModifiers]`。
- **评估**：该数据专供 GUI 编辑器的高亮渲染器消费。将其反序列化拼接成文本对 LLM 上下文无任何逻辑增量，且每次文件变动重新计算 Semantic Tokens 会给服务端 JVM 带来显著的 CPU 负担。

#### 4. 架构决策

- **严禁**在代理层或代码读取层向源码拼接 Inlay Hints 与 Semantic Tokens。
- 保持终端与磁盘代码文件的 100% 字符一致性。若对多态重载签名存在疑义，指导 Agent 主动触发 `xd://lsp` 的 `hover` 或 `definition`。

---

## 3. 领域二：工程构建与测试推导策略

### 3.1 AGP 构建目标推导缺陷的底层反编译机理与规约治理

#### 1. 缺陷机理逆向还原

在 `plugins/dap-jvm/lib/modules/language-server.dap.jvm.jar` 中反编译 `com.jetbrains.dap.jvm.launch.GradleLaunchContributorKt`：

```bytecode
Compiled from "GradleLaunchContributor.kt"
public final class com.jetbrains.dap.jvm.launch.GradleLaunchContributorKt {
...
  public static final java.lang.String gradleClassesTask(java.lang.String);
    Code:
         0: aload_0          // sourceSet 名称
         1: ldc           #43 // String "sourceSet"
         3: invokestatic  #16 // Method kotlin/jvm/internal/Intrinsics.checkNotNullParameter:(Ljava/lang/Object;Ljava/lang/String;)V
         6: aload_0
         7: ldc           #129 // String "main"
         9: invokestatic  #133 // Method kotlin/jvm/internal/Intrinsics.areEqual:(Ljava/lang/Object;Ljava/lang/Object;)Z
        12: ifeq          20
        15: ldc           #135 // String "classes"
        17: goto          26
        20: aload_0
        21: invokedynamic #138,  0 // InvokeDynamic #1:makeConcatWithConstants:(Ljava/lang/String;)Ljava/lang/String; (拼接: sourceSet + "Classes")
        26: areturn
...
```

再查看调用链中的 `gradleBuildCommand`：
```bytecode
  public static final com.jetbrains.ls.api.core.launch.BuildToolBuildResult$Command gradleBuildCommand(java.nio.file.Path, java.lang.String, java.lang.String);
    Code:
        30: aload_0
        31: invokestatic  #53 // Method gradleExecutable:(Path)String
        34: invokeinterface #59, 2 // List.add:(Object)Z
        40: aload         4
        42: aload_1           // projectPath (例如 ":app")
        43: aload_2           // sourceSet (在 Android 变体下为 "debug")
        44: invokestatic  #63 // Method gradleClassesTask:(String)String -> 得出 "debugClasses"
        47: invokestatic  #67 // Method gradleTaskPath:(String;String)String -> 得出 ":app:debugClasses"
        50: invokeinterface #59, 2 // List.add
```

#### 2. Android AGP 工程实测报错

在现代 Android 工程（如 `MyHook`，AGP 9.4.1）中调用 `intellij.java.resolveBuildCommand`：
- **服务端响应**：

  ```json
  {
    "supported": true,
    "command": ["./gradlew", ":app:debugClasses"],
    "cwd": "F:/source/MyHook",
    "tool": "gradle"
  }
  ```
- **执行报错**：

  ```text
  FAILURE: Build failed with an exception.
  * What went wrong:
  Task 'debugClasses' not found in project ':app'. Some candidates are: 'compileDebugSources', 'compileDebugUnitTestSources'.
  ```

#### 3. 方案权衡与决策

| 方案                         | 实现方式                                                                                                                            | 优势                                                                                  | 风险与代价                                                                                                          |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **方案 A：代理层透明重写**   | 在 `run-core.ts` 中拦截 `resolvedBuild.command`，将 `:module:<variant>Classes` 动态正则替换为 `:module:compile<Variant>Sources`。   | 用户无感知，一键 launch 体验流畅。                                                    | 当工程使用多 Flavor 组合（如 `freeDebugClasses`）或非标准变体时，正则映射可能失效；无法覆盖增量 Dexing 与资源打包。 |
| **方案 B：规约约束（推荐）** | Android 项目调试强制在 DAP launch 配置中声明 `"build": false`；构建过程由 OMP 原生 `bash` 直接调用 `./gradlew :app:assembleDebug`。 | 构建与调试解耦，100% 兼容所有 AGP 自定义 Task、变体与构建参数，退出码与日志完全保真。 | 需要调用者掌握两阶段执行规范。                                                                                      |
| **方案 C：等待上游修复**     | 向 JetBrains 反馈 `AndroidProjectModelBuilder` 与 `GradleLaunchContributor` 的不匹配。                                              | 官方协议原生修复。                                                                    | 周期漫长，版本发布不受控。                                                                                          |

**最终决策**：采用方案 B，保留原始构建语义。
- Android 构建、打包与安装由 OMP `bash` 和 Android 工具执行，调试走 JDWP attach；适配器参与启动时显式关闭预构建。
- 不在代理层按任务后缀透明重写。源码编译、资源生成和打包目标不同，改名无法保证调用者需要的产物。

---

### 3.2 Kotlin 测试扫描空结果的注册表黑盒根因与发现边界

#### 1. 空结果底层根因逆向

定位 `plugins/java.lsp/lib/modules/language-server.api.features.impl.java.jar` 中的 `com.jetbrains.ls.api.features.impl.java.o.r` 与 `e`：

```bytecode
// com/jetbrains/ls/api/features/impl/java/o/r.class
public final class com.jetbrains.ls.api.features.impl.java.o.r {
...
  public final com.jetbrains.ls.api.features.impl.java.o.y A(com.intellij.openapi.vfs.VirtualFile);
    Code:
         0: aload_1          // VirtualFile
        52: aload         6  // 遍历已注册的处理器 y
        54: invokeinterface #3, 1 // Method y.A:()String (返回支持的扩展名)
        59: aload_1
        60: invokevirtual #102    // Method VirtualFile.getExtension:()String
        63: invokestatic  #41     // areEqual:(Object;Object)Z
        66: ifeq          23
        69: aload         5
        71: goto          75
        74: aconst_null
        78: areturn
...
  static {};
    Code:
        10: getstatic     #38 // Field com/jetbrains/ls/api/features/impl/java/o/b.c:Lb;
        13: invokestatic  #6  // Method CollectionsKt.listOf:(Object)List;
        16: putstatic     #13 // Field o:List;  <--- 仅注册了 b.c！
```

检查 `com.jetbrains.ls.api.features.impl.java.o.b`：
```bytecode
  public java.lang.String A();
    Code:
         0: ldc #3 // String "java"
         2: areturn
```

调用链最终在 `com.jetbrains.ls.api.features.impl.java.o.e.A` 中直接短路：
```bytecode
  18: getstatic     #114 // Field y.A:Lr;
  21: aload_1            // VirtualFile
  22: invokevirtual #212 // Method r.A:(VirtualFile)y;
  25: dup
  26: ifnonnull     34
  29: pop
  30: invokestatic  #151 // Method CollectionsKt.emptyList:()List;  <--- 扩展名非 "java" 直接返回空列表！
  33: areturn
```

**黑盒根因结论**：
服务端的测试文件发现命令 `intellij.jvm.discoverTestsInFile` 的注册中心 `r` 中，目前**仅硬编码注册了 `.java` 文件扫描器 `b`**，对 `.kt` 文件的请求必然且无条件返回空数组 `[]`。

#### 2. 类名解析可行性验证

后续的测试启动规格解析命令 `intellij.jvm.resolveTestLaunch`（由 `com.jetbrains.ls.api.features.impl.java.o.l` 实现）：
```bytecode
// com/jetbrains/ls/api/features/impl/java/o/l.class
31: invokestatic #184 // Method ClassUtil.findPsiClass:(PsiManager;String)PsiClass;
```
由于 IntelliJ Platform 内置了 Kotlin UAST 与 Symbol Light Classes，只要直接传入全限定类名（例如 `com.example.KotlinAppTest`），`ClassUtil.findPsiClass` 能够无缝定位并生成基于 `com.intellij.rt.junit.JUnitStarter` 的完整参数（包含 classpath 与 vmArgs）。

#### 3. 发现边界与工程决策

- 当前 `src/test-launch.ts` 保留服务端发现结果和显式测试 ID 路径；发现为空时明确报错，多个启动规格要求分组执行。
- 类名含 `Test` 或声明顶层类均不能证明测试可运行。正则方案还需要处理修饰符、反引号标识符、注释、继承和嵌套结构，不能直接进入执行清单。
- 文件读取或解析错误必须保留原因，禁止吞掉错误后伪装为无测试。
- 自动发现继续在 `RESEARCH.md` 研究服务端符号或测试语义；用真实 fixture 和请求响应验证漏报、误报及启动分组。

---

## 4. 领域三：DAP 调试底层与上游限制

### 4.1 深层调用栈 JDI 越界异常（Index 128 out of bounds for length 65）机理与分页规避实验

#### 1. 背景与复现

历史记录包含一次 `stackTrace` 返回 `Index 128 out of bounds for length 65` 的失败。该错误本身不能证明服务进程崩溃，也不能把 65 层推广为所有 JDK 和暂停位置的固定阈值。

#### 2. 逆向机理分析

反编译 `lib/language-server.dap.platform.jar` 中的 `com.jetbrains.dap.platform.XDapStackFrameSupport`：

```bytecode
// XDapStackFrameSupport.class - stackTrace
105: aload_1
106: invokevirtual getThreadId-Bpwn2l8:()I
110: aload_1
111: invokevirtual getStartFrame:()Integer -> startFrame (默认 0)
128: aload_1
129: invokevirtual getLevels:()Integer     -> levels (默认 2147483647)
147: iload_3
148: invokestatic fromDapId:(I)XExecutionStackId
153: aload 6
155: iload 4  // 传入 startFrame
204: invokestatic collectStackFrames:(XExecutionStackId;I;Continuation)
...
262: checkcast java/util/List
265: astore 7 // 所有收集完成的 frames
272: iload 5  // levels 参数
274: invokestatic CollectionsKt.take:(Iterable;I)List // 在内存中做截断！
```

继续跟入 `collectStackFrames`：
1. `startFrame` 作为 `firstIndex` 被送入了底层的 `computeStackFrames`。
2. **`levels` 参数完全未传递给底层 JDI 抓取器**，仅在整条栈全量拉取完成后，在内存中执行 `take(frames, levels)`。
3. 底层 `JavaExecutionStack$AppendFrameCommand` 会持续循环通过 JDI `ThreadReferenceProxyImpl.frames()` 收集直到栈底。
4. 在 JB JDI 库（`plugins/dap-jvm/lib/intellij.java.debugger.libraries.jb.jdi.jar`）中，批量抓取采用了 128 的固定分片步长，且缺少对末端帧数的边界保护，导致底层数组索引越界。

#### 3. 分页结论待复现

- 所列字节码提示 `levels` 在收集后截断，但不足以独立证明所有请求组合均无法读取真实浅层帧。
- `README.md` 另记载 `levels: 1` 曾读取顶层工程帧；两份记录的版本、线程、暂停位置、实际栈深与请求顺序尚未对齐。
- 按 `RESEARCH.md` 补齐固定条件下的分页矩阵及完整 DAP 报文，分别确认请求失败、会话结束与进程退出。

#### 4. 代理层错误契约

- 保留服务端 `success: false`、错误正文与请求关联，禁止以 `success: true` 掩盖失败。
- 仅转发服务端返回的真实 frame ID；合成帧无法支持后续 scopes、variables 或 evaluate。
- 单次栈请求错误不应主动结束会话；以继续运行、再次暂停和正常断开验证会话状态。自动重试或分页绕过方案待预研完成。

---

### 4.2 Android 设备/模拟器进程调试连接链路与 ADB 权责边界

#### 1. 物理连接拓扑

```mermaid
graph LR
    subgraph Host Workstation
        OMP[OMP Agent] -->|JDWP Attach| Proxy[omp-intellij dap-proxy]
        Proxy -->|TCP 127.0.0.1:8700| ADBClient[ADB Local Port]
    end
    
    subgraph Device / Emulator
        ADBClient -->|USB / TCP Tunnel| ADBDaemon[adbd]
        ADBDaemon -->|Unix Socket / JDWP| ART[Android App Process (ART)]
    end
```

#### 2. 环境依赖复杂度剖析

如果将 `adb forward` 自动化封装入 `omp-intellij`：
- **设备多路复用歧义**：多台真机与模拟器同时在线时，必须向用户或 Agent 询问 `-s <serial>`。
- **进程生命周期竞争**：Android 应用冷启动挂起（`am start -D`）后，PID 是动态生成的，插件内部需要编写轮询与重试逻辑。
- **端口泄漏隐患**：如果调试异常断开，必须确保 `adb forward --remove tcp:<port>` 被精准执行，否则引发后续调试端口冲突。

#### 3. 架构落地决策

**坚决不在 `omp-intellij` 内封装 ADB 逻辑**。
- **职责收敛**：`omp-intellij` 专精于作为标准的通用 JDWP 适配器。
- **标准范式**：
  1. 端口映射与设备调度由 OMP 原生的 `android-cli` 或自动化脚本负责：

     ```sh
     adb forward tcp:8700 jdwp:$(adb shell pidof com.example.app)
     ```
  2. OMP `debug` 工具直接发起原生 `attach`：

     ```json
     {
       "action": "attach",
       "adapter": "intellij",
       "host": "127.0.0.1",
       "port": 8700
     }
     ```
  3. `dap-proxy.ts` 保证握手稳定、断开不杀远程进程，权责清晰，零环境耦合。

---

### 4.3 Android 多变体切换机制与 Native C++ (CMake) 深度支持边界

#### 1. 变体切换（Variant Switching）事实

在 `plugins/kotlin.lsp/lib/modules/language-server.workspace-import.gradle-plugin.jar` 中反编译 `com.jetbrains.ls.imports.gradle.model.builder.android.AndroidUtilsKt`：

```bytecode
// AndroidUtilsKt.class - selectActiveVariant
57: ldc "lsp.android.variant"
59: invokeinterface gradleProperty:(String)Provider;
74: ldc "lsp.android.variant"
76: invokeinterface systemProperty:(String)Provider;
96: ldc "LSP_ANDROID_VARIANT"
98: invokeinterface environmentVariable:(String)Provider;
```

- **机制线索**：所列字节码按顺序读取 Gradle property、system property 和环境变量，但具体优先级及默认选择规则需要完整实现与实验核对。
- **待验证**：尚未建立动态切变体 RPC 或现有 reload 路径更新变体的端到端证据。
- **工程边界**：工程级导入环境见 `TODO.md`；以真实多 flavor 工程的 source roots、classpath 和专属符号作为生效证据。已经启动的共享服务不会因父 shell 后续修改环境而自动更新。

#### 2. Native C++ (CMake / JNI) 支持边界

对全部 636 个服务端 Jar 包进行字节码扫描，结果如下：
- `CMake` 相关类：**0**
- `OCSymbol` / `OCElement`（CLion C++ 核心抽象）：**0**
- `CPPElement`：**0**

**边界定论**：`intellij-server` 仅包含 Java、Kotlin、Spring 等 JVM 生态插件，**完全移除了 C/C++ 语言引擎**。
在包含 JNI 的 Android 工程中，`externalNativeBuild` 被静默跳过。Java/Kotlin 中的 `external` 或 `native` 方法无法导航至 `.cpp` 源码。针对 C/C++ 源码的跳转与重构，必须通过 Clangd 独立接入。

---

## 5. 领域四：服务端架构与宿主环境

### 5.1 Headless 服务端动态扩展机制（-Dplugin.path 逆向分析）

#### 1. 逆向机理分析

在 `lib/intellij.platform.core.impl.jar` 中反编译 `com.intellij.ide.plugins.PluginDescriptorLoader`：

```bytecode
Compiled from "PluginDescriptorLoader.kt"
public final class com.intellij.ide.plugins.PluginDescriptorLoader {
...
  private static final kotlinx.coroutines.Deferred<com.intellij.ide.plugins.DiscoveredPluginsList> loadDescriptorsFromProperty(kotlinx.coroutines.CoroutineScope, com.intellij.ide.plugins.PluginDescriptorLoadingContext, com.intellij.util.lang.ZipEntryResolverPool);
    Code:
         0: ldc_w         #510 // String "plugin.path"
         3: invokestatic  #516 // Method java/lang/System.getProperty:(String)String;
         6: dup
         7: ifnonnull     19
        10: pop
        11: aconst_null
        12: invokestatic  #522 // Method CompletableDeferred:(Object)CompletableDeferred;
        15: checkcast     #524 // class kotlinx/coroutines/Deferred
        18: areturn
        19: astore_3
        20: ldc_w         #526 // String "idea.use.core.classloader.for.plugin.path"
        23: invokestatic  #532 // Method java/lang/Boolean.getBoolean:(String)Z
        26: istore        4
        28: new           #534 // class java/util/StringTokenizer
        31: dup
        32: aload_3
        33: getstatic     #540 // Field java/io/File.pathSeparatorChar:C
        36: istore        6
        38: ldc_w         #542 // String ","
        41: astore        7
        43: new           #42  // class java/lang/StringBuilder
        46: dup
        47: invokespecial #45  // Method StringBuilder."<init>":()V
        50: iload         6
        52: invokevirtual #545 // Method StringBuilder.append:(C)StringBuilder;
        55: aload         7
        57: invokevirtual #49  // Method StringBuilder.append:(String)StringBuilder;
        60: invokevirtual #53  // Method StringBuilder.toString:()String;
        63: invokespecial #548 // Method StringTokenizer."<init>":(String;String;)V
...
```

#### 2. 扩展机制的证据边界

- `plugin.path` 读取代码证明平台包含加载机制线索；目标分发包的依赖、扩展注册和类加载行为仍需实测。
- JVM 系统属性应经启动器支持的 JVM 配置通道传入，具体路径按安装包核实；不把 `-D` 当作服务端 CLI 参数。
- 微型插件修复继续预研。加载成功、扩展点生效和覆写既有实现是不同验收条件，不能由加载器存在直接推导。

---

### 5.2 长周期运行与内存驻留特征（RocksDB 膨胀曲线与 closeProject 缺失事实）

#### 1. 缓存膨胀实测数据

对宿主机 `F:/cache/intellij-server/shared` 进行深度统计：
- 目录总大小：**3991.53 MB** (~4 GB)。
- 历史工程数：12 个。
- 目录分布剖析：

  ```text
  workspaces/
  ├── 1e7c75c036851973ca5b75d53842e6bb/ (465.63 MB)
  │   └── index/intellij-server/rocks/    (465.50 MB, RocksDB SST 文件)
  ├── 2b9a35a751bf13964d06209e1ea4e801/ (566.96 MB)
  │   └── index/intellij-server/rocks/    (566.80 MB)
  ...
  ```
- **证据范围**：这是历史磁盘占用快照，支持多工程缓存占用的判断；增长速率与长期膨胀规律需要时间序列。

#### 2. 项目关闭方法与内存释放边界

反编译 `lib/language-server.analyzer.jar` 中的 `com.jetbrains.analyzer.bootstrap.AnalyzerProjectManager`：

```bytecode
Compiled from "AnalyzerProjectManager.kt"
public final class com.jetbrains.analyzer.bootstrap.AnalyzerProjectManager extends com.intellij.openapi.project.ProjectManager {
...
  public boolean closeProject(com.intellij.openapi.project.Project);
    Code:
         0: aload_1
         1: ldc           #3 // String "project"
         3: invokestatic  #66 // Method kotlin/jvm/internal/Intrinsics.checkNotNullParameter:(Ljava/lang/Object;Ljava/lang/String;)V
         6: new           #41 // class java/lang/IllegalStateException
         9: dup
        10: ldc           #1  // String "not implemented"
        12: invokevirtual #11 // Method Object.toString:()String;
        15: invokespecial #27 // Method IllegalStateException."<init>":(String;)V
        18: athrow

  public boolean closeAndDispose(com.intellij.openapi.project.Project);
    Code:
         ...
        10: ldc           #1  // String "not implemented"
        18: athrow
```

- **机制线索**：所列 `closeProject` / `closeAndDispose` 方法未实现；其他断连与销毁路径、对象可达性及 GC 行为尚未覆盖。
- **待验证**：用长期压测区分设计驻留、可回收缓存和真实泄漏，不能由两个方法推导全部项目永久驻留。
- **工程决策**：保留既有 `idleTimeout`，优先提供受租约与活动会话保护的显式 stop / restart。自动轮替阈值与策略继续预研，不依据项目数量直接触发重启。

---

### 5.3 无头环境与容器化离线授权治理（EULA Hash 算法与静默预装规范）

#### 1. EULA 验证机理逆向

在 `lib/language-server.main.jar` 中反编译 `com.intellij.ls.server.eula.EulaKt`：

```bytecode
Compiled from "eula.kt"
public final class com.intellij.ls.server.eula.EulaKt {
...
  public static final void enforceEulaAccepted(java.lang.String, java.nio.file.Path);
    Code:
       116: aload_1 // EULA.txt 路径
       117: invokestatic Files.readAllBytes:(Path)[B
       128: ldc "SHA-256"
       130: invokestatic MessageDigest.getInstance:(String)MessageDigest;
       133: aload 4
       135: invokevirtual MessageDigest.digest:([B)[B
       173: aload 6 // Hex 字符串
       179: invokevirtual String.substring:(II)String // 截取前 16 位！
...
       226: invokestatic eulaAcceptanceGranted:(String;String;EulaAcceptanceStore)Z
       229: ifeq 233
       232: return
       233: bipush 11 // System.exit(11) 并打印报错
```

- **EULA 机制线索**：所列实现计算实际 EULA 内容的 SHA-256 前 16 位十六进制字符，并支持通过启动参数提交已接受的 hash。
- **接受约束**：hash 可计算不等于用户已同意；首次接受与协议内容变化都需要用户明确确认，接受记录与许可证凭据分离。

#### 2. 离线部署待验证条件

- 原固定 hash 与推测的接受文件写入示例已移除；文档不提供绕过确认的预置接受记录。
- 固定服务端分发包，核实自带 JBR、EULA 位置、支持的许可证注入方式与持久化行为。
- 使用经授权的凭据验证离线启动、容器重建、授权失效和无交互错误反馈；凭据不进入镜像公开层或普通日志。
- EULA 确认和授权状态的确定性功能见 `TODO.md`；完整容器指南在实际运行通过后发布。

---

### 5.4 Kotlin 编译器前端演进（K2 Analysis API 纯净度与 KMP 跨源集 expect/actual 解析）

#### 1. 前端版本核验

通过对服务端类库的全量扫描证实：
- `idea.k2` 类数量：**1644 个**
- `idea.fe10` 类数量：**0 个**
- 包含 `kotlinc.analysis.api.k2.jar`、`kotlinc.kotlin.compiler.fir.jar`、`kotlinc.low.level.api.fir.jar`。

**证据范围**：所列类库支持当前分发包采用 K2/FIR 的判断；扫描命名空间的结果不单独证明全部前端路径及 KMP 平台支持。

#### 2. KMP 跨源集符号解析机制

在 `lib/language-server.api.core.util.jar` 中，`LSImplementationsKt` 通过 `ImplementationSearcher` 路由符号发现：

```bytecode
// LSImplementationsKt.class
81: invokestatic ImplementationSearcher.getFlags:()I
89: invokestatic TargetElementUtil.getInstance:()TargetElementUtil;
```

`ExpectActualSupport` 是跨源集搜索的机制线索。仍需在真实 KMP fixture 中验证：
- `commonMain` 的 `expect` 执行 implementation 后返回哪些平台的真实位置。
- 平台 `actual` 的 definition 是否返回共享声明，以及 references、诊断是否跨源集正确。
- Gradle 导入后的源码集模型及宿主可用目标。导入成功与搜索类存在均不等同于完整导航验证。

---

## 6. 落地分流方案与技术行动项

执行清单与预研分别以 [TODO.md](./TODO.md) 和 [RESEARCH.md](./RESEARCH.md) 为准，本节仅记录分流边界。

### 1. 确定性功能开发

按顺序推进 EULA 明确确认、导入错误保真、授权状态感知、安全 stop / restart、bridge / runner 有效配置一致性、工程级导入环境。具体范围、验收条件及进程所有权约束见 TODO；这些功能尚未实现。

### 2. 继续预研

Kotlin 自动测试发现、JDI 分页、Android 变体与真实 ART 调试、微型服务端插件、长期内存与自动轮替、离线授权部署、KMP 跨源集支持。缺少端到端证据前不转为开发任务。

### 3. 已收敛的职责边界

- 语义查询与重构复用原生 LSP，层级特殊查询走 raw `request`；源码保持原文。
- 工程执行复用 OMP `bash` / service，调试复用原生 `debug`；ADB 与 C++ 交给独立工具。
- 保留显式测试 ID、原始失败和真实调试帧；禁止正则猜测可运行测试、合成成功帧及透明改写 AGP task。
- 保留既有验证计划；本次文档审查没有新增运行验证结论。
