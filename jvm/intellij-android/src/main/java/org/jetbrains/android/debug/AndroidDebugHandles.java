package org.jetbrains.android.debug;

import com.android.adblib.AdbSession;
import kotlin.Unit;
import kotlinx.coroutines.CoroutineScope;
import kotlinx.coroutines.DisposableHandle;
import kotlinx.coroutines.Job;
import kotlinx.coroutines.JobKt;

import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;

public class AndroidDebugHandles {
    public static final long DEFAULT_TTL_MS = 300_000L; // 5 minutes

    public enum HandleState {
        PREPARED,
        CLAIMED,
        CLOSING,
        CLOSED
    }

    public record TargetId(String deviceId, int pid) {
        public TargetId {
            Objects.requireNonNull(deviceId, "deviceId must not be null");
        }
    }

    public static final class DebugHandle {
        private final String cleanupKey;
        private final long expiresAt;
        private final String deviceId;
        private final int pid;
        private final String processName;
        private final String host;
        private final int port;
        private final AdbSession childSession;
        private final TargetId targetId;

        private volatile HandleState state = HandleState.PREPARED;
        private volatile ScheduledFuture<?> expirationFuture;
        private volatile Job ownerJob;
        private volatile DisposableHandle ownerDisposableHandle;
        private volatile Throwable lastCloseError;
        private volatile boolean closingStarted;
        private volatile CompletableFuture<Boolean> closeFuture = new CompletableFuture<>();

        public DebugHandle(String cleanupKey,
                           long expiresAt,
                           String deviceId,
                           int pid,
                           String processName,
                           String host,
                           int port,
                           AdbSession childSession) {
            this.cleanupKey = cleanupKey;
            this.expiresAt = expiresAt;
            this.deviceId = deviceId;
            this.pid = pid;
            this.processName = processName;
            this.host = host;
            this.port = port;
            this.childSession = childSession;
            this.targetId = new TargetId(deviceId, pid);
        }

        public String getCleanupKey() {
            return cleanupKey;
        }

        public long getExpiresAt() {
            return expiresAt;
        }

        public String getDeviceId() {
            return deviceId;
        }

        public int getPid() {
            return pid;
        }

        public String getProcessName() {
            return processName;
        }

        public String getHost() {
            return host;
        }

        public int getPort() {
            return port;
        }

        public AdbSession getChildSession() {
            return childSession;
        }

        public TargetId getTargetId() {
            return targetId;
        }

        public HandleState getState() {
            return state;
        }

        public Job getOwnerJob() {
            return ownerJob;
        }

        public CompletableFuture<Boolean> getCloseFuture() {
            return closeFuture;
        }

        public Throwable getLastCloseError() {
            return lastCloseError;
        }
    }

    public record ClaimResult(boolean claimed, String cleanupKey) {
        public static ClaimResult notClaimed() {
            return new ClaimResult(false, null);
        }

        public static ClaimResult claimed(String cleanupKey) {
            return new ClaimResult(true, cleanupKey);
        }
    }

    public record ReleaseResult(boolean success, boolean cleaned, String reason) {
        public static ReleaseResult successCleaned() {
            return new ReleaseResult(true, true, null);
        }

        public static ReleaseResult successAlreadyCleaned() {
            return new ReleaseResult(true, false, "already_cleaned");
        }
    }

    private final Object lock = new Object();
    private final Map<String, DebugHandle> handlesByKey = new HashMap<>();
    private final Map<Integer, DebugHandle> handlesByPort = new HashMap<>();
    private final Map<TargetId, Object> activeTargets = new HashMap<>(); // Holds DebugHandle or RESERVATION_PLACEHOLDER
    private final Map<Integer, Long> expiredPortTombstones = new HashMap<>();
    private final ScheduledExecutorService scheduler;
    private final boolean ownsScheduler;

    private static final Object RESERVATION_PLACEHOLDER = new Object();

