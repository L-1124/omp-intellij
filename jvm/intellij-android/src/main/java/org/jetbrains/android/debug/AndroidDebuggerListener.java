package org.jetbrains.android.debug;

import com.intellij.debugger.actions.MuteRendererUtils;
import com.intellij.debugger.engine.DebugProcess;
import com.intellij.debugger.engine.DebugProcessListener;
import com.intellij.debugger.engine.DebuggerUtils;
import com.intellij.debugger.engine.JavaDebugProcess;
import com.intellij.debugger.engine.events.DebuggerCommandImpl;
import com.intellij.debugger.impl.DebuggerManagerListener;
import com.intellij.debugger.impl.DebuggerSession;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.util.registry.Registry;
import com.intellij.openapi.util.registry.RegistryValue;
import com.intellij.xdebugger.XDebugProcess;
import com.intellij.xdebugger.XDebuggerManagerListener;
import com.intellij.xdebugger.impl.XDebugSessionImpl;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.Set;

public final class AndroidDebuggerListener implements DebuggerManagerListener, XDebuggerManagerListener {
    private static final Logger LOG = Logger.getInstance(AndroidDebuggerListener.class);
    private static final Set<DebuggerSession> ANDROID_SESSIONS =
            Collections.newSetFromMap(new IdentityHashMap<>());
    private static Boolean previousAsyncJdi;

    @Override
    public void sessionCreated(DebuggerSession session) {
        session.getProcess().addDebugProcessListener(new DebugProcessListener() {
            @Override
            public void processAttached(DebugProcess process) {
                configure(session);
            }

            @Override
            public void processDetached(DebugProcess process, boolean closedByUser) {
                release(session);
            }
        });
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

    @Override
    public void processStarted(XDebugProcess process) {
        if (process instanceof JavaDebugProcess javaProcess) {
            sessionAttached(javaProcess.getDebuggerSession());
        }
    }

    private static void configure(DebuggerSession session) {
        if (session.getProcess().isAttached()
                && DebuggerUtils.isAndroidVM(
                        session.getProcess().getVirtualMachineProxy().getVirtualMachine())) {
            acquire(session);
            // Automatic renderers leave ART child presentations incomplete; values stay available on demand.
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
                // ILS 271 object presentations stall on ART with asynchronous JDI.
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
