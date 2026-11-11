package org.jetbrains.android.debug

import com.intellij.debugger.actions.MuteRendererUtils
import com.intellij.debugger.engine.DebugProcess
import com.intellij.debugger.engine.DebugProcessListener
import com.intellij.debugger.engine.DebuggerUtils
import com.intellij.debugger.engine.JavaDebugProcess
import com.intellij.debugger.engine.events.DebuggerCommandImpl
import com.intellij.debugger.impl.DebuggerManagerListener
import com.intellij.debugger.impl.DebuggerSession
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.util.registry.Registry
import com.intellij.xdebugger.XDebugProcess
import com.intellij.xdebugger.XDebuggerManagerListener
import com.intellij.xdebugger.impl.XDebugSessionImpl
import java.util.Collections
import java.util.IdentityHashMap

class AndroidDebuggerListener : DebuggerManagerListener, XDebuggerManagerListener {

    override fun sessionCreated(session: DebuggerSession) {
        session.process?.addDebugProcessListener(object : DebugProcessListener {
            override fun processAttached(process: DebugProcess) {
                configure(session)
            }

            override fun processDetached(process: DebugProcess, closedByUser: Boolean) {
                release(session)
            }
        })
    }

    override fun sessionAttached(session: DebuggerSession) {
        session.process?.managerThread?.schedule(object : DebuggerCommandImpl() {
            override fun action() {
                configure(session)
            }
        })
    }

    override fun processStarted(process: XDebugProcess) {
        if (process is JavaDebugProcess) {
            process.debuggerSession?.let { sessionAttached(it) }
        }
    }

    override fun sessionDetached(session: DebuggerSession) {
        release(session)
    }

    override fun sessionRemoved(session: DebuggerSession) {
        release(session)
    }

    private companion object {
        private val LOG = Logger.getInstance(AndroidDebuggerListener::class.java)
        private val ANDROID_SESSIONS: MutableSet<DebuggerSession> =
            Collections.newSetFromMap(IdentityHashMap())
        private var previousAsyncJdi: Boolean? = null

        private fun configure(session: DebuggerSession) {
            val process = session.process ?: return
            val vmProxy = process.virtualMachineProxy ?: return
            if (process.isAttached && DebuggerUtils.isAndroidVM(vmProxy.virtualMachine)) {
                acquire(session)
                // Automatic renderers leave ART child presentations incomplete; values stay available on demand.
                val javaProcess = process.xdebugProcess
                if (javaProcess != null) {
                    val xSession = javaProcess.session
                    if (xSession is XDebugSessionImpl) {
                        val data = xSession.sessionData
                        if (!MuteRendererUtils.isMuted(data)) {
                            MuteRendererUtils.getOrCreateFlow(data).value = true
                            LOG.info("Muted renderers for Android debugger session")
                        }
                    }
                }
            }
        }

        private fun acquire(session: DebuggerSession) {
            synchronized(ANDROID_SESSIONS) {
                val process = session.process ?: return
                if (!process.isAttached || session in ANDROID_SESSIONS) return
                if (ANDROID_SESSIONS.isEmpty()) {
                    val asyncJdi = Registry.get("debugger.async.jdi")
                    previousAsyncJdi = asyncJdi.asBoolean()
                    // ILS 271 object presentations stall on ART with asynchronous JDI.
                    asyncJdi.setValue(false)
                    LOG.info("Using synchronous JDI while Android debugger sessions are attached")
                }
                ANDROID_SESSIONS.add(session)
            }
        }

        private fun release(session: DebuggerSession) {
            synchronized(ANDROID_SESSIONS) {
                if (!ANDROID_SESSIONS.remove(session) || ANDROID_SESSIONS.isNotEmpty()) return
                val prev = previousAsyncJdi
                if (prev != null) {
                    Registry.get("debugger.async.jdi").setValue(prev)
                    previousAsyncJdi = null
                }
                LOG.info("Restored JDI mode after the last Android debugger session ended")
            }
        }
    }
}
