package com.recallix.dto;

import com.recallix.domain.MeetingStatus;
import com.recallix.domain.SourceType;
import com.recallix.entity.Meeting;

import java.time.Instant;
import java.util.List;

public record MeetingResponse(
        String id,
        String title,
        MeetingStatus status,
        List<String> participants,
        List<String> tags,
        String audioUrl,
        Integer durationSeconds,
        Instant createdAt,
        String errorMessage,
        /** Lets the UI drop the audio player and deep-links for text sources. */
        SourceType sourceType,
        String sourceUrl,
        /** Detected transcription language (ISO-639-1); null until processed. */
        String language
) {
    public static MeetingResponse from(Meeting m) {
        return new MeetingResponse(
                m.getId(),
                m.getTitle(),
                m.getStatus(),
                m.getParticipants(),
                m.getTags(),
                m.getAudioUrl(),
                m.getDurationSeconds(),
                m.getCreatedAt(),
                m.getErrorMessage(),
                m.getSourceType(),
                m.getSourceUrl(),
                m.getLanguage()
        );
    }
}
