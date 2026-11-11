package org.jetbrains.android.debug

import com.android.adblib.AdbServerChannelProvider
import com.android.adblib.AdbSession
import com.android.adblib.AdbSessionHost
import kotlinx.coroutines.CompletableJob
import kotlinx.coroutines.Job
import kotlinx.coroutines.job
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import java.io.IOException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.time.Duration
import java.util.concurrent.*
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

class AndroidDebugHandlesTest {
    private var host: AdbSessionHost? = null
    private var channelProvider: AdbServerChannelProvider? = null
    private var rootSession: AdbSession? = null
    private var scheduler: ScheduledExecutorService? = null
    private var handles: AndroidDebugHandles? = null

    @Before
    fun setUp() {
        val h = AdbSessionHost()
        host = h
        val cp = AdbServerChannelProvider.createConnectAddresses(h) {
            listOf(InetSocketAddress("127.0.0.1", 5037))
        }
        channelProvider = cp
        rootSession = AdbSession.create(h, cp, Duration.ofSeconds(5))
        val s = Executors.newScheduledThreadPool(4)
        scheduler = s
        handles = AndroidDebugHandles(s)
    }

    @After
    fun tearDown() {
        handles?.closeAll()
        rootSession?.close()
        host?.close()
        scheduler?.shutdownNow()
    }

    private fun createChildSession(): AdbSession {
        return AdbSession.createChildSession(
            rootSession!!,
            host!!,
            channelProvider!!,
            Duration.ofSeconds(5)
        )
    }

    @Test
    fun testConcurrentPrepareSameTargetOnlyOneSucceeds() {
        val threads = 8
        val executor = Executors.newFixedThreadPool(threads)
        val startLatch = CountDownLatch(1)
        val doneLatch = CountDownLatch(threads)

        val successCount = AtomicInteger(0)
        val conflictCount = AtomicInteger(0)

        for (i in 0 until threads) {
            val port = 50000 + i
            executor.submit {
                val child = createChildSession()
                try {
                    startLatch.await()
                    handles!!.recordPrepared("device-1", 1234, "com.example.app", "127.0.0.1", port, child)
                    successCount.incrementAndGet()
                } catch (e: AndroidDebugException) {
                    if (e.reason == "lease_conflict") {
                        conflictCount.incrementAndGet()
                    }
                    try {
                        child.close()
                    } catch (_: Exception) {
                    }
                } catch (_: Exception) {
                    try {
                        child.close()
                    } catch (_: Exception) {
                    }
                } finally {
                    doneLatch.countDown()
                }
            }
        }

        startLatch.countDown()
        assertTrue("Timed out waiting for concurrent threads", doneLatch.await(5, TimeUnit.SECONDS))
        executor.shutdown()

        assertEquals("Exactly one prepare should succeed", 1, successCount.get())
        assertEquals("Other prepares should fail with conflict", threads - 1, conflictCount.get())
    }

    @Test
    fun testTwoDifferentTargetsDoNotInterfere() {
        val child1 = createChildSession()
        val child2 = createChildSession()

        val h1 = handles!!.recordPrepared(
            "device-1", 1001, "com.app.one", "127.0.0.1", 50101, child1
        )
        val h2 = handles!!.recordPrepared(
            "device-2", 2002, "com.app.two", "127.0.0.1", 50102, child2
        )

        assertNotNull(h1)
        assertNotNull(h2)
        assertNotEquals(h1.cleanupKey, h2.cleanupKey)

        // Release h1
        val r1 = handles!!.release(h1.cleanupKey)
        assertTrue(r1.success)
        assertTrue(r1.cleaned)

        // Verify h1 is cleaned, but h2 is still intact and can be claimed
        val owner = Job()
        val claim2 = handles!!.claim("127.0.0.1", 50102, owner)
        assertTrue(claim2.claimed)
        assertEquals(h2.cleanupKey, claim2.cleanupKey)
    }

    @Test
    fun testClaimWithMatchingPortAndTTLTimerCancelled() {
        val child = createChildSession()
        val handle = handles!!.recordPrepared(
            "device-1", 1001, "com.app", "127.0.0.1", 50201, child, 200L
        )

        assertEquals(AndroidDebugHandles.HandleState.PREPARED, handle.state)

        val owner = Job()
        val claim = handles!!.claim("127.0.0.1", 50201, owner)
        assertTrue(claim.claimed)
        assertEquals(handle.cleanupKey, claim.cleanupKey)
        assertEquals(AndroidDebugHandles.HandleState.CLAIMED, handle.state)

        // Wait past original 200ms TTL to verify it does NOT expire
        Thread.sleep(300)
        assertEquals("Handle should remain CLAIMED past TTL", AndroidDebugHandles.HandleState.CLAIMED, handle.state)
    }

