# Android JDWP 调试与运行时排障

## 核心结论

1. **JDWP 代理架构**：在 ILS 271.2085.0（JBR 25）进程内集成 Google 官方 `adblib 9.4.1` 与 `adblib-tools 9.4.1`，通过 `JdwpProcessTracker` 和 `ConnectedDevicesTracker` 发现目标进程并建立本地回环 JDWP 代理（`JdwpProxySocketServer`）。上层复用 IntelliJ 原生 DAP 服务对接本地代理端口，不向宿主系统写入任何外置 `adb forward` 映射，消除端口泄漏与进程冲突。
2. **单线程调度自等待死锁根除**：句柄管理器 `AndroidDebugHandles` 使用单线程 `ScheduledExecutorService` 管理 TTL 与异步清理。在连接断开或 owner Job 进入 completion/cancellation 回调时，禁止在调度器线程上同步等待 `release()` 结果，而应在锁内仅标记 `beginCloseLocked`，由调度器异步执行 `doClose`，避免单线程队列自我等待导致的 10 秒超时死锁。
3. **10.3s Presentation 超时定位与双重抑制**：
   - 在 Android ART 运行时下，JBR 25 默认的异步 JDI（`debugger.async.jdi=true`）会导致子节点事件通知未能正确送达；
   - 切换到同步 JDI 后，IntelliJ 平台级富文本渲染器（如 `ToStringRenderer`）仍会在复合对象展开时尝试在挂起线程中执行计算或依赖被拒绝的 `BatchEvaluatorServer`，导致 DAP 的子节点展示通知链路在硬编码的 10.3 秒窗口（`FinalPresentationKt.awaitFinal` 等待 300ms + 10s）内无响应。
   - **解决方案**：在 `AndroidDebuggerListener` 中实现 `XDebuggerManagerListener` 与 `DebuggerManagerListener`，于会话启动时通过 `MuteRendererUtils.INSTANCE.getOrCreateFlow(data).setValue(true)` 开启会话级静默渲染；同时仅在首个 Android 会话附加时切换全局 `debugger.async.jdi=false`，并在最后一个 Android 会话分离时恢复原值。此方案保持基于反射的原始字段结构即时展开，复杂表达式按需求值，彻底根除 10.3s 超时。
4. **进程保护与幂等回收契约**：DAP `disconnect` 请求严格传递 `terminateDebuggee: false`，断开后目标 Android 应用进程（实测 PID 7736）全程存活；句柄释放支持显式 RPC/CLI 与自动生命周期双轨回收，重复释放返回 `{ success: true, cleaned: false, reason: "already_cleaned" }`，保证幂等。

---

## 踩坑记录与根因分析

### 1. `variables` 请求报 `no presentation within 10.3s` 超时全过程

#### 1.1 问题现象与触发场景

在真实 AVD（`emulator-5554`，Android API 34）或测试工程中命中断点后，基本类型局部变量（如 `int counter`、`int before`、`int after`）在 `stackTrace` 和栈帧变量请求中能即时返回。但在展开复合对象（如 `event` 枚举、`MainActivity` 的 `this$0`、`MainViewModel` 实例及其嵌套 `uiState`）时，DAP 客户端抛出异常：

```
Error: DAP command 'variables' failed: no presentation within 10.3s
    at Object.request (fixture.js:489:19)
    at async TestContext.<anonymous> (android-attach.test.js:386:487)
```

随后执行 `continue` 操作超时或卡死，无法正常恢复目标应用执行。

#### 1.2 排查过程与推翻的假说

##### 假说一：`toString()` 死锁（推翻）

- **推测**：断点命中时主线程被挂起，IntelliJ 的 `ToStringRenderer` 试图在挂起线程上执行 `invokeMethod("toString")` 导致线程互锁死锁。
- **排查与反证**：
  1. 通过 `jcmd <ILS_PID> Thread.dump` 抓取 ILS 进程（PID 36516）与应用线程栈。
  2. 线程转储显示：IntelliJ 的 `DebuggerManagerThread` 处于正常的空闲 `TIMED_WAITING (parking)` 状态，没有锁等待（`waiting on condition` 或 `blocked`）。
  3. 变量展开超时后，直接发送原生 DAP `continue` 指令，分别在 **4ms** 和 **3ms** 内极速返回 `{ allThreadsContinued: true }`，应用恢复执行完全正常。
  4. **结论**：虚拟机与调试器底层并未发生死锁。

