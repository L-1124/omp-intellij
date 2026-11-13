# Android 应用运行与调试

## 客户端与端点

Android 运行链在 ILS JVM 扩展内执行。普通 LSP/DAP 客户端仅需固定版 ILS、已加载的 Android 插件、Android SDK 和明确指定的设备；Gradle 目标还需工程 wrapper 与完整 JDK。JVM 不读取 OMP 配置、环境变量或控制文件。

扩展提供两个 `workspace/executeCommand` 命令：

| 命令 | 参数 | 结果 |
| --- | --- | --- |
| `org.intellij.android.debug.startServer` | `[{}]` | `{ "port": 端口 }` |
| `org.intellij.android.run.targets` | `[{ "buildRoot": "可选构建根", "deviceId": "可选设备" }]` | 在线设备、ABI、application 模块与真实 variant 模型 |

`startServer` 执行官方导入高水位屏障后发布 `127.0.0.1` 随机端口。参数对象必须为空；端点仅接收一个客户端，30 秒未连接即关闭。LSP 连接拥有端点，DAP 连接拥有本次运行资源。目标查询只读，不构建、安装或启动应用，也不自动选择设备。

客户端连接返回端口后依次发送标准 DAP `initialize`、`launch` 或 `attach`。收到 `initialized` 后发送断点和 `configurationDone`；随后等待原始启动响应。启动响应需要配置完成，不能先等待启动响应再开始配置。

官方 `runDapServer` 负责 framing、请求关联与事件输出。包装层在同一进程内调用原生 `intellij_jvm` 调试器，无第二个 DAP listener。原生 debugger 的停止信号与外层传输分离，避免 disconnect 在包装层清理和响应写出前关闭 socket。Android disconnect 返回时本会话清理已完成；代理收到结果后关闭自己拥有的连接，由客户端 EOF 结束官方传输，不再等待服务端先关闭 socket。普通 JVM 继续使用官方 `start_debug_server`。

## Launch 参数

标准 DAP wire 示例：

```json
{
  "command": "launch",
  "arguments": {
    "noDebug": false,
    "android": {
      "deviceId": "emulator-5580",
      "target": {
        "kind": "gradle",
        "module": ":app",
        "variant": "debug"
      }
    }
  }
}
```

`android` 直接位于 wire `arguments` 中。客户端无需额外包装 `adapterArguments`；官方 serializer 将扩展字段解码到 JVM typed 参数的 `adapterArguments`。

| 字段 | 契约 |
| --- | --- |
| `android.deviceId` | 必填，精确设备 serial |
| `android.userId` | 可选非负用户 ID；省略时解析一次当前设备用户，后续操作显式携带该用户 |
| `android.target` | 必填，见下方目标类型 |
| `android.activity` | 可选 Activity 或 alias；省略仅允许唯一 launcher |
| `android.restartApp` | 默认 false；已有进程时在安装或停止之前报 `target_running` |
| `android.timeoutMs` | 默认 120000，范围 1..300000 |
| `cwd` | 相对路径基准；默认 bootstrap 所属 LSP 工作区 |
| `program` | APK 目标可使用的单 APK 路径 |
| `noDebug` | 标准顶层字段，默认 false |

目标类型：

- `{"kind":"gradle","module":":app","variant":"debug","buildRoot":"可选","build":true}`：使用官方 AGP 模型指定的 assemble task 和 artifact listing；`build=false` 仅使用有效既有产物。`module` 在选定 `buildRoot` 内查找，included build 使用自己的构建根与连接。
- `{"kind":"apks","files":["base.apk","feature.apk"]}`：显式安装集；省略 files 时必须由 program 指定一个 APK。多个独立 ABI 输出从模型与设备 ABI 中选一个，不能当作 split 安装集。
- `{"kind":"installed","packageName":"com.example.app"}`：从选定设备用户的实际已安装 base APK 读取身份。

APK 路径必须存在且无重复。安装集必须同包、同版本、恰有一个 base，split 名无重复。AAB 和动态特性交付明确拒绝。稳定 build-tools 的 `aapt2` 用于二进制 Manifest 身份、debuggable、launcher、process 与 alias 解析；缺少工具直接报前提错误。

Android 端点拒绝非空 DAP `args`。Gradle 模型与构建必须使用含 `jlink` 的完整 JDK；ILS 裁剪 JBR 不满足 Android 构建前提。

## Attach 与应用所有权

```json
{
  "command": "attach",
  "arguments": {
    "android": {
      "deviceId": "emulator-5580",
      "packageName": "com.example.app"
    }
  }
}
```

可选 `userId`、`pid` 或 `processName`；pid 与 processName 互斥。省略进程选择时仅允许唯一匹配进程。Attach 仅取得 JDWP 资源，不构建、安装、启动或重启应用。

| 会话 | `disconnect` 默认 / true | `disconnect(false)` |
| --- | --- | --- |
| 本次 launch 拥有的应用 | 身份复核后停止所选包/用户并释放资源 | Detach，保留应用 |
| 外部 attach | 默认 detach；显式 true 在完成 detach 后返回 `invalid_params` | Detach，保留应用 |

外部 attach 的显式停止错误为 `terminateDebuggee=true is not permitted for external attach`。原生 delegate 总是收到 `terminateDebuggee=false`；设备应用停止由 Android ownership 层执行。

