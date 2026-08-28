package com.orion.dto;

import com.orion.domain.MomentRange;
import com.orion.entity.TranscriptMoment;

import java.time.Instant;
import java.util.List;

/** A highlight, bookmark, note or reaction as the transcript view draws it. */
public record MomentResponse(
        String id,
        String meetingId,
        String kind,
        List<MomentRange> ranges,
        String quote,
        String body,
        String speaker,
        double startSeconds,
        double endSeconds,
        Instant createdAt,
        Instant updatedAt
) {
    public static MomentResponse from(TranscriptMoment m) {
        return new MomentResponse(
                m.getId(),
                m.getMeetingId(),
                m.getKind(),
                m.getRanges() == null ? List.of() : List.copyOf(m.getRanges()),
                m.getQuote(),
                m.getBody(),
                m.getSpeaker(),
                m.getStartSeconds(),
                m.getEndSeconds(),
                m.getCreatedAt(),
                m.getUpdatedAt());
    }
}
