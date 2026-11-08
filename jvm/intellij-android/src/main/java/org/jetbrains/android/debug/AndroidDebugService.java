package org.jetbrains.android.debug;

import com.android.adblib.*;
import com.android.adblib.tools.debugging.*;
import com.intellij.openapi.Disposable;
import com.intellij.openapi.application.Application;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.util.Disposer;
import kotlin.Unit;
import kotlin.ResultKt;
import kotlin.coroutines.Continuation;
import kotlin.coroutines.EmptyCoroutineContext;
import kotlin.jvm.functions.Function2;
import kotlinx.coroutines.*;
import kotlinx.coroutines.flow.FlowCollector;
import kotlinx.coroutines.flow.MutableStateFlow;
import kotlinx.coroutines.flow.StateFlow;
import kotlinx.coroutines.flow.StateFlowKt;
import kotlinx.serialization.json.*;

import java.io.File;
import java.net.InetSocketAddress;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Predicate;

public class AndroidDebugService implements Disposable {
    private static volatile AndroidDebugService instance;
    private static final Object instanceLock = new Object();

    public static AndroidDebugService getInstance() {
        AndroidDebugService s = instance;
        if (s == null) {
            synchronized (instanceLock) {
                s = instance;
                if (s == null) {
                    s = new AndroidDebugService();
                    Application app = ApplicationManager.getApplication();
                    if (app != null) {
                        try {
                            Disposer.register(app, s);
                        } catch (Throwable ignored) {
                        }
                    }
                    instance = s;
                }
            }
        }
        return s;
    }

    public static void setInstanceForTesting(AndroidDebugService testInstance) {
        synchronized (instanceLock) {
            instance = testInstance;
        }
    }

    private final AdbSessionHost host;
    private final AndroidDebugHandles handles;
    private final ExecutorService workerExecutor;
    private final ScheduledExecutorService scheduler;
    private final AtomicBoolean disposed = new AtomicBoolean(false);

    private final Object adbLock = new Object();
    private volatile String currentAdbPath;
    private volatile AdbServerController serverController;
    private volatile AdbServerChannelProvider channelProvider;
    private volatile AdbSession parentSession;

    public AndroidDebugService() {
        this(new AdbSessionHost(), new AndroidDebugHandles());
    }

