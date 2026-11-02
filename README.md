# omp-intellij

OMP 的 IntelliJ Language Server 集成插件。提供共享 IntelliJ 服务端连接、项目索引屏障、工程 JDK 管理、Java/Kotlin 程序运行与 DAP 调试。

## 功能特性

- **共享服务端进程**：多个项目与 OMP 会话复用同一个后台 IntelliJ 实例，动态分配回环端口，避免多开 JVM 消耗内存。
- **项目索引屏障**：在服务端完成初始化与项目导入前暂存查询，收到 `intellij/ready-for-test` 通知后统一放行，防止返回空结果误判。
- **工程 JDK 管理**：按项目隔离并持久化 JDK 配置，自动检测候选 JDK，重放初始化参数，支持 Maven 与 Gradle 项目。
- **原生调试与运行**：通过 DAP 适配器接入 OMP 原生 `debug` 工具，执行前自动完成项目构建，支持断点、单步、调用栈与表达式求值。
- **内置服务端安装器**：内置固定版本官方服务端下载逻辑，支持指定安装目录、SHA-256 校验、版本隔离与跨进程锁。
- **统一状态调度**：状态栏集中显示下载、校验、解压、服务连接与项目索引进度。

## 环境要求

- Node.js >= 22
- JDK 21（用于构建与运行测试工程；服务端自带 JBR）
- 解压工具：Windows / macOS 使用系统自带 `tar`；Linux 需要 `tar` 与 `unzip`
- IntelliJ 许可证：服务端 1.0+ 需要 IntelliJ IDEA Ultimate 或试用授权

## 安装

### 1. 构建插件

```sh
npm ci
npm run build
```

### 2. 安装到 OMP

在 OMP 中通过本地 marketplace 注册并安装：

```sh
omp plugin marketplace add F:/source/omp-intellij
omp plugin install omp-intellij@omp-intellij-local
```

插件加载时会在自身包目录下自动生成 `.lsp.json` 与 `.dap.json`，将启动路径指向包内的 `dist/bridge.js` 与 `dist/dap-proxy.js`。无需手动修改全局 `~/.omp/agent/lsp.json` 或 `dap.json`。

> [!NOTE]
> 若之前使用 `omp plugin link` 安装过同名插件，先执行 `omp plugin uninstall omp-intellij` 解除链接。

## 使用说明

### 1. 服务端安装与启停

```text
# 下载并安装官方服务端（默认路径 ~/.omp/servers/intellij，支持自定义目录）
/intellij install --dir "F:/toolchains/IntelliJ Managed Server"

# 查看服务端连接状态、配置路径与项目索引进度
/intellij status

# 手动启动后台共享服务
/intellij start
```

### 2. 工程 JDK 管理

```text
# 查看当前项目的 JDK 配置与生效状态
/intellij workspace status

# 列出所有已配置的工程及其 JDK
/intellij workspace list

# 扫描并列出本机已安装的 JDK 候选路径
/intellij workspace jdks

# 为当前工程绑定指定 JDK 并触发重新导入
/intellij workspace jdk "F:/toolchains/jvms/store/21.0.4"

# 重新导入当前工程
/intellij workspace reload
```

工程配置保存在 `~/.omp/agent/intellij-workspaces/<工程哈希>.json` 中，与缓存生命周期分离。

### 3. 缓存查看与清理

```text
# 查看各工程的缓存占用与服务端进程
/intellij cache

# 预览可清理的陈旧缓存目录
/intellij prune

# 确认执行清理（带有活跃连接租约的目录会被自动跳过）
/intellij prune --apply
```

### 4. 程序运行、测试与调试

以下 JSON 是 OMP 原生 `debug` 工具参数，以测试工程目录为当前工作目录。

运行或调试 main：

```json
{
  "action": "launch",
  "adapter": "intellij",
  "program": "src/main/java/com/example/JavaGreeter.java",
  "timeout": 180
}
```

默认先构建，再停在 main 入口。使用 `continue` 运行，或设置源码断点后继续调试。`noDebug` 属于适配器配置字段，OMP 当前的 `debug launch` 参数没有直接暴露它。

运行测试文件：

```json
{
  "action": "launch",
  "adapter": "intellij-test",
  "program": "src/test/java/com/example/JavaGreeterTest.java",
  "timeout": 180
}
```

`intellij-test` 默认发现文件内的可运行测试类。`args` 可指定服务端原始测试 ID：类为 `com.example.JavaGreeterTest`，方法为 `com.example.JavaGreeterTest#testJavaGreeting`。这些参数在测试适配器中表示测试选择器，main 适配器的 `args` 仍表示程序参数。

测试启动前执行对应源集的构建，JDK、工程 classpath 和 runner 参数由服务端解析。代理先停在 runner 的 main，让 agent 能在活动会话中设置测试源码断点，再 `continue`；只运行测试时直接继续即可。用 `output` 查看测试输出和 `IntelliJ tests exited with code N`。启动成功与测试通过分别判断，退出码 0 才表示本次进程正常结束。

