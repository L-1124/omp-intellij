package org.jetbrains.android.debug;

import com.android.adblib.AdbServerChannelProvider;
import com.android.adblib.AdbSession;
import com.android.adblib.AdbSessionHost;
import kotlinx.coroutines.CompletableJob;
import kotlinx.coroutines.Job;
import kotlinx.coroutines.JobKt;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.Assert.*;

public class AndroidDebugHandlesTest {
    private AdbSessionHost host;
    private AdbServerChannelProvider channelProvider;
    private AdbSession rootSession;
    private ScheduledExecutorService scheduler;
    private AndroidDebugHandles handles;

    @Before
    public void setUp() {
        host = new AdbSessionHost();
        channelProvider = AdbServerChannelProvider.Companion.createConnectAddresses(
                host,
                cont -> List.of(new InetSocketAddress("127.0.0.1", 5037))
        );
        rootSession = AdbSession.Companion.create(host, channelProvider, Duration.ofSeconds(5));
        scheduler = Executors.newScheduledThreadPool(4);
        handles = new AndroidDebugHandles(scheduler);
    }

    @After
    public void tearDown() throws Exception {
        if (handles != null) {
            handles.closeAll();
        }
        if (rootSession != null) {
            rootSession.close();
        }
        if (host != null) {
            host.close();
        }
        if (scheduler != null) {
            scheduler.shutdownNow();
        }
    }

    private AdbSession createChildSession() {
        return AdbSession.Companion.createChildSession(
                rootSession,
                host,
                channelProvider,
                Duration.ofSeconds(5)
        );
    }

    @Test
    public void testConcurrentPrepareSameTargetOnlyOneSucceeds() throws Exception {
        int threads = 8;
        ExecutorService executor = Executors.newFixedThreadPool(threads);
        CountDownLatch startLatch = new CountDownLatch(1);
        CountDownLatch doneLatch = new CountDownLatch(threads);

        AtomicInteger successCount = new AtomicInteger(0);
        AtomicInteger conflictCount = new AtomicInteger(0);

        for (int i = 0; i < threads; i++) {
            final int port = 50000 + i;
            executor.submit(() -> {
                AdbSession child = createChildSession();
                try {
                    startLatch.await();
                    handles.recordPrepared("device-1", 1234, "com.example.app", "127.0.0.1", port, child);
                    successCount.incrementAndGet();
                } catch (AndroidDebugException e) {
                    if ("lease_conflict".equals(e.getReason())) {
                        conflictCount.incrementAndGet();
                    }
                    try { child.close(); } catch (Exception ignored) {}
                } catch (Exception e) {
                    try { child.close(); } catch (Exception ignored) {}
                } finally {
                    doneLatch.countDown();
                }
            });
        }

        startLatch.countDown();
        assertTrue("Timed out waiting for concurrent threads", doneLatch.await(5, TimeUnit.SECONDS));
        executor.shutdown();

        assertEquals("Exactly one prepare should succeed", 1, successCount.get());
        assertEquals("Other prepares should fail with conflict", threads - 1, conflictCount.get());
    }

    @Test
    public void testTwoDifferentTargetsDoNotInterfere() {
        AdbSession child1 = createChildSession();
        AdbSession child2 = createChildSession();

        AndroidDebugHandles.DebugHandle h1 = handles.recordPrepared(
                "device-1", 1001, "com.app.one", "127.0.0.1", 50101, child1);
        AndroidDebugHandles.DebugHandle h2 = handles.recordPrepared(
                "device-2", 2002, "com.app.two", "127.0.0.1", 50102, child2);

        assertNotNull(h1);
        assertNotNull(h2);
        assertNotEquals(h1.getCleanupKey(), h2.getCleanupKey());

        // Release h1
        AndroidDebugHandles.ReleaseResult r1 = handles.release(h1.getCleanupKey());
        assertTrue(r1.success());
        assertTrue(r1.cleaned());

        // Verify h1 is cleaned, but h2 is still intact and can be claimed
        CompletableJob owner = JobKt.Job(null);
        AndroidDebugHandles.ClaimResult claim2 = handles.claim("127.0.0.1", 50102, owner);
        assertTrue(claim2.claimed());
        assertEquals(h2.getCleanupKey(), claim2.cleanupKey());
    }

