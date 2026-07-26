package com.recallix.dto.callback;

import java.util.List;

/**
 * Full result posted by FastAPI to POST /internal/meetings/{id}/result
 * (api-contracts §5). Unknown fields are ignored via Jackson global config.
 */
public record MeetingBriefResult(
        String meetingId,
        String transcript,
        String language,
        List<AiSegment> segments,
        String shortSummary,
        String detailedSummary,
        List<String> keyPoints,
        List<AiDecision> decisions,
        List<AiActionItem> actionItems,
        List<AiRisk> risks,
        /**
         * Only sent for URL imports, where the worker learns the real title and
         * length from the video's metadata. Null for uploads, which already
         * have both from the browser.
         */
        String title,
        Integer durationSeconds
) {
    public List<AiSegment> segmentsOrEmpty() { return segments == null ? List.of() : segments; }
    public List<String> keyPointsOrEmpty() { return keyPoints == null ? List.of() : keyPoints; }
    public List<AiDecision> decisionsOrEmpty() { return decisions == null ? List.of() : decisions; }
    public List<AiActionItem> actionItemsOrEmpty() { return actionItems == null ? List.of() : actionItems; }
    public List<AiRisk> risksOrEmpty() { return risks == null ? List.of() : risks; }
}
