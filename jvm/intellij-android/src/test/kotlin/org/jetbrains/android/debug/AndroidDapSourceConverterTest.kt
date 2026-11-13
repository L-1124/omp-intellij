package org.jetbrains.android.debug

import com.jetbrains.dap.protocol.Breakpoint
import com.jetbrains.dap.protocol.BreakpointEventReason
import com.jetbrains.dap.protocol.FrameId
import com.jetbrains.dap.protocol.BreakpointEventArguments
import com.jetbrains.dap.protocol.BreakpointLocationsArguments
import com.jetbrains.dap.protocol.BreakpointReason
import com.jetbrains.dap.protocol.DapLine
import com.jetbrains.dap.protocol.DapRequestFailedException
import com.jetbrains.dap.protocol.DisassembleResponse
import com.jetbrains.dap.protocol.DisassembledInstruction
import com.jetbrains.dap.protocol.GotoTargetsArguments
import com.jetbrains.dap.protocol.LoadedSourceEventArguments
import com.jetbrains.dap.protocol.LoadedSourceEventReason
import com.jetbrains.dap.protocol.LoadedSourcesResponse
import com.jetbrains.dap.protocol.LocationsResponse
import com.jetbrains.dap.protocol.OutputCategory
import com.jetbrains.dap.protocol.OutputEventArguments
import com.jetbrains.dap.protocol.Scope
import com.jetbrains.dap.protocol.ScopesResponse
import com.jetbrains.dap.protocol.SetBreakpointsArguments
import com.jetbrains.dap.protocol.SetBreakpointsResponse
import com.jetbrains.dap.protocol.Source
import com.jetbrains.dap.protocol.SourceArguments
import com.jetbrains.dap.protocol.SourceBreakpoint
import com.jetbrains.dap.protocol.SourceReference
import com.jetbrains.dap.protocol.StackFrame
import com.jetbrains.dap.protocol.StackTraceResponse
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.nio.file.Path

@Suppress("UnstableApiUsage")
class AndroidDapSourceConverterTest {

    private val localFile: Path = Path.of("F:/tmp/android-src-test/MainActivity.java").toAbsolutePath().normalize()
    private val localFileUri: String = localFile.toUri().toString()

    @Test
    fun testInboundFileUriConvertsToLocalPathAndPreservesMetadata() {
        val converter = AndroidDapSourceConverter(useUriPathFormat = true)
        val adapterData = JsonPrimitive("keep-adapter-data")
        val nestedVirtual = Source(
            name = "Virtual.java",
            path = null,
            sourceReference = SourceReference(99),
            adapterData = JsonPrimitive("nested-keep"),
        )
        val inputSource = Source(
            name = "MainActivity.java",
            path = localFileUri,
            sourceReference = SourceReference(0),
            origin = "app",
            sources = listOf(nestedVirtual),
            adapterData = adapterData,
        )

        val bpReq = converter.toNativeRequest(
            SetBreakpointsArguments(
                source = inputSource,
                breakpoints = listOf(SourceBreakpoint(line = DapLine(13))),
            )
        )
        assertEquals(localFile.toString(), bpReq.source.path)
        assertEquals(adapterData, bpReq.source.adapterData)
        assertEquals(0, bpReq.source.sourceReference?.id)
        assertEquals(nestedVirtual, bpReq.source.sources?.single())

        val bpLocReq = converter.toNativeRequest(
            BreakpointLocationsArguments(source = inputSource, line = DapLine(13))
        )
        assertEquals(localFile.toString(), bpLocReq.source.path)

        val srcReq = converter.toNativeRequest(
            SourceArguments(source = inputSource, sourceReference = SourceReference(0))
        )
        assertEquals(localFile.toString(), srcReq.source?.path)

        val gotoReq = converter.toNativeRequest(
            GotoTargetsArguments(source = inputSource, line = DapLine(13))
        )
        assertEquals(localFile.toString(), gotoReq.source.path)
    }

    @Test
    fun testInboundRejectsUnsupportedUriSchemesAndKeepsWindowsPaths() {
        val converter = AndroidDapSourceConverter(useUriPathFormat = true)

        val windowsSource = Source(path = localFile.toString())
        assertEquals(localFile.toString(), converter.toNativeSource(windowsSource).path)

        val virtualOnly = Source(path = null, sourceReference = SourceReference(7))
        assertNull(converter.toNativeSource(virtualOnly).path)
        assertEquals(7, converter.toNativeSource(virtualOnly).sourceReference?.id)

        for (badUri in listOf(
            "http://example.com/MainActivity.java",
            "jar:///F:/sdk/android.jar!/android/app/Activity.class",
            "jrt:/java.base/java/lang/String.class",
            "untitled:Unsaved.java",
        )) {
            try {
                converter.toNativeRequest(
                    SetBreakpointsArguments(source = Source(path = badUri))
                )
                fail("Expected rejection for $badUri")
            } catch (ex: DapRequestFailedException) {
                assertTrue(
                    "Expected [invalid_params] for $badUri, got ${ex.message}",
                    ex.message.startsWith("[invalid_params] configuring:")
                )
            }
        }
    }

