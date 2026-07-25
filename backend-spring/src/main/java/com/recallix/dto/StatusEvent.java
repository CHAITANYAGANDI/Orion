package com.recallix.dto;

import com.recallix.domain.MeetingStatus;

/**
 * Status payload pushed to the frontend over STOMP and mirrored into Redis
 * (api-contracts §6/§7). Also the shape of the Kafka status topics.
 */
public record StatusEvent(
        String meetingId,
        MeetingStatus status,
        int progress,
        String message
) {
}
