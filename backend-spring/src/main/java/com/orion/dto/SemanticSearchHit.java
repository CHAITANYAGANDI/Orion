package com.orion.dto;

import java.time.Instant;

/**
 * One semantic search result: the best-matching transcript passage from a
 * meeting, plus enough meeting metadata for the UI to render a result card
 * without a second round-trip.
 *
 * <p>{@code score} is a cosine similarity in [0,1] — higher is closer.
 */
public record SemanticSearchHit(
        String meetingId,
        String meetingTitle,
        String meetingStatus,
        Instant meetingCreatedAt,
        int chunkIndex,
        String snippet,
        Double start,
        Double end,
        double score
) {
}