    @Test
    public void testClaimWithMatchingPortAndTTLTimerCancelled() throws Exception {
        AdbSession child = createChildSession();
        AndroidDebugHandles.DebugHandle handle = handles.recordPrepared(
                "device-1", 1001, "com.app", "127.0.0.1", 50201, child, 200L);

        assertEquals(AndroidDebugHandles.HandleState.PREPARED, handle.getState());

        CompletableJob owner = JobKt.Job(null);
        AndroidDebugHandles.ClaimResult claim = handles.claim("127.0.0.1", 50201, owner);
        assertTrue(claim.claimed());
        assertEquals(handle.getCleanupKey(), claim.cleanupKey());
        assertEquals(AndroidDebugHandles.HandleState.CLAIMED, handle.getState());

        // Wait past original 200ms TTL to verify it does NOT expire
        Thread.sleep(300);
        assertEquals("Handle should remain CLAIMED past TTL", AndroidDebugHandles.HandleState.CLAIMED, handle.getState());
    }

    @Test
    public void testIdempotentClaimSameOwner() {
        AdbSession child = createChildSession();
        AndroidDebugHandles.DebugHandle handle = handles.recordPrepared(
                "device-1", 1001, "com.app", "127.0.0.1", 50301, child);

        CompletableJob owner = JobKt.Job(null);
        AndroidDebugHandles.ClaimResult claim1 = handles.claim("127.0.0.1", 50301, owner);
        assertTrue(claim1.claimed());

        // Second claim with same owner
        AndroidDebugHandles.ClaimResult claim2 = handles.claim("127.0.0.1", 50301, owner);
        assertTrue(claim2.claimed());
        assertEquals(claim1.cleanupKey(), claim2.cleanupKey());
    }

    @Test
    public void testClaimDifferentOwnerFailsWithLeaseConflict() {
        AdbSession child = createChildSession();
        handles.recordPrepared("device-1", 1001, "com.app", "127.0.0.1", 50401, child);

        CompletableJob owner1 = JobKt.Job(null);
        CompletableJob owner2 = JobKt.Job(null);

        AndroidDebugHandles.ClaimResult claim1 = handles.claim("127.0.0.1", 50401, owner1);
        assertTrue(claim1.claimed());

        try {
            handles.claim("127.0.0.1", 50401, owner2);
            fail("Expected lease_conflict for different owner");
        } catch (AndroidDebugException e) {
            assertEquals("lease_conflict", e.getReason());
        }
    }

    @Test
    public void testClaimUnknownPortReturnsNotClaimed() {
        CompletableJob owner = JobKt.Job(null);
        AndroidDebugHandles.ClaimResult result = handles.claim("127.0.0.1", 59999, owner);
        assertFalse(result.claimed());
        assertNull(result.cleanupKey());
    }

    @Test
    public void testClaimAlreadyCancelledOwnerCleansUpAndFails() throws Exception {
        AdbSession child = createChildSession();
        handles.recordPrepared("device-1", 1001, "com.app", "127.0.0.1", 50451, child);

        CompletableJob cancelledOwner = JobKt.Job(null);
        cancelledOwner.cancel(null); // Already cancelled!

        try {
            handles.claim("127.0.0.1", 50451, cancelledOwner);
            fail("Expected lease_conflict when owner is already cancelled");
        } catch (AndroidDebugException e) {
            assertEquals("lease_conflict", e.getReason());
        }

        // Subsequent claim must report lease_expired, never claimed: false
        CompletableJob newOwner = JobKt.Job(null);
        try {
            handles.claim("127.0.0.1", 50451, newOwner);
            fail("Expected lease_expired after cancelled owner cleanup");
        } catch (AndroidDebugException e) {
            assertEquals("lease_expired", e.getReason());
        }
    }

    @Test
    public void testTtlExpirationClosesHandle() throws Exception {
        AdbSession child = createChildSession();
        handles.recordPrepared("device-1", 1001, "com.app", "127.0.0.1", 50501, child, 50L);

        // Wait for TTL expiration
        Thread.sleep(150);

        CompletableJob owner = JobKt.Job(null);
        try {
            handles.claim("127.0.0.1", 50501, owner);
            fail("Expected lease_expired after TTL");
        } catch (AndroidDebugException e) {
            assertEquals("lease_expired", e.getReason());
        }
    }

    @Test
    public void testOwnerCancellationReleasesHandle() throws Exception {
        AdbSession child = createChildSession();
        AndroidDebugHandles.DebugHandle handle = handles.recordPrepared(
                "device-1", 1001, "com.app", "127.0.0.1", 50601, child);

        CompletableJob owner = JobKt.Job(null);
        AndroidDebugHandles.ClaimResult claim = handles.claim("127.0.0.1", 50601, owner);
        assertTrue(claim.claimed());

        // Owner cancels/completes (simulate LSP connection disconnect)
        owner.cancel(null);

        // Wait briefly for invokeOnCompletion callback
        Boolean closed = handle.getCloseFuture().get(2, TimeUnit.SECONDS);
        assertTrue("Child session and handle should be closed when owner cancels", closed);
        assertEquals(AndroidDebugHandles.HandleState.CLOSED, handle.getState());
    }

