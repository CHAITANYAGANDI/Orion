package com.recallix.dto;

/** Headline counters for the Meeting Memory dashboard. */
public record MemoryStatsResponse(
        long open,
        long fulfilled,
        long slipped,
        long dropped,
        /** Unacknowledged CONTRADICTS links — the ones worth a badge. */
        long openContradictions
) {
}
