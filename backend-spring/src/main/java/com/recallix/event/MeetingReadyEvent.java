package com.recallix.event;

/**
 * Published once a meeting's brief has been persisted and its transcript indexed
 * into pgvector. Consumed after commit to run Meeting Memory reconciliation.
 */
public record MeetingReadyEvent(String meetingId, String userId) {
}