##### 假说二：`BatchEvaluatorServer` 类加载异常为全部根因（推翻）

- **推测**：反编译 `intellij.java.debugger.impl.jar` 中的 `BatchEvaluator.java:360` 发现，`ToStringRenderer` 默认走批处理求值，通过 `ClassLoadingUtils.getHelperClass(BatchEvaluatorServer.class)` 尝试向目标虚拟机调用 `ClassLoader.defineClass` 注入 JVM `.class` 字节码。而 Android ART 只接受 DEX 字节码，且在 JBR 25 下找不到 `idea_rt.jar`，导致报错。
- **排查与反证**：
  1. IntelliJ 平台通过 `JdiHelperClassLoaderImpl.kt` 实际上判断了 `!DebuggerUtils.isAndroidVM(vm)` 并拒绝注入；而在当前版本的 `BatchEvaluator.kt` 中，Helper 加载失败会捕获异常并单项回退为常规求值。
  2. 尝试关闭 `Registry.get("debugger.batch.evaluation").setValue(false)` 并禁用 `BatchEvaluatorServer` 后，类加载错误虽然消失，但子字段展开依然超时：小型 `event` 枚举依然超时 30 秒，包含 116 个字段的 `MainActivity` 展开在 60 秒内无响应。
  3. **结论**：Helper class 加载异常只是表象，关闭批处理求值无法解决超时。

##### 假说三与终局定位：ART 下异步 JDI 与子节点富文本渲染 notification 链路挂起（证实）

- **关键链路分析**：
  1. DAP platform 层（`language-server.dap.platform.jar` 的 `FinalPresentationKt.awaitFinal`）存在硬编码超时机制：

     ```kotlin
     val firstPresentation = withTimeoutOrNull(300.milliseconds) { presentationFlow.first() }
     if (firstPresentation == null) {
         withTimeout(10.seconds) { presentationFlow.first() } // 合计 10.3s
     }
     ```

     如果 10.3 秒内没有任何一条 presentation 事件流发出，直接抛出 `no presentation within 10.3s`。
  2. 异步 JDI（`debugger.async.jdi`）：IntelliJ 271 / JBR 25 默认启用了 `debugger.async.jdi=true`（位于 `DebuggerUtilsAsync.java`）。Android ART 运行时的 JDWP 实现对异步事件/包的处理方式与 HotSpot 不同，导致异步请求下的子节点计算未能正确唤醒 `presentationFlow`。
  3. 自动 Renderer 的批处理通知挂起：即便切换到同步 JDI（`debugger.async.jdi=false`），针对复杂 Android 对象（如 `MainActivity` 继承层级、ViewModel、StateFlow 等），IntelliJ 的 `NodeRendererSettings` 仍然会为栈帧中的每一个子节点触发默认的 `ToStringRenderer` 等复合富文本渲染。这些自动计算在同步 JDI 批处理通知链中挂起，导致 `DapVariablesManager` 对所有子变量 `awaitAll` 时整体阻塞，再次击穿 10.3s 门限。

#### 1.3 解决方案设计与代码实现

- **方案原则**：
  1. 避免全局污染：不能硬编码修改全局设置影响普通 Java 调试。
  2. 会话级静默（Session-level Renderer Muting）：仅针对 Android 调试会话关闭自动富展示计算，保留基于反射的真实字段展开；用户显式求值时仍可按需计算。
  3. 动态 JDI 切换与引用计数回收：Android 会话激活时动态关闭全局异步 JDI，最后一个 Android 会话断开时恢复原有配置。
