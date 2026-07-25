package com.recallix.dto;

import com.recallix.entity.MeetingDecision;

public record DecisionResponse(
        String id,
        String meetingId,
        String decision,
        String confidence,
        String sourceSentence
) {
    public static DecisionResponse from(MeetingDecision d) {
        return new DecisionResponse(
                d.getId(),
                d.getMeetingId(),
                d.getDecisionText(),
                d.getConfidence(),
                d.getSourceSentence()
        );
    }
}