    @Test
    fun testIdempotentClaimSameOwner() {
        val child = createChildSession()
        val handle = handles!!.recordPrepared(
            "device-1", 1001, "com.app", "127.0.0.1", 50301, child
        )

        val owner = Job()
        val claim1 = handles!!.claim("127.0.0.1", 50301, owner)
        assertTrue(claim1.claimed)

        // Second claim with same owner
        val claim2 = handles!!.claim("127.0.0.1", 50301, owner)
        assertTrue(claim2.claimed)
        assertEquals(claim1.cleanupKey, claim2.cleanupKey)
    }

    @Test
    fun testClaimDifferentOwnerFailsWithLeaseConflict() {
        val child = createChildSession()
        handles!!.recordPrepared("device-1", 1001, "com.app", "127.0.0.1", 50401, child)

        val owner1 = Job()
        val owner2 = Job()

        val claim1 = handles!!.claim("127.0.0.1", 50401, owner1)
        assertTrue(claim1.claimed)

        try {
            handles!!.claim("127.0.0.1", 50401, owner2)
            fail("Expected lease_conflict for different owner")
        } catch (e: AndroidDebugException) {
            assertEquals("lease_conflict", e.reason)
        }
    }

    @Test
    fun testClaimUnknownPortReturnsNotClaimed() {
        val owner = Job()
        val result = handles!!.claim("127.0.0.1", 59999, owner)
        assertFalse(result.claimed)
        assertNull(result.cleanupKey)
    }

    @Test
    fun testClaimAlreadyCancelledOwnerCleansUpAndFails() {
        val child = createChildSession()
        handles!!.recordPrepared("device-1", 1001, "com.app", "127.0.0.1", 50451, child)

        val cancelledOwner = Job()
        cancelledOwner.cancel()

        try {
            handles!!.claim("127.0.0.1", 50451, cancelledOwner)
            fail("Expected lease_conflict when owner is already cancelled")
        } catch (e: AndroidDebugException) {
            assertEquals("lease_conflict", e.reason)
        }

        val handle = handles!!.getHandleByPort(50451)
        if (handle != null) {
            handle.closeFuture.get(2, TimeUnit.SECONDS)
        }
        val newOwner = Job()
        try {
            handles!!.claim("127.0.0.1", 50451, newOwner)
            fail("Expected lease_expired after cancelled owner cleanup")
        } catch (e: AndroidDebugException) {
            assertEquals("lease_expired", e.reason)
        }
    }

    @Test
    fun testTtlExpirationClosesHandle() {
        val child = createChildSession()
        handles!!.recordPrepared("device-1", 1001, "com.app", "127.0.0.1", 50501, child, 50L)

        Thread.sleep(150)

        val owner = Job()
        try {
            handles!!.claim("127.0.0.1", 50501, owner)
            fail("Expected lease_expired after TTL")
        } catch (e: AndroidDebugException) {
            assertEquals("lease_expired", e.reason)
        }
    }

    @Test
    fun testOwnerCancellationReleasesHandle() {
        val child = createChildSession()
        val handle = handles!!.recordPrepared(
            "device-1", 1001, "com.app", "127.0.0.1", 50601, child
        )

        val owner = Job()
        val claim = handles!!.claim("127.0.0.1", 50601, owner)
        assertTrue(claim.claimed)

        owner.cancel()

        val closed = handle.closeFuture.get(2, TimeUnit.SECONDS)
        assertTrue("Child session and handle should be closed when owner cancels", closed)
        assertEquals(AndroidDebugHandles.HandleState.CLOSED, handle.state)

        val newOwner = Job()
        try {
            handles!!.claim("127.0.0.1", 50601, newOwner)
            fail("Expected lease_expired after cancelled owner lease")
        } catch (e: AndroidDebugException) {
            assertEquals("lease_expired", e.reason)
        }
    }

