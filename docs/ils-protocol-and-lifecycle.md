# IntelliJ Language Server (ILS) 私有协议与生命周期治理规范

## 核心结论

1. **版本演进与锁定契约（263.7084.0 -> 271.2085.0 JBR 25）**：
   - 上游 ILS 升级至 `271.2085.0`，底层运行环境变更为 JBR 25（`25.0.4.1`，类字节码 major 69）。平台运行时将 `idea.plugins.compatible.build` 设为 `999.SNAPSHOT`，JVM 插件 `plugin.xml` 必须仅声明 `<idea-version since-build="271"/>`，并在 TypeScript 启动层通过 SHA-256 与 `build.txt` 实行精准强锁定。
   - 彻底废弃运行时向 GitHub / Open VSX 发起动态版本探测（`latest`），安装过程只消费内置锁定的发行版元数据；上游版本与元数据更新收敛为离线维护工具 `scripts/update-server-bundle.mjs`。

2. **`server.port` 格式变更根因与防御**：
   - ILS 263 的 `server.port` 文件仅含单行端口号，而 271 版本变更为三行结构（第 1 行：端口号，第 2 行：服务端 PID，第 3 行：构建号 `ILS-271.2085.0`）。
   - 若直接对文件内容调用 `Number()` 解析，多行文本会导致结果计算为 `NaN`，服务端已在 1.2 秒内正常监听却被误报为“30 秒启动超时”。解析逻辑必须统一收敛为提取首行、正则匹配纯数字并做 `1–65535` 范围校验的 `parsePortFile`。

3. **二进制分发与资产双通道校验**：
   - Open VSX 的完整扩展包（VSIX）体积达到约 13.5 MB，元数据解析缓冲区必须从 4 MB 提升至 32 MB，超时放宽至 120 秒，杜绝静默截断降级。
   - 插件资产管道实行文本与二进制严格分流：配置文件按 UTF-8 字符串读写并计算哈希；JAR、SO 等二进制资产使用 `Buffer` 读取、校验 SHA-256 旁挂摘要并原样写入，避免 UTF-8 编码将非法字节替换为 `0xFFFD` 造成字节码损毁。

4. **版本发布遵循 CalVer 规范与自动同步**：
   - 插件版本号采用日期规范（CalVer，如 `YYYY.M.D` 或 `YYYY.MMDD.PATCH`），消除 SemVer 在语言服务封装层中 Major/Minor/Patch 边界模糊的问题，同时严格遵守 npm 禁止版本号数字段包含前导零的规则。
   - 通过 `--sync-marketplace` 工具自动化提取上游 VSIX 中的 `activationEvents`（生成 `rootMarkers`）与配置默认项，同步维护 `.omp-plugin/marketplace.json`。

5. **`intellijExtensions` 开启与 ModCommand QuickFix 完整性**：
   - JetBrains 服务端在将 `ModCommand`（模型驱动指令）转换为 LSP `CodeAction` 时，如果客户端在 `initialize` 的 `initializationOptions` 中缺少 `intellijExtensions: true` 与 `lazyIntentions: true`，服务端会将交互型指令（如 `RenameFix`、代码重构、剪贴板操作）置为 `null`，导致关键修复在前端彻底丢失。开启该扩展后，服务端正常下发 `intellij/runEditorCommand {"command": "editor.action.rename"}`。

6. **MCP 工具动态发现机制替代客户端硬编码**：
   - 服务端通过 `executeCommandProvider.commands` 暴露 `list-mcp-tools` 与 `run-mcp-tool`。通过发送 `{"command":"list-mcp-tools","arguments":[]}` 可动态拉取当前项目可用的 22 项 MCP 工具定义及其完整的 `inputSchema`。
   - 工具调用必须封装为 `{"command":"run-mcp-tool","arguments":[{"tool":"<tool_name>","arguments":{...}}]}`，严禁传错参数结构（缺少外层包装对象会触发服务端 `-32602` 参数校验异常）。能力广告不等于可用性证明，未构建或缺少模块元数据时部分工具（如 `list_directory_tree`）会返回执行错误。

