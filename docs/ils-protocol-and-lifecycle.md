# ILS 协议与生命周期规范

## 1. 服务端分发与启动生命周期

### 1.1 版本元数据与归档校验

目标 ILS 版本、底层 JBR 版本、配套 VSIX 版本以及各平台归档格式（macOS `.sit`、Linux `.tar.gz`、Windows `.win.zip`）、文件大小和 SHA-256 校验和统一维护在 `src/server/bundle-metadata.ts` 中。

运行时安装与更新直接消费内置元数据而不探测远程 `latest`：
- **下载基准 URL**：`https://download.jetbrains.com/language-server/intellij-server/<version>/intellij-server-<version>[suffix].[ext]`
- **下载与磁盘校验**：安装前校验本地缓存的字节大小与 SHA-256；下载后执行流式 `crypto.createHash('sha256')` 比对，校验失败立即删除临时文件并中止解压。Windows 发行包根目录直接包含 `build.txt` 与 `bin/intellij-server.exe`，安装器与校验脚本按该直铺目录结构核验。

### 1.2 离线版本更新工具

插件采用日期版本号（CalVer，如 `YYYY.M.D` 或 `YYYY.MMDD.PATCH`，数字段不含前导零以符合 npm 规范）。上游服务端升级与 `.omp-plugin/marketplace.json` 同步由离线脚本 `scripts/update-server-bundle.mjs` 完成（VSIX 解析缓冲上限 32 MiB，网络超时 120 秒）：

```bash
# 检查当前锁定版本与配置
npm run update-bundle -- --sync-marketplace --check

# 指定升级版本并同步 marketplace 配置
npm run update-bundle -- --version <ils-build> --vsix-version <vsix-version> --sync-marketplace
npm run update-bundle -- --sync-marketplace --check
```

脚本核对 VSIX 内 `server-bundle.json` 记录的服务端版本与平台哈希后才更新元数据；`--sync-marketplace` 提取上游 `activationEvents` 生成 `rootMarkers` 与默认配置。

### 1.3 运行时转译与端口文件解析

- **运行时转译（`src/plugin.ts`）**：按源码与配置内容计算哈希，将 TypeScript 转译为 Node ESM 并原子发布到 `.runtime/`。不复制或自动装载服务端扩展资产。

- **端口文件解析（`src/server/service.ts`）**：ILS 写入的 `server.port` 包含三行文本——第 1 行为监听端口，第 2 行为服务端 PID，第 3 行为服务端构建号（如 `ILS-<build>`）。`endpoint()`、`isServerAlive()` 和 `isPortListening()` 统一调用 `parsePortFile` 提取首行并校验 `1–65535` 端口范围：

  ```ts
  export function parsePortFile(text: string): number | null {
    const first = text.split(/\r?\n/, 1)[0]?.trim() ?? '';
    if (!/^\d+$/.test(first)) return null;
    const port = Number(first);
    return port >= 1 && port <= 65535 ? port : null;
  }
  ```

- **进程身份查询**：Windows CIM 与其他平台的 `ps` 查询使用异步子进程，单次命令预算为 5 秒，避免阻塞协议响应与取消。Windows 仅在 `pwsh.exe` 缺失时回退到 `powershell.exe`；查询超时、失败或身份缺失时维持拒绝确认所有权的行为。

---

## 2. Bridge 连接与协议适配

### 2.1 初始化握手与工作区归并

- **连接与构建根归并**：Bridge 从接收 `initialize` 开始计时（覆盖配置读取、建立原生 TCP 连接及握手响应），若期间超时、失败或断连则向未完成的请求回传错误并关闭流。工作区标识按构建聚合根（Gradle settings / Maven 父 POM）规范化，并将 `rootUri`、`rootPath` 和 `workspaceFolders` 去重归并；模块级运行上下文仍由服务端导入模型决定。
- **进度与符号适应**：Bridge 保留宿主宣告的编辑与模板能力。宿主宣告 `window.workDoneProgress` 时直接透传相关创建请求与进度通知；未宣告时由 Bridge 自行应答 `window/workDoneProgress/create`，在本地追踪进度并吸收对应 token 的通知。`partialResultToken` 保持独立；`documentSymbol` 按客户端能力决定是否展平为 `SymbolInformation[]`，保留 `tagSupport` 与 `deprecated` 字段，并在流式数组分片与终态响应之间复用同一适配与清理规则。

