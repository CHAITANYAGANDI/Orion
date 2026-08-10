package com.recallix.dto;

import jakarta.validation.constraints.NotBlank;

import java.util.List;

/** POST /api/v1/meetings — created after the client uploads to the presigned URL. */
public record MeetingCreateRequest(
        @NotBlank String objectKey,
        @NotBlank String title,
        List<String> participants,
        List<String> tags,
        String contentType,
        Integer durationSeconds,
        /**
         * Which summary shape to write these notes in. Null means General, so a
         * client that does not offer the picker still creates meetings.
         */
        String summaryTemplate
) {
    public List<String> participantsOrEmpty() {
        return participants == null ? List.of() : participants;
    }

    public List<String> tagsOrEmpty() {
        return tags == null ? List.of() : tags;
    }
}