7. **同进程内嵌官方 Android Lint 架构**：
   - 彻底摒弃外部每次调用 `cmdline-tools/bin/lint` 的冷启动方案（外部独立 JVM 启动耗时 5–15 秒，在保存/输入时无法交互）。
   - 将官方 Lint 核心精简为 6 个核心依赖 JAR（共 11.36 MB，较初始 43.94 MB 缩减 74.1%），直接挂载在 ILS 的 `LSDiagnosticProvider` 扩展点上，复用内存中的未保存 PSI 与 K2 FIR UAST，单次诊断耗时收敛至 6 ms – 39 ms。
   - 明确规则分离：系统内置规则（如 `NewApi`）由 `tools.lint-checks.jar` 提供，现代 Jetpack Compose 规则由 AAR Transform 目录下的 `lint.jar` 提供，二者通过 `CompositeIssueRegistry` 合并加载。

---

## 踩坑记录与根因分析

### 1. `server.port` 三行格式解析异常导致虚假启动超时

#### 问题现象
在将默认服务升级至 `271.2085.0` 后，运行集成测试或通过命令行启动服务时，服务端日志明确显示已在 1.2 秒内就绪并写入端口：
```text
2026-11-04 22:55:26,885 [ 5] INFO - #c.i.l.s.PortFile - Published server port 59375 to C:\Users\...\AppData\Local\Temp\omp-server\server.port
```
但客户端始终阻塞，直到 30 秒超时抛出错误：
```text
Error: Timed out waiting for server to start at endpoint 127.0.0.1:NaN
    at waitForServerReady (src/server/service.ts:380)
```

#### 根因排查
- 检查 `server.port` 文件内容：
  - 历史版本 `263.7084.0` 内容为：`59375\n`
  - 新版本 `271.2085.0` 内容变更为三行：
    ```text
    59375
    18420
    ILS-271.2085.0
    ```
    第 1 行为 TCP 监听端口，第 2 行为服务端进程 PID，第 3 行为 ILS 内部构建号。
- 旧版代码读取逻辑：
  ```ts
  const text = (await readFile(portFile, 'utf8')).trim();
  const port = Number(text); // 当 text 为 "59375\n18420\nILS-271.2085.0" 时，Number() 结果为 NaN
  ```
- 由于 `Number("59375\n18420\nILS-271.2085.0") === NaN`，导致 `isPortListening` 和 `endpoint` 校验全部失败，客户端在端口轮询死循环中直到超时退出。

#### 解决方案与实测对比
在 `src/server/service.ts` 引入专用解析函数 `parsePortFile`，仅提取首行并严格做整数范围校验：
```ts
export function parsePortFile(text: string): number | null {
  const first = text.split(/\r?\n/, 1)[0]?.trim() ?? '';
  if (!/^\d+$/.test(first)) return null;
  const port = Number(first);
  return port >= 1 && port <= 65535 ? port : null;
}
```
并在 `endpoint()`、`isServerAlive()` 和 `isPortListening()` 中统一接入。

- **实测对比**：
  - 修复前：100% 出现 30 秒超时假死，无法建立 LSP 连接；
  - 修复后：服务端启动 1.2 秒内读取到合法端口 `59375`，TCP 套接字即时握手成功。

---

### 2. Open VSX 归档缓冲区截断与动态版本探测脆弱性

#### 问题现象
在旧逻辑中调用 `latestServerVersion()` 时，经常随机抛出流异常：
```text
Error: Response exceeds maximum allowed size of 4194304 bytes
    at readBoundedBytes (src/server/bundles.ts:101)
```
或者因网络环境受限抛出 `AbortError: The operation was aborted due to timeout (10000ms)`，导致版本探测静默回退到过期的 GitHub Lua 脚本，拉取到旧版本构建。

