package com.orion.dto;

import com.orion.domain.MeetingStatus;
import com.orion.domain.SourceType;
import com.orion.entity.Meeting;

import java.time.Instant;
import java.util.List;

public record MeetingResponse(
        String id,
        String title,
        MeetingStatus status,
        List<String> tags,
        String audioUrl,
        Integer durationSeconds,
        Instant createdAt,
        String errorMessage,
        /** Lets the UI drop the audio player and deep-links for text sources. */
        SourceType sourceType,
        String sourceUrl,
        /** Detected transcription language (ISO-639-1); null until processed. */
        String language,
        /**
         * The language the user told us this meeting is in, or null to use the
         * account default (V42).
         *
         * <p>Sent separately from {@link #language} because the picker has to
         * show what was *asked for* rather than what came back: those differ
         * exactly when somebody is trying to fix a mis-transcription, which is
         * the one time the control matters.
         */
        String spokenLanguage,
        /** Which summary template this meeting's notes are written in. */
        String summaryTemplate,
        /**
         * MIME type of the stored media, so the player renders a video as a
         * video. Null for pre-V16 meetings and YouTube imports; both play as
         * audio, which is what they did before this field existed.
         */
        String contentType,
        /** The project this meeting is filed under, or null for unfiled (V30). */
        String projectId,

        /**
         * When the recording was erased, or null (V35).
         *
         * <p>Sent so the page can say "you deleted this on the 3rd" instead of
         * "no audio" — which is also what it would have to say about a YouTube
         * import and about an upload still in flight. Three different situations
         * with one wrong sentence between them.
         */
        Instant audioDeletedAt,

        /** When the transcript was erased, or null. The notes outlive it. */
        Instant transcriptDeletedAt,

        /** When the person recording confirmed they had told the room, or null. */
        Instant consentConfirmedAt
) {
    public static MeetingResponse from(Meeting m) {
        return new MeetingResponse(
                m.getId(),
                m.getTitle(),
                m.getStatus(),
                m.getTags(),
                m.getAudioUrl(),
                m.getDurationSeconds(),
                m.getCreatedAt(),
                m.getErrorMessage(),
                m.getSourceType(),
                m.getSourceUrl(),
                m.getLanguage(),
                m.getSpokenLanguage(),
                m.getSummaryTemplate(),
                m.getContentType(),
                m.getProjectId(),
                m.getAudioDeletedAt(),
                m.getTranscriptDeletedAt(),
                m.getConsentConfirmedAt()
        );
    }
}
