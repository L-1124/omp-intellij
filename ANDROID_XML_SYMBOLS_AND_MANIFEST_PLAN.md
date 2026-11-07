# Android XML DocumentSymbol 与 Manifest References：A/B 实施计划

## 目标、优先级与当前状态

以 `plan.md` §§4–6 为契约，交付 A（Android XML 文档符号）与 B（Manifest 类属性触发 Java/Kotlin references），并迁移已有 Android definition。目标服务端为锁定的 ILS `271.2085.0`。本文件是待实施规格，不表示生产 Provider 已存在。

实现优先级固定为：**现有标准 LSP → 已广告且实测满足契约的私有命令/内置 MCP → 仅对剩余 Android 缺口补 JVM Provider**。XML 解析、位置换算、类解析和语义搜索复用服务端当前 PSI、Document、索引与模块模型。Bridge 负责协议中继和已证实必要的格式适配，不新增 TS XML/Gradle 解析器，也不再基于空原生响应启动 TS Android 查询。

本专项不新增资源声明 references（阶段 C）、Compose/Lint（D/H）或设备调试（E）的实现；与这些阶段共享的 JVM 上下文及发布机制按主计划执行。已有 R/XML definition 的迁移须保持原有行为。

## 一、先发现并验证原生能力

### 1.1 可复现的发现入口

1. 对目标 Java/Kotlin/XML 文件使用 `xd://lsp` 的 `capabilities`，确认路由到 `intellij-server`，读取标准能力、`executeCommandProvider.commands` 和 `experimental`。缺少服务时先检查插件安装、fileTypes、真实工程 marker 和运行配置路径，再 reload；不能通过杀健康共享服务解决路由问题。
2. 命令广告包含 `list-mcp-tools` 时，通过 `request` 发送 `workspace/executeCommand`，参数为 `{"command":"list-mcp-tools","arguments":[]}`，读取实际工具名称、description 和 inputSchema。
3. 已确认的调用封装为 `{"command":"run-mcp-tool","arguments":[{"tool":"get_project_modules","arguments":{}}]}`。实际工具参数按发现的 schema 填写；有 projectPath 时传目标工程路径。不能把工具自身的 inputSchema 当成 run-mcp-tool 封装 schema。
4. 保留完整原生错误；MCP 还须检查返回的 `isError`，传输成功不表示工具执行成功。能力广告、工具清单和具体调用成功分别记录。

Agent 可使用现有 `xd://lsp request` 完成发现与调用，不要求为这些已有功能另造 `intellij/projectView`、专用 structure action 或静态复制全部 MCP schema。Capabilities 能列出已声明能力，不能枚举所有未广告的自定义 JSON-RPC 方法。

`xd://lsp` 的现有入口分工如下；它是宿主工具，不能将其 action 名称全部等同为 LSP 标准方法：

| 任务 | 入口 |
| --- | --- |
| 服务发现、协商、重载 | `status`、`capabilities`、`reload`；ready 不能单独证明工程索引就绪 |
| 文件大纲、全工作区符号 | `symbols`；指定 file 查文件，`file: "*"` 配合 query 查工作区 |
| 定义、类型、实现、引用、文档 | `definition`、`type_definition`、`implementation`、`references`、`hover` |
| 重构与修复 | `rename`（默认应用，可预览）、`rename_file`、`code_actions`（默认列举） |
| 诊断 | `diagnostics`，支持文件、glob 与工作区；具体获取机制取决于适配器 |
| 无独立 action 的标准方法、已广告私有命令 | `request`，query 为方法名、payload 为 JSON 参数字符串；不限于私有协议 |

目标服务端已广告调用层级、类型层级、语义高亮和格式化时，可经 request 使用对应标准方法；先核对 capability 与方法参数，不为这些能力另设 Bridge 业务接口。标准方法经 request 调用仍属于第一优先级。按 file 选择服务端；位置类动作使用工具要求的 file、1 基 line 与明确 symbol。


### 1.2 已观察能力与边界