    public AndroidDebugService(AdbSessionHost host, AndroidDebugHandles handles) {
        this.host = Objects.requireNonNull(host, "host must not be null");
        this.handles = Objects.requireNonNull(handles, "handles must not be null");
        this.workerExecutor = Executors.newVirtualThreadPerTaskExecutor();
        this.scheduler = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "android-debug-service-scheduler");
            t.setDaemon(true);
            return t;
        });
    }

    public AndroidDebugHandles getHandles() {
        return handles;
    }

    public AdbSessionHost getHost() {
        return host;
    }

    public AdbSession getParentSession() {
        return parentSession;
    }

    public Path resolveAdbPath(String explicitAdbPath) {
        String exeName = System.getProperty("os.name", "").toLowerCase(Locale.ROOT).startsWith("win") ? "adb.exe" : "adb";

        if (explicitAdbPath != null) {
            if (explicitAdbPath.isBlank()) {
                throw new AndroidDebugException("invalid_params", "adbPath must not be empty or blank");
            }
            Path p = Paths.get(explicitAdbPath);
            if (!Files.isRegularFile(p)) {
                throw new AndroidDebugException("adb_not_found", "Explicit ADB path does not exist: " + explicitAdbPath);
            }
            return p;
        }

        String androidHome = System.getenv("ANDROID_HOME");
        if (androidHome != null && !androidHome.isBlank()) {
            Path p = Paths.get(androidHome, "platform-tools", exeName);
            if (Files.isRegularFile(p)) {
                return p;
            }
        }

        String sdkRoot = System.getenv("ANDROID_SDK_ROOT");
        if (sdkRoot != null && !sdkRoot.isBlank()) {
            Path p = Paths.get(sdkRoot, "platform-tools", exeName);
            if (Files.isRegularFile(p)) {
                return p;
            }
        }

        String pathEnv = System.getenv("PATH");
        if (pathEnv != null && !pathEnv.isBlank()) {
            for (String entry : pathEnv.split(PatternQuote(File.pathSeparator))) {
                if (!entry.isBlank()) {
                    Path p = Paths.get(entry, exeName);
                    if (Files.isRegularFile(p)) {
                        return p;
                    }
                }
            }
        }

        return null;
    }

    private static String PatternQuote(String s) {
        return java.util.regex.Pattern.quote(s);
    }

    public void ensureAdbSessionInitialized(String explicitAdbPath, long timeoutMs) {
        Path adbPath = resolveAdbPath(explicitAdbPath);
        String adbPathStr = adbPath != null ? adbPath.toAbsolutePath().toString() : null;

        synchronized (adbLock) {
            if (parentSession != null && !disposed.get() && Objects.equals(currentAdbPath, adbPathStr)) {
                return;
            }

            // If path changed or previous session closed, tear down old session cleanly
            if (serverController != null) {
                try {
                    serverController.close();
                } catch (Throwable ignored) {
                }
                serverController = null;
            }
            if (parentSession != null) {
                try {
                    parentSession.close();
                } catch (Throwable ignored) {
                }
                parentSession = null;
            }

            currentAdbPath = adbPathStr;
            MutableStateFlow<AdbServerConfiguration> configFlow = StateFlowKt.MutableStateFlow(
                    new AdbServerConfiguration(adbPath, 5037, false, false, Map.of())
            );
            serverController = AdbServerController.Companion.createServerController(host, configFlow);
            channelProvider = serverController.getChannelProvider();

            try {
                CompletableFuture<Void> startFuture = new CompletableFuture<>();
                BuildersKt.launch(CoroutineScopeKt.CoroutineScope(host.getIoDispatcher()), EmptyCoroutineContext.INSTANCE, CoroutineStart.DEFAULT,
                        (s, cont) -> serverController.start(new Continuation<>() {
                            @Override
                            public kotlin.coroutines.CoroutineContext getContext() {
                                return cont.getContext();
                            }

                            @Override
                            public void resumeWith(Object result) {
                                try {
                                    ResultKt.throwOnFailure(result);
                                    startFuture.complete(null);
                                } catch (Throwable t) {
                                    startFuture.completeExceptionally(t);
                                }
                                cont.resumeWith(ResultKt.createFailure(new CancellationException("Completed")));
                            }
                        }));
                startFuture.get(Math.min(timeoutMs, 15000L), TimeUnit.MILLISECONDS);
            } catch (TimeoutException e) {
                throw new AndroidDebugException("timeout", "Timed out waiting for ADB server startup", e);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new CancellationException("Interrupted starting ADB server");
            } catch (ExecutionException e) {
                Throwable cause = e.getCause() != null ? e.getCause() : e;
                if (cause instanceof CancellationException ce) {
                    throw ce;
                }
                throw new AndroidDebugException("adb_unavailable", "Failed to start ADB server: " + cause.getMessage(), cause);
            }

            parentSession = AdbSession.Companion.create(host, channelProvider, Duration.ofMillis(timeoutMs));
        }
    }

    public JsonObject prepare(String packageName,
                              Integer pid,
                              String deviceId,
                              String adbPath,
                              Integer timeoutMs) {
        if (disposed.get()) {
            throw new AndroidDebugException("cleanup_failed", "Android debug service has been disposed");
        }

        if ((packageName == null && pid == null) || (packageName != null && pid != null)) {
            throw new AndroidDebugException("invalid_params", "Must specify either packageName or pid, not both");
        }
        if (packageName != null && packageName.isBlank()) {
            throw new AndroidDebugException("invalid_params", "packageName must not be blank");
        }
        if (deviceId != null && deviceId.isBlank()) {
            throw new AndroidDebugException("invalid_params", "deviceId must not be blank");
        }
        if (pid != null && pid <= 0) {
            throw new AndroidDebugException("invalid_params", "pid must be a positive integer");
        }
        long timeout = (timeoutMs != null) ? timeoutMs : 10000L;
        if (timeout < 1 || timeout > 300000L) {
            throw new AndroidDebugException("invalid_params", "timeoutMs must be between 1 and 300000");
        }

        long deadlineNanos = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeout);

        ensureAdbSessionInitialized(adbPath, timeout);

        AdbSession childSession = AdbSession.Companion.createChildSession(parentSession, host, channelProvider, Duration.ofMillis(timeout));
        AndroidDebugHandles.TargetId reservedTargetId = null;
        boolean published = false;

        try {
            ConnectedDevice device = selectDevice(childSession, deviceId, deadlineNanos);
            JdwpProcess process = selectProcess(device, packageName, pid, deadlineNanos);

            // Phase 1: Atomic reservation BEFORE proxy creation to prevent concurrent races
            AndroidDebugHandles.TargetId targetId = new AndroidDebugHandles.TargetId(
                    ConnectedDeviceKt.getSerialNumber(device),
                    process.getPid()
            );
            if (!handles.tryReserveTarget(targetId)) {
                throw new AndroidDebugException("lease_conflict",
                        "Target " + targetId + " is already prepared or claimed by another debug session");
            }
            reservedTargetId = targetId;

            // Phase 2: JDWP proxy socket binding
            JdwpProxySocketServer proxyServer = JdwpProxySocketServerKt.getJdwpProxySocketServer(process);
            JdwpProxySocketServerStatus status = awaitProxyStatus(childSession.getScope(), proxyServer.getProxyStatusFlow(), deadlineNanos);

            if (status.getSocketAddress().isError()) {
                throw new AndroidDebugException("proxy_failed", status.getSocketAddress().getErrorMessageOrThrow());
            }
            if (!status.getSocketAddress().getHasValue()) {
                throw new AndroidDebugException("proxy_failed", "JDWP proxy did not bind to a valid socket address");
            }

            InetSocketAddress socketAddress = status.getSocketAddress().getOrThrow();
            int port = socketAddress.getPort();
            if (port <= 0 || port > 65535) {
                throw new AndroidDebugException("proxy_failed", "Invalid proxy port bound: " + port);
            }

            // Verify device and process are still active before publishing
            if (device.getDeviceInfoFlow().getValue().getDeviceState() != DeviceState.ONLINE || !CoroutineScopeKt.isActive(process.getScope())) {
                throw new AndroidDebugException("target_changed", "Target device or process exited before debug session established");
            }

            String processName = resolveProcessName(process);
            AndroidDebugHandles.DebugHandle handle = handles.recordPrepared(
                    ConnectedDeviceKt.getSerialNumber(device),
                    process.getPid(),
                    processName,
                    "127.0.0.1",
                    port,
                    childSession,
                    AndroidDebugHandles.DEFAULT_TTL_MS
            );

            // Phase 3: Attach lifecycle listeners for device disconnect and process exit
            Job processJob = JobKt.getJob(process.getScope().getCoroutineContext());
            if (processJob != null) {
                processJob.invokeOnCompletion(cause -> {
                    scheduler.execute(() -> {
                        try {
                            handles.release(handle.getCleanupKey());
                        } catch (Throwable ignored) {
                        }
                    });
                    return Unit.INSTANCE;
                });
            }
            Job deviceJob = JobKt.getJob(ConnectedDeviceKt.getScope(device).getCoroutineContext());
            if (deviceJob != null) {
                deviceJob.invokeOnCompletion(cause -> {
                    scheduler.execute(() -> {
                        try {
                            handles.release(handle.getCleanupKey());
                        } catch (Throwable ignored) {
                        }
                    });
                    return Unit.INSTANCE;
                });
            }

            published = true;
            return buildPreparedResponse(handle, timeout);
        } finally {
            if (!published) {
                if (reservedTargetId != null) {
                    handles.cancelReservation(reservedTargetId);
                }
                try {
                    childSession.close();
                } catch (Throwable ignored) {
                }
            }
        }
    }

    public JsonObject claim(String host, int port, Job ownerJob) {
        if (!isLoopbackHost(host)) {
            throw new AndroidDebugException("invalid_params", "Host must be a loopback address: " + host);
        }
        if (port < 1 || port > 65535) {
            throw new AndroidDebugException("invalid_params", "Port must be between 1 and 65535: " + port);
        }

        // Avoid AdbSession creation: claim only inspects handles in memory
        AndroidDebugHandles.ClaimResult result = handles.claim(host, port, ownerJob);
        Map<String, JsonElement> map = new LinkedHashMap<>();
        map.put("claimed", JsonElementKt.JsonPrimitive(result.claimed()));
        if (result.claimed()) {
            map.put("cleanupKey", JsonElementKt.JsonPrimitive(result.cleanupKey()));
        }
        return new JsonObject(map);
    }

    public JsonObject release(String cleanupKey) {
        if (cleanupKey == null || cleanupKey.isBlank()) {
            throw new AndroidDebugException("invalid_params", "cleanupKey must not be null or blank");
        }
        try {
            UUID.fromString(cleanupKey);
        } catch (IllegalArgumentException e) {
            throw new AndroidDebugException("invalid_params", "cleanupKey must be a valid UUID string: " + cleanupKey);
        }

        // Avoid AdbSession creation: release delegates to handles in memory
        AndroidDebugHandles.ReleaseResult result = handles.release(cleanupKey);
        Map<String, JsonElement> map = new LinkedHashMap<>();
        map.put("success", JsonElementKt.JsonPrimitive(result.success()));
        map.put("cleaned", JsonElementKt.JsonPrimitive(result.cleaned()));
        if (result.reason() != null) {
            map.put("reason", JsonElementKt.JsonPrimitive(result.reason()));
        }
        return new JsonObject(map);
    }

    private long remainingMs(long deadlineNanos) {
        long rem = TimeUnit.NANOSECONDS.toMillis(deadlineNanos - System.nanoTime());
        if (rem <= 0) {
            throw new AndroidDebugException("timeout", "Prepare operation timed out");
        }
        return rem;
    }

    private ConnectedDevice selectDevice(AdbSession childSession, String requestedDeviceId, long deadlineNanos) {
        ConnectedDevicesTracker tracker = AdbSessionKt.getConnectedDevicesTracker(childSession);
        StateFlow<ConnectedDeviceList> devicesFlow = tracker.getConnectedDevices();

        // Wait until flow is initialized
        try {
            awaitFlow(childSession.getScope(), devicesFlow, list -> !list.getFlowStatus().isStartOfFlow(), remainingMs(deadlineNanos),
                    "Timed out waiting for ADB device tracker to initialize");
        } catch (CancellationException | InterruptedException e) {
            throw new CancellationException("Request cancelled while waiting for device tracker");
        } catch (Exception e) {
            throw mapFlowException(e, "no_device", "Timed out waiting for device connection");
        }

        if (requestedDeviceId != null && !requestedDeviceId.isBlank()) {
            ConnectedDevice device = ConnectedDevicesTrackerKt.device(tracker, requestedDeviceId);
            if (device == null) {
                try {
                    awaitFlow(childSession.getScope(), devicesFlow,
                            list -> list.stream().anyMatch(d -> requestedDeviceId.equals(ConnectedDeviceKt.getSerialNumber(d))),
                            remainingMs(deadlineNanos), "Device " + requestedDeviceId + " not connected");
                } catch (CancellationException | InterruptedException e) {
                    throw new CancellationException("Request cancelled while waiting for device " + requestedDeviceId);
                } catch (Exception e) {
                    throw new AndroidDebugException("no_device", "Device " + requestedDeviceId + " not connected");
                }
                device = ConnectedDevicesTrackerKt.device(tracker, requestedDeviceId);
            }
            if (device == null) {
                throw new AndroidDebugException("no_device", "Device " + requestedDeviceId + " not found");
            }

            DeviceState state = ConnectedDeviceKt.getDeviceInfo(device).getDeviceState();
            if (state == DeviceState.ONLINE) {
                return device;
            } else if (state == DeviceState.UNAUTHORIZED) {
                throw new AndroidDebugException("unauthorized_device", "Device " + requestedDeviceId + " is unauthorized");
            } else if (state == DeviceState.OFFLINE) {
                throw new AndroidDebugException("device_offline", "Device " + requestedDeviceId + " is offline");
            } else {
                throw new AndroidDebugException("device_offline", "Device " + requestedDeviceId + " is in state " + state);
            }
        }

        // Auto-select single online device
        ConnectedDeviceList currentDevices = devicesFlow.getValue();
        List<ConnectedDevice> online = currentDevices.stream().filter(ConnectedDeviceKt::isOnline).toList();

        if (online.size() == 1) {
            return online.get(0);
        } else if (online.size() > 1) {
            List<JsonElement> candidateElements = new ArrayList<>();
            for (ConnectedDevice d : online) {
                candidateElements.add(new JsonObject(Map.of(
                        "deviceId", JsonElementKt.JsonPrimitive(ConnectedDeviceKt.getSerialNumber(d))
                )));
            }
            throw new AndroidDebugException("ambiguous_device",
                    "Multiple online devices found; please specify deviceId",
                    new JsonArray(candidateElements));
        }

        // 0 online devices: wait on flow until deadline
        try {
            awaitFlow(childSession.getScope(), devicesFlow,
                    list -> list.stream().anyMatch(ConnectedDeviceKt::isOnline),
                    remainingMs(deadlineNanos), "No online devices appeared within timeout");
        } catch (CancellationException | InterruptedException e) {
            throw new CancellationException("Request cancelled while waiting for online device");
        } catch (Exception ignored) {
        }

        currentDevices = devicesFlow.getValue();
        online = currentDevices.stream().filter(ConnectedDeviceKt::isOnline).toList();
        if (online.size() == 1) {
            return online.get(0);
        } else if (online.size() > 1) {
            List<JsonElement> candidateElements = new ArrayList<>();
            for (ConnectedDevice d : online) {
                candidateElements.add(new JsonObject(Map.of(
                        "deviceId", JsonElementKt.JsonPrimitive(ConnectedDeviceKt.getSerialNumber(d))
                )));
            }
            throw new AndroidDebugException("ambiguous_device",
                    "Multiple online devices found; please specify deviceId",
                    new JsonArray(candidateElements));
        }

        // Still 0 online: check non-ready devices
        if (currentDevices.isEmpty()) {
            throw new AndroidDebugException("no_device", "No connected Android devices found");
        } else if (currentDevices.size() == 1) {
            ConnectedDevice single = currentDevices.get(0);
            DeviceState state = ConnectedDeviceKt.getDeviceInfo(single).getDeviceState();
            if (state == DeviceState.UNAUTHORIZED) {
                throw new AndroidDebugException("unauthorized_device", "Connected device is unauthorized");
            } else if (state == DeviceState.OFFLINE) {
                throw new AndroidDebugException("device_offline", "Connected device is offline");
            }
        }
        throw new AndroidDebugException("ambiguous_device", "Multiple non-ready devices found; none online");
    }

    private JdwpProcess selectProcess(ConnectedDevice device, String packageName, Integer pid, long deadlineNanos) {
        JdwpProcessTracker tracker = JdwpProcessTrackerKt.getJdwpProcessTracker(device);
        StateFlow<JdwpProcessList> processFlow = tracker.getProcessesFlow();

        try {
            awaitFlow(ConnectedDeviceKt.getScope(device), processFlow, list -> !list.getFlowStatus().isStartOfFlow(),
                    remainingMs(deadlineNanos), "Timed out waiting for JDWP process tracker to initialize");
        } catch (CancellationException | InterruptedException e) {
            throw new CancellationException("Request cancelled waiting for process tracker initialization");
        } catch (Exception e) {
            throw mapFlowException(e, "process_not_found", "Timed out waiting for processes");
        }

        if (pid != null) {
            return selectProcessByPid(device, processFlow, pid, deadlineNanos);
        } else {
            return selectProcessByPackage(device, processFlow, packageName, deadlineNanos);
        }
    }

    private JdwpProcess selectProcessByPid(ConnectedDevice device, StateFlow<JdwpProcessList> processFlow, int targetPid, long deadlineNanos) {
        // Fast path: already present in process list
        JdwpProcess process = findProcessByPid(processFlow.getValue(), targetPid);
        if (process != null) {
            return process;
        }

        // Check AppProcessTracker for non-debuggable target
        checkNotJdwpPid(device, targetPid);

        // Reactive wait without ad-hoc loops
        CompletableFuture<JdwpProcess> processFound = new CompletableFuture<>();
        Job job = BuildersKt.launch(ConnectedDeviceKt.getScope(device), EmptyCoroutineContext.INSTANCE, CoroutineStart.DEFAULT,
                new Function2<CoroutineScope, Continuation<? super Unit>, Object>() {
                    @Override
                    public Object invoke(CoroutineScope s, Continuation<? super Unit> cont) {
                        return processFlow.collect(new FlowCollector<JdwpProcessList>() {
                            @Override
                            public Object emit(JdwpProcessList list, Continuation<? super Unit> cont2) {
                                JdwpProcess p = findProcessByPid(list, targetPid);
                                if (p != null) {
                                    processFound.complete(p);
                                }
                                return Unit.INSTANCE;
                            }
                        }, cont);
                    }
                });

        try {
            return processFound.get(remainingMs(deadlineNanos), TimeUnit.MILLISECONDS);
        } catch (TimeoutException e) {
            checkNotJdwpPid(device, targetPid);
            throw new AndroidDebugException("process_not_found", "No JDWP process found with PID " + targetPid);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new CancellationException("Request cancelled while waiting for process PID " + targetPid);
        } catch (ExecutionException e) {
            throw mapFlowException(e, "process_not_found", "Error finding process PID " + targetPid);
        } finally {
            job.cancel(null);
        }
    }

    static JdwpProcess selectPackageMatch(List<JdwpProcess> processes,
                                          java.util.function.Function<JdwpProcess, JdwpProcessProperties> propertiesOf,
                                          String targetPackage,
                                          boolean settled) {
        List<JdwpProcess> matches = new ArrayList<>();
        boolean loading = false;
        boolean unsupported = false;
        for (JdwpProcess process : processes) {
            JdwpProcessProperties props = propertiesOf.apply(process);
            if (matchesPackageName(props, targetPackage)) {
                matches.add(process);
                continue;
            }
            OptionalValue<List<String>> packages = props.getPackageNames();
            OptionalValue<String> name = props.getProcessName();
            boolean packageKnown = packages.getHasValue() && !packages.getOrThrow().isEmpty();
            boolean nameKnown = name.getHasValue() && !name.getOrThrow().isBlank();
            if (!packageKnown && !nameKnown) {
                if (packages.isError() || name.isError()) {
                    unsupported = true;
                } else {
                    loading = true;
                }
            }
        }
        if (matches.size() > 1) {
            matches.sort(Comparator.comparingInt(JdwpProcess::getPid));
            List<JsonElement> candidates = new ArrayList<>();
            for (JdwpProcess p : matches) {
                JdwpProcessProperties props = propertiesOf.apply(p);
                String name = props.getProcessName().getHasValue() ? props.getProcessName().getOrThrow()
                        : props.getPackageName().getHasValue() ? props.getPackageName().getOrThrow() : "pid:" + p.getPid();
                Map<String, JsonElement> item = new LinkedHashMap<>();
                item.put("pid", JsonElementKt.JsonPrimitive(p.getPid()));
                item.put("processName", JsonElementKt.JsonPrimitive(name));
                candidates.add(new JsonObject(item));
            }
            throw new AndroidDebugException("ambiguous_process",
                    "Multiple processes match package " + targetPackage,
                    new JsonArray(candidates));
        }
        if (matches.size() == 1 && (!loading || settled)) {
            return matches.get(0);
        }
        if (settled && matches.isEmpty() && unsupported) {
            throw new AndroidDebugException("process_not_found",
                    "Device process metadata cannot confirm package " + targetPackage + "; specify --pid explicitly");
        }
        return null;
    }

    private JdwpProcess selectProcessByPackage(ConnectedDevice device, StateFlow<JdwpProcessList> processFlow, String targetPackage, long deadlineNanos) {
        Map<JdwpProcess, Job> propertyListeners = new ConcurrentHashMap<>();
        CompletableFuture<JdwpProcess> resolved = new CompletableFuture<>();
        Runnable evaluate = () -> {
            try {
                JdwpProcess match = selectPackageMatch(processFlow.getValue(), JdwpProcessPropertiesCollectorKt::getProperties, targetPackage, false);
                if (match != null) resolved.complete(match);
            } catch (Throwable t) {
                resolved.completeExceptionally(t);
            }
        };
        Job listCollector = BuildersKt.launch(ConnectedDeviceKt.getScope(device), EmptyCoroutineContext.INSTANCE, CoroutineStart.DEFAULT,
                (s, cont) -> processFlow.collect((list, cont2) -> {
                    Set<JdwpProcess> active = new HashSet<>(list);
                    for (JdwpProcess p : list) {
                        propertyListeners.computeIfAbsent(p, proc -> BuildersKt.launch(proc.getScope(), EmptyCoroutineContext.INSTANCE, CoroutineStart.DEFAULT,
                                (ps, pcont) -> JdwpProcessPropertiesCollectorKt.getPropertiesFlow(proc).collect((props, pcont2) -> {
                                    evaluate.run();
                                    return Unit.INSTANCE;
                                }, pcont)));
                    }
                    for (JdwpProcess known : new ArrayList<>(propertyListeners.keySet())) {
                        if (!active.contains(known)) {
                            Job job = propertyListeners.remove(known);
                            if (job != null) job.cancel(null);
                        }
                    }
                    evaluate.run();
                    return Unit.INSTANCE;
                }, cont));
        try {
            evaluate.run();
            return resolved.get(remainingMs(deadlineNanos), TimeUnit.MILLISECONDS);
        } catch (TimeoutException ignored) {
            JdwpProcess match = selectPackageMatch(processFlow.getValue(), JdwpProcessPropertiesCollectorKt::getProperties, targetPackage, true);
            if (match != null) return match;
            checkNotJdwpPackage(device, targetPackage);
            throw new AndroidDebugException("process_not_found", "No debuggable process found for package " + targetPackage);
        } catch (ExecutionException e) {
            Throwable cause = e.getCause();
            if (cause instanceof RuntimeException re) throw re;
            if (cause instanceof Error err) throw err;
            throw new AndroidDebugException("process_not_found", String.valueOf(cause), cause);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new CancellationException("Request cancelled while waiting for package " + targetPackage);
        } finally {
            listCollector.cancel(null);
            for (Job job : propertyListeners.values()) job.cancel(null);
        }
    }

    private JdwpProcess findProcessByPid(List<JdwpProcess> list, int pid) {
        for (JdwpProcess p : list) {
            if (p.getPid() == pid) {
                return p;
            }
        }
        return null;
    }

    static boolean matchesPackageName(JdwpProcessProperties props, String targetPackage) {
        if (props.getPackageNames().getHasValue()) {
            List<String> pkgList = props.getPackageNames().getOrThrow();
            if (pkgList.contains(targetPackage)) {
                return true;
            }
        }
        if (props.getProcessName().getHasValue()) {
            String name = props.getProcessName().getOrThrow();
            if (name.equals(targetPackage) || name.startsWith(targetPackage + ":")) {
                return true;
            }
        }
        return false;
    }

    private void checkNotJdwpPid(ConnectedDevice device, int pid) {
        try {
            AppProcessTracker appTracker = AppProcessTrackerKt.getAppProcessTracker(device);
            List<AppProcess> appProcesses = appTracker.getAppProcessFlow().getValue();
            for (AppProcess ap : appProcesses) {
                if (ap.getPid() == pid && !AppProcessKt.getDebuggable(ap)) {
                    throw new AndroidDebugException("not_jdwp", "Process " + pid + " exists but is not debuggable (not JDWP)");
                }
            }
        } catch (AndroidDebugException e) {
            throw e;
        } catch (CancellationException ce) {
            throw ce;
        } catch (Throwable t) {
            if (t instanceof LinkageError) {
                throw (LinkageError) t;
            }
        }
    }

    private void checkNotJdwpPackage(ConnectedDevice device, String packageName) {
        try {
            AppProcessTracker appTracker = AppProcessTrackerKt.getAppProcessTracker(device);
            List<AppProcess> appProcesses = appTracker.getAppProcessFlow().getValue();
            for (AppProcess ap : appProcesses) {
                OptionalValue<String> procOpt = ap.getPropertiesFlow().getValue().getProcessName();
                String procName = procOpt.getHasValue() ? procOpt.getOrThrow() : null;
                if (procName != null && (procName.equals(packageName) || procName.startsWith(packageName + ":"))) {
                    if (!AppProcessKt.getDebuggable(ap)) {
                        throw new AndroidDebugException("not_jdwp", "Process " + packageName + " exists but is not debuggable");
                    }
                }
            }
        } catch (AndroidDebugException e) {
            throw e;
        } catch (CancellationException ce) {
            throw ce;
        } catch (Throwable t) {
            if (t instanceof LinkageError) {
                throw (LinkageError) t;
            }
        }
    }

    private String resolveProcessName(JdwpProcess process) {
        JdwpProcessProperties props = JdwpProcessPropertiesCollectorKt.getProperties(process);
        if (props.getProcessName().getHasValue()) {
            return props.getProcessName().getOrThrow();
        }
        if (props.getPackageName().getHasValue()) {
            return props.getPackageName().getOrThrow();
        }
        return "pid:" + process.getPid();
    }

    private JdwpProxySocketServerStatus awaitProxyStatus(CoroutineScope scope, StateFlow<JdwpProxySocketServerStatus> statusFlow, long deadlineNanos) {
        try {
            return awaitFlow(scope, statusFlow, status -> {
                OptionalValue<InetSocketAddress> socketAddress = status.getSocketAddress();
                return socketAddress.getHasValue() || socketAddress.isError();
            }, remainingMs(deadlineNanos), "Timed out waiting for JDWP proxy server to bind socket");
        } catch (CancellationException | InterruptedException e) {
            throw new CancellationException("Request cancelled while waiting for JDWP proxy socket");
        } catch (Exception e) {
            throw mapFlowException(e, "proxy_failed", "Timed out waiting for proxy status");
        }
    }

    private JsonObject buildPreparedResponse(AndroidDebugHandles.DebugHandle handle, long timeoutMs) {
        Map<String, JsonElement> debugObj = new LinkedHashMap<>();
        debugObj.put("action", JsonElementKt.JsonPrimitive("attach"));
        debugObj.put("adapter", JsonElementKt.JsonPrimitive("intellij"));
        debugObj.put("host", JsonElementKt.JsonPrimitive(handle.getHost()));
        debugObj.put("port", JsonElementKt.JsonPrimitive(handle.getPort()));
        debugObj.put("timeout", JsonElementKt.JsonPrimitive(Math.max(1, (int) (timeoutMs / 1000L))));

        Map<String, JsonElement> root = new LinkedHashMap<>();
        root.put("success", JsonElementKt.JsonPrimitive(true));
        root.put("cleanupKey", JsonElementKt.JsonPrimitive(handle.getCleanupKey()));
        root.put("expiresAt", JsonElementKt.JsonPrimitive(handle.getExpiresAt()));
        root.put("deviceId", JsonElementKt.JsonPrimitive(handle.getDeviceId()));
        root.put("pid", JsonElementKt.JsonPrimitive(handle.getPid()));
        root.put("processName", JsonElementKt.JsonPrimitive(handle.getProcessName()));
        root.put("host", JsonElementKt.JsonPrimitive(handle.getHost()));
        root.put("port", JsonElementKt.JsonPrimitive(handle.getPort()));
        root.put("jdwpTarget", JsonElementKt.JsonPrimitive("jdwp:" + handle.getPid()));
        root.put("debug", new JsonObject(debugObj));

        return new JsonObject(root);
    }

    public static <T> T awaitFlow(CoroutineScope scope,
                                  StateFlow<T> flow,
                                  Predicate<T> predicate,
                                  long timeoutMs,
                                  String timeoutMessage) throws Exception {
        T current = flow.getValue();
        if (predicate.test(current)) {
            return current;
        }

        CompletableFuture<T> future = new CompletableFuture<>();
        Job job = BuildersKt.launch(scope, EmptyCoroutineContext.INSTANCE, CoroutineStart.DEFAULT,
                new Function2<CoroutineScope, Continuation<? super Unit>, Object>() {
                    @Override
                    public Object invoke(CoroutineScope s, Continuation<? super Unit> cont) {
                        return flow.collect(new FlowCollector<T>() {
                            @Override
                            public Object emit(T value, Continuation<? super Unit> cont2) {
                                if (predicate.test(value)) {
                                    future.complete(value);
                                }
                                return Unit.INSTANCE;
                            }
                        }, cont);
                    }
                });

        try {
            return future.get(timeoutMs, TimeUnit.MILLISECONDS);
        } catch (TimeoutException e) {
            throw new AndroidDebugException("timeout", timeoutMessage, e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new CancellationException("Flow wait interrupted");
        } finally {
            job.cancel(null);
        }
    }

    private AndroidDebugException mapFlowException(Exception e, String defaultReason, String defaultMessage) {
        if (e instanceof AndroidDebugException ade) {
            return ade;
        }
        if (e.getCause() instanceof AndroidDebugException ade) {
            return ade;
        }
        if (e instanceof CancellationException ce) {
            throw ce;
        }
        if (e.getCause() instanceof CancellationException ce) {
            throw ce;
        }
        return new AndroidDebugException(defaultReason, defaultMessage + ": " + e.getMessage(), e);
    }

    private boolean isLoopbackHost(String host) {
        if (host == null || host.isBlank()) {
            return false;
        }
        return "127.0.0.1".equals(host) || "localhost".equalsIgnoreCase(host) || "::1".equals(host) || "0:0:0:0:0:0:0:1".equals(host);
    }


    @Override
    public void dispose() {
        if (disposed.compareAndSet(false, true)) {
            handles.closeAll();
            synchronized (adbLock) {
                if (serverController != null) {
                    try {
                        serverController.close();
                    } catch (Throwable ignored) {
                    }
                }
                if (parentSession != null) {
                    try {
                        parentSession.close();
                    } catch (Throwable ignored) {
                    }
                }
            }
            try {
                host.close();
            } catch (Throwable ignored) {
            }
            workerExecutor.shutdownNow();
            scheduler.shutdownNow();
        }
    }
}
