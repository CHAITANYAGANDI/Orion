package com.recallix.dto;

import com.recallix.entity.MeetingInsight;

import java.time.Instant;

/**
 * A decision or risk as the meeting page shows it.
 *
 * <p>{@code sourceSection} is carried through so the UI can say where a row
 * came from — "Blockers" and "Risks" both store as RISK, and a reader who
 * cannot tell them apart has lost the distinction between what is already
 * happening and what might.
 */
public record InsightResponse(
        String id,
        String meetingId,
        String kind,
        String text,
        String sourceSection,
        /** True once a person has edited or added it, rather than the model. */
        boolean edited,
        Instant createdAt
) {
    public static InsightResponse from(MeetingInsight i) {
        return new InsightResponse(
                i.getId(),
                i.getMeetingId(),
                i.getKind(),
                i.getText(),
                i.getSourceSection(),
                i.isEdited(),
                i.getCreatedAt());
    }
}