    @Test
    public void testOwnerCancellationClosesProxyBeforeSuspendedChildCompletes() throws Exception {
        handles.closeAll();
        handles = new AndroidDebugHandles();
        CompletableJob owner = JobKt.Job(null);
        kotlinx.coroutines.AbstractCoroutine<kotlin.Unit> suspendedChild =
                new kotlinx.coroutines.AbstractCoroutine<>(owner, true, true) {};
        AndroidDebugHandles.DebugHandle handle = handles.recordPrepared(
                "device-1", 1001, "com.app", "127.0.0.1", 50551, createChildSession());
        handles.claim("127.0.0.1", 50551, owner);

        try {
            owner.cancel(null);
            assertFalse("Owner must still be waiting for its suspended child", owner.isCompleted());
            assertTrue(handle.getCloseFuture().get(2, TimeUnit.SECONDS));
            assertEquals(AndroidDebugHandles.HandleState.CLOSED, handle.getState());
            assertFalse(owner.isCompleted());
        } finally {
            suspendedChild.resumeWith(kotlin.Unit.INSTANCE);
        }
        assertTrue(owner.isCompleted());
    }

    @Test
    public void testExplicitReleaseAlreadyCleaned() {
        AdbSession child = createChildSession();
        AndroidDebugHandles.DebugHandle handle = handles.recordPrepared(
                "device-1", 1001, "com.app", "127.0.0.1", 50701, child);

        AndroidDebugHandles.ReleaseResult r1 = handles.release(handle.getCleanupKey());
        assertTrue(r1.success());
        assertTrue(r1.cleaned());
        assertNull(r1.reason());

        // Subsequent release for same key
        AndroidDebugHandles.ReleaseResult r2 = handles.release(handle.getCleanupKey());
        assertTrue(r2.success());
        assertFalse(r2.cleaned());
        assertEquals("already_cleaned", r2.reason());

        // Unknown key
        AndroidDebugHandles.ReleaseResult r3 = handles.release("00000000-0000-0000-0000-000000000000");
        assertTrue(r3.success());
        assertFalse(r3.cleaned());
        assertEquals("already_cleaned", r3.reason());
    }

    @Test
    public void testCloseAllDisposesAllHandles() throws Exception {
        AdbSession c1 = createChildSession();
        AdbSession c2 = createChildSession();

        AndroidDebugHandles.DebugHandle h1 = handles.recordPrepared(
                "device-1", 1001, "com.app.1", "127.0.0.1", 50801, c1);
        AndroidDebugHandles.DebugHandle h2 = handles.recordPrepared(
                "device-2", 2002, "com.app.2", "127.0.0.1", 50802, c2);

        handles.closeAll();

        assertTrue(h1.getCloseFuture().get(2, TimeUnit.SECONDS));
        assertTrue(h2.getCloseFuture().get(2, TimeUnit.SECONDS));
        assertEquals(AndroidDebugHandles.HandleState.CLOSED, h1.getState());
        assertEquals(AndroidDebugHandles.HandleState.CLOSED, h2.getState());
    }

    private AdbSession bindSocketToChild(ServerSocket socket) {
        AdbSession child = createChildSession();
        Job job = JobKt.getJob(child.getScope().getCoroutineContext());
        assertNotNull(job);
        job.invokeOnCompletion(cause -> {
            try { socket.close(); } catch (IOException ignored) {}
            return kotlin.Unit.INSTANCE;
        });
        return child;
    }

    private static void awaitRebindable(int port) throws Exception {
        long deadline = System.currentTimeMillis() + 5000L;
        while (true) {
            try (ServerSocket rebind = new ServerSocket(port, 1, java.net.InetAddress.getByName("127.0.0.1"))) {
                assertEquals(port, rebind.getLocalPort());
                return;
            } catch (IOException error) {
                if (System.currentTimeMillis() >= deadline) throw error;
                Thread.sleep(25L);
            }
        }
    }

    @Test
    public void testRealListeningSocketFreedAcrossAllCloseTriggers() throws Exception {
        for (String trigger : java.util.List.of("release", "ttl", "owner", "process", "dispose")) {
            ServerSocket socket = new ServerSocket(0, 1, java.net.InetAddress.getByName("127.0.0.1"));
            int port = socket.getLocalPort();
            AdbSession child = bindSocketToChild(socket);
            AndroidDebugHandles.DebugHandle handle = handles.recordPrepared(
                    "device-1", 9000 + port, "com.real." + trigger, "127.0.0.1", port, child,
                    "ttl".equals(trigger) ? 30L : 5000L);
            switch (trigger) {
                case "release" -> assertTrue(handles.release(handle.getCleanupKey()).cleaned());
                case "ttl" -> {}
                case "owner" -> {
                    CompletableJob owner = JobKt.Job(null);
                    assertTrue(handles.claim("127.0.0.1", port, owner).claimed());
                    owner.cancel(null);
                }
                case "process" -> {
                    CompletableJob processJob = JobKt.Job(null);
                    processJob.invokeOnCompletion(cause -> {
                        handles.release(handle.getCleanupKey());
                        return kotlin.Unit.INSTANCE;
                    });
                    processJob.cancel(null);
                }
                case "dispose" -> {
                    handles.closeAll();
                    handles = new AndroidDebugHandles();
                }
            }
            awaitRebindable(port);
        }
    }