| 入口 | 本会话证据 | 本专项可用范围 |
| --- | --- | --- |
| `list-mcp-tools` | 返回含说明与 inputSchema 的 22 项工具 | 原生功能发现；工具集合随服务端版本/工程能力变化，不固定数量为协议契约 |
| `get_project_modules` | 临时 Maven marker 工程返回模块 name/type | 模块概览；没有实测源码根、namespace、资源根或变体字段，不能替代 Android 上下文 |
| `get_project_dependencies` | 上述工程返回空 dependencies | 依赖入口已可调用；不证明 Android 依赖、模块边和作用域完整 |
| `list_directory_tree` | 当前工程返回 `The project directory cannot be determined.` | 仅记录失败；不能宣称目录树或包视图已验收 |
| `analyze_calls` / `search_symbol` | 清单含 schema，未在 Android 场景验收 | 分别用于调用关系/定位候选；不能替代包含 import、KDoc 的 references 或证明唯一类身份 |
| `exportWorkspace` | 现有代码已调用并读取 workspace.json；主计划保留导入实验 | 导出已导入工作区模型，不是 XML PSI、AST 或包树；体积/耗时按实际文件测量 |

主计划记录 271 的原生 XML 空结果及自有 PSI 大纲探针。实施时在同一目标版本、真实 Android 导入与实际文档上复核，不能用临时 marker 工程证明 Android 能力。

### 1.3 补扩展的判定

先在隔离 271 实例对 Manifest/values 的标准 `documentSymbol`、`definition`、`references` 记录原生范围、内容及未保存文档行为。只有满足下文身份、范围、includeDeclaration、模块作用域与取消契约的能力才能直接复用。非空响应本身不证明 Android 语义完整；泛 XML 标签树也不能自动算作 Android 资源大纲。

原生标准请求完整满足某项时，保持其处理链，删除该项自有实现任务。内置 MCP 仅在其实际 schema 和行为符合所需语义时复用，不将调用树伪装成引用集合。原生缺少 A/B 语义时，在已有 XML 语言中追加 JVM Provider；不以 Bridge 解析/过滤 XML 来弥补，不重写上游已有功能。

## 二、实现分工与切换

| 位置 | 实施内容 |
| --- | --- |
| `jvm/android-ls-extension/`（拟新增，按主计划构建/加载） | Android 工程上下文、XML PSI 大纲和 Manifest 类目标解析；仅实现经原生验收确认的缺口 |
| JVM definition/references 共享服务（拟新增） | 当前模块依赖范围内解析真实 Java/Kotlin 目标，复用平台语义搜索，统一位置与去重 |
| `src/bridge.ts` | 保留标准请求、文档同步、错误和取消转发；若仍有层级兼容问题，仅转换符号响应格式 |
| `src/shared/navigation-relay.ts` | 删除切换后已被 JVM 覆盖的 Android 业务中继；其他仍存在的内部请求保留完整 ID 归属和清理 |
| `src/android/xml.ts`、`navigation.ts`、`resource-resolver.ts` | 对照原有行为迁移；验收完成后删除被替代实现、无用类型/测试及 `saxes` 依赖，不保留 TS 备用解析路径 |
| 现有 Node 与隔离 ILS 测试 | 协议边界留在 Node；Android 身份、XML/代码语义迁到真实 JVM/ILS 行为验收 |

不新建 `src/android/document-symbols.ts` 或 `src/android/references.ts` 的 TS 业务实现。修改导出接口先查 LSP references；迁移所有调用方。精确版本资产、插件依赖、SPI、加载失败的报告和安全重启均使用主计划 §12，不向共享服务热塞 JAR。

Provider 通过 `LanguageServerExtension` / `LSConfigurationPiece.entries` 注册到既有 `xml`；不重复注册语言。复用已验证的 `LSDocumentSymbolProviderPsiBase` / `LSDocumentSymbolCustomizer` 入口；references Provider 及 Kotlin 搜索路径在 271 实测后接线。多个 Provider 的聚合、目标优先级和错误传播必须实测，不能假设追加 Provider 就会覆盖原生字节码目标。

## 三、共享工程与文档上下文

- 在本请求的 `server.withAnalysisContext` 中取得 Project，利用平台读操作、Module/ProjectFileIndex、依赖库表和导入模型识别文件所属模块。不能从全局取第一个 Project，或仅凭 android.jar、模块名后缀、文件名及 `/res/values` 子串确认完整 Android 身份。
- 同一 Gradle projectId 下生产、测试和变体模块分别处理。namespace、Manifest 角色、自定义资源根及变体只接受已验证模型/来源证据，缺失时保留未知状态，不默认 debug、不把 applicationId 当 namespace。
- MCP 的模块名称/类型不是源码根清单。JVM 内已有模型可直接读取，不绕行 exportWorkspace 再由 TS 重建；导出用于诊断和对照，不称其为巨型 AST 或宣称固定体积/毫秒性能。
- 使用本连接已同步的当前 Document/PSI；不读取旧磁盘替代失同步文档，不另开 LSP 连接重新查同一未保存文件，不自行增加未证实必要的 commitDocument。
- 仅缓存经测量确有必要的纯结果。缓存须按工程、文档修改戳、模型/来源快照隔离；不保存跨读操作 PSI/KaSession，不新增无依据的 FQN LRU 或可取消在途 Promise 共享。

