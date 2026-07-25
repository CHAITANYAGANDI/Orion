package com.recallix.dto.callback;

/** Body of POST /internal/meetings/{id}/status (meetingId is in the path). */
public record StatusCallbackRequest(
        String status,
        Integer progress,
        String message
) {
}
