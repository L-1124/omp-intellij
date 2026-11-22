# omp-intellij

将 JetBrains IntelliJ Language Server (ILS) 接入 OMP，为 Java 与 Kotlin 工程提供代码分析、依赖导航、运行与调试支持。

- **语言服务 (LSP)**：通过 OMP 原生 `lsp` 工具提供跳转定义、查找引用、实时诊断、重构重命名与快速修复（ModCommand QuickFix）。
- **运行与调试 (DAP)**：将 OMP 原生 `debug` 请求适配并转发至服务端，支持 JVM 主类、测试与外部进程附加。
- **生命周期治理**：多工程共享后台服务进程，支持多版本安装切换、JDK 与环境变量按工程独立绑定，以及基于哈希的工作区隔离。

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

   已连接工程切换 JDK 或环境变量后，先重启该工程的 LSP 客户端连接，再执行 `/intellij workspace reload`。旧配置连接仍在线时会返回 `PROJECT_LSP_RECONNECT_REQUIRED`；共享 ILS 服务无需重启。调试所有者先结束或 detach 当前会话，再重连其客户端。

---

## 日常使用

### 1. 代码智能与导航 (LSP)

日常代码分析与重构直接使用 OMP 的原生 `lsp` 工具。语言能力由外部服务端及其已安装扩展提供；本包只负责协议转发与客户端能力适配，不构建、捆绑或自动加载服务端扩展。

除了直接使用 `lsp` 工具外，插件还提供专有的 `intellij` 工具。启用 `bash` 时，在 OMP 的 `bash` 工具中调用以下命令；这些命令由 OMP 会话提供，无需安装独立 CLI。首次使用先查看帮助：

```sh
intellij --help
intellij --action wait --project . --timeout 120
intellij --action model --file src/main/java/com/example/App.java
```

未启用 `bash` 时，使用同名普通工具及对应参数。

- `wait`：阻塞等待后台服务端索引完成。
- `model`：只读查询源文件所属模块、源根、SDK 与注册构建工具；不会构建或推测运行时 Classpath、启动命令。
- `reload`：重新导入并同步当前工程配置。

嵌套工程的配置查询按文件 scope 选择最具体的已注册工程根；默认工程不会覆盖子工程配置。

---

### 2. 运行与调试 (DAP)

通过 OMP 原生 `debug` 工具启动调试会话，支持以下适配器：

| 适配器            | 说明                                                        |
| :---------------- | :---------------------------------------------------------- |
| `intellij`        | 构建并启动主类，或附加到外部调试进程                        |
| `intellij-test`   | 运行测试；可通过 `args` 指定测试类或 `ClassName#methodName` |
| `intellij-gradle` | 走服务端的 Gradle 任务链路启动调试                          |

启动配置示例（在 OMP 的 `bash` 工具中执行）：

```sh
debug --help
debug --action launch --adapter intellij --program src/main/java/com/example/App.java --timeout 180
```

运行指定测试方法：

```sh
debug --action launch --adapter intellij-test --program src/test/java/com/example/JavaGreeterTest.java --args com.example.JavaGreeterTest#testJavaGreeting --timeout 180
```

使用 Gradle 启动主类：

```sh
debug --action launch --adapter intellij-gradle --program src/main/java/com/example/App.java --timeout 180
```

`program` 是源码文件路径；相对路径以 `cwd` 为基准，省略 `cwd` 时使用 OMP 当前工作目录。普通启动的 `args` 是应用参数，测试预设的 `args` 是测试筛选标识，Gradle 预设的 `args` 仍是应用参数。全部预设默认在入口暂停，使用 `continue` 继续；切换调试目标前先结束当前会话。完整参数边界见 [OMP DAP 契约](docs/dap-proxy-and-workspace.md#1-调试适配器与启动配置)。

启动后，断点命中、单步步进、变量检查与表达式求值均使用原生 `debug` 工具。


## 管理命令

在 OMP 对话中可通过斜杠命令管理服务端状态：

| 命令                                            | 用途                                       |
| :---------------------------------------------- | :----------------------------------------- |
| `/intellij status`                              | 查看当前服务端运行状态与活动工程           |
| `/intellij doctor`                              | 检查安装完整性、网络、协议、JDK 与日志路径 |
| `/intellij install [--version <build\|latest>]` | 安装指定或最新服务端版本                   |
| `/intellij versions [--remote]`                 | 查看本地已安装版本或查询远程可用版本       |
| `/intellij use <build>`                         | 切换或回滚服务端版本                       |
| `/intellij start`、`stop`、`restart`            | 控制共享服务端进程的启停                   |
| `/intellij workspace status`、`list`            | 查看当前工作区状态或已注册工程列表         |
| `/intellij workspace jdk <path>`                | 设置当前工程专用 JDK                       |
| `/intellij workspace reload`                    | 重新导入工程构建模型                       |
| `/intellij cache`、`prune [--apply]`            | 查看或清理过期缓存目录                     |

---

## 从源码构建

使用 Node.js 22 或更新版本，在仓库根目录执行：

```sh
npm ci
npm run build
```

开发环境、分层测试和修改约束见 [AGENTS.md](AGENTS.md)。

---

## 技术文档

`docs/` 说明架构设计、协议契约、扩展边界与测试运维规范：

- [**ILS 协议与生命周期规范**](docs/ils-protocol-and-lifecycle.md)：服务端分发与端口解析、Bridge 握手与退出边界、多 Provider 分派与编辑安全、MCP 工具、Pull 诊断刷新、构建与 Worktree 分叉。
- [**DAP 调试代理与多工作区隔离规范**](docs/dap-proxy-and-workspace.md)：适配器预设与参数校验、JSON-RPC 分帧、多工作区隔离与进程归属校验、DAP 状态机、控制接口与测试隔离规范。

---

## 使用边界

- **测试执行环境**：调试适配器的直接 JVM 启动方式与 Maven Surefire 或 Gradle `test` 运行环境有差异。如需完全对齐构建工具环境，建议通过构建工具启动目标 JVM 并以 JDWP attach 方式接入。
- **原生 JVM 启动**：构建与启动由 ILS DAP 统一执行；当前版本无法保证跳过构建，`build:false` 会明确报不支持。
- **代码调用层次**：调用层次（Call Hierarchy）查询受上游代码索引范围限制；测试用例中的调用分析建议使用 `references`。