#### 根因排查
1. **体积超限**：Open VSX 上分发的 `JetBrains.intellij-server-*.vsix` 实际是一个包含了完整内嵌运行时的 ZIP 归档，解包前的 VSIX 压缩包体积已达约 13.5 MB。旧逻辑设置的 `4 * 1024 * 1024`（4 MB）硬上限必然发生流截断。
2. **下载耗时**：跨地域下载 13.5 MB 文件在弱网环境下通常需要 15–30 秒，默认的 10 秒超时必然被触发。
3. **架构隐患**：在用户运行时执行远程动态解析存在致命脆弱性：如果国内网络无法访问 GitHub Raw，或者系统缺失 `unzip`/`tar` 命令，就会导致安装失败；同时自动拉取未经本地适配验证的最新构建，极易因上游协议变更破坏现有稳定性。

#### 解决方案与实测对比
1. **扩大缓冲区与超时配置**：
   ```ts
   const VSX_ARTIFACT_MAX_BYTES = 32 * 1024 * 1024; // 32 MB
   const VSX_ARTIFACT_TIMEOUT_MS = 120_000;         // 120 秒
   ```
2. **架构重构**：将动态解析彻底从客户端运行时中剔除。运行时 `/intellij install` 仅消费经过本地验证的硬编码版本（`271.2085.0`）。将版本更新逻辑移至独立维护脚本 `scripts/update-server-bundle.mjs`，在开发阶段通过 `npm run update-bundle` 手动同步并跑通测试套件后再固化。

---

### 3. 资产分发文本通道损坏二进制 JAR 文件

#### 问题现象
当引入自研的 `intellij-android.jar` 以及 6 个官方 Lint 依赖库（合计约 11.36 MB）到插件资产目录后，客户端解包启动服务时报 Java 类加载错误：
```text
java.util.zip.ZipException: zip END header not found
    at java.base/java.util.zip.ZipFile$Source.findEND(ZipFile.java:1605)
    at java.base/java.util.zip.ZipFile$Source.initPeeker(ZipFile.java:1537)
```
或者在校验 SHA-256 时发现文件哈希与官方源文件完全不符。

#### 根因排查
- 排查 `src/plugin.ts` 的资产同步逻辑：
  ```ts
  // 错误的历史逻辑：所有资产均当做文本读写
  const content = await readFile(srcPath, 'utf8');
  hasher.update(content);
  await writeFile(destPath, content, 'utf8');
  ```
- Node.js 在以 `'utf8'` 读取二进制文件（JAR/ZIP）时，会将所有不符合 UTF-8 规范的字节序列替换为 Unicode 替换字符 `U+FFFD`（三字节 `EF BF BD`），彻底破坏了 ZIP 文件的魔数、中央目录（Central Directory）及压缩数据体。

#### 解决方案与实测对比
在 `src/plugin.ts` 中实现资产读写与校验的双通道：
```ts
// 区分文本资产与二进制资产
const isBinaryAsset = ext === '.jar' || ext === '.so' || ext === '.dll';

if (isBinaryAsset) {
  // 二进制通道：Buffer 读取 -> 计算原始 SHA-256 -> 原始流复制
  const buffer = await readFile(srcPath);
  hasher.update(buffer);
  await writeFile(destPath, buffer);
} else {
  // 文本通道：utf8 读取与结构校验
  const text = await readFile(srcPath, 'utf8');
  hasher.update(text);
  await writeFile(destPath, text, 'utf8');
}
```
同时对每个官方依赖 JAR 在同级目录提供 `.sha256` 侧车文件进行严格比对。

- **实测对比**：
  - 修复前：JAR 文件在复制后体积膨胀且结构损坏，JVM 类加载器直接报 `ZipException`；
  - 修复后：7 个 JAR 资产字节级保真，SHA-256 校验 100% 匹配，类加载顺畅无阻。

---

### 4. 缺少 `intellijExtensions` 导致 ModCommand QuickFix 丢失

#### 问题现象
在针对 Java / Kotlin 代码的语法错误或代码异味请求 `textDocument/codeAction` 时，客户端能拿到编译器警告，但原本应该出现的交互式修复（例如类名重命名 `RenameFix`、构造函数生成、导入调整）完全不出现，`codeActions` 列表为空或仅包含无操作意图项。

