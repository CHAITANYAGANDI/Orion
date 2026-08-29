package com.orion.dto;

/**
 * Where the converted recording is, or why it is not there yet.
 *
 * <h2>Why this is not just a URL</h2>
 *
 * <p>Converting an hour of audio takes tens of seconds. A synchronous endpoint
 * that did it would hold a request thread for the whole of that and then lose
 * the race anyway: Render's proxy, most corporate proxies and every browser
 * give up well before the longest recording Orion accepts is finished. The
 * failure mode is the worst kind — the conversion completes, the object is
 * written, and the user is looking at a timeout.
 *
 * <p>So the endpoint answers immediately with one of three states and the client
 * asks again. {@code preparing} is not an error and must not be rendered as one;
 * {@code failed} is, and carries a sentence written to be read rather than a
 * status code.
 *
 * <p>{@code ready} is the same shape as {@link AudioDownloadResponse} on
 * purpose — a short-lived presigned link straight to object storage, because the
 * derivative is exactly as large as the original and proxying it through a
 * request thread would be the same mistake in a new place.
 */
public record AudioExportResponse(
        /** {@code ready}, {@code preparing} or {@code failed}. */
        String status,
        /** The presigned link; null unless ready. */
        String url,
        /** What the browser will save it as; null unless ready. */
        String filename,
        /** {@code audio/mpeg} when ready, so the caller can verify what it got. */
        String contentType,
        /** How long {@code url} stays valid, so the UI knows when to ask again. */
        long expiresInSeconds,
        /** A sentence for the user; only ever set when failed. */
        String message
) {

    public static final String READY = "ready";
    public static final String PREPARING = "preparing";
    public static final String FAILED = "failed";

    public static AudioExportResponse ready(String url, String filename,
                                            String contentType, long expiresInSeconds) {
        return new AudioExportResponse(READY, url, filename, contentType, expiresInSeconds, null);
    }

    /**
     * Still converting.
     *
     * <p>Carries no URL, deliberately. An "almost ready" link that 404s if
     * followed would turn one clear waiting state into an intermittent broken
     * download, which is precisely the class of bug this endpoint exists to end.
     */
    public static AudioExportResponse preparing() {
        return new AudioExportResponse(PREPARING, null, null, null, 0, null);
    }

    public static AudioExportResponse failed(String message) {
        return new AudioExportResponse(FAILED, null, null, null, 0, message);
    }
}
