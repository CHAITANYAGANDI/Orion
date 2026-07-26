package com.recallix.dto;

import com.recallix.entity.Commitment;

import java.time.Instant;
import java.util.List;

/**
 * A tracked promise plus its evidence trail. The status is inferred from what
 * later meetings said, and every claim is backed by the quotes in {@code evidence}.
 */
public record CommitmentResponse(
        String id,
        String text,
        String ownerName,
        String dueDate,
        String status,
        String originMeetingId,
        String originMeetingTitle,
        String actionItemId,
        int checksRun,
        Instant lastCheckedAt,
        Instant createdAt,
        Instant updatedAt,
        List<CommitmentEvidenceDto> evidence
) {
    public static CommitmentResponse from(Commitment c,
                                          String originMeetingTitle,
                                          List<CommitmentEvidenceDto> evidence) {
        return new CommitmentResponse(
                c.getId(),
                c.getText(),
                c.getOwnerName(),
                c.getDueDate(),
                c.getStatus(),
                c.getOriginMeetingId(),
                originMeetingTitle,
                c.getActionItemId(),
                c.getChecksRun(),
                c.getLastCheckedAt(),
                c.getCreatedAt(),
                c.getUpdatedAt(),
                evidence == null ? List.of() : evidence);
    }
}
