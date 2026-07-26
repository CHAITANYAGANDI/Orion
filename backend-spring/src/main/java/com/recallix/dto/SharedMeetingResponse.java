package com.recallix.dto;

import java.time.Instant;
import java.util.List;

/**
 * The redacted, unauthenticated view of a shared meeting.
 *
 * <p>Deliberately its own shape rather than a filtered {@link MeetingResponse}:
 * this is what an anonymous visitor sees, so it must never carry the owner's id,
 * the audio URL, storage keys, or internal status. Adding a field to an internal
 * DTO must not silently widen what is public.
 *
 * <p>The nested records exist for the same reason — the internal
 * {@code DecisionResponse}/{@code RiskResponse}/{@code ActionItemResponse} all
 * expose database identifiers that a share recipient has no business seeing.
 */
public record SharedMeetingResponse(
        String title,
        Instant meetingDate,
        Integer durationSeconds,
        List<String> participants,
        String shortSummary,
        String detailedSummary,
        List<String> keyPoints,
        List<SharedDecision> decisions,
        List<SharedActionItem> actionItems,
        List<SharedRisk> risks,
        /** Null unless the owner opted into sharing the verbatim transcript. */
        String transcript
) {
    public record SharedDecision(String decision, String confidence, String sourceSentence) {}

    public record SharedActionItem(String title, String ownerName, String dueDate, String priority) {}

    public record SharedRisk(String risk, String severity, String sourceSentence) {}
}
