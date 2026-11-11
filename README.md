# omp-intellij

将 JetBrains IntelliJ Language Server (ILS) 接入 OMP，为 Java 与 Kotlin 工程提供代码分析、依赖导航、运行与调试支持。

- **语言服务 (LSP)**：通过 OMP 原生 `lsp` 工具提供跳转定义、查找引用、实时诊断、重构重命名与快速修复（ModCommand QuickFix）。
- **Android 语义增强**：支持 Manifest 与 values XML 大纲（DocumentSymbol）、Manifest 类属性代码反查、`R.*` 资源定位及 Composable 函数大写命名豁免。
- **运行与调试 (DAP)**：通过 OMP 原生 `debug` 工具启动主类、运行测试、打断点、单步执行，以及针对 Android 应用的 JDWP 附加调试（JDWP attach）。
- **生命周期治理**：多工程共享后台服务进程，支持多版本安装切换、JDK 与环境变量按工程独立绑定，以及基于哈希的工作区隔离。

---

## 环境要求

- **OMP**：支持插件扩展、LSP 与 DAP 接口。
- **Node.js**：`>= 22`，用于驱动 LSP 桥接进程与 DAP 调试代理。
- **JDK 与构建工具**：目标工程所需的 JDK（如 JDK 17、JDK 21）与构建工具（Gradle / Maven）；Language Server 自身运行在自带的 JBR 运行时中。
- **授权**：使用服务端所需的 JetBrains 账号授权与 EULA 许可。

---

## 安装

### 从市场安装

在 OMP 中注册市场并安装插件：

```sh
omp plugin marketplace add L-1124/omp-intellij
omp plugin install omp-intellij@omp-intellij
```

安装完成后重新启动 OMP。已安装用户更新至最新源码版本：

```sh
omp plugin marketplace update omp-intellij
omp plugin install --force omp-intellij@omp-intellij
```

> [!NOTE]
> 插件首次加载时由 OMP 内置运行时自动转译桥接代码，产物缓存在插件目录的 `.runtime/` 中。

---

## 快速上手

在目标工程根目录下启动 OMP，按以下步骤初始化服务端：

1. **安装服务端与查看协议**：
   ```text
   /intellij install
   /intellij eula status
   /intellij eula view
   ```

2. **接受许可协议并校验运行环境**：
   ```text
   /intellij eula accept <status 显示的哈希>
   /intellij doctor
   ```

   > [!IMPORTANT]
   > 许可协议（EULA）按安装包内置文本核对，插件不会代为自动接受。必须传入 `status` 查看到的实际哈希值。

3. **配置工程 JDK（可选）**：
   ```text
   /intellij workspace jdks
   /intellij workspace jdk <目标 JDK 路径>
   ```

   JDK 自动发现复用已保存的工程配置、`JAVA_HOME`、`JDK_HOME`、`PATH` 和系统标准安装位置。

---

## 日常使用

### 1. 代码智能与导航 (LSP)

日常代码分析与重构直接使用 OMP 的原生 `lsp` 工具。扩展自动补齐以下 Android 语义特性：

- **XML 大纲 (DocumentSymbol)**：支持 `AndroidManifest.xml` 与 values 资源文件的层级结构化符号树。
- **引用反查 (References)**：从 `AndroidManifest.xml` 中的 Activity、Service、Provider 类属性，反向检索 Java 与 Kotlin 源码中的语义引用及 KDoc 链接。
- **资源跳转 (Definition)**：支持 `R.*` 及 XML 资源属性向源码声明跳转；同一资源的多限定符（多语言/多分辨率）支持返回多个目标。
- **Compose 规范抑制**：基于 K2 Analysis API，对标注 `@Composable` 的大写函数名称自动豁免常规函数命名规范检查（`FunctionName` / `TestFunctionName`）。

除了直接使用 `lsp` 工具外，插件还提供专有的 `intellij` 工具接口：

```json
{ "action": "wait", "project": ".", "timeout": 120 }
```
```json
{ "action": "model", "file": "src/main/java/com/example/App.java" }
```

- `wait`：阻塞等待后台服务端索引完成。
- `model`：查询源文件所属模块、SDK、Classpath 与构建链路。
- `reload`：重新导入并同步当前工程配置。

嵌套工程的配置查询按文件 scope 选择最具体的已注册工程根；默认工程不会覆盖子工程配置。

---

### 2. 运行与调试 (DAP)

通过 OMP 原生 `debug` 工具启动调试会话，支持以下适配器：

| 适配器 | 说明 |
| :--- | :--- |
| `intellij` | 构建并启动主类，或附加到外部调试进程 |
| `intellij-test` | 运行测试；可通过 `args` 指定测试类或 `ClassName#methodName` |
| `intellij-gradle` | 走服务端的 Gradle 任务链路启动调试 |

启动配置示例（写入 `xd://debug`）：

```json
{
  "action": "launch",
  "adapter": "intellij",
  "program": "src/main/java/com/example/App.java",
  "timeout": 180
}
```