#### 根因排查
- 查看服务端日志和反编译类：`com.jetbrains.ls.api.features.impl.common.extract.LSExtractModCommandProviderBase`。
- JetBrains 自定义了一套基于 `ModCommand` 的动作执行流。当服务端将 `ModCommand` 转换为 LSP 标准 CodeAction 时，会检查初始化选项：
  - 若客户端未显式声明 `intellijExtensions: true` 与 `lazyIntentions: true`，服务端判定客户端“不具备处理 JetBrains 私有交互动作的能力”，因此在转换时将交互型操作直接赋值为 `null` 并从最终结果集中静默剔除。

#### 解决方案与实测对比
在 `src/bridge.ts` 与 `.omp-plugin/marketplace.json` 的 `initOptions` 中明确开启协议扩展支持：
```json
"initOptions": {
  "intellijExtensions": true,
  "lazyIntentions": true,
  "runMainCodeLens": true
}
```
开启后，服务端下发的 CodeAction 携带自定义执行指令：
```json
{
  "title": "Rename file to MainActivity.kt",
  "kind": "quickfix",
  "command": {
    "title": "applyModCommand",
    "command": "applyModCommand",
    "arguments": [...]
  }
}
```
当客户端触发该 action 时，服务端会通过 `intellij/runEditorCommand` 协议下发具体编辑器指令（如 `{"command": "editor.action.rename"}`），Bridge 层无需针对特定类名设置黑名单过滤。

---

## 关键协议与运行时契约

### 1. 服务端二进制分发与元数据清单

ILS `271.2085.0` 在全平台的二进制归档均采用严格的 SHA-256 旁挂校验，所有平台包元数据锁定在 `src/server/bundle-metadata.ts` 中：

| 操作系统 | 架构 | 归档格式 | 字节大小 (Bytes) | SHA-256 校验和 |
| :--- | :--- | :--- | :--- | :--- |
| **Darwin (macOS)** | arm64 | `.sit` | 385,899,733 | `0b8022627f20cdbe52508afbd5dcb3a6e18afc170fb84d8f70d92ad87b815a78` |
| **Darwin (macOS)** | x64 | `.sit` | 387,873,566 | `860e9ab04b99640790112a96de7f7df024b28bf3d6b573e5102a1a627b8e4a8e` |
| **Linux** | arm64 | `.tar.gz` | 394,206,359 | `ba6d0831043c197edede20518e3137974bc53838ef6601e71c23ff785070fc34` |
| **Linux** | x64 | `.tar.gz` | 395,255,755 | `fb4fbac78a5043ce568e8b93ec57a1c40c4ba8136db68139d8813d7de3a4f7e4` |
| **Windows** | arm64 | `.win.zip` | 368,571,128 | `b8cab4d3e30849440fe4d318c352981012ffb9b3895b2ceda1f73e430407274f` |
| **Windows** | x64 | `.win.zip` | 389,022,064 | `9ab4ecd982a8abdfaa1fff1bcdd4246db2d071653168c78555a5869271ee3f9f` |

- **下载基准 URL**：`https://download.jetbrains.com/language-server/intellij-server/271.2085.0/intellij-server-271.2085.0[suffix].[ext]`
- **校验流程**：下载前检查本地缓存文件的字节数与 SHA-256；下载后使用流式 `crypto.createHash('sha256')` 计算哈希，不匹配立即删除临时文件并报错，严禁解压损坏文件。

---

### 2. MCP 工具集成协议契约

服务端通过 `ServerCapabilities.executeCommandProvider.commands` 暴露 MCP（Model Context Protocol）能力：

#### ① 协议发现与指令注册
在握手阶段，服务端声明具备以下命令：
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

#### ② 工具清单发现 (`list-mcp-tools`)
客户端通过发送原生 LSP 请求获取完整工具集：
- **请求格式**：
  ```json
  {
    "method": "workspace/executeCommand",
    "params": {
      "command": "list-mcp-tools",
      "arguments": []
    }
  }
  ```
- **返回结构**：返回一个数组，包含 22 项工具定义。每项具备 `name`、`description` 和符合 JSON Schema 规范的 `inputSchema`。主要工具包括：
  - `get_project_modules`：列出当前项目模块名称与类型。
  - `get_project_dependencies`：获取工程依赖项列表。
  - `analyze_calls`：调用层级树分析。
  - `get_file_problems`：获取文件特定诊断。
  - `read_file`：读取、解包或反编译归档文件。
  - `rename_refactoring`：代码符号重命名重构。