- **核心代码实现**（`AndroidDebuggerListener.java`）：
  在 `plugin.xml` 中以 `<listener>` 注册 `AndroidDebuggerListener`，同时实现 `DebuggerManagerListener` 与 `XDebuggerManagerListener`：

  ```java
  public final class AndroidDebuggerListener implements DebuggerManagerListener, XDebuggerManagerListener {
      private static final Logger LOG = Logger.getInstance(AndroidDebuggerListener.class);
      private static final Set<DebuggerSession> ANDROID_SESSIONS =
              Collections.newSetFromMap(new IdentityHashMap<>());
      private static Boolean previousAsyncJdi;

      @Override
      public void processStarted(XDebugProcess process) {
          if (process instanceof JavaDebugProcess javaProcess) {
              sessionAttached(javaProcess.getDebuggerSession());
          }
      }

      @Override
      public void sessionAttached(DebuggerSession session) {
          session.getProcess().getManagerThread().schedule(new DebuggerCommandImpl() {
              @Override
              protected void action() {
                  configure(session);
              }
          });
      }

      private static void configure(DebuggerSession session) {
          if (session.getProcess().isAttached()
                  && DebuggerUtils.isAndroidVM(
                          session.getProcess().getVirtualMachineProxy().getVirtualMachine())) {
              acquire(session);
              JavaDebugProcess process = session.getProcess().getXdebugProcess();
              if (process != null && process.getSession() instanceof XDebugSessionImpl xSession) {
                  var data = xSession.getSessionData();
                  if (!MuteRendererUtils.isMuted(data)) {
                      MuteRendererUtils.INSTANCE.getOrCreateFlow(data).setValue(true);
                      LOG.info("Muted renderers for Android debugger session");
                  }
              }
          }
      }

      private static void acquire(DebuggerSession session) {
          synchronized (ANDROID_SESSIONS) {
              if (!session.getProcess().isAttached() || ANDROID_SESSIONS.contains(session)) return;
              if (ANDROID_SESSIONS.isEmpty()) {
                  RegistryValue asyncJdi = Registry.get("debugger.async.jdi");
                  previousAsyncJdi = asyncJdi.asBoolean();
                  asyncJdi.setValue(false);
                  LOG.info("Using synchronous JDI while Android debugger sessions are attached");
              }
              ANDROID_SESSIONS.add(session);
          }
      }

      @Override
      public void sessionDetached(DebuggerSession session) {
          release(session);
      }

      @Override
      public void sessionRemoved(DebuggerSession session) {
          release(session);
      }

      private static void release(DebuggerSession session) {
          synchronized (ANDROID_SESSIONS) {
              if (!ANDROID_SESSIONS.remove(session) || !ANDROID_SESSIONS.isEmpty()) return;
              Registry.get("debugger.async.jdi").setValue(previousAsyncJdi);
              previousAsyncJdi = null;
              LOG.info("Restored JDI mode after the last Android debugger session ended");
          }
      }
  }
  ```

#### 1.4 实测数据对比与性能表现

测试环境：真实工程 `MyHook`（PID 7736，包名 `com.app.myhook`，设备 `emulator-5554`，Android API 34）：

| 调试操作 / 检查目标                          | 未静默时表现      | 会话级静默 + 同步 JDI 后表现              | 验收门限要求 | 结论 |
| :------------------------------------------- | :---------------- | :---------------------------------------- | :----------- | :--- |
| **`event` 枚举展开**                         | 30s+ 超时报错     | **43ms - 50ms**                           | < 30s        | 通过 |
| **`MainActivity`（`this$0` 全部 116 字段）** | 60s+ 超时挂死     | **780ms - 787ms**                         | < 60s        | 通过 |
| **`MainViewModel`（全部 9 个成员）**         | 10.3s 超时报错    | **119ms - 121ms**                         | < 60s        | 通过 |
| **`uiState`（`ReadonlyStateFlow` 嵌套）**    | 30s+ 超时报错     | **95ms - 100ms**                          | < 30s        | 通过 |
| **`viewModel$delegate`**                     | 10.3s 超时报错    | **113ms**                                 | < 30s        | 通过 |
| **原生 `continue` 恢复执行**                 | 超时卡死 / 阻塞   | **< 5ms**（实测 4ms/3ms）                 | 立即返回     | 通过 |
| **运行时内部字段过滤**                       | 暴露 ART 私有字段 | `shadow$_klass_`、`shadow$_monitor_` 隐藏 | 严格隐藏     | 通过 |

---

### 2. 单线程调度器自等待死锁（Self-wait Deadlock）排查与治理

#### 2.1 问题现象

在 Scenario 3 异常断开回归测试中（对 `dap-proxy` 发起 `SIGKILL` 强杀），LSP 触发 `release` 或内部过期逻辑时，服务端卡死满 10 秒后抛出：
```
com.jetbrains.lsp.implementation.LspResponseErrorException: Timed out waiting for debug handle cleanup
    at org.jetbrains.android.debug.AndroidDebugHandles.release(AndroidDebugHandles.java:340)
```
导致端口释放超时，阻塞后续测试用例。

#### 2.2 根因排查

1. `AndroidDebugHandles` 内部由单线程调度器驱动 TTL 与异步关闭：

   ```java
   this.scheduler = Executors.newSingleThreadScheduledExecutor(r -> {
       Thread t = new Thread(r, "android-debug-handles-ttl");
       t.setDaemon(true);
       return t;
   });
   ```