### 2.2 索引屏障与连接退出

- **通知与索引等待**：仅当服务端声明 `workspace.workspaceFolders.changeNotifications` 为 `true` 或注册动态能力 ID 时才触发重载与索引屏障（ILS 不订阅 `workspace/didChangeWorkspaceFolders`，重新导入显式通过 `intellij/reloadWorkspace` 执行）。等待索引期间，Bridge 持续透传 `textDocument/didChange` 与 `didClose` 并支持 `$/cancelRequest`（返回 `RequestCancelled`），请求超时或导入失败时结束等待并清理符号关联状态。
- **连接隔离与进程退出**：单个 Bridge 只拥有自身会话连接：收到 `shutdown` 在本地拒绝排队请求并返回 `null`，收到 `exit` 时关闭连接、释放租约、销毁 stdin 并快速退出，不影响共享 JVM 守护进程和其他工程连接（停止守护进程统一通过 `/intellij stop` 与空闲回收控制）。在 Windows 环境下，强制终止首个启动共享进程的 Bridge 整棵进程树可能连带结束脱离终端运行的 JVM 后台进程。

### 2.3 CodeAction 与工作区编辑边界

ILS 的 `LSExtractModCommandProviderBase` 在将 `ModCommand` 转换为 LSP `CodeAction` 时要求客户端初始化选项包含 `intellijExtensions: true` 与 `lazyIntentions: true`，否则会过滤掉交互式修复动作。

标准 `workspace/applyEdit` 经 Bridge 透明转发给宿主应用，插件不另建写文件引擎或 Snippet 解析器：
- `snippetEditSupport` 仅保留宿主声明能力；只读 runner 不宣告编辑能力，并对未知反向请求返回 `MethodNotFound`。
- `showConflicts`、`chooseAction`、`runEditorCommand` 与 `copyToClipboard` 等服务端消息按标准 JSON-RPC 原样转发，交互决策由上层宿主处理。
- **编辑与诊断一致性**：外部编辑应用须异步执行，避免阻塞 LSP 事件循环及诊断刷新等反向请求的确认。磁盘变更后的诊断拉取须经过原生高水位屏障；原生刷新验收在写入前排空上一批索引工作，并检查下一次刷新后的首次拉取及模块失效范围。

初始化参数核心配置示例：

```json
{
  "processId": 1234,
  "rootUri": "file:///F:/source/MyAndroidApp",
  "capabilities": {
    "window": {
      "workDoneProgress": true
    },
    "textDocument": {
      "diagnostic": {
        "dynamicRegistration": true
      },
      "codeAction": {
        "codeActionLiteralSupport": {
          "codeActionKind": {
            "valueSet": ["quickfix", "refactor", "source"]
          }
        }
      }
    }
  },
  "initializationOptions": {
    "intellijExtensions": true,
    "lazyIntentions": true,
    "runMainCodeLens": true
  }
}
```

### 2.4 工作区编辑能力

Bridge 原样转发客户端的 `workspace.workspaceEdit` 能力与服务端的标准 `WorkspaceEdit`，不增加逐功能私有开关，也不承担文件编辑或语义完整性判断。

---

## 3. 扩展协议与宿主能力

### 3.1 MCP 工具协议 (`list-mcp-tools` / `run-mcp-tool`)

ILS 在 `ServerCapabilities.executeCommandProvider.commands` 中发布原生命令：

```json
"executeCommandProvider": {
  "commands": [
    "list-mcp-tools",
    "run-mcp-tool",
    "exportWorkspace",
    "start_debug_server",
    "decompile"
  ]
}
```

