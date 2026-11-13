package org.jetbrains.android.debug

import com.jetbrains.dap.protocol.Breakpoint
import com.jetbrains.dap.protocol.BreakpointEventArguments
import com.jetbrains.dap.protocol.BreakpointLocationsArguments
import com.jetbrains.dap.protocol.DisassembleResponse
import com.jetbrains.dap.protocol.DisassembledInstruction
import com.jetbrains.dap.protocol.GotoTargetsArguments
import com.jetbrains.dap.protocol.LoadedSourceEventArguments
import com.jetbrains.dap.protocol.LoadedSourcesResponse
import com.jetbrains.dap.protocol.LocationsResponse
import com.jetbrains.dap.protocol.OutputEventArguments
import com.jetbrains.dap.protocol.Scope
import com.jetbrains.dap.protocol.ScopesResponse
import com.jetbrains.dap.protocol.SetBreakpointsArguments
import com.jetbrains.dap.protocol.SetBreakpointsResponse
import com.jetbrains.dap.protocol.Source
import com.jetbrains.dap.protocol.SourceArguments
import com.jetbrains.dap.protocol.StackFrame
import com.jetbrains.dap.protocol.StackTraceResponse
import org.jetbrains.annotations.ApiStatus
import org.jetbrains.android.run.AndroidRunError
import org.jetbrains.android.run.AndroidRunErrorCode
import org.jetbrains.android.run.AndroidRunStage
import java.net.URI
import java.net.URISyntaxException
import java.nio.file.FileSystemNotFoundException
import java.nio.file.InvalidPathException
import java.nio.file.Path