保留应用时，native disconnect 仅提交后台 teardown；包装层等待独立的 native stopped signal，确保 VM resume/dispose 路径结束后才释放 JDWP handle。该信号与外层 transport stopped 分离，客户端仍能收到 disconnect 响应再关闭连接。

应用句柄保存设备、用户、包、UID 与真实进程实例。已观察到外部重启或 PID 重用时，stale handle 保留新实例。Android 包级 force-stop 不支持原子 expected-PID 条件，身份复核与停止之间仍有平台固有的极窄竞态。

`terminate` 请求不受支持且保留会话；所有权通过 `disconnect` 表达。未知退出码不伪造 `exited(0)`。设备离线只释放本地资源，不自动重连或启动应用。

## 普通运行、进度与取消

`noDebug=true` 使用同一个官方 DAP transport，完成安装、启动与进程观察，但不创建 JDWP 代理或调用 native attach。收到一次 `initialized` 后可完成配置握手；断点返回 unverified 并说明 noDebug，线程、变量、求值、执行控制等调试请求明确拒绝。

支持进度事件的客户端会收到 `configuring`、`building`、`installing`、`starting`、`attaching` 阶段，不报告虚构百分比。每次连接只允许一次 launch/attach，进度 ID 为 `org.intellij.android.launch`。

`cancel.requestId` 或 `cancel.progressId` 取消本次启动。取消响应成功只表示取消请求已处理；原始启动失败响应和 `progressEnd` 发生在清理路径完成后。官方传输独立写出响应与进度事件；客户端按 progressId 等待 `progressEnd`，不以启动响应作为事件已送达的屏障。EOF、LSP 断线、超时和 disconnect 进入同一清理协调器。

Gradle 通过官方 `CancellationTokenSource` 停止本次 operation；关闭本次连接，不停止共享 daemon。流式安装要求 Android API 21+。安装 session 在未确认 commit 成功的退出路径中，以独立 5 秒清理预算在 `NonCancellable` 下 abandon。

Commit 已发送但成功确认丢失时，错误保留 `outcomeUnknown=true` 并停止后续启动。设备上可能已有生效 APK；不重试安装、不卸载回滚，也不以相同包版本推断提交成功。清理错误与原始错误一起保留。

## 路径与固定 SDK 错误边界

普通客户端可协商 `path`/`uri` 以及 1-based/0-based 行列。包装层只转换协议定义的 Source/path；不改变量值或 adapterData。行列协商交由原生调试器，避免双重偏移。非 file 源码保留 sourceReference，不支持的 URI scheme 明确报错。

固定版原生 attach 不提供模块/classpath 作用域参数，不保证不同模块中同一限定类名的断点隔离。对未部署模块的同名类设置断点，仍可能返回 verified，并命中运行类中相同行号的其他方法；verified 不证明该源码属于设备上的 APK。客户端仅配置当前部署产物对应源码的断点，切换目标时清除其他同名类断点。包装层保留原生行为，不自动继续这类停点，也不通过猜测模块或新增隐式源码过滤改变结果。

客户端在 launch/attach 尚未完成时，收到 `initialized` 后配置断点并发送 `configurationDone`；先等待启动请求最终响应再发送配置完成，会阻塞原生调试器握手。

运行错误文本为 `[code] stage: detail`。JVM 构造标准 `Message(id=3001)`，包含有界 code/stage/context，关闭 telemetry。ILS 271.2085.0 官方 transport 将异常转换为仅含 message 的失败响应，wire 不保留 `body.error`；客户端应以 `success=false` 与 message 判错。

## OMP 接入与排障

OMP 继续使用既有 `intellij` adapter，将项目 `.omp/dap.json` 的 `adapters.intellij.launchDefaults.android` 平铺到 DAP wire body。TS 代理仅选择 Android 端点和适配协议，不承担构建、安装或应用停止。

OMP 宿主只保存 initialize 响应能力，不处理后发 capabilities。代理初始化时保守关闭 terminate/cancel/terminateDebuggee；标准客户端仍会收到真实后端 capabilities 更新。OMP 退出直接发送 disconnect(true)：owned launch 停止应用，external attach 返回拒绝停止并完成 detach，宿主捕获失败后销毁本地会话。

ART 调试 Project 显式绑定 `AndroidDebuggerListener`。Android 会话启用同步 JDI 和会话级 renderer muting，最后一个 Android 会话结束时恢复原设置。同一 DAP 上下文显式注册 `AndroidFieldVisibilityProvider`，由会话消息总线的 disposable 管理，过滤 ART `java.lang.Object` 的两个 shadow 字段，断开后注销。不要全局永久关闭异步 JDI、增加 variables 超时或重试掩盖生命周期问题。

设备/JDWP 服务由 LSP 连接的 Job 拥有，在进入调试上下文前注入 backend；同一连接的后续 attach 复用该服务，LSP 结束时释放。不要把进程级缓存服务注册到一次性调试 Application 的 disposable 下。

AMS 的 PID=0 记录表示进程尚未启动，不作为运行目标或已启动身份。启动等待持续到出现正 PID 的匹配记录，再建立 JDWP 会话。

遇到失败，保留本次 sandbox 的 ILS 日志、阶段输出和清理错误。只检查或清理本次拥有的进程、安装 session、JDWP 资源与 fixture 包；共享服务、Gradle daemon、ADB 和用户工程保持独立。
