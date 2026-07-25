package com.recallix.dto;

import java.util.List;

public record SummaryResponse(
        String meetingId,
        String shortSummary,
        String detailedSummary,
        List<String> keyPoints
) {
}
