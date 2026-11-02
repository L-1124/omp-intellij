# Changelog

## Unreleased

- 文档：将 TODO 拆为六项功能开发与独立验证计划，明确验收条件、已有模拟回归与真实环境覆盖缺口；修正研究报告中的类名猜测、合成调试帧、透明改写 AGP task、自动清缓存和进程清理建议，未决方案保留预研。本次未实现新增功能或重跑上游实验。

- 新增显式 `intellij-test` 原生 DAP 适配器，支持按文件、类或方法选择测试，复用工程 JDK、构建和测试 runner 参数。
- 测试启动先暂停在 runner 入口，允许 agent 设置源码断点；输出保留真实测试结果与进程退出码。
- 支持通过 `intellij` 附加已有 JDWP JVM，等待实际连接确认，断开时保留外部进程。
- 统一 DAP backend 建连、启动响应和取消清理，防止并发启动及 EOF 留下悬挂请求。
- 增加 `intellij-gradle` 适配器，复用服务端原生 `buildToolTarget`，保留 Gradle 编译、资源处理、工程属性及应用参数；冷构建不再受 15 秒启动等待限制。
- 增加原生 `debug custom_request` 的 `omp/intellij/status`，以及 `/intellij debug status|recover [id]`；恢复按工程和会话隔离，失败保留诊断记录。
- JDWP 就绪改为 `intellij/threadDump` 实际探测；断开先等待服务端 teardown 和正常关闭连接，再通知 OMP 结束，清理错误不再被吞掉。
- 工程构建、配置化测试与 JDWP 后台启动复用 OMP 的 `bash`、命名 service 和原生 `debug attach`，不增加重复的任务执行器。
- 增加 Maven profile/Surefire 与 Gradle wrapper/资源处理测试工程，验证配置化执行、真实断点和表达式求值。
- 测试目录增加标准 `tsconfig.json` 入口，复用现有测试编译配置，使 TypeScript LSP 正确加载 `@types/node`。

## 1.6.1

- 将 LSP 与 DAP 声明统一收敛至插件目录，扩展加载时按安装路径生成包内协议配置。
- 移除用户全局配置中的绝对启动命令与 DAP 适配器定义，仅保留用户 EULA 选项。
- 验证原生 LSP 符号查询与原生 DAP 调试流程（启动、断点、栈帧、终止）。

## 1.6.0

- 新增 `/intellij install [--dir <path>]` 命令，支持指定安装目录、版本缓存、SHA-256 校验、失败清理与跨进程安装锁。
- 服务端配置独立保存在 `~/.omp/agent/intellij.json`，安装成功后生效，保留外部可执行文件模式。
- 状态栏统一调度安装进度与索引状态，安装完成后自动恢复索引监控。

## 1.5.0

- 提供 LSP bridge 与 DAP proxy 独立入口，模块导入时不产生进程副作用。
- runner 支持独立握手与索引等待超时配置，重放项目初始化选项，等待对应索引 token 确认。
- 索引等待在未连接或连接断开时立即退出，超时保留 indexing 状态。
- 移除同义工具 `intellij_run`，统一使用原生 `debug` 与 `intellij` 适配器。
