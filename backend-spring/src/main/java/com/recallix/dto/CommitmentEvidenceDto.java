package com.recallix.dto;

import com.recallix.entity.CommitmentEvidence;

import java.time.Instant;

/** One later meeting's verdict on a commitment, with the quote that justifies it. */
public record CommitmentEvidenceDto(
        String id,
        String meetingId,
        String meetingTitle,
        String verdict,
        String rationale,
        String quote,
        Double start,
        String confidence,
        Instant createdAt
) {
    public static CommitmentEvidenceDto from(CommitmentEvidence e, String meetingTitle) {
        return new CommitmentEvidenceDto(
                e.getId(),
                e.getMeetingId(),
                meetingTitle,
                e.getVerdict(),
                e.getRationale(),
                e.getQuote(),
                e.getStartTime(),
                e.getConfidence(),
                e.getCreatedAt());
    }
}