    @Test
    public void testControlledTimerClaimRace() throws Exception {
        int iterations = 10;
        ExecutorService raceExec = Executors.newFixedThreadPool(4);

        for (int i = 0; i < iterations; i++) {
            AdbSession child = createChildSession();
            int port = 51000 + i;
            AndroidDebugHandles.DebugHandle handle = handles.recordPrepared(
                    "device-1", 3000 + i, "com.race.test", "127.0.0.1", port, child, 20L);

            CountDownLatch raceLatch = new CountDownLatch(1);
            CompletableJob owner = JobKt.Job(null);

            Future<AndroidDebugHandles.ClaimResult> claimFuture = raceExec.submit(() -> {
                raceLatch.await();
                return handles.claim("127.0.0.1", port, owner);
            });

            Thread.sleep(15); // Stride near expiration boundary
            raceLatch.countDown();

            try {
                AndroidDebugHandles.ClaimResult cr = claimFuture.get(2, TimeUnit.SECONDS);
                assertTrue(cr.claimed()); // Claimed before expiration
            } catch (ExecutionException e) {
                // Must be lease_expired, NEVER claimed: false!
                Throwable cause = e.getCause();
                assertTrue("Expected lease_expired exception on late claim", cause instanceof AndroidDebugException);
                assertEquals("lease_expired", ((AndroidDebugException) cause).getReason());
            }

            handles.release(handle.getCleanupKey());
        }

        raceExec.shutdown();
    }

    @Test
    public void testReleaseFailureRetries() throws Exception {
        AtomicBoolean failClose = new AtomicBoolean(true);
        AdbSession child = createChildSession();

        // Custom child session close that fails on first attempt
        AdbSession failingChild = new AdbSession() {
            @Override
            public void close() throws Exception {
                if (failClose.get()) {
                    throw new IOException("Simulated child close network failure");
                }
                child.close();
            }

            @Override public AdbSession getParentSession() { return child.getParentSession(); }
            @Override public AdbSessionHost getHost() { return child.getHost(); }
            @Override public com.android.adblib.AdbChannelFactory getChannelFactory() { return child.getChannelFactory(); }
            @Override public com.android.adblib.AdbHostServices getHostServices() { return child.getHostServices(); }
            @Override public com.android.adblib.AdbDeviceServices getDeviceServices() { return child.getDeviceServices(); }
            @Override public kotlinx.coroutines.CoroutineScope getScope() { return child.getScope(); }
            @Override public com.android.adblib.CoroutineScopeCache getCache() { return child.getCache(); }
            @Override public kotlinx.coroutines.CoroutineDispatcher getIoDispatcher() { return child.getIoDispatcher(); }
            @Override public kotlinx.coroutines.CoroutineDispatcher getBlockingIoDispatcher() { return child.getBlockingIoDispatcher(); }
            @Override public void throwIfClosed() { child.throwIfClosed(); }
        };

        AndroidDebugHandles.DebugHandle handle = handles.recordPrepared(
                "device-1", 7777, "com.fail.retry", "127.0.0.1", 52001, failingChild);

        // First release fails
        try {
            handles.release(handle.getCleanupKey());
            fail("Expected cleanup_failed on simulated failure");
        } catch (AndroidDebugException e) {
            assertEquals("cleanup_failed", e.getReason());
        }

        // Verify handle was NOT removed or marked CLOSED
        assertNotNull(handles.getHandle(handle.getCleanupKey()));
        assertNotEquals(AndroidDebugHandles.HandleState.CLOSED, handle.getState());

        // Allow close to succeed and retry
        failClose.set(false);
        AndroidDebugHandles.ReleaseResult retryResult = handles.release(handle.getCleanupKey());
        assertTrue("Retry release must succeed", retryResult.success());
        assertTrue("Retry release must clean handle", retryResult.cleaned());

        // Subsequent release must report already_cleaned
        AndroidDebugHandles.ReleaseResult finalResult = handles.release(handle.getCleanupKey());
        assertFalse(finalResult.cleaned());
        assertEquals("already_cleaned", finalResult.reason());
    }
}
