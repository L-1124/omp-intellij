package org.jetbrains.android.debug

import com.jetbrains.dap.protocol.BreakpointEventArguments
import com.jetbrains.dap.protocol.Capabilities
import com.jetbrains.dap.protocol.CapabilitiesEventArguments
import com.jetbrains.dap.protocol.DapClient
import com.jetbrains.dap.protocol.ExitedEventArguments
import com.jetbrains.dap.protocol.InitializedEventArguments
import com.jetbrains.dap.protocol.LoadedSourceEventArguments
import com.jetbrains.dap.protocol.OutputEventArguments
import com.jetbrains.dap.protocol.ProcessEventArguments
import com.jetbrains.dap.protocol.ProcessStartMethod
import com.jetbrains.dap.protocol.TerminatedEventArguments
import org.jetbrains.annotations.ApiStatus
import java.util.concurrent.atomic.AtomicBoolean

internal data class AndroidProcessIdentity(
    val name: String,
    val pid: Int,
    val isExternalAttach: Boolean,
)

@ApiStatus.Experimental
@Suppress("UnstableApiUsage")
internal class AndroidDapEventFilter(
    private val downstream: DapClient,
    private val sourceConverter: AndroidDapSourceConverter,
    private val processIdentityProvider: () -> AndroidProcessIdentity?,
    private val capabilitiesPatcher: (Capabilities) -> Capabilities,
    private val onNativeTerminated: () -> Unit,
) : DapClient by downstream {

    private val initializedEmitted = AtomicBoolean(false)
    private val processEmitted = AtomicBoolean(false)
    private val terminatedEmitted = AtomicBoolean(false)

    override fun initialized(args: InitializedEventArguments) {
        if (initializedEmitted.compareAndSet(false, true)) {
            downstream.initialized(args)
        }
    }

    override fun process(args: ProcessEventArguments) {
        val identity = processIdentityProvider()
        val rewritten = if (identity != null) {
            args.copy(
                name = identity.name.ifBlank { args.name },
                systemProcessId = identity.pid,
                isLocalProcess = false,
                startMethod = if (identity.isExternalAttach) {
                    ProcessStartMethod.Attach
                } else {
                    ProcessStartMethod.Launch
                },
            )
        } else {
            args.copy(isLocalProcess = false)
        }
        if (processEmitted.compareAndSet(false, true)) {
            downstream.process(rewritten)
        }
    }

    override fun exited(args: ExitedEventArguments) {
        // Native JDWP does not know the Android process exit code; suppress synthetic exited(0).
    }

    override fun terminated(args: TerminatedEventArguments) {
        onNativeTerminated()
    }

    override fun capabilities(args: CapabilitiesEventArguments) {
        downstream.capabilities(CapabilitiesEventArguments(capabilitiesPatcher(args.capabilities)))
    }

    override fun output(args: OutputEventArguments) {
        downstream.output(sourceConverter.toClientEvent(args))
    }

    override fun breakpoint(args: BreakpointEventArguments) {
        downstream.breakpoint(sourceConverter.toClientEvent(args))
    }

    override fun loadedSource(args: LoadedSourceEventArguments) {
        downstream.loadedSource(sourceConverter.toClientEvent(args))
    }

    fun emitAndroidProcessIfNeeded(identity: AndroidProcessIdentity) {
        if (processEmitted.compareAndSet(false, true)) {
            downstream.process(
                ProcessEventArguments(
                    name = identity.name,
                    systemProcessId = identity.pid,
                    isLocalProcess = false,
                    startMethod = if (identity.isExternalAttach) {
                        ProcessStartMethod.Attach
                    } else {
                        ProcessStartMethod.Launch
                    },
                )
            )
        }
    }

    fun emitVerifiedExited(exitCode: Int) {
        downstream.exited(ExitedEventArguments(exitCode = exitCode))
    }

    fun emitTerminatedOnce(args: TerminatedEventArguments = TerminatedEventArguments()) {
        if (terminatedEmitted.compareAndSet(false, true)) {
            downstream.terminated(args)
        }
    }
}