    @Test
    fun testOutboundRespectsPathFormatAndPreservesVirtualSourcesAndAdapterData() {
        val adapterData = JsonPrimitive("do-not-touch")
        val virtualSource = Source(
            name = "Synthetic.java",
            path = null,
            sourceReference = SourceReference(12),
            adapterData = adapterData,
        )
        val jarSource = Source(
            name = "Handler.class",
            path = "jar:///F:/sdk/android.jar!/android/os/Handler.class",
            sourceReference = SourceReference(5),
        )
        val localSource = Source(
            name = "MainActivity.java",
            path = localFile.toString(),
            adapterData = adapterData,
        )
        val nativeFileUriSource = Source(
            name = "MainActivity.java",
            path = localFileUri,
            adapterData = adapterData,
        )

        val uriConverter = AndroidDapSourceConverter(useUriPathFormat = true)
        val bpResp = uriConverter.toClientResponse(
            SetBreakpointsResponse(
                listOf(
                    Breakpoint(
                        verified = true,
                        source = localSource,
                        line = DapLine(13),
                    )
                )
            )
        )
        assertEquals(localFileUri, bpResp.breakpoints.single().source?.path)
        assertEquals(adapterData, bpResp.breakpoints.single().source?.adapterData)

        val stackResp = uriConverter.toClientResponse(
            StackTraceResponse(
                stackFrames = listOf(
                    StackFrame(
                        id = FrameId(1),
                        name = "tick",
                        source = localSource,
                        line = DapLine(13),
                        column = com.jetbrains.dap.protocol.DapColumn(1)
                    ),
                    StackFrame(
                        id = FrameId(2),
                        name = "handle",
                        source = jarSource,
                        line = DapLine(10),
                        column = com.jetbrains.dap.protocol.DapColumn(1)
                    ),
                    StackFrame(
                        id = FrameId(3),
                        name = "synth",
                        source = virtualSource,
                        line = DapLine(1),
                        column = com.jetbrains.dap.protocol.DapColumn(1)
                    ),
                )
            )
        )
        assertEquals(localFileUri, stackResp.stackFrames[0].source?.path)
        assertEquals(jarSource.path, stackResp.stackFrames[1].source?.path)
        assertEquals(5, stackResp.stackFrames[1].source?.sourceReference?.id)
        assertNull(stackResp.stackFrames[2].source?.path)
        assertEquals(12, stackResp.stackFrames[2].source?.sourceReference?.id)
        assertEquals(adapterData, stackResp.stackFrames[2].source?.adapterData)

        val scopesResp = uriConverter.toClientResponse(
            ScopesResponse(
                listOf(
                    Scope(
                        name = "Locals",
                        variablesReference = com.jetbrains.dap.protocol.VariablesReference(1),
                        expensive = false,
                        source = localSource
                    )
                )
            )
        )
        assertEquals(localFileUri, scopesResp.scopes.single().source?.path)

        val loadedResp = uriConverter.toClientResponse(LoadedSourcesResponse(listOf(localSource, jarSource)))
        assertEquals(localFileUri, loadedResp.sources[0].path)
        assertEquals(jarSource.path, loadedResp.sources[1].path)

        val locResp = uriConverter.toClientResponse(LocationsResponse(source = localSource))
        assertEquals(localFileUri, locResp.source?.path)

        val disasmResp = uriConverter.toClientResponse(
            DisassembleResponse(
                listOf(
                    DisassembledInstruction(
                        address = "0x1",
                        instruction = "nop",
                        location = localSource
                    )
                )
            )
        )
        assertEquals(localFileUri, disasmResp.instructions.single().location?.path)

        val outEvent = uriConverter.toClientEvent(
            OutputEventArguments(category = OutputCategory.Console, output = "ok\n", source = localSource)
        )
        assertEquals(localFileUri, outEvent.source?.path)

        val bpEvent = uriConverter.toClientEvent(
            BreakpointEventArguments(
                reason = BreakpointEventReason.New,
                breakpoint = Breakpoint(verified = false, source = localSource),
            )
        )
        assertEquals(localFileUri, bpEvent.breakpoint.source?.path)

        val loadedEvent = uriConverter.toClientEvent(
            LoadedSourceEventArguments(reason = LoadedSourceEventReason.New, source = localSource)
        )
        assertEquals(localFileUri, loadedEvent.source.path)

        // When client negotiated pathFormat="path", native file:/// URIs are converted back to local paths.
        val pathConverter = AndroidDapSourceConverter(useUriPathFormat = false)
        val pathStack = pathConverter.toClientResponse(
            StackTraceResponse(
                stackFrames = listOf(
                    StackFrame(
                        id = FrameId(1),
                        name = "tick",
                        source = nativeFileUriSource,
                        line = DapLine(13),
                        column = com.jetbrains.dap.protocol.DapColumn(1)
                    ),
                )
            )
        )
        assertEquals(localFile.toString(), pathStack.stackFrames.single().source?.path)
        assertEquals(adapterData, pathStack.stackFrames.single().source?.adapterData)
    }
}
