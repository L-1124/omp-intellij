# TODO

本文记录已确定边界的功能开发与验证计划；所有复选框均为待完成项。规划中的命令和状态字段以实现验收为准，当前可用接口见 [README.md](./README.md)。

## 设计约束

- 语义查询与重构复用 OMP 原生 `xd://lsp`，调试复用原生 `debug`，工程执行复用 `bash` 与命名 service。
- 插件负责 IntelliJ 特有的配置、状态和生命周期；不增加同义工具、任务执行器、ADB 调度或 C++ 分析引擎。
- 错误保留真实原因；不猜测测试 ID、不伪造成功响应或调试帧、不透明改写 Android 构建任务。
- 进程清理必须证明所有权，缓存删除必须显式确认；活动工程与 attach 的外部 JVM 受保护。

## 功能开发

### P0-1：首次启动 EULA 确认与版本绑定

- [ ] **按实际安装包管理 EULA 接受记录**
  - 读取所选安装包的实际 EULA，计算当前 hash，提供查看与明确接受入口。
  - 接受记录绑定协议内容 hash，启动时仅传递已接受的当前 hash；移除 runner 中过时的固定 hash。
  - 协议内容变化后重新确认；无交互环境返回待确认原因，禁止自动接受。
  - **验收**：未接受、接受后启动、协议更新三条路径准确；EULA 记录与许可证凭据分离。

### P0-2：导入失败根因与协议错误保真

- [ ] **统一失败状态与原因展示**
  - 保留失败工程、导入阶段、服务端原始错误和 JSON-RPC `code`、`data`。
  - 在现有 `intellij_index` 与 `/intellij workspace status` 中展示最近失败原因及相关日志位置。
  - 区分连接失败、导入失败、授权拒绝、取消和超时；展示与日志内容脱敏。
  - **验收**：JDK 错误、依赖下载失败、导入失败可区分；失败立即结束索引等待；原始原因可追溯，凭据不泄露。

### P0-3：授权状态感知与恢复指引

- [ ] **在现有状态入口展示真实授权状态**
  - 根据服务端状态区分未知、有效、需激活和已过期，明确表达“服务可连接但语义功能被拒绝”。
  - 对已确认的授权拒绝给出恢复指引；缺少相关协议时标记未知，保留原始响应。
  - 登录、试用和提交激活信息均由用户明确触发，不在启动或重试中自动执行。
  - 诊断重试若属于 OMP 原生 LSP 客户端，在宿主侧修复；插件提供授权事实，不另建诊断循环。
  - **验收**：未授权与索引中、断连可区分；有效授权后正常查询；凭据不进入普通日志。

### P1-1：共享服务安全停止与重启

- [ ] **提供显式 stop / restart 生命周期操作**
  - 规划 `/intellij stop` 与 `/intellij restart`，与启动及缓存清理共用生命周期锁。
  - 锁内复查所有工程的连接租约与活动调试会话；存在活动消费者时列出阻塞者并拒绝默认操作。
  - 验证服务实例身份，只清理本插件拥有的服务及元数据；重启保留索引与工程配置。
  - **验收**：无活动消费者时完成停止→清理→启动；其他工程活动期间拒绝停止；端口与 owner 记录一致；attach 的外部 JVM 保持运行。
  - 自动内存轮替与阈值策略继续留在预研。

### P1-2：bridge 与 runner 有效配置一致性

- [ ] **统一两条连接路径的配置解析规则**
  - 复用 OMP 原生 LSP settings，明确宿主配置进入 runner 的传递路径，避免维护第二份同义配置。
  - 按 `workspace/configuration` 请求的 section 返回对应值，保留带空格的字面键名；未配置 section 返回 `null`。
  - 明确初始化选项、动态 settings、服务进程环境和工程导入环境的职责与优先级。
  - **验收**：同一工程经 bridge 与 runner 连接时取得一致配置；项目级覆盖生效；跨工程配置隔离。

### P1-3：工程级导入环境与生效状态

- [ ] **扩展现有工程配置的导入环境覆盖**
  - 复用现有导入模型 `env` 路径，支持工程级代理、构建工具参数等显式环境覆盖。
  - 与 JDK 配置合成时保留用户字段，明确 `JAVA_HOME` 冲突优先级；不修改共享 JVM 的全局环境。
  - 区分已保存、已提交重新导入、导入成功和导入失败；具体配置的生效声明必须有实际证据。
  - **验收**：两个工程使用不同值时互不污染；reload 后模型反映目标配置；失败保留原因；敏感值不进入状态输出。
  - Android 变体作为候选真实项目验收案例；变量优先级、传递与模型变化先按 `RESEARCH.md` 核实。

## 验证计划

已有模拟回归覆盖部分连接、配置与会话管理边界，下列复选框保留真实环境及平台覆盖缺口，不代表相关机制尚未实现。补充材料报告的 207 项测试通过属于历史执行记录，本次文档更新未重跑测试。

