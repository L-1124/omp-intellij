package org.jetbrains.android.debug

import com.jetbrains.lsp.implementation.ByteReader
import com.jetbrains.lsp.implementation.ByteWriter
import com.jetbrains.lsp.implementation.LspConnection
import com.jetbrains.lsp.implementation.inputStreamByteReader
import com.jetbrains.lsp.implementation.joinReaderThread
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import kotlinx.io.Sink
import kotlinx.io.asSink
import kotlinx.io.buffered
import java.io.IOException
import java.net.Socket
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

class AndroidDapConnection(
    private val socket: Socket,
    readerThreadName: String = DEFAULT_READER_THREAD_NAME
) : LspConnection {

    override val input: ByteReader = inputStreamByteReader(socket.getInputStream(), readerThreadName)

    private val closed = AtomicBoolean(false)
    private val closedCauseRef = AtomicReference<Throwable?>(null)

    override val output: ByteWriter = object : ByteWriter {
        override val isClosedForWrite: Boolean
            get() = closed.get() || socket.isClosed || socket.isOutputShutdown

        override val closedCause: Throwable?
            get() = closedCauseRef.get()

        override val writeBuffer: Sink = socket.getOutputStream().asSink().buffered()

        override suspend fun flush() {
            if (closed.get()) {
                throw closedCauseRef.get() ?: IOException("DAP connection is closed")
            }
            withContext(Dispatchers.IO) {
                try {
                    writeBuffer.flush()
                } catch (t: Throwable) {
                    if (t !is CancellationException) {
                        recordClosedCause(t)
                        closeInternal(t)
                    }
                    throw t
                }
            }
        }

        override suspend fun flushAndClose() {
            try {
                if (!closed.get()) {
                    withContext(NonCancellable + Dispatchers.IO) {
                        try {
                            writeBuffer.flush()
                        } catch (t: Throwable) {
                            recordClosedCause(t)
                            throw t
                        }
                    }
                }
            } finally {
                close()
            }
        }

        override fun cancel(cause: Throwable?) {
            recordClosedCause(cause)
            closeInternal(cause)
        }
    }

    override fun isAlive(): Boolean =
        !closed.get() && !socket.isClosed && !input.isClosedForRead && !output.isClosedForWrite

    override fun close() {
        closeInternal(null)
    }

    suspend fun closeAndJoin(timeoutMillis: Long = DEFAULT_READER_JOIN_TIMEOUT_MS) {
        withContext(NonCancellable) {
            close()
            input.joinReaderThread(timeoutMillis)
        }
    }

    private fun recordClosedCause(cause: Throwable?) {
        if (cause != null) {
            closedCauseRef.compareAndSet(null, cause)
        }
    }

    private fun closeInternal(cause: Throwable?) {
        recordClosedCause(cause)
        if (closed.compareAndSet(false, true)) {
            try {
                socket.close()
            } catch (t: Throwable) {
                recordClosedCause(t)
            }
            input.cancel(closedCauseRef.get())
        }
    }

    companion object {
        const val DEFAULT_READER_THREAD_NAME = "android-dap-reader"
        const val DEFAULT_READER_JOIN_TIMEOUT_MS = 3_000L
    }
}
