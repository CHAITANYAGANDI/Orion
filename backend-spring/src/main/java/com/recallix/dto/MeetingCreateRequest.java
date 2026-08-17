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
        String projectId,

        /**
         * The recorder confirming they told the room (V35).
         *
         * <p>Only the browser recorder sends this, and only because it is the
         * only client that was present when the recording started — an uploaded
         * file was captured somewhere Recallix was not there to ask. Absent and
         * false are the same thing and both mean "not asserted", which is the
         * honest state for every meeting that arrived any other way.
         *
         * <p>Recorded, not verified. It is the account holder's statement about
         * what they did, which is the only form this can take and is also the
         * only form anybody would ever want it in.
         */
        Boolean consentConfirmed,

        /**
         * The recorder saying this was captured here (V40).
         *
         * <p>Separate from {@code consentConfirmed} even though only the
         * recorder sends either, because that one is conditional on a tickbox
         * and this one is not — a recording made without confirming consent is
         * still a recording. Conflating them would have made the recap
         * preference depend on whether somebody ticked an unrelated box.
         *
         * <p>Absent is false, which reads as "arrived some other way". That is
         * right for every client that is not the recorder, including any future
         * one that never learns to send this.
         */
        Boolean recorded
) {

    /** Absent and false are the same thing: not captured here. */
    public boolean recordedHere() {
        return Boolean.TRUE.equals(recorded);
    }
    public List<String> tagsOrEmpty() {
        return tags == null ? List.of() : tags;
    }

    /** The override, or null when the filename-derived title should stand. */
    public String titleOverrideOrNull() {
        return title == null || title.isBlank() ? null : title.trim();
    }
}