@ApiStatus.Experimental
@Suppress("UnstableApiUsage")
class AndroidDapSourceConverter(
    @Volatile var useUriPathFormat: Boolean = false
) {
    fun toNativeSource(source: Source): Source {
        val convertedNested = source.sources?.map(::toNativeSource)
        val rawPath = source.path
        val convertedPath = if (rawPath.isNullOrBlank()) {
            rawPath
        } else {
            toNativeSourcePath(rawPath)
        }
        return if (convertedPath == rawPath && convertedNested == source.sources) {
            source
        } else {
            source.copy(path = convertedPath, sources = convertedNested)
        }
    }

    fun toClientSource(source: Source): Source {
        val convertedNested = source.sources?.map(::toClientSource)
        val rawPath = source.path
        val convertedPath = if (rawPath.isNullOrBlank()) {
            rawPath
        } else {
            toClientSourcePath(rawPath)
        }
        return if (convertedPath == rawPath && convertedNested == source.sources) {
            source
        } else {
            source.copy(path = convertedPath, sources = convertedNested)
        }
    }

    fun toNativeRequest(args: SetBreakpointsArguments): SetBreakpointsArguments =
        args.copy(source = toNativeSource(args.source))

    fun toNativeRequest(args: BreakpointLocationsArguments): BreakpointLocationsArguments =
        args.copy(source = toNativeSource(args.source))

    fun toNativeRequest(args: SourceArguments): SourceArguments =
        args.copy(source = args.source?.let(::toNativeSource))

    fun toNativeRequest(args: GotoTargetsArguments): GotoTargetsArguments =
        args.copy(source = toNativeSource(args.source))

    fun toClientResponse(response: SetBreakpointsResponse): SetBreakpointsResponse =
        response.copy(breakpoints = response.breakpoints.map(::convertBreakpoint))

    fun toClientResponse(response: StackTraceResponse): StackTraceResponse =
        response.copy(stackFrames = response.stackFrames.map(::convertStackFrame))

    fun toClientResponse(response: ScopesResponse): ScopesResponse =
        response.copy(scopes = response.scopes.map(::convertScope))

    fun toClientResponse(response: LoadedSourcesResponse): LoadedSourcesResponse =
        response.copy(sources = response.sources.map(::toClientSource))

    fun toClientResponse(response: LocationsResponse): LocationsResponse =
        response.copy(source = response.source?.let(::toClientSource))

    fun toClientResponse(response: DisassembleResponse): DisassembleResponse =
        response.copy(instructions = response.instructions.map(::convertInstruction))

    fun toClientEvent(args: OutputEventArguments): OutputEventArguments =
        args.copy(source = args.source?.let(::toClientSource))

    fun toClientEvent(args: BreakpointEventArguments): BreakpointEventArguments =
        args.copy(breakpoint = convertBreakpoint(args.breakpoint))

    fun toClientEvent(args: LoadedSourceEventArguments): LoadedSourceEventArguments =
        args.copy(source = toClientSource(args.source))

    private fun convertBreakpoint(bp: Breakpoint): Breakpoint {
        val source = bp.source ?: return bp
        val converted = toClientSource(source)
        return if (converted === source) bp else bp.copy(source = converted)
    }

    private fun convertStackFrame(frame: StackFrame): StackFrame {
        val source = frame.source ?: return frame
        val converted = toClientSource(source)
        return if (converted === source) frame else frame.copy(source = converted)
    }

    private fun convertScope(scope: Scope): Scope {
        val source = scope.source ?: return scope
        val converted = toClientSource(source)
        return if (converted === source) scope else scope.copy(source = converted)
    }

    private fun convertInstruction(instruction: DisassembledInstruction): DisassembledInstruction {
        val location = instruction.location ?: return instruction
        val converted = toClientSource(location)
        return if (converted === location) instruction else instruction.copy(location = converted)
    }

    private fun toNativeSourcePath(rawPath: String): String {
        if (!hasUriScheme(rawPath)) {
            return rawPath
        }
        val uri = try {
            URI(rawPath)
        } catch (e: URISyntaxException) {
            throw invalidSourceError("Invalid URI in Source.path: $rawPath", e)
        }
        val scheme = uri.scheme ?: return rawPath
        if (!"file".equals(scheme, ignoreCase = true)) {
            throw invalidSourceError("Unsupported URI scheme '$scheme' in Source.path: $rawPath")
        }
        if (uri.isOpaque) {
            throw invalidSourceError("Opaque file URI is not supported in Source.path: $rawPath")
        }
        return try {
            Path.of(uri).toAbsolutePath().normalize().toString()
        } catch (e: IllegalArgumentException) {
            throw invalidSourceError("Invalid file URI in Source.path: $rawPath", e)
        } catch (e: FileSystemNotFoundException) {
            throw invalidSourceError("Invalid file URI in Source.path: $rawPath", e)
        }
    }

    private fun toClientSourcePath(rawPath: String): String {
        if (hasUriScheme(rawPath)) {
            val uri = try {
                URI(rawPath)
            } catch (_: URISyntaxException) {
                return rawPath
            }
            val scheme = uri.scheme ?: return rawPath
            if (!"file".equals(scheme, ignoreCase = true)) {
                return rawPath
            }
            if (uri.isOpaque) {
                return rawPath
            }
            val localPath = try {
                Path.of(uri).toAbsolutePath().normalize()
            } catch (_: IllegalArgumentException) {
                null
            } catch (_: FileSystemNotFoundException) {
                null
            } ?: return rawPath
            return if (useUriPathFormat) {
                localPath.toUri().toString()
            } else {
                localPath.toString()
            }
        }

        if (!useUriPathFormat) {
            return rawPath
        }
        val localPath = try {
            Path.of(rawPath)
        } catch (_: InvalidPathException) {
            return rawPath
        }
        if (!localPath.isAbsolute) {
            return rawPath
        }
        return localPath.toAbsolutePath().normalize().toUri().toString()
    }

    private fun hasUriScheme(value: String): Boolean {
        if (value.startsWith("/") || value.startsWith("\\\\")) {
            return false
        }
        if (value.length >= 2 && value[0].isLetter() && value[1] == ':') {
            if (value.length == 2 || value[2] == '/' || value[2] == '\\') {
                return false
            }
        }
        return URI_SCHEME_REGEX.containsMatchIn(value)
    }

    private fun invalidSourceError(detail: String, cause: Throwable? = null) =
        AndroidRunError(
            code = AndroidRunErrorCode.INVALID_PARAMS,
            stage = AndroidRunStage.CONFIGURING,
            detail = detail,
        ).toDapException(cause)

    companion object {
        private val URI_SCHEME_REGEX = Regex("^[A-Za-z][A-Za-z0-9+.-]+:")
    }
}
