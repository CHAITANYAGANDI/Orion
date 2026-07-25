package com.recallix.dto;

import com.recallix.entity.MeetingRisk;

public record RiskResponse(
        String id,
        String meetingId,
        String risk,
        String severity,
        String sourceSentence
) {
    public static RiskResponse from(MeetingRisk r) {
        return new RiskResponse(
                r.getId(),
                r.getMeetingId(),
                r.getRiskText(),
                r.getSeverity(),
                r.getSourceSentence()
        );
    }
}
