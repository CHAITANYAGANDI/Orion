package com.recallix.dto;

import com.recallix.entity.DecisionLink;
import com.recallix.entity.MeetingDecision;

import java.time.Instant;

/**
 * Two decisions that interact, side by side, with the meetings they came from.
 *
 * <p>{@code relation} is CONTRADICTS, SUPERSEDES or REAFFIRMS — pairs judged
 * unrelated are never stored, so every row here is a real finding.
 */
public record DecisionDriftResponse(
        String id,
        String relation,
        String rationale,
        Double similarity,
        boolean acknowledged,
        Instant createdAt,
        String earlierDecisionId,
        String earlierText,
        String earlierMeetingId,
        String earlierMeetingTitle,
        String laterDecisionId,
        String laterText,
        String laterMeetingId,
        String laterMeetingTitle
) {
    public static DecisionDriftResponse from(DecisionLink link,
                                             MeetingDecision earlier,
                                             MeetingDecision later,
                                             String earlierMeetingTitle,
                                             String laterMeetingTitle) {
        return new DecisionDriftResponse(
                link.getId(),
                link.getRelation(),
                link.getRationale(),
                link.getSimilarity(),
                link.isAcknowledged(),
                link.getCreatedAt(),
                earlier.getId(),
                earlier.getDecisionText(),
                earlier.getMeetingId(),
                earlierMeetingTitle,
                later.getId(),
                later.getDecisionText(),
                later.getMeetingId(),
                laterMeetingTitle);
    }
}