2. 当外部代理断开或 owner Job 结束时，触发注册的 completion 回调：

   ```java
   handle.ownerDisposableHandle = ownerJob.invokeOnCompletion(true, true, cause -> { ... });
   ```
3. 该回调若在调度器线程上同步调用 `release()`，内部会调用 `closeFutureToWait.get(10, TimeUnit.SECONDS)`。而实际执行底层网络与会话关闭的 `doClose()` 方法正是通过 `scheduler.execute(() -> doClose(handle, attempt))` 提交给同一个调度器排队的。
4. 调度器线程在等待 `closeFutureToWait` 完成，而使该 Future 完成的 `doClose()` 任务正堵在同一个线程的任务队列末尾等待被调度，构成经典的**单线程自等待死锁（Self-wait Deadlock）**，直到 10 秒超时抛错后队列任务才得以推进。

#### 2.3 解决方案

1. **异步启动关闭**：owner Job 进入 cancelling 阶段时，只在同步锁内调用 `beginCloseLocked(handle)`，由调度器异步排队执行 `doClose`，禁止在 completion 回调中进行阻塞等待：

   ```java
   handle.ownerDisposableHandle = ownerJob.invokeOnCompletion(true, true, cause -> {
       synchronized (lock) {
           if (handle.state != HandleState.CLOSED) beginCloseLocked(handle);
       }
       return Unit.INSTANCE;
   });
   ```
2. **协程等待保护上限**：在 `doClose` 中针对 `handle.childSession.close()` 触发的协程清理，限定 1 秒超时（`jobDone.get(1, TimeUnit.SECONDS)`），防止 `adblib` 内部 Socket EOF 悬挂拖累整体状态流转。
3. **状态移除原子化**：句柄在 `doClose` 成功后立即从 `handlesByKey`、`handlesByPort` 和 `activeTargets` 中移除并标记 `CLOSED`，允许后续请求即刻复用端口。

---

### 3. Detach 进程存活保护与 Release 幂等性

#### 3.1 进程存活保护机制

- 在 DAP 协议中，客户端发起 `disconnect` 时若未显式指定，可能默认终止被调试程序（`terminateDebuggee = true`）。
- 在 Android 远程附加调试场景中，目标是连接已在运行的应用，分离时绝对不能导致应用退出。
- 实现契约（`src/debug/dap-proxy.ts`）：

  ```typescript
  {
    terminateDebuggee: sessionMode === 'launch', // attach 模式下严格为 false
    suspendDebuggee: false,
  }
  ```
- **实测验证**：在 `MyHook` 验收中，断开调试会话后通过 `adb shell pidof com.app.myhook` 验证，应用原 PID（`7736`）全程存活，无重启、无崩溃。

#### 3.2 句柄释放幂等性

- 句柄释放提供显式 RPC/CLI 释放与 DAP Proxy 关闭生命周期绑定的隐式自动释放双轨机制。
- **契约设计**：当一个已经关闭（`state == CLOSED`）或已不存在的句柄再次接收到 `release` 命令时，不抛出错误，返回包含已清理原因的成功应答：

  ```json
  {
    "success": true,
    "cleaned": false,
    "reason": "already_cleaned"
  }
  ```

---

## 关键协议与运行时契约

### 1. `adblib` JDWP Proxy 编排架构

- **依赖组成**：
  - `adblib-9.4.1.jar`
  - `adblib-tools-9.4.1.jar`
  - 资产位于 `resources/ils/271.2085.0/android.lsp/lib/`，不引入传递依赖；实现模块通过显式依赖访问宿主提供的库。
- **连接编排**：
  - `AdbSessionHost` 管理父会话，通过 `AdbServerController` 与本地 `adb.exe` 进程建立长连接。
  - 使用 `ConnectedDevicesTracker` 监听在线设备状态流（`StateFlow<ConnectedDeviceList>`）。
  - 使用 `JdwpProcessTracker` 监听目标进程状态流（`StateFlow<JdwpProcessList>`），配合 `AppProcessTracker` 校验目标是否具备 `DEBUGGABLE` 属性。
  - 创建本地 Socket 代理：为目标 JDWP PID 启动独立的 `JdwpProxySocketServer`，绑定随机本地端口（`127.0.0.1:0`），对外暴露标准 JDWP 服务端口。

### 2. LSP 私有扩展命令契约

通过 `AndroidDebugCommands.java` 注册于 `workspace/executeCommand`：