#### ③ 工具调用规范与参数格式 (`run-mcp-tool`)
调用具体 MCP 工具时必须遵循严格的外层包装结构：
- **正确调用参数**：
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
- **常见错误代码**：
  - 传参为 `["get_project_modules", {}]`：报错 `LSP error -32602: Expected one object argument`。
  - 传参为 `[{"name": "get_project_modules", "arguments": {}}]`：报错 `LSP error -32602: Expected a non-empty string property 'tool'`。
- **运行边界**：
  - 必须检查返回结果的 `isError` 字段，LSP 请求传输成功（HTTP/RPC 200）不代表 MCP 工具业务执行成功。
  - 工具能力广告不等于可用性证明。在仅有标记文件（Marker）但未初始化的 Maven/Gradle 工程中，`get_project_dependencies` 返回 `[]`，`list_directory_tree` 会抛出 `'The project directory cannot be determined.'`。

---

### 3. 内嵌官方 Android Lint 依赖与规则架构

为了消除外部命令行进程的冷启动开销，将官方 Android Lint 作为库内嵌至 ILS 运行时进程中。

#### ① 6 个核心依赖 JAR 清单（总计 11.36 MB / 11,362,788 字节）
从 Android SDK `cmdline-tools;23.0`（或 Google Maven）提取并锁定：

| 序号 | JAR 名称 | SDK 相对路径 | 字节大小 | SHA-256 摘要 | 运行时职责 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | `tools.lint-checks.jar` | `lib/lint/tools.lint-checks.jar` | 7,256,470 | `61e6b0a90d6fe8a5ac5d4d8519fb1134fd064fbba12525dcfc08ce4b43ffd0ae` | 官方内置检查器集合与 `BuiltinIssueRegistry`（包含 `ApiDetector` 等） |
| 2 | `tools.sdklib.jar` | `lib/sdklib/tools.sdklib.jar` | 1,909,475 | `d0bbe0e03155a7bdd9bac03567b6b26797f81a778f55d5eadc3e71e7a0a27434` | Android SDK 平台定义、API 级别推断 (`SdkVersionInfo`, `AndroidVersion`) |
| 3 | `tools.lint-api.jar` | `lib/lint/tools.lint-api.jar` | 1,417,813 | `e6a6e0244b5a9a325580c0a8901b94e1a8b37e0cca7030f5fcb06186f7f46b61` | Lint 核心调度器 `LintDriver`、客户端基类 `LintClient`、`DefaultUastParser` |
| 4 | `tools.common.jar` | `lib/common/tools.common.jar` | 570,290 | `ed2fea24fd74c82cac6ca964b8a3f5b33f7aa8f675bd6fb51ee78772f49995f2` | 基础工具类、安全 XML 解析器 `PositionXmlParser`、资源路径类型 |
| 5 | `kxml2-2.3.0.jar` | `lib/external/.../kxml2-2.3.0.jar` | 43,858 | `f264dd9f79a1fde10ce5ecc53221eff24be4c9331c830b7d52f2f08a7b633de2` | `ApiLookup` 解析 `platforms/android-xx/data/api-versions.xml` 必需的 XML 解析器 |
| 6 | `tools.lint-model.jar` | `lib/lint/tools.lint-model.jar` | 164,882 | `81ac1f03f390f0aa8308d389a8bbe4238f9bd843ff705556f68564f6ee257cf1` | 构建变体依赖模型，支撑 `DefaultJavaEvaluator.getDependencies()` 与库版本检测 |

