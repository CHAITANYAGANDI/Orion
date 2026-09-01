package com.reverie.dto.callback;

/** Body of POST /internal/meetings/{id}/status (meetingId is in the path). */
public record StatusCallbackRequest(
        String status,
        Integer progress,
        String message,
        /**
         * Which processing run this reports, carried from the
         * {@code meeting_uploaded} event that started it.
         *
         * <p>Not read from the meeting row on arrival, and this is the whole
         * point: a callback can arrive after its own response was lost and
         * after somebody has reprocessed the meeting in the meantime, and
         * reading the row then would have handed an obsolete execution the new
         * run's identity. Null from a worker that predates this field, which
         * {@code CallbackService} reads as the first run — the oldest there is,
         * so it can never impersonate a newer one.
         */
        Integer processingAttempt
) {
}
