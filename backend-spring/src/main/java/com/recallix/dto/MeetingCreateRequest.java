package com.recallix.dto;

import jakarta.validation.constraints.NotBlank;

import java.util.List;

/**
 * POST /api/v1/meetings — created after the client uploads to the presigned URL.
 *
 * <p>Carries almost nothing on purpose. Confirming an upload should be one
 * click, so the meeting is named after the file that was uploaded (done at
 * presign time) and everything else is edited afterwards on the meeting itself,
 * where the person can already see what the meeting turned out to be. Asking
 * for a title and a tag list before anyone has heard a word of it produced
 * mostly-empty metadata and one more form between a user and their transcript.
 *
 * <p>{@code title} therefore stays only as an override for clients that have a
 * better name than the filename — the recorder, whose files are called
 * {@code recording-1755084000000.webm}. Blank or absent keeps the filename.
 */
public record MeetingCreateRequest(
        @NotBlank String objectKey,
        /** Optional override; blank or absent keeps the filename-derived title. */
        String title,
        List<String> tags,
        String contentType,
        Integer durationSeconds,
        /**
         * Which summary shape to write these notes in. Null means General, so a
         * client that does not offer the picker still creates meetings.
         */
        String summaryTemplate,

        /**
         * File it as it arrives (V30). Null leaves it unfiled.
         *
         * <p>The one piece of metadata worth asking for up front, and the
         * exception to everything said above: whoever is uploading knows which
         * project this belongs to before they have heard a word of it, and
         * filing later means going back through a list of things you have
         * already dealt with.
         */
        String projectId
) {
    public List<String> tagsOrEmpty() {
        return tags == null ? List.of() : tags;
    }

    /** The override, or null when the filename-derived title should stand. */
    public String titleOverrideOrNull() {
        return title == null || title.isBlank() ? null : title.trim();
    }
}
