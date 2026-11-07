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

从 GitHub 注册 marketplace 并安装：

```sh
omp plugin marketplace add L-1124/omp-intellij
omp plugin install omp-intellij@omp-intellij
```

安装后重新启动 OMP 会话。

已安装的用户可刷新市场并重新安装最新源码：

```sh
omp plugin marketplace update omp-intellij
omp plugin install --force omp-intellij@omp-intellij
```

插件首次加载时由 OMP 内置 Bun 自动转译桥接源码，产物缓存在安装目录的 `.runtime/` 中。安装目录需要可写；Node.js 用于运行 LSP 桥接和 DAP 代理。

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

### Android XML 与源码导航

ILS `271.2085.0` 的独立 JVM 扩展提供：

- Manifest、values XML 的文档符号，包含资源类型、层级与原始名称选择范围；不要求 R.jar。
- 从 Manifest 类属性查询 Java/Kotlin 语义引用，保留原生代码/KDoc 范围及 `includeDeclaration`，追加一次当前属性；alias 使用 `targetActivity`。
- Manifest 类 definition，以及 `R.*` / XML 资源引用到源码声明的 definition。同一资源的不同限定符可返回多个声明；已确认资源源码优先于生成的 R 字节码。

解析使用当前 XML/Kotlin PSI、Document、模块及依赖索引。Bridge 仅在客户端不支持层级符号时展平响应；旧 TS XML/Gradle 解析、Android 子 RPC 和 `saxes` 已删除。

资源 definition 使用对应模块、变体的真实 AGP merger/blame，已在 AGP `9.4.1` 验证。先通过工程的 Gradle 任务生成产物；查询不会自动构建。来源缺失、声明删除/改名、新增覆盖或元数据失效时保留原生目标。未保存文档参与名称与位置校验。

Android 身份来自已导入模块。导入器缺失的 namespace、资源根和 Manifest 位置由当前 `build.gradle.kts` 的确定字面量补充；支持已确认源集的自定义目录与 Manifest 文件名，动态 DSL、外部脚本及无法确认的变体保持未知。已识别的 Manifest 类无法解析时返回具体 `-32803` 错误；取消保留 `-32800`。

构建与发布：

```sh
npm run build:jvm -- --ils-home "<已安装的 ILS 271.2085.0 目录>"
npm run check:assets
npm run build
npm pack --dry-run --json --ignore-scripts
```

编译使用目标发行包的 JBR 25 `javac`；缺少 JAR 工具时使用 `JAVA_HOME` 或 PATH 中的完整 JDK 25。发布包包含一个自有 JAR、ABI/SHA-256 清单和校验文件，二进制原样进入 `.runtime/<hash>`。本次未加入资源声明 references、Compose 抑制或 Android Lint。

启动层校验精确版本与资产摘要，并合并已有 `IJ_JAVA_OPTIONS` / `plugin.path`。不可用原因写入 `<systemPath>/launcher.log`；原生 LSP/DAP 保留。已有共享服务不热加载新 JAR，启用更新须先关闭消费者，再安全重启。

`npm run clean:runtime` 仅预览历史 runtime 清理；实际清理在关闭 OMP、Bridge、DAP 和 ILS 后执行 `node scripts/clean-runtime.mjs --apply`。当前声明引用的 hash 保留，启动时不自动回收历史或临时目录。

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
