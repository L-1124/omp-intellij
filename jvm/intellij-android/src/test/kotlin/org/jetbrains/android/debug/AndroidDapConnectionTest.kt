package org.jetbrains.android.debug

import com.jetbrains.lsp.implementation.joinReaderThread
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.io.readString
import kotlinx.io.writeString
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.nio.charset.StandardCharsets
import java.util.UUID
import java.util.concurrent.TimeUnit

class AndroidDapConnectionTest {

    @Test
    fun testRoundTripAndFlushAndClose() = runBlocking {
        val threadName = "android-dap-test-rt-${UUID.randomUUID()}"
        withSocketPair { serverSide, clientSide ->
            val connection = AndroidDapConnection(serverSide, threadName)
            try {
                assertTrue(connection.isAlive())

                clientSide.getOutputStream().write("hello".toByteArray(StandardCharsets.UTF_8))
                clientSide.getOutputStream().flush()

                val hasBytes = withTimeout(5_000) { connection.input.awaitContent(5) }
                assertTrue(hasBytes)
                assertEquals("hello", connection.input.readBuffer.readString(5))

                connection.output.writeBuffer.writeString("world")
                connection.output.flushAndClose()

                assertFalse(connection.isAlive())
                assertTrue(connection.output.isClosedForWrite)

                val received = ByteArray(5)
                val readCount = clientSide.getInputStream().read(received)
                assertEquals(5, readCount)
                assertEquals("world", String(received, StandardCharsets.UTF_8))
                assertEquals(-1, clientSide.getInputStream().read())
            } finally {
                connection.closeAndJoin(3_000)
                awaitReaderThreadExit(threadName)
            }
        }
    }

    @Test
    fun testPeerEofClosesReaderAndExitsReaderThread() = runBlocking {
        val threadName = "android-dap-test-eof-${UUID.randomUUID()}"
        withSocketPair { serverSide, clientSide ->
            val connection = AndroidDapConnection(serverSide, threadName)
            try {
                clientSide.close()
                val hasMore = withTimeout(5_000) { connection.input.awaitContent(1) }
                assertFalse(hasMore)
                connection.closeAndJoin(3_000)
                assertFalse(connection.isAlive())
                awaitReaderThreadExit(threadName)
            } finally {
                connection.closeAndJoin(3_000)
            }
        }
    }

    @Test
    fun testCancelUnblocksReaderRecordsFirstCauseAndCloseIsIdempotent() = runBlocking {
        val threadName = "android-dap-test-cancel-${UUID.randomUUID()}"
        withSocketPair { serverSide, _ ->
            val connection = AndroidDapConnection(serverSide, threadName)
            try {
                val firstCause = IOException("first cancel cause")
                val secondCause = IOException("second cancel cause")

                connection.output.cancel(firstCause)
                connection.output.cancel(secondCause)
                connection.close()
                connection.close()

                assertSame(firstCause, connection.output.closedCause)
                assertTrue(connection.output.isClosedForWrite)
                assertTrue(connection.input.isClosedForRead)
                assertFalse(connection.isAlive())

                withTimeout(5_000) {
                    connection.input.joinReaderThread(3_000)
                }
                awaitReaderThreadExit(threadName)

                var flushError: Throwable? = null
                try {
                    connection.output.flush()
                } catch (t: Throwable) {
                    flushError = t
                }
                assertSame(firstCause, flushError)
            } finally {
                connection.closeAndJoin(3_000)
            }
        }
    }

    private suspend fun withSocketPair(block: suspend (serverSide: Socket, clientSide: Socket) -> Unit) {
        ServerSocket(0, 1, InetAddress.getByName("127.0.0.1")).use { listener ->
            listener.soTimeout = 5_000
            val client = Socket()
            client.connect(listener.localSocketAddress, 5_000)
            client.soTimeout = 5_000
            val server = listener.accept()
            server.soTimeout = 5_000
            client.use { c ->
                server.use { s ->
                    block(s, c)
                }
            }
        }
    }

    private fun awaitReaderThreadExit(threadName: String) {
        val deadlineNanos = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
        while (System.nanoTime() < deadlineNanos) {
            val stillAlive = Thread.getAllStackTraces().keys.any { it.name == threadName && it.isAlive }
            if (!stillAlive) {
                return
            }
            Thread.sleep(20)
        }
        val alive = Thread.getAllStackTraces().keys.any { it.name == threadName && it.isAlive }
        assertFalse("Reader thread $threadName should exit after connection close", alive)
    }
}
