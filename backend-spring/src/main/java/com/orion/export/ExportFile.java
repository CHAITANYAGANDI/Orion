package com.orion.export;

/** A rendered download: what to call it, what it is, and the bytes. */
public record ExportFile(String filename, String mediaType, byte[] content) {
}