    public AndroidDebugHandles() {
        this(Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "android-debug-handles-ttl");
            t.setDaemon(true);
            return t;
        }), true);
    }

    public AndroidDebugHandles(ScheduledExecutorService scheduler) {
        this(scheduler, false);
    }

    private AndroidDebugHandles(ScheduledExecutorService scheduler, boolean ownsScheduler) {
        this.scheduler = Objects.requireNonNull(scheduler, "scheduler must not be null");
        this.ownsScheduler = ownsScheduler;
    }

    public boolean tryReserveTarget(TargetId targetId) {
        synchronized (lock) {
            if (activeTargets.containsKey(targetId)) {
                return false;
            }
            activeTargets.put(targetId, RESERVATION_PLACEHOLDER);
            return true;
        }
    }

    public void cancelReservation(TargetId targetId) {
        synchronized (lock) {
            Object current = activeTargets.get(targetId);
            if (current == RESERVATION_PLACEHOLDER) {
                activeTargets.remove(targetId);
            }
        }
    }

    public DebugHandle recordPrepared(String deviceId,
                                      int pid,
                                      String processName,
                                      String host,
                                      int port,
                                      AdbSession childSession) {
        return recordPrepared(deviceId, pid, processName, host, port, childSession, DEFAULT_TTL_MS);
    }

    public DebugHandle recordPrepared(String deviceId,
                                      int pid,
                                      String processName,
                                      String host,
                                      int port,
                                      AdbSession childSession,
                                      long ttlMs) {
        TargetId targetId = new TargetId(deviceId, pid);
        String cleanupKey = UUID.randomUUID().toString();
        long expiresAt = System.currentTimeMillis() + ttlMs;

        DebugHandle handle;
        synchronized (lock) {
            Object existing = activeTargets.get(targetId);
            if (existing != null && existing != RESERVATION_PLACEHOLDER) {
                throw new AndroidDebugException("lease_conflict",
                        "Target " + targetId + " is already prepared or claimed by an active debug session");
            }
            if (handlesByPort.containsKey(port)) {
                throw new AndroidDebugException("lease_conflict",
                        "Port " + port + " is already allocated to an active debug handle");
            }

            handle = new DebugHandle(cleanupKey, expiresAt, deviceId, pid, processName, host, port, childSession);
            ScheduledFuture<?> future = scheduler.schedule(() -> handleExpired(cleanupKey), ttlMs, TimeUnit.MILLISECONDS);
            handle.expirationFuture = future;

            handlesByKey.put(cleanupKey, handle);
            handlesByPort.put(port, handle);
            activeTargets.put(targetId, handle);
            expiredPortTombstones.remove(port);
        }
        return handle;
    }

    private CompletableFuture<Boolean> beginCloseLocked(DebugHandle handle) {
        handle.state = HandleState.CLOSING;
        if (handle.expirationFuture != null) {
            handle.expirationFuture.cancel(false);
            handle.expirationFuture = null;
        }
        if (handle.ownerDisposableHandle != null) {
            try {
                handle.ownerDisposableHandle.dispose();
            } catch (Throwable ignored) {
            }
            handle.ownerDisposableHandle = null;
        }
        if (!handle.closingStarted || handle.closeFuture.isCompletedExceptionally()) {
            CompletableFuture<Boolean> attempt = handle.closeFuture.isCompletedExceptionally()
                    ? new CompletableFuture<>()
                    : handle.closeFuture;
            handle.closeFuture = attempt;
            handle.closingStarted = true;
            scheduler.execute(() -> doClose(handle, attempt));
        }
        return handle.closeFuture;
    }

    private void handleExpired(String cleanupKey) {
        synchronized (lock) {
            DebugHandle handle = handlesByKey.get(cleanupKey);
            if (handle == null || handle.state != HandleState.PREPARED) {
                return;
            }
            expiredPortTombstones.put(handle.port, System.currentTimeMillis());
            beginCloseLocked(handle);
        }
    }

    public ClaimResult claim(String host, int port, Job ownerJob) {
        synchronized (lock) {
            DebugHandle handle = handlesByPort.get(port);
            if (handle == null) {
                if (expiredPortTombstones.containsKey(port)) {
                    throw new AndroidDebugException("lease_expired", "Debug handle has already expired or closed");
                }
                return ClaimResult.notClaimed();
            }

            if (handle.state == HandleState.CLOSED || handle.state == HandleState.CLOSING) {
                throw new AndroidDebugException("lease_expired", "Debug handle has already expired or is closing");
            }

            if (handle.state == HandleState.PREPARED && System.currentTimeMillis() >= handle.expiresAt) {
                expiredPortTombstones.put(port, System.currentTimeMillis());
                beginCloseLocked(handle);
                throw new AndroidDebugException("lease_expired", "Debug handle has expired");
            }

            if (handle.state == HandleState.CLAIMED) {
                if (Objects.equals(handle.ownerJob, ownerJob)) {
                    return ClaimResult.claimed(handle.cleanupKey);
                }
                throw new AndroidDebugException("lease_conflict",
                        "Debug handle on port " + port + " is already claimed by another connection");
            }

            if (handle.state == HandleState.PREPARED) {
                if (ownerJob != null && (ownerJob.isCompleted() || ownerJob.isCancelled())) {
                    beginCloseLocked(handle);
                    throw new AndroidDebugException("lease_conflict", "Owner connection scope is already cancelled or closed");
                }

                // Valid claim
                if (handle.expirationFuture != null) {
                    handle.expirationFuture.cancel(false);
                    handle.expirationFuture = null;
                }
                handle.state = HandleState.CLAIMED;
                handle.ownerJob = ownerJob;

                if (ownerJob != null) {
                    // Completion can wait for debugger children that need this proxy to close first.
                    handle.ownerDisposableHandle = ownerJob.invokeOnCompletion(true, true, cause -> {
                        synchronized (lock) {
                            if (handle.state != HandleState.CLOSED) beginCloseLocked(handle);
                        }
                        return Unit.INSTANCE;
                    });
                }
                return ClaimResult.claimed(handle.cleanupKey);
            }

            // Any other state throws lease_expired
            throw new AndroidDebugException("lease_expired", "Debug handle is in state " + handle.state);
        }
    }

    public ReleaseResult release(String cleanupKey) {
        DebugHandle handle;
        CompletableFuture<Boolean> closeFutureToWait;
        synchronized (lock) {
            handle = handlesByKey.get(cleanupKey);
            if (handle == null || handle.state == HandleState.CLOSED) {
                return ReleaseResult.successAlreadyCleaned();
            }
            closeFutureToWait = beginCloseLocked(handle);
        }

        try {
            closeFutureToWait.get(10, TimeUnit.SECONDS);
            return ReleaseResult.successCleaned();
        } catch (TimeoutException e) {
            throw new AndroidDebugException("cleanup_failed", "Timed out waiting for debug handle cleanup", e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new AndroidDebugException("cleanup_failed", "Interrupted waiting for debug handle cleanup", e);
        } catch (ExecutionException e) {
            Throwable cause = e.getCause() == null ? e : e.getCause();
            throw new AndroidDebugException("cleanup_failed", "Error during debug handle cleanup: " + cause.getMessage(), cause);
        }
    }

    private void doClose(DebugHandle handle, CompletableFuture<Boolean> attempt) {
        try {
            closeAttachedDebugSession(handle.getPort());

            if (handle.childSession != null) {
                handle.childSession.close();
                CoroutineScope scope = handle.childSession.getScope();
                if (scope != null) {
                    Job job = JobKt.getJob(scope.getCoroutineContext());
                    if (job != null && !job.isCompleted()) {
                        CompletableFuture<Void> jobDone = new CompletableFuture<>();
                        DisposableHandle registration = job.invokeOnCompletion(cause -> {
                            jobDone.complete(null);
                            return Unit.INSTANCE;
                        });
                        try {
                            jobDone.get(1, TimeUnit.SECONDS);
                        } finally {
                            registration.dispose();
                        }
                    }
                }
            }
            synchronized (lock) {
                handle.lastCloseError = null;
            }
        } catch (Throwable t) {
            if (t instanceof InterruptedException) Thread.currentThread().interrupt();
            synchronized (lock) {
                handle.lastCloseError = t;
            }
            attempt.completeExceptionally(t);
            return;
        }
        synchronized (lock) {
            handle.state = HandleState.CLOSED;
            handlesByKey.remove(handle.cleanupKey, handle);
            handlesByPort.remove(handle.port, handle);
            activeTargets.remove(handle.targetId, handle);
        }
        attempt.complete(true);
    }

    private void closeAttachedDebugSession(int port) {
        try {
            com.intellij.openapi.application.Application app = com.intellij.openapi.application.ApplicationManager.getApplication();
            if (app == null) return;
            com.intellij.openapi.project.ProjectManager pm = com.intellij.openapi.project.ProjectManager.getInstance();
            if (pm == null) return;
            String portStr = String.valueOf(port);
            for (com.intellij.openapi.project.Project project : pm.getOpenProjects()) {
                com.intellij.xdebugger.XDebuggerManager xdm = com.intellij.xdebugger.XDebuggerManager.getInstance(project);
                if (xdm == null) continue;
                for (com.intellij.xdebugger.XDebugSession session : xdm.getDebugSessions()) {
                    com.intellij.xdebugger.XDebugProcess xProcess = session.getDebugProcess();
                    if (xProcess instanceof com.intellij.debugger.engine.JavaDebugProcess javaProcess) {
                        com.intellij.debugger.engine.DebugProcessImpl debugProcess = javaProcess.getDebuggerSession().getProcess();
                        com.intellij.execution.configurations.RemoteConnection conn = debugProcess.getConnection();
                        if (conn != null && portStr.equals(conn.getApplicationAddress())) {
                            debugProcess.getManagerThread().schedule(new com.intellij.debugger.engine.events.DebuggerCommandImpl(com.intellij.debugger.impl.PrioritizedTask.Priority.HIGH) {
                                @Override
                                protected void action() {
                                    debugProcess.stop(false);
                                }
                            });
                        }
                    }
                }
            }
        } catch (Throwable ignored) {
        }
    }

    public void closeAll() {
        List<CompletableFuture<Boolean>> toClose = new ArrayList<>();
        synchronized (lock) {
            for (DebugHandle handle : handlesByKey.values()) {
                if (handle.state != HandleState.CLOSED) {
                    toClose.add(beginCloseLocked(handle));
                }
            }
        }

        for (CompletableFuture<Boolean> attempt : toClose) {
            try {
                attempt.get(10, TimeUnit.SECONDS);
            } catch (Throwable ignored) {
            }
        }

        synchronized (lock) {
            handlesByKey.clear();
            handlesByPort.clear();
            activeTargets.clear();
            expiredPortTombstones.clear();
        }

        if (ownsScheduler) {
            scheduler.shutdownNow();
        }
    }

    public DebugHandle getHandle(String cleanupKey) {
        synchronized (lock) {
            return handlesByKey.get(cleanupKey);
        }
    }

    public DebugHandle getHandleByPort(int port) {
        synchronized (lock) {
            return handlesByPort.get(port);
        }
    }

    public boolean isTargetReserved(TargetId targetId) {
        synchronized (lock) {
            return activeTargets.containsKey(targetId);
        }
    }
}
