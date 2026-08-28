package com.orion.event;

/**
 * Published once a meeting's brief has been persisted and its transcript indexed
 * into pgvector. Consumed after commit to send the recap email.
 */
public record MeetingReadyEvent(String meetingId, String userId) {
}