测试直接通过 JVM 运行，不继承 Maven Surefire 或 Gradle `test` 任务的专用配置；需要这些配置时，通过构建工具启动 JDWP，再使用 attach。服务端返回多个启动规格时明确报错，按组分别启动，不会静默漏跑。

#### 按工程配置执行

普通构建和测试直接使用 OMP 的 `bash`；等待 JDWP 的测试进程使用命名后台 service。优先使用工程的 Maven/Gradle wrapper，保留原有 profile、任务路径、环境变量与退出码。插件不提供第二套任务执行器。

需要 Surefire 配置时，先通过 `bash` 启动 Maven，再用原生 `debug attach` 连接测试 JVM。例如，在 `test-fixtures/maven-execution` 下使用 JDK 21 执行：

```sh
mvn -Pengineering -Dengineering.expected=maven-profile \
  "-Dmaven.surefire.debug=-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=127.0.0.1:5005" test
```

Windows PowerShell 中使用 `mvn.cmd`，将命令写在同一行；`JAVA_HOME` 指向 JDK 21。这里的 `5005` 是显式选择的测试 JVM 端口，使用前应确认空闲。Surefire 可能捕获 JDWP 的启动输出，后台 service 可用该端口作为就绪条件，不依赖控制台文本。Gradle 测试使用工程原有的 `test --debug-jvm` 或对应子模块任务；调试端口遵循工程的 `debugOptions`。

Gradle main 使用服务端原生的构建工具启动链路：

```json
{
  "action": "launch",
  "adapter": "intellij-gradle",
  "program": "src/main/java/com/example/GradleMain.java",
  "cwd": "F:/source/omp-intellij/test-fixtures/gradle-execution",
  "timeout": 300
}
```

它通过 IntelliJ 的 `buildToolTarget` 启动，编译和资源处理交给 Gradle，不再提前执行普通 JVM 构建。工程需要 wrapper 或可用的 Gradle。`gradleArgs`、`projectPath`、`sourceSet`、`vmArgs` 属于适配器的 `launchDefaults`，可使用 OMP 原生项目级 DAP 配置设置；原生 `debug` 工具的 `args` 仍只传给应用。Gradle 启动等待默认复用 `requestWaitTimeoutMs`，适配器 `timeout` 可覆盖它（毫秒）；工具调用的 `timeout` 单位为秒，应覆盖冷构建所需时间。

### 5. 附加到已有 JVM

目标 JVM 需先启用 JDWP；`port` 是目标公布的监听端口，不是插件内部的 DAP 端口：

```json
{
  "action": "attach",
  "adapter": "intellij",
  "host": "127.0.0.1",
  "port": 5005,
  "cwd": "F:/source/omp-intellij/test-fixtures/jvm-hybrid-app",
  "timeout": 90
}
```

仅支持 JDWP 端口附加，不支持从 PID 猜测端口。代理通过服务端的 `intellij/threadDump` 请求确认 JVM 已连接，不依赖英文 console 输出或必须暂停的线程上下文。探测期间会短暂暂停并恢复 JVM，不产生用户暂停操作；缺少该能力、连接失败或超时都会明确报错。

附加会话的 `terminate`、`disconnect` 和异常关闭都只结束调试连接，保留外部 JVM。通过 `address=127.0.0.1:0` 启动的 JVM 可能在 detach 后重新分配 JDWP 端口，重连应读取它新公布的值。

#### 调试状态与会话恢复

agent 使用 OMP 原生 `debug`：

```json
{
  "action": "custom_request",
  "command": "omp/intellij/status"
}
```

返回连接阶段、launch/attach 模式、工程路径、backend 端口、未完成请求数和错误。阶段区分 `connecting-lsp`、`connecting-dap`、`connecting-jvm`、`running`、`stopped`、`cleaning`、`closed`、`failed`。结束当前活动会话使用原生 `debug terminate`。

需要从会话外检查或清理时：

```text
/intellij debug status
/intellij debug recover
/intellij debug recover <session-id>
```

恢复只作用于当前工程的指定代理连接，不重启共享 IntelliJ 服务端，也不终止 attach 的外部 JVM。同一工程有多个活动代理时必须指定 ID；正常结束、断开及恢复都在清理完成后发送结束通知。原生服务端可能先完成 teardown 并正常关闭 TCP，再来得及返回 disconnect 响应；代理接受这一正常关闭路径，超时、错误响应和异常断连仍报告失败。

控制端口随机分配，仅监听回环地址并使用独立 token。每个代理按工程哈希和 UUID 保存记录，位于 `systemPath/plugin-metadata/debug-sessions/`；失败记录保留诊断信息。代理已经退出时会标为不可恢复，不会猜端口重连或杀共享 JVM。

### 6. 索引状态工具

扩展向 agent 暴露只读工具 `intellij_index`：

- `intellij_index status`：获取当前工程的索引阶段（`connecting`、`importing`、`indexing`、`ready`）。
- `intellij_index wait`：阻塞等待索引完成，可配置超时时间（秒）。未启动服务或已断开时立即返回对应状态。

## 配置管理

