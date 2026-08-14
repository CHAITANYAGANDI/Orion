package com.recallix.dto.callback;

import com.recallix.domain.Quotation;
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
        /**
         * Quotations the worker already verified against the transcript.
         * Absent from an older worker's payload, and legitimately empty when
         * nothing the model produced could be found in the transcript.
         */
        List<Quotation> quotes,
        String templateSlug,
        List<AiActionItem> actionItems,
        /**
         * Decisions and risks read out of {@code sections} above. Absent from an
         * older worker's payload, and legitimately empty for a template with no
         * decision-shaped section — a 1:1 settles nothing, it produces
         * commitments, which are action items.
         */
        List<AiInsight> insights,
        /**
         * Starter questions for this meeting's chat. Absent from an older
         * worker's payload, and legitimately empty when the model could not
         * produce specific ones.
         */
        List<String> suggestions,
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

    public List<Quotation> quotesOrEmpty() { return quotes == null ? List.of() : quotes; }
    public List<AiActionItem> actionItemsOrEmpty() { return actionItems == null ? List.of() : actionItems; }

    public List<String> suggestionsOrEmpty() {
        return suggestions == null ? List.of() : suggestions;
    }

    /** Only the entries an older or misbehaving worker could not have malformed. */
    public List<AiInsight> insightsOrEmpty() {
        return insights == null
                ? List.of()
                : insights.stream().filter(i -> i != null && i.isUsable()).toList();
    }
}
