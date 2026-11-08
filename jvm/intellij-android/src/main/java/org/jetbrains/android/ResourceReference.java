package org.jetbrains.android;

import com.jetbrains.lsp.protocol.Range;

import java.nio.file.Path;

public record ResourceReference(String type, String name, String namespace, boolean isFramework,
                                Range originRange, Path classOrigin) {
}