### 服务端路径配置

安装成功后配置保存在 `~/.omp/agent/intellij.json`（可通过环境变量 `OMP_INTELLIJ_CONFIG` 覆盖）：

- **托管模式（推荐）**：

  ```json
  {
    "server": {
      "mode": "managed",
      "installDir": "F:/toolchains/IntelliJ Managed Server"
    }
  }
  ```

- **外部模式**（使用已有安装）：

  ```json
  {
    "server": {
      "mode": "external",
      "executable": "F:/toolchains/intellij-server/server/bin/intellij-server.exe"
    }
  }
  ```

### 运行超时与缓存策略

包内 `settings.json`（可通过环境变量 `OMP_INTELLIJ_SETTINGS` 覆盖）配置底层运行限制：

```json
{
  "executable": "F:/toolchains/intellij-server/server/bin/intellij-server.exe",
  "host": "127.0.0.1",
  "systemPath": "F:/cache/intellij-server/shared",
  "startupTimeoutMs": 30000,
  "initializeTimeoutMs": 30000,
  "requestWaitTimeoutMs": 300000,
  "idleTimeout": "30m",
  "cachePolicy": {
    "retentionDays": 30,
    "warnAboveGiB": 5,
    "automaticDeletion": false
  }
}
```

- `startupTimeoutMs`：共享服务端后台启动等待时间。
- `initializeTimeoutMs`：LSP 初始化握手超时。
- `requestWaitTimeoutMs`：请求在索引就绪前的最大等待时间。
- `cachePolicy.automaticDeletion`：必须保持 `false`，清理操作必须显式执行。

## 项目结构

```text
omp-intellij/
├── src/
│   ├── plugin.ts            # 插件入口，自动物化包内 .lsp.json 与 .dap.json
│   ├── extension.ts         # OMP 扩展生命周期、命令与状态栏渲染
│   ├── bridge.ts            # LSP stdio ↔ TCP 桥接服务
│   ├── dap-proxy.ts         # DAP stdio 调试代理服务
│   ├── index-barrier.ts     # 索引就绪屏障与请求队列
│   ├── server-install.ts    # 官方服务端下载、校验与解压安装器
│   ├── server-bundles.ts    # 官方各平台归档版本与 SHA-256 清单
│   ├── server-config.ts     # 用户级服务端选择与安装发现配置
│   ├── workspace.ts         # 工程 JDK 检测、持久化与参数合成
│   ├── cache-manager.ts     # 缓存清单统计与租约安全清理
│   └── service.ts           # 共享后台服务端进程管理与锁调度
├── test/                    # 单元与集成回归测试
├── test-fixtures/           # Java / Kotlin 混合构建测试工程
├── .omp-plugin/
│   └── marketplace.json     # 插件元数据及 LSP/DAP 模板声明
├── settings.json            # 默认服务参数配置
└── package.json
```

## 开发与测试

```sh
# 类型检查
npm run typecheck

# 代码检查与格式验证
npm run check
npm run format:check

# 自动修复 lint 与格式问题
npm run check:fix

# 运行完整测试套件
npm test
```

测试工程：

- `test-fixtures/jvm-hybrid-app`：Java/Kotlin 互调、JUnit 5、main 与 JDWP attach。
- `test-fixtures/maven-execution`：Surefire profile 与系统属性；`mvn -Pengineering -Dengineering.expected=maven-profile test`。
- `test-fixtures/gradle-execution`：官方 Gradle wrapper、main 启动、资源处理与工程属性；`./gradlew -PengineeringMessage=cli-configured run --args="first second"`（Windows 使用 `gradlew.bat`）。

## 已知边界

> [!WARNING]
> - **服务端调用层级**：调用层级可能遗漏测试源码，测试影响分析请使用引用查询。
> - **Kotlin 测试发现**：当前服务端版本在按文件扫描 Kotlin 测试用例时可能返回空列表；按已知类名解析运行参数可正常执行。
> - **JUnit 调用栈**：当前服务端读取完整测试调用栈时可能报 `Index ... out of bounds`；历史实测曾用 `levels: 1` 读取顶层工程帧，其通用规避效果仍待固定条件复现，代理保留原始错误。
> - **授权许可**：服务端首次启动需接受 EULA，且需要绑定有效许可证或开启 30 天试用。

## 开发规划与研究

- [TODO.md](./TODO.md)：六项功能开发及独立验证计划，包含优先级、验收条件和已有回归的证据边界。
- [RESEARCH.md](./RESEARCH.md)：可靠测试发现、JDI 分页、Android 变体、服务端扩展、长期内存、离线授权和 KMP 的未决问题。
- [RESEARCH_REPORT.md](./RESEARCH_REPORT.md) 与 [INTELLIJ_SERVER_ANALYSIS.md](./INTELLIJ_SERVER_ANALYSIS.md)：历史机制记录与审查后的设计边界；不作为新增功能已完成的说明。

EULA 确认、授权状态、安全 stop / restart、有效配置统一及工程导入环境等列在开发清单中；当前可用命令仍以上文使用说明为准。
