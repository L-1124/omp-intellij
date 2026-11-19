# omp-intellij 开发者文档

`omp-intellij` 负责 OMP 与外部 IntelliJ Language Server (ILS) 之间的 LSP/DAP 转发与适配，以及服务端生命周期、多工作区和会话隔离。语言语义与调试实现由服务端提供。

目标 ILS / VSIX 版本与平台归档摘要见 [bundle-metadata.ts](../src/server/bundle-metadata.ts)。本仓库不构建或分发服务端扩展。

## 专题文档

| 文档 | 内容范围 |
| :--- | :--- |
| [**1. ILS 协议与生命周期规范**](ils-protocol-and-lifecycle.md) | 服务端分发与端口解析、Bridge 握手与退出边界、编辑转发、MCP 工具、诊断刷新与缓存 |
| [**2. DAP 调试代理与多工作区隔离规范**](dap-proxy-and-workspace.md) | 适配器预设、JSON-RPC 分帧、多工作区隔离、DAP 状态机、控制接口与测试隔离 |