## 四、A：Android XML 符号

### 4.1 身份、解析和范围

Manifest 必须具有已确认 Android 源集中的实际 Manifest 角色，根为 manifest；values XML 须位于已证明的资源根的合法 values/values-* 目录，根为 resources。自定义根需真实来源证据；未知文件不贡献扩展结果。A 不调用 resolveLaunch，不要求 R.jar，不因查询触发 Gradle。

使用 `XmlFile`、`XmlTag`、`XmlAttributeValue` 和当前 Document。平台负责语法、实体及增量同步；不启用外部实体访问。文档有 PsiErrorElement 时只收集名称和范围仍完整有效的节点，不要求整个文档无错，也不把不完整节点用于类身份解析。

`range` 覆盖元素；`selectionRange` 为名称属性原始值区间（不含引号），必须被 range 包含。匿名 manifest/application 使用标签名区间。通过当前 Document 换算 UTF-16 行列，不用解码字符串长度推算位置。

### 4.2 名称与层级

完整映射沿用 `plan.md` §5.2：string→String(15)，color/dimen→Constant(14)，bool→Boolean(17)，integer→Number(16)，数组/plurals→Array(18)，style→Class(5)，declare-styleable→Interface(11)，attr/具名 style item→Property(7)，id→Variable(13)。顶层 item 按已支持的 type 映射；未知类型、匿名数组 item、注释和缺名资源跳过，保持源码顺序。

Manifest 根→Namespace(3)，application→Module(2)，application 下组件及根 instrumentation→Class(5)，activity-alias→Interface(11)。name 使用资源名或 android:name 原始语义名称；匿名容器使用主计划约定的 package/标签名，resources 容器不伪造资源符号。具名 Android 属性以 namespace URI 判断，支持前缀改名及遮蔽。

不把资源值、Launcher 标识或装饰文本拼进符号 name；需要额外展示信息时使用标准 detail 且不改变身份，不能为 Agent 展示新增另一套解析规则。

### 4.3 能力协商

由已加载 Provider 参与服务端真实能力声明；Bridge 不无条件补 documentSymbolProvider 来掩盖 Provider 未加载。读取真实 `hierarchicalDocumentSymbolSupport`：支持则透传层级结果；主计划记载 271 未自动展平，仅在复核仍需适配时，将返回的 DocumentSymbol DFS 转成 SymbolInformation（使用原范围、uri 和直接父 containerName），不重读 XML。不声明本专项未实现的 workspace/symbol 或其他能力。

## 五、B：Manifest 类属性 references

支持 application/activity/service/provider/receiver 的 Android name、根 instrumentation 的 Android name，以及 activity-alias 的 Android targetActivity。验证 PSI 层级、namespace URI 和光标位于属性值。alias name、permission/action/category、`${...}` 和非类属性不接管。

1. 从当前 PSI 取得属性、原始值范围和模块上下文；definition/references 使用同一目标解析服务。
2. 相对名依据已确认的 Manifest base package/模块 namespace；完整 FQN 无需依赖 R.jar 得到自身身份。按 PackageClassConverter 已核对规则处理相对名及 `$` 内部类，不能正则解析 Gradle 或猜包名。
3. 在当前模块及依赖作用域内用原生 Java/Kotlin PSI 解析唯一真实目标，按完整身份与规范位置消歧。不能按 simpleName 取首项或用 search_symbol 的展示范围冒充声明。
4. XML references Provider 在同一请求分析上下文直接复用平台语义搜索；不经 Bridge 发源码 references 子 RPC。Kotlin/KDoc/import 行为须对照目标源码的原生 references 结果验收，analyze_calls 不能替代该集合。
5. 保留原生语义引用范围和 KDoc，加上当前 XML 属性位置并去重。false 不含类声明；true 增加真实类声明，不能虚构 workspace/symbol 坐标。
6. 使用规范本地 URI/range 去重，jar entry 保留身份，不对整条 jar URI 小写。不同平台遵循实际文件系统身份；保留原生顺序，当前属性不存在时追加。

结果范围仍为“约定作用域的代码语义引用 + 当前查询属性”，不宣称跨全仓 XML Find Usages。目标已解析但零代码引用时，结果仍包含当前属性；无法解析的库目标、缺 namespace、歧义或缺模型均不得伪装为合法零引用。