- **发现与调用**：发送 `{"command":"list-mcp-tools","arguments":[]}` 获取可用 MCP 工具名称、描述及 `inputSchema`（涵盖 `get_project_modules`、`get_project_dependencies`、`analyze_calls`、`get_file_problems`、`read_file`、`rename_refactoring` 等）。调用通过 `run-mcp-tool` 传入单元素对象数组：

  ```json
  {
    "method": "workspace/executeCommand",
    "params": {
      "command": "run-mcp-tool",
      "arguments": [
        {
          "tool": "get_project_modules",
          "arguments": {
            "projectPath": "F:/source/MyProject"
          }
        }
      ]
    }
  }
  ```

  - 参数传为 `["get_project_modules", {}]` 时返回 `-32602: Expected one object argument`。
  - 缺少 `tool` 字符串字段时返回 `-32602: Expected a non-empty string property 'tool'`。
  - 业务执行状态由返回体中的 `isError` 标识；`LSMcpSessionProjectResolver` 固定按当前会话工程解析，不随 `projectPath` 切换目标工程；未初始化导入模型的工程部分工具（如 `list_directory_tree`）会报错。
- **Analyzer 模式诊断边界**：`get_file_problems` 与 `lint_files` 在部分无界面配置下可能因缺少 `DaemonCodeAnalyzer` 服务返回错误。Bridge 保留服务端错误，不添加语言专属的检查实现或替代结果。

### 3.2 Pull 诊断与刷新机制

`workspace/diagnostic/refresh` 是不附带文件路径的会话级请求，表示诊断依赖状态可能发生变化。Bridge 保持透传；刷新调度与结果发布由客户端负责。

客户端消费刷新请求应满足四项协议要求：
1. **非阻塞调度**：协议读取循环会等待请求处理器返回后再消费下一帧消息，刷新处理器须立即返回应答并将重拉任务派发至异步调度器。
2. **增量 ID 兼容**：未携带 `previousResultId` 时直接以全量报告替换；启用增量 `previousResultId` 后，收到 `unchanged` 响应时保留已缓存报告。
3. **双模来源与刷新代次**：配置变更引发重新分析时，源码文件本身的文档版本号通常未变化。对于同时消费 push 与 pull 诊断的客户端，刷新策略需依据来源与刷新代次清算过期告警（防止空 full 报告后仍残留同版本旧 push 结果），同时保持纯 push 服务端行为，并把更新同步发布至用户会话当前状态。
4. **文件监听范围隔离**：`refreshOpenFiles` 会向未编辑文档重发相同内容的 `didChange`/`didSave`，不适用于静态配置触发的诊断刷新；文件同步与监听通知仅发送实际改动且处于能力声明范围内的路径，未修改的源文件通过 pull 重新拉取。

### 3.3 虚拟源码反编译 (`decompile`) 与 Inlay Hint

- **虚拟源码读取**：访问外部 JAR 或 JDK 依赖源码时，直接调用服务端命令 `decompile` 传入定义查询返回的原始 `jar:` 或 `jrt:` URI：

  ```json
  {
    "action": "request",
    "file": "工程中的源文件.kt",
    "query": "workspace/executeCommand",
    "payload": "{\"command\":\"decompile\",\"arguments\":[\"定义返回的原始 jar: 或 jrt: URI\"]}"
  }
  ```

  反编译文档标为 stub 时仅反映公开声明与签名，不含方法体；反编译后的虚拟 class URI 不保证全部文件级 LSP 请求（如 `documentSymbol`、`hover`、`references`）均有输出，跨依赖排查可转向 `workspace/symbol` 或调用方源码发起查询。
- **Inlay Hint 两段式解析**：ILS 原生支持 `textDocument/inlayHint` 与 `inlayHint/resolve`；首轮 hint 允许不携带位置信息，完整 Kotlin hint 原样调用 resolve 后可填充 `label[].location`。客户端实现须声明 `resolveSupport.properties: ["label.location"]`，并将服务端返回的 `data` 作为不透明对象原样回传而不改写其结构或解码内部 pointer；无位置信息的结果只作只读展示。

### 3.4 构建执行 (`intellij.build`) 与只读模型查询

