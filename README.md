# omp-intellij

将 JetBrains IntelliJ Language Server 接入 OMP，为 Java、Kotlin 工程提供代码分析、构建、运行与调试。

- 通过 OMP 原生 `lsp` 工具使用定义、引用、诊断、重命名与代码操作等服务端能力。
- 多工程共享后台服务，等待工程导入与索引就绪后处理请求。
- 安装、查询、切换服务端版本；远程版本信息同时查询 JetBrains manifest 与 Open VSX。
- 按工程配置 JDK 与导入环境，支持工作区重载。
- 通过原生 `debug` 工具运行应用、执行测试、设置断点或附加到 JDWP 进程。

## 环境要求

- OMP，支持插件扩展、LSP 与 DAP。
- Node.js 22 或更新版本，用于启动 LSP 桥接与 DAP 代理。
- 目标工程所需的 JDK 与构建工具；服务端使用安装包自带的 JBR。
- 使用服务端所需的 JetBrains 授权。

## 安装插件

当前从源码构建后，通过本地 marketplace 安装：

```sh
npm ci
npm run build
omp plugin marketplace add .
omp plugin install omp-intellij@omp-intellij
```

安装后重新启动 OMP 会话。

## 首次使用

在目标工程目录启动 OMP，执行：

```text
/intellij install
/intellij eula status
/intellij eula view
```

阅读协议后，用 `status` 显示的当前哈希确认接受，再检查环境：

```text
/intellij eula accept <hash>
/intellij doctor
```

> [!IMPORTANT]
> EULA 按安装包中的协议内容确认。插件不会自动接受协议；请使用当前安装包显示的哈希。

需要指定工程 JDK 时，执行 `/intellij workspace jdks` 查看候选项，再执行 `/intellij workspace jdk <JDK路径>`。

## 日常使用

代码导航、诊断与重构由 OMP 原生 `lsp` 工具提供，具体操作范围取决于服务端能力。插件额外提供 `intellij` 工具，调用前可读取 `xd://intellij` 查看完整参数。

写入 `xd://intellij` 的常用请求：

```json
{ "action": "doctor" }
```

```json
{ "action": "wait", "project": ".", "timeout": 120 }
```

```json
{ "action": "reload", "project": ".", "timeout": 120 }
```

```json
{ "action": "model", "file": "src/main/java/com/example/App.java" }
```

`doctor` 检查配置与运行条件；`wait` 等待索引就绪；`reload` 重新导入工程；`model` 查询源文件所属模块、SDK、Classpath 与构建命令。`status`、`wait` 和 `doctor` 不会启动服务端。

### 运行与调试

通过 OMP 原生 `debug` 工具使用以下适配器：

| 适配器            | 用途                                                        |
| ----------------- | ----------------------------------------------------------- |
| `intellij`        | 构建并启动应用，或附加到外部 JDWP 进程                      |
| `intellij-test`   | 启动测试；可通过 `args` 指定测试类或 `ClassName#methodName` |
| `intellij-gradle` | 使用服务端的 Gradle 启动链路                                |

例如，写入 `xd://debug`：

```json
{
  "action": "launch",
  "adapter": "intellij",
  "program": "src/main/java/com/example/App.java",
  "timeout": 180
}
```

后续断点、继续执行、栈帧、变量和输出查询均使用同一原生工具。完整参数以 `xd://debug` 文档为准。

## 管理命令

| 命令                                            | 用途                                |
| ----------------------------------------------- | ----------------------------------- |
| `/intellij status`                              | 查看服务端与工程状态                |
| `/intellij doctor`                              | 检查安装、协议、JDK、授权与日志位置 |
| `/intellij install [--version <build\|latest>]` | 安装固定、指定或最新服务端版本      |
| `/intellij versions [--remote]`                 | 查看本地版本，或查询远程版本        |
| `/intellij use <build>`                         | 切换到已安装版本，也可用于回滚      |
| `/intellij start`、`stop`、`restart`            | 管理共享服务端                      |
| `/intellij workspace status`、`list`            | 查看当前工程或已保存的工程配置      |
| `/intellij workspace jdk <path>`                | 设置当前工程 JDK                    |
| `/intellij workspace env`                       | 查看导入环境变量配置                |
| `/intellij workspace reload`                    | 修改构建配置后重新导入工程          |
| `/intellij debug status`、`recover [id]`        | 查看或回收调试代理会话              |
| `/intellij cache`、`prune [--apply]`            | 查看缓存，预览或执行过期缓存清理    |

切换版本、停止或重启服务端会检查活动连接，避免中断其他工程。

## 配置

安装与工程配置默认保存在 `~/.omp/agent/intellij.json`，可通过 `OMP_INTELLIJ_CONFIG` 指向其他文件。超时与缓存策略默认读取包内 `settings.json`，可通过 `OMP_INTELLIJ_SETTINGS` 指定替代配置。

优先使用 `/intellij` 命令管理安装、版本、JDK 和工程环境配置。

## 使用边界

- 测试适配器的直接 JVM 启动路径与 Maven Surefire、Gradle `test` 的执行环境有差异。依赖构建工具测试配置时，通过原构建工具启动目标 JVM，再使用 JDWP attach 调试。
- 部分 Kotlin 测试文件的服务端自动发现可能返回空结果；显式测试 ID 仍受服务端运行能力约束。
- Android 工程的构建与测试优先使用实际 Gradle 任务，调试通过 JDWP attach 接入。
- 调用层次查询受上游生产代码范围限制；分析测试代码引用时使用 `references`。
