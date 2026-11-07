package org.omp.intellij.android;

import com.jetbrains.lsp.protocol.Location;
import com.jetbrains.lsp.protocol.Range;

import java.lang.invoke.MethodHandle;
import java.lang.invoke.MethodHandles;
import java.lang.invoke.MethodType;
import java.nio.file.Path;

final class AndroidLocations {
    private static final MethodHandle CONSTRUCTOR;
    private static final MethodHandle URI;

    static {
        try {
            // URI is a Kotlin inline value; its public JVM constructor is synthetic to Java.
            CONSTRUCTOR = MethodHandles.publicLookup().findConstructor(Location.class,
                    MethodType.methodType(void.class, String.class, Range.class, kotlin.jvm.internal.DefaultConstructorMarker.class));
            URI = MethodHandles.publicLookup().findVirtual(Location.class, "getUri-0xi3r-g", MethodType.methodType(String.class));
        } catch (ReflectiveOperationException error) {
            throw new ExceptionInInitializerError(error);
        }
    }

    private AndroidLocations() {
    }

    static Location at(Path path, Range range) {
        try {
            String uri = com.jetbrains.ls.api.core.util.UriConverterKt.intellijUriToLspUri(com.intellij.openapi.vfs.VfsUtilCore.pathToUrl(path.toAbsolutePath().normalize().toString()));
            return (Location) CONSTRUCTOR.invokeExact(uri, range, (kotlin.jvm.internal.DefaultConstructorMarker) null);
        } catch (RuntimeException | Error error) {
            throw error;
        } catch (Throwable error) {
            throw new IllegalStateException(error);
        }
    }

    static Path path(Location location) {
        try {
            return Path.of(java.net.URI.create((String) URI.invokeExact(location)));
        } catch (RuntimeException | Error error) {
            throw error;
        } catch (Throwable error) {
            throw new IllegalStateException(error);
        }
    }
}