#### ② 架构拓扑与规则聚合
```text
                             LSP textDocument/diagnostic
                                         │
                                         ▼
                     ILS LSDiagnostic.getDiagnostics (Kotlin Flow)
                                         │
                     ┌───────────────────┴───────────────────┐
                     ▼                                       ▼
          内置编译器诊断 (Native)              OmpLintDiagnosticProvider (LSDiagnosticProvider)
                                                             │
                                                             ▼
                                                LintDriver (复用内存 PSI/UAST)
                                                             │
                                        ┌────────────────────┴────────────────────┐
                                        ▼                                         ▼
                        内置系统规则 (tools.lint-checks)           AAR 自带规则 (Gradle 缓存 lint.jar)
                                        │                                         │
                               BuiltinIssueRegistry                     JarFileIssueRegistry
                                        └────────────────────┬────────────────────┘
                                                             ▼
                                                   CompositeIssueRegistry
```

- **内置规则 vs 随库分发规则**：
  - Android SDK 的 `tools.lint-checks.jar` 只包含平台通用规则（如 `NewApi`、`HardcodedText`）；
  - Jetpack Compose 等现代 Android 规则（如 `UnrememberedMutableState`、`ComposableNaming`）存放在各库 AAR 内部的 `lint.jar` 中。Gradle 在构建阶段通过 AAR Transform 将其解压至缓存目录 `~/.gradle/caches/.../transformed/<lib>/jars/lint.jar`。
  - 内嵌引擎通过 `JarFileIssueRegistry` 动态加载 AAR `lint.jar`，与 `BuiltinIssueRegistry` 合并为 `CompositeIssueRegistry`，在单次 AST 遍历中并发执行。
- **性能实测数据（基于 MyHook Android 工程）**：
  - 外部 `cmdline-tools/bin/lint`：单次冷启动 5,200 ms – 14,000 ms；
  - 内存内嵌运行：
    - 首次类加载与 `api-versions.xml` 解析：298 ms；
    - 后续增量触发（`MainActivity.kt` 内存编辑）：**16 ms – 39 ms**；
    - 纯 Java 文件（`JceHead.java`）`NewApi` 校验：**6 ms**。

---

## 最佳实践与操作指引

### 1. 服务端元数据离线维护与同步

当需要跟踪 JetBrains 上游发布的新版 `intellij-server` 或同步 VS Code 扩展配置时，使用维护脚本统一执行：

```bash
# 1. 检查远端是否有新版本（仅比对元数据，不修改本地文件）
npm run update-bundle -- --version latest --check

# 2. 升级并固化目标版本（拉取 6 个平台的归档摘要并回写 src/server/bundle-metadata.ts）
npm run update-bundle -- --version 271.2085.0

# 3. 同步 upstream VSIX 的激活文件类型与 marker 配置到 .omp-plugin/marketplace.json
npm run update-bundle -- --sync-marketplace
```

### 2. 启动与端口解析的健康排查

若遇到客户端连接超时，可按以下步骤排查系统状态：

1. **检查临时目录下的 `server.port` 内容**：
   ```bash
   cat "$TEMP/omp-server/server.port"
   ```
   确认第一行是否为 `1–65535` 之间的合法数字，且第二行 PID 进程当前仍在运行。
2. **验证 TCP 端口可达性**：
   ```bash
   # 查看指定端口是否处于 LISTENING 状态
   netstat -ano | findstr 59375
   ```
3. **验证命令行参数转义**：
   Windows 环境下若在 `IJ_JAVA_OPTIONS` 注入 JVM 插件路径，路径中的反斜杠必须全部归一化为正斜杠：
   ```bash
   # 正确格式
   -Dplugin.path=F:/source/omp-intellij/resources/ils/271.2085.0/intellij-android
   ```

### 3. LSP 客户端初始化参数配置推荐

为了确保 LSP 3.17 规范及私有协议功能全部正常生效，连接时的 `initialize` 参数建议如下配置：

```json
{
  "processId": 1234,
  "rootUri": "file:///F:/source/MyAndroidApp",
  "capabilities": {
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

### 4. 资产发布前完整性验证

在打包发布前，必须执行以下测试与 dry-run 命令，确认无死重文件且二进制资产完好：

```bash
# 1. 运行核心生命周期测试（验证 3 行格式 server.port 解析与健康检测）
npm test -- test/lifecycle.test.ts

# 2. 检查 npm 打包文件列表（确认 dist/ 已被排除，resources/ 完整包含）
npm pack --dry-run --json
```