    @OptIn(kotlinx.coroutines.InternalCoroutinesApi::class)
    @Test
    fun testOwnerCancellationClosesProxyBeforeSuspendedChildCompletes() {
        handles!!.closeAll()
        handles = AndroidDebugHandles()
        val owner = Job()
        val suspendedChild =
            object : kotlinx.coroutines.AbstractCoroutine<Unit>(owner, initParentJob = true, active = true) {}
        val handle = handles!!.recordPrepared(
            "device-1", 1001, "com.app", "127.0.0.1", 50551, createChildSession()
        )
        handles!!.claim("127.0.0.1", 50551, owner)

        try {
            owner.cancel()
            assertFalse("Owner must still be waiting for its suspended child", owner.isCompleted)
            assertTrue(handle.closeFuture.get(2, TimeUnit.SECONDS))
            assertEquals(AndroidDebugHandles.HandleState.CLOSED, handle.state)
            assertFalse(owner.isCompleted)
        } finally {
            suspendedChild.resumeWith(Result.success(Unit))
        }
        assertTrue(owner.isCompleted)
    }

    @Test
    fun testExplicitReleaseAlreadyCleaned() {
        val child = createChildSession()
        val handle = handles!!.recordPrepared(
            "device-1", 1001, "com.app", "127.0.0.1", 50701, child
        )

        val r1 = handles!!.release(handle.cleanupKey)
        assertTrue(r1.success)
        assertTrue(r1.cleaned)
        assertNull(r1.reason)

        val r2 = handles!!.release(handle.cleanupKey)
        assertTrue(r2.success)
        assertFalse(r2.cleaned)
        assertEquals("already_cleaned", r2.reason)

        val r3 = handles!!.release("00000000-0000-0000-0000-000000000000")
        assertTrue(r3.success)
        assertFalse(r3.cleaned)
        assertEquals("already_cleaned", r3.reason)
    }

    @Test
    fun testCloseAllDisposesAllHandles() {
        val c1 = createChildSession()
        val c2 = createChildSession()

        val h1 = handles!!.recordPrepared(
            "device-1", 1001, "com.app.1", "127.0.0.1", 50801, c1
        )
        val h2 = handles!!.recordPrepared(
            "device-2", 2002, "com.app.2", "127.0.0.1", 50802, c2
        )

        handles!!.closeAll()

        assertTrue(h1.closeFuture.get(2, TimeUnit.SECONDS))
        assertTrue(h2.closeFuture.get(2, TimeUnit.SECONDS))
        assertEquals(AndroidDebugHandles.HandleState.CLOSED, h1.state)
        assertEquals(AndroidDebugHandles.HandleState.CLOSED, h2.state)
    }

    private fun bindSocketToChild(socket: ServerSocket): AdbSession {
        val child = createChildSession()
        val job = child.scope.coroutineContext.job
        assertNotNull(job)
        job.invokeOnCompletion {
            try {
                socket.close()
            } catch (_: IOException) {
            }
        }
        return child
    }

    private fun awaitRebindable(port: Int) {
        val deadline = System.currentTimeMillis() + 5000L
        while (true) {
            try {
                ServerSocket(port, 1, InetAddress.getByName("127.0.0.1")).use { rebind ->
                    assertEquals(port, rebind.localPort)
                    return
                }
            } catch (error: IOException) {
                if (System.currentTimeMillis() >= deadline) throw error
                Thread.sleep(25L)
            }
        }
    }