| 验证方向 | 当前可定位的实现或回归 | 待补证据 |
| --- | --- | --- |
| 多工程并发 | `test/workspace.test.ts` 的 JDK 合成；`test/debug-control.test.ts` 的多工程会话隔离 | JDK 17 / 21 双工程真实并发构建、断点与定向恢复 |
| 取消与断连 | `test/connection-close.test.ts`、`test/run-session.test.ts`、`test/debug-control.test.ts` | Windows 真实强杀、端口与文件锁释放、共享进程保护 |
| 超时分层 | `test/run-session.test.ts` 的数值校验、覆盖优先级与取消 | 冷下载和大源码树下的实际超时传播 |
| 多模块 | 现有启动路径与工作目录解析 | Maven reactor、Gradle 多项目的 classpath、工作目录和同名类消歧 |
| reload | `test/run-session.test.ts` 的无关 progress end 与索引 token 回归 | 真实增加依赖及切换 JDK 后的符号与运行结果 |
| 跨平台 CI | 现有测试包含 fake LSP / DAP fixtures | Windows、Linux、macOS 工作流与各平台实际结果；真实服务验证另需合法授权 |

### P0：稳定性与生命周期边界

- [ ] **多工程与多会话并发验证**
  - 同时打开两个配置不同 JDK（例如 JDK 17 与 JDK 21）的工程。
  - 并发执行索引等待、Gradle 构建与 DAP 调试会话。
  - 触发单会话 `/intellij debug recover <id>`，验证目标会话正常清理且不干扰同项目或跨项目其他活动会话。

- [ ] **取消、崩溃与异常断连矩阵**
  - 索引等待中取消（OMP tool timeout 或用户中止）。
  - Gradle `buildToolTarget` 启动期间取消，仅回收可证明由本次操作独占拥有的 JVM 与子进程；共享 Gradle daemon 的存活本身不作为泄漏判据。
  - JDWP attach 等待握手期间取消，验证外部 JVM 未被误杀且代理端口释放。
  - 模拟代理进程异常崩溃（SIGKILL / 强杀 PID），验证 `listDebugSessions` 正确标记为 unrecoverable，不残留可被误连的死端口。
  - 模拟共享 IntelliJ 服务端崩溃，验证 LSP 连接转为 disconnected 或 failed、DAP 会话报告失败并保留原因，且不留下悬挂 Promise。

- [ ] **冷启动与大工程超时阶梯分级**
  - 验证首次依赖下载、超大源码树导入等耗时场景。
  - 区分 OMP 工具超时（秒）、共享服务启动 `startupTimeoutMs`、LSP 初始化 `initializeTimeoutMs`、索引等待 `requestWaitTimeoutMs` 及 DAP 操作/清理 deadline（毫秒）。
  - 当前 DAP 清理 deadline 为 15 秒；200ms 是结束事件后的调度延迟，不是清理超时。Gradle launch 等待和 attach timeout 按实际操作分别验证。
  - 确保取消与超时信号在每一层准确传递，不挂死 OMP 主调度器。

### P1：工程执行与真实项目覆盖

- [ ] **Gradle 测试任务调试套件落地**
  - 搭建 Gradle 测试专用 fixture，验证通过原生 `bash` 或命名后台 service 启动 `./gradlew test --debug-jvm`。
  - 验证多测试过滤器（`--tests "com.example.*"`）与子模块任务路径（`:subproject:test`）。
  - 验证 `test` 任务绑定的自定义 `debugOptions`（非默认 5005 端口）。
  - 验证 DAP `attach` 接入、断点命中、测试报告输出与进程正常退出。

- [ ] **多模块工程实测套件**
  - Maven reactor 多模块工程：验证跨模块依赖、独立 `target/classes`、模块工作目录解析及同名 main class 消歧。
  - Gradle 多项目构建：验证 `projectPath`、多 sourceSet（如 `integrationTest`）及依赖模块 jar 的 classpath 解析。

- [ ] **配置变更与重新导入验证**
  - 修改 `pom.xml` 或 `build.gradle.kts` 添加新依赖后执行 `/intellij workspace reload`。
  - 验证旧 classpath 缓存作废，新符号可被索引解析，新依赖类可在启动时加载。
  - 切换工程 JDK 后验证服务端重传初始化参数并更新运行环境。

- [ ] **服务端升级与能力探针**
  - 验证官方后续版本中 `buildToolTarget` 与 `intellij/threadDump` 等自定义协议扩展的兼容性。
  - 在需要对应能力的操作前快速返回明确错误并保留原始原因；缺少 DAP 扩展不阻断已有 LSP 导航。

### P2：持续集成

- [ ] **跨平台 CI 矩阵构建**
  - 在 GitHub Actions / 平台 CI 中构建 Windows、Linux 与 macOS 矩阵。
  - 运行 `typecheck`、`test`、`biome check` 与 `format:check`。
  - 复用已有 fake LSP / DAP fixtures，核实普通回归不依赖商业授权；需真实服务的验证单独分组，记录授权与平台前提。

---

## 调研与技术预研

涉及协议级落差、上游缺陷绕过、可行性未知或方案待论证的课题，已统一收敛至 [RESEARCH.md](./RESEARCH.md)。在预研得出确定结论与具体设计前，严禁作为开发任务直接列入待办。
