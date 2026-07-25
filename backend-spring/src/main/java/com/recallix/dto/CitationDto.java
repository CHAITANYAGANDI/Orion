package com.recallix.dto;

/**
 * A transcript passage an answer was grounded in.
 *
 * <p>{@code meetingId}/{@code meetingTitle} are populated for workspace-wide
 * answers, which span meetings. They are null for single-meeting chat, where the
 * meeting is already implied by the request path.
 */
public record CitationDto(
        int chunkIndex,
        Double start,
        Double end,
        String text,
        String meetingId,
        String meetingTitle
) {
}