    @Test
    fun testRealListeningSocketFreedAcrossAllCloseTriggers() {
        for (trigger in listOf("release", "ttl", "owner", "process", "dispose")) {
            val socket = ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))
            val port = socket.localPort
            val child = bindSocketToChild(socket)
            val handle = handles!!.recordPrepared(
                "device-1", 9000 + port, "com.real.$trigger", "127.0.0.1", port, child,
                if ("ttl" == trigger) 30L else 5000L
            )
            when (trigger) {
                "release" -> assertTrue(handles!!.release(handle.cleanupKey).cleaned)
                "ttl" -> {
                }

                "owner" -> {
                    val owner = Job()
                    assertTrue(handles!!.claim("127.0.0.1", port, owner).claimed)
                    owner.cancel()
                }

                "process" -> {
                    val processJob = Job()
                    processJob.invokeOnCompletion {
                        handles!!.release(handle.cleanupKey)
                    }
                    processJob.cancel()
                }

                "dispose" -> {
                    handles!!.closeAll()
                    handles = AndroidDebugHandles()
                }
            }
            awaitRebindable(port)
        }
    }

    @Test
    fun testControlledTimerClaimRace() {
        val iterations = 10
        val raceExec = Executors.newFixedThreadPool(4)

        for (i in 0 until iterations) {
            val child = createChildSession()
            val port = 51000 + i
            val handle = handles!!.recordPrepared(
                "device-1", 3000 + i, "com.race.test", "127.0.0.1", port, child, 20L
            )

            val raceLatch = CountDownLatch(1)
            val owner = Job()

            val claimFuture = raceExec.submit<AndroidDebugHandles.ClaimResult> {
                raceLatch.await()
                handles!!.claim("127.0.0.1", port, owner)
            }

            Thread.sleep(15)
            raceLatch.countDown()

            try {
                val cr = claimFuture.get(2, TimeUnit.SECONDS)
                assertTrue(cr.claimed)
            } catch (e: ExecutionException) {
                val cause = e.cause
                assertTrue("Expected lease_expired exception on late claim", cause is AndroidDebugException)
                assertEquals("lease_expired", (cause as AndroidDebugException).reason)
            }

            handles!!.release(handle.cleanupKey)
        }

        raceExec.shutdown()
    }

    @Test
    fun testReleaseFailureRetries() {
        val failClose = AtomicBoolean(true)
        val child = createChildSession()

        val failingChild = object : AdbSession {
            override fun close() {
                if (failClose.get()) {
                    throw IOException("Simulated child close network failure")
                }
                child.close()
            }

            override val parentSession: AdbSession? get() = child.parentSession
            override val host: AdbSessionHost get() = child.host
            override val channelFactory get() = child.channelFactory
            override val hostServices get() = child.hostServices
            override val deviceServices get() = child.deviceServices
            override val scope get() = child.scope
            override val cache get() = child.cache
            override val ioDispatcher get() = child.ioDispatcher
            override val blockingIoDispatcher get() = child.blockingIoDispatcher
            override fun throwIfClosed() = child.throwIfClosed()
        }

        val handle = handles!!.recordPrepared(
            "device-1", 7777, "com.fail.retry", "127.0.0.1", 52001, failingChild
        )

        try {
            handles!!.release(handle.cleanupKey)
            fail("Expected cleanup_failed on simulated failure")
        } catch (e: AndroidDebugException) {
            assertEquals("cleanup_failed", e.reason)
        }

        assertNotNull(handles!!.getHandle(handle.cleanupKey))
        assertNotEquals(AndroidDebugHandles.HandleState.CLOSED, handle.state)

        failClose.set(false)
        val retryResult = handles!!.release(handle.cleanupKey)
        assertTrue("Retry release must succeed", retryResult.success)
        assertTrue("Retry release must clean handle", retryResult.cleaned)

        val finalResult = handles!!.release(handle.cleanupKey)
        assertFalse(finalResult.cleaned)
        assertEquals("already_cleaned", finalResult.reason)
    }

    @Test
    fun testExpiredPortTombstonesBoundedLruAndNewLease() {
        val child = createChildSession()
        val basePort = 61000
        val h0 = handles!!.recordPrepared(
            "device-1", 1000, "com.app.base", "127.0.0.1", basePort, child
        )
        handles!!.release(h0.cleanupKey)

        val owner = Job()
        try {
            handles!!.claim("127.0.0.1", basePort, owner)
            fail("Expected lease_expired for recently released handle")
        } catch (e: AndroidDebugException) {
            assertEquals("lease_expired", e.reason)
        }

        for (i in 1..AndroidDebugHandles.MAX_EXPIRED_PORT_TOMBSTONES + 5) {
            val port = basePort + i
            val h = handles!!.recordPrepared(
                "device-1", 1000 + i, "com.app.$i", "127.0.0.1", port, child
            )
            handles!!.release(h.cleanupKey)
        }

        val claimEvicted = handles!!.claim("127.0.0.1", basePort, owner)
        assertFalse("Evicted port tombstone should return claimed: false", claimEvicted.claimed)

        val recentPort = basePort + AndroidDebugHandles.MAX_EXPIRED_PORT_TOMBSTONES + 5
        try {
            handles!!.claim("127.0.0.1", recentPort, owner)
            fail("Expected lease_expired for recently tombstoned port")
        } catch (e: AndroidDebugException) {
            assertEquals("lease_expired", e.reason)
        }

        val rePrepared = handles!!.recordPrepared(
            "device-1", 9999, "com.app.renewed", "127.0.0.1", recentPort, child
        )
        val claimNew = handles!!.claim("127.0.0.1", recentPort, owner)
        assertTrue("Newly prepared lease on tombstoned port must be claimable", claimNew.claimed)
        assertEquals(rePrepared.cleanupKey, claimNew.cleanupKey)
    }
}