- **原生启动与构建参数**：`start_debug_server` 配合 `tool: "java"` 由宿主 `ModuleRuntime`、`JavaCommandBuildTool` 与 `JavaRunCommandsKt` 自动推导输出路径、依赖、JDK、工作目录、preview 与 JPMS 参数（`tool: "gradle"` 传入原生顶层 `projectPath`、`sourceSet` 与 `toolArgs`）。关联构建工具的项目启动默认包含前置构建，且不支持跳过构建开关（`build:false` 直接返回不支持）；常规调试启动不再重复调用 `intellij.build`。
- **构建输出流（`intellij.build`）**：构建通知通过 `intellij/buildOutput` 发送 `{buildId, category, line}`（当前使用 `stdout`、`stderr`、`system` 分类），终态 `BuildResponse` 返回可空 `exitCode`、`reason` 与 `unsupported`。`LSBuildDescriptorProvider` 将请求携带的 `buildId` 透传至通知，阶段与任务名当前无独立结构化字段；调用方在请求前开启监听窗口按 `buildId` 连续收集通知并与终态关联，`$/cancelRequest` 以实际进程退出为准。失败原因可能仅出现在 `stderr`，终态未提供 `reason` 时保留缺失，不由 Bridge 从输出拼装。
- **只读模型接口**：`intellij.java.buildTool` 与 `exportWorkspace` 只查询已导入模块、源根、SDK、库依赖与注册构建工具（不触发构建，不返回运行时 classpath、argv 或可执行路径）。其中 `moduleName` 专指 JPMS 模块名，Gradle/Maven 模块上下文通过 `file` 参数消歧。

---

## 4. 构建配置重载、Worktree 分叉与缓存清理

### 4.1 显式构建重载 (`intellij reload`)

修改 `pom.xml`、`build.gradle(.kts)` 或 JPS 配置后应显式调用 `intellij reload`，并在模型与索引均就绪后再继续查询（同一批配置修改全部保存后统一执行一次重载）。扩展不在后台扫描构建文件，也不在语义查询前隐式触发重导入。

`LSServer.waitForHighWatermark` 等待当前已入队索引与模型任务，但不覆盖尚未投递的 OS 文件事件；就绪响应本身不代表刚写盘的新文件已被索引。

### 4.2 Git Worktree 索引分叉 (`fromWorkspace`)

`initializationOptions.fromWorkspace` 控制是否为新连接的工作区从主工作区索引分叉。当当前目录为 Git linked worktree 且主工作区已存在就绪、路径归属匹配的初始化记录时，`applyWorkspaceOptions` 自动注入主工作区的原始 `rootUri`（不确定时回退冷启动；显式传入 `fromWorkspace` 包含 `null` 禁用时优先）。索引分叉通过传递原始源 URI 由服务端完成 RocksDB 分支（Windows 下须保持源 URI 大小写与主工作区初始化时完全一致；成功时日志输出 `Forking the workspace database from ...`，路径未命中时输出 `Not forking ... holds no database`），不直接复制底层 RocksDB 目录。

### 4.3 启动排障与运行时清理

- **连接超时排查步骤**：
  1. 读取 `$TEMP/omp-server/server.port`，核对第 1 行为 `1–65535` 端口、第 2 行为存活进程 PID、第 3 行为对应 ILS 构建号：

     ```bash
     cat "$TEMP/omp-server/server.port"
     ```

  2. 确认端口处于 `LISTENING` 状态：

     ```bash
     netstat -ano | findstr 59375
     ```

  3. 如用户自行配置 `IJ_JAVA_OPTIONS` 的 `-Dplugin.path`，检查路径和引用；宿主不会自行注入扩展路径。

- **打包清单验证**：npm 包包含 OMP 转译所需的 `src/`、编译后的 `dist/`、配置与宿主文档，不包含服务端扩展资产。打包前运行：

  ```bash
  npm test
  npm pack --dry-run --json
  ```

- **运行时缓存清理（`clean-runtime.mjs`）**：通过 `npm run clean:runtime -- --dry-run` 预览过期目录，`--apply` 执行删除。清理脚本保留占用检查（存在活跃 OMP、Node、Bun 或 Java 进程时保守跳过删除），且始终保护 `.lsp.json` 与 `.dap.json` 仍在引用的哈希缓存目录。
