package com.recallix.dto.callback;

import com.recallix.domain.SummarySection;

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
        /**
         * The template's sections in order. Empty when an older worker, which
         * knows nothing about templates, posts a result — the three fields
         * above are still populated in that case, so the brief renders.
         */
        List<SummarySection> sections,
        String templateSlug,
        List<AiActionItem> actionItems,
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
    public List<SummarySection> sectionsOrEmpty() { return sections == null ? List.of() : sections; }
    public List<AiActionItem> actionItemsOrEmpty() { return actionItems == null ? List.of() : actionItems; }
}