#### 2.1 `omp.android.debug.prepare`

- **请求参数**：

  ```json
  {
    "packageName": "com.app.myhook",  // 与 pid 二选一
    "pid": 7736,                       // 与 packageName 二选一
    "deviceId": "emulator-5554",       // 可选，多设备在线时必填
    "adbPath": "C:/Android/sdk/platform-tools/adb.exe", // 可选
    "timeoutMs": 15000                 // 可选，默认 15000ms
  }
  ```
- **成功响应**：

  ```json
  {
    "success": true,
    "cleanupKey": "c2005435-0210-4355-9a86-7496666ad63c",
    "expiresAt": 1731065600000,
    "deviceId": "emulator-5554",
    "pid": 7736,
    "processName": "com.app.myhook",
    "host": "127.0.0.1",
    "port": 58321,
    "jdwpTarget": "jdwp:7736",
    "debug": {
      "action": "attach",
      "adapter": "intellij",
      "host": "127.0.0.1",
      "port": 58321,
      "timeout": 15
    }
  }
  ```
- **错误码与错误原因**：
  - `-32602 (invalid_params)`：参数类型错误、包名与 PID 同时传入、参数为空等。
  - `no_device`：无在线设备。
  - `ambiguous_device`：多设备在线且未指定 `deviceId`。
  - `process_not_found`：目标包名或 PID 进程不存在。
  - `not_jdwp`：进程存在但不可调试（非 JDWP 进程）。
  - `lease_conflict`：目标设备/PID 已存在活跃准备中的调试句柄或端口已被占用。

#### 2.2 `omp.android.debug.claim`

- **请求参数**：

  ```json
  {
    "host": "127.0.0.1",
    "port": 58321
  }
  ```
- **契约行为**：将状态从 `PREPARED` 切换为 `CLAIMED`，取消 TTL 过期定时器，绑定连接生命周期 Job。
- **响应**：`{ "claimed": true, "cleanupKey": "..." }` 或 `{ "claimed": false }`。

#### 2.3 `omp.android.debug.release`

- **请求参数**：

  ```json
  {
    "cleanupKey": "c2005435-0210-4355-9a86-7496666ad63c"
  }
  ```
- **响应**：
  - 首次清理成功：`{ "success": true, "cleaned": true }`
  - 重复清理（幂等）：`{ "success": true, "cleaned": false, "reason": "already_cleaned" }`

---

## 最佳实践与操作指引

### 1. 独立 CLI 命令用法

支持无需启动完整 LSP/DAP 会话直接调用调试生命周期管理：
```bash
# 1. 针对指定包名准备调试代理（自动寻找在线单设备）
node dist/android/debug-attach-cli.js prepare --package com.app.myhook

# 2. 针对指定设备与 PID 准备调试代理
node dist/android/debug-attach-cli.js prepare --device emulator-5554 --pid 7736

# 3. 自定义 ADB 路径与超时时间（毫秒）
node dist/android/debug-attach-cli.js prepare --package com.app.myhook --adb-path "D:/Android/Sdk/platform-tools/adb.exe" --timeout 20000

# 4. 释放调试句柄
node dist/android/debug-attach-cli.js release c2005435-0210-4355-9a86-7496666ad63c
```

### 2. 排查与诊断命令

在调试过程中遇到网络、进程或响应异常时，使用以下命令获取现场状态：
```bash
# 1. 检查 ADB 端口转发状态（验证是否存在转发端口泄露）
adb forward --list

# 2. 获取设备上目标应用的 PID
adb shell pidof com.app.myhook

# 3. 抓取 ILS 服务端当前所有线程堆栈（分析死锁或阻塞）
# 查找 MainImpl 进程 PID
jcmd -l | grep MainImpl
# 转储完整堆栈
jcmd <ILS_PID> Thread.dump

# 4. 验证 AVD JDWP 进程列表
adb jdwp
```

### 3. 配置建议与排障检查表

1. **环境变量**：确保 `ANDROID_HOME` 正确设置，指向包含 `platform-tools/adb` 的 Android SDK 根目录。在多设备环境下，必须在 `prepare` 命令中明确传递 `--device <serial>`。
2. **源码只读隔离准则**：执行附加调试与集成测试时，严禁污染业务工程源码树。确保测试前后 `git status --porcelain` 均为空。
3. **断开规范**：断开 DAP 连接时，客户端配置务必保持 `terminateDebuggee: false`。调试结束后，优先调用 `release` 释放代理端口与句柄资源。
