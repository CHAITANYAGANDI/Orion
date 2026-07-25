package com.recallix.dto;

import java.util.List;

public record TranscriptResponse(
        String meetingId,
        String transcript,
        String language,
        List<SegmentDto> segments
) {
}