启动后，断点命中、单步步进、变量检查与表达式求值均使用原生 `debug` 工具。

---

### 3. Android JDWP Attach 附加调试

针对运行在 Android 模拟器或真实设备上的应用，插件提供进程发现、端口代理与 JDWP Attach 编排：

1. **准备附加并建立本地回环代理**：
   ```sh
   node dist/android/debug-attach-cli.js prepare --package com.example.app --device emulator-5554
   ```
   *也支持 `--pid <PID>` 精确指定进程。成功时输出包含目标 `host`、`port` 与 `cleanupKey` 的 JSON。*

2. **附加调试器**：
   将返回的连接参数传入原生 `debug` 工具：
   ```json
   {
     "action": "attach",
     "adapter": "intellij",
     "host": "127.0.0.1",
     "port": 58637,
     "timeout": 180
   }
   ```

3. **结束调试并清理资源**：
   调试器分离时默认保持 `terminateDebuggee: false`，避免终止目标应用进程。如需提前手动释放代理端口：
   ```sh
   node dist/android/debug-attach-cli.js cleanup --key <cleanupKey>
   ```

> [!NOTE]
> 在 Android 附加调试期间，系统会自动启用同步 JDI 并在会话级静默富渲染器（MuteRenderer），避免 ART 运行时在复合对象展示时超时，同时完整保留字段反射展开与显式求值。

---

## 管理命令

在 OMP 对话中可通过斜杠命令管理服务端状态：

| 命令 | 用途 |
| :--- | :--- |
| `/intellij status` | 查看当前服务端运行状态与活动工程 |
| `/intellij doctor` | 检查安装完整性、网络、协议、JDK 与日志路径 |
| `/intellij install [--version <build\|latest>]` | 安装指定或最新服务端版本 |
| `/intellij versions [--remote]` | 查看本地已安装版本或查询远程可用版本 |
| `/intellij use <build>` | 切换或回滚服务端版本 |
| `/intellij start`、`stop`、`restart` | 控制共享服务端进程的启停 |
| `/intellij workspace status`、`list` | 查看当前工作区状态或已注册工程列表 |
| `/intellij workspace jdk <path>` | 设置当前工程专用 JDK |
| `/intellij workspace reload` | 重新导入工程构建模型 |
| `/intellij cache`、`prune [--apply]` | 查看或清理过期缓存目录 |

---

## 开发者构建

如需修改扩展或本地从源码构建打包：

服务端目标版本统一维护在 `src/server/bundle-metadata.ts`，运行时加载器与 Gradle 构建共同消费。开发环境配置脚本读取编译后的元数据，因此首次构建先编译 TypeScript。

官方 OMP SDK 与 omptype 固定为 `18.18.7`，仅作开发依赖。`npm run typecheck` 同时检查扩展 factory 与官方 `ExtensionFactory` 的兼容性；测试使用真实 schema builder。生产代码仅通过类型导入引用 SDK，Bridge/DAP 的 Node 启动链路保持不变。

交互确认按官方 `confirm(title, message)` 契约分别传递标题与操作详情；工具进度回调保留完整的 details 类型。

```sh
npm run typecheck
# 1. 编译 TypeScript 桥接层与 bundle 元数据
npm run build
# 2. 配置本地环境并编译 JVM 扩展资产
npm run build:jvm
# 3. 执行测试
npm test

# 4. 验证 npm 包分发清单
npm pack --dry-run --json --ignore-scripts
```

---

## 技术经验与规范文档

开发、调试、协议接入与工程化排障的完整实测经验记录在 `docs/` 目录中：

- [**Android JDWP 调试与运行时排障**](docs/android-jdwp-debugging.md)：ART 运行时特性、adblib proxy 编排、`variables` 10.3s 超时根因与会话级静默渲染解决方案。
- [**Android JVM 扩展与工程化体系**](docs/android-jvm-extension.md)：ILS 插件 SPI、`plugin.xml` 声明、K2 Compose 命名豁免、Gradle 9.8.0 规范化与反编译器实测横评。
- [**ILS 私有协议与生命周期治理**](docs/ils-protocol-and-lifecycle.md)：ILS 271 (JBR 25) 升级适配、`server.port` 三行格式解析、CalVer 策略与 ModCommand QuickFix 完整性。
- [**DAP 代理、工作区隔离与测试体系**](docs/dap-proxy-and-workspace.md)：stdio 分帧粘包处理、多工作区 systemPath 隔离、DAP 状态机与测试夹具设计。

---

## 使用边界

- **测试执行环境**：调试适配器的直接 JVM 启动方式与 Maven Surefire 或 Gradle `test` 运行环境有差异。如需完全对齐构建工具环境，建议通过构建工具启动目标 JVM 并以 JDWP attach 方式接入。
- **构建优先原则**：Android 工程的编译、资源打包与自动化测试优先使用工程原生的 Gradle 任务执行，调试通过 JDWP attach 接入。
- **代码调用层次**：调用层次（Call Hierarchy）查询受上游代码索引范围限制；测试用例中的调用分析建议使用 `references`。
