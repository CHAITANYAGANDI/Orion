package com.orion.dto;

/**
 * Where to fetch the original recording, and what to call it once it lands.
 *
 * <p>A URL rather than the bytes. The audio is the largest thing Orion
 * stores, and proxying it through the API to add nothing would tie up a request
 * thread for the length of a download; the presigned link goes straight to
 * object storage. It is also why this is a separate call from the meeting: the
 * link expires, and one baked into a page somebody left open overnight would be
 * dead by morning.
 */
public record AudioDownloadResponse(
        String url,
        String filename,
        /** As declared on upload; null for older meetings and YouTube imports. */
        String contentType,
        /** How long {@code url} stays valid, so the UI knows when to ask again. */
        long expiresInSeconds
) {
}
