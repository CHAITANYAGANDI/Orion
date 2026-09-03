package com.reverie.dto;

import java.util.List;

public record TranscriptResponse(
        String meetingId,
        String transcript,
        String language,
        List<SegmentDto> segments,
        /**
         * Talk-time per speaker, derived from the segments on every read rather
         * than stored — renames and edits both move it.
         * Empty for a document, which has no speakers.
         */
        List<SpeakerStatsDto> speakers
) {
}