## 六、取消、错误与原生共存

A/B 使用 ILS Provider 的分析上下文、平台可取消读操作和请求生命周期，不新建 Bridge 三方法增强任务表。循环检查取消，读操作重试时每次独立收集；只在结束后返回纯结果，读锁外不持有 PSI。提交前复核文档修改戳与相关模型/来源快照，编辑、重载、断连或取消后不提交旧结果、不回填缓存。

既有通用内部 RPC 若仍存在，继续绑定父/子 ID、一次响应、超时、迟到帧隔离及清理；AbortController 只传递本地取消信号，不能自动发送 `$/cancelRequest` 或替代响应归属。删除旧 Android 业务链时同步删除仅服务该链的状态，不删除其他消费者仍需的协议保护。

| 情况 | 契约 |
| --- | --- |
| 非 Android/未支持节点 | 扩展不贡献结果，沿用原生处理 |
| 已识别语义查询缺前提或歧义 | `-32803`，具体 model_unavailable / target_unresolved / ambiguous_target 等 reason |
| 取消 / 内容改变 | `-32800` / `-32801`，不吞成 [] |
| 超时 | `-32803 timeout` 并结束相关工作 |
| 合法零引用 | 返回约定的成功集合，与目标未解析区分 |
| Provider 未加载或 ABI 不匹配 | 启动/状态层明确报告不可用；不伪造逐请求错误或恢复 TS 解析 |

原生错误不在 Bridge 改写；新增 Provider 的失败如何参与原生聚合，须在切换前验证。已有 definition 的源码优先级、原生字节码目标并存和可选增强失败语义未验收前，不删除可用旧链。

## 七、实施顺序与验收

1. 先保存 271 的标准能力、MCP schema、原生 A/B/definition 基线；逐项确认上游是否已满足需求，删除可被替代的自有任务。模块概览/MCP 可调用与 Android 语义正确分开验收。
2. 对确认缺口建立主计划 JVM 构建/加载链与共享工程上下文。先验证 XML Provider 聚合、definition 优先级、Kotlin references 和错误传播，再实现正式 A/B 规则。
3. 迁移已有 definition，同一套 PSI/模型/来源服务供 A/B 与后续 C 使用；完成同等行为验收后删除 TS XML 业务链和依赖，保留必要通用协议适配。
4. 复用 `test/integration/fixture.ts` 隔离沙箱/协议客户端；Node 测试保留协议行为，真实 PSI/搜索用 JVM/ILS 集成验证。运行 `npm run typecheck`、修改范围的 Biome 检查、`npm test` 及隔离 ILS 验收，不重排无关文件。

### 行为与证据要求

- A：主计划全部类型、源码顺序、层级/平面、精确 range/selectionRange；CRLF、emoji、实体、单双引号、多行属性；未保存修改；局部错误 XML、DTD/外部实体安全；非 Android 同名路径、自定义目录证据和干净无 R.jar 工程。
- B：false/true、零代码引用、当前属性去重、根 instrumentation、alias target/name、前缀/遮蔽、placeholder、相对/完整/内部类、同名不同包、依赖模块、真实声明歧义和不可解析库目标。
- 并发：取消/编辑/导入失效在解析及搜索中发生；两个请求互不取消；迟到结果只响应一次；关闭释放记录；增强期间无关 hover 正常返回；其他工程不受影响。
- 原生利用：发现到工具但执行失败须保留失败记录；不能因 list 返回名称就宣称能力已验收。generic lint_files 不等于 Android Lint，目录树不等于语义包树。

真实烟测使用独立 systemPath 和已安装的 271，复用相同 hash 的既有 EULA 记录，不自动接受新条款。通过真实 Bridge 完成 initialize→initialized→导入/就绪，再 didOpen 临时 Android 工程副本的 strings.xml/Manifest，查询 A/B 与既有 definition，核对 URI、当前属性、代码引用和声明集合。先比原生基线；有上游实现则验证其等价行为，不为凑数覆盖它。

263 的 MainActivity 3/4、HookLogProvider 2/3、McpForegroundService 9/10（含当前属性）仅作为历史证据，不能固定为 271 预期。271 使用真实位置集合验收，包含仅 didChange 未保存修改、并行 hover、搜索中取消和新会话恢复。最后关闭客户端、停止自有沙箱服务并清理自有临时资产；不触碰共享服务和 MyHook 生产文件。交付原生/扩展的能力与协议证据，不能用单元测试或本计划代替生产验收。
