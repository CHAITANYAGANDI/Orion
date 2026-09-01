package com.reverie.dto;

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
         * file was captured somewhere Reverie was not there to ask. Absent and
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
        Boolean recorded,

        /**
         * How many people to expect, when the person uploading knows (V45).
         *
         * <p>Null is "auto", and auto is the default and the overwhelmingly
         * common answer. These become <em>hard constraints</em> at the
         * transcription provider: an exact count forces diarization to find
         * that many voices whether or not that many spoke, so a wrong two
         * splits a conversation into four people or merges four into two.
         *
         * <p>Which is why nothing infers them. A calendar invitation with four
         * attendees is not four speakers — two of them were listening — and
         * Reverie will not turn an invitation into a constraint on somebody's
         * transcript. A human says this or nobody does.
         *
         * <p>A range is the middle setting and the one worth offering: people
         * know roughly how many were in the room, not exactly how many spoke.
         */
        Integer expectedSpeakersMin,
        Integer expectedSpeakersMax
) {

    /** Absent and false are the same thing: not captured here. */
    public boolean recordedHere() {
        return Boolean.TRUE.equals(recorded);
    }
    public List<String> tagsOrEmpty() {
        return tags == null ? List.of() : tags;
    }

    /**
     * The speaker constraint, sanitised, or null for automatic.
     *
     * <p>Out-of-range numbers become null rather than a rejected upload: the
     * provider accepts 1..10, and somebody who typed 40 has said something
     * meaningless rather than something worth refusing a recording over.
     */
    public int[] expectedSpeakerRangeOrNull() {
        Integer low = inRange(expectedSpeakersMin);
        Integer high = inRange(expectedSpeakersMax);
        if (low == null && high == null) {
            return null;
        }
        if (low != null && high != null && low > high) {
            return new int[]{high, low};
        }
        return new int[]{low == null ? 0 : low, high == null ? 0 : high};
    }

    private static Integer inRange(Integer value) {
        return value != null && value >= 1 && value <= 10 ? value : null;
    }

    /** The override, or null when the filename-derived title should stand. */
    public String titleOverrideOrNull() {
        return title == null || title.isBlank() ? null : title.trim();
    }
}
