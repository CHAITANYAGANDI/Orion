package com.reverie.dto;

import com.reverie.domain.MeetingStatus;

/**
 * Status payload pushed to the frontend over STOMP (api-contracts §7), and the
 * body of the internal status callback the AI worker posts on every stage.
 */
public record StatusEvent(
        String meetingId,
        MeetingStatus status,
        int progress,
        String message
) {
}
