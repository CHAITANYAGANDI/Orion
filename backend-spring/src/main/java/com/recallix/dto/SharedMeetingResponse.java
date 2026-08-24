package com.recallix.dto;

import java.time.Instant;
import java.util.List;

/**
 * The redacted, unauthenticated view of a shared meeting.
 *
 * <p>Deliberately its own shape rather than a filtered {@link MeetingResponse}:
 * this is what an anonymous visitor sees, so it must never carry the owner's id,
 * storage keys, or internal status. Adding a field to an internal DTO must not
 * silently widen what is public.
 *
 * <p>The nested records exist for the same reason — the internal
 * {@code ActionItemResponse} and friends all expose database identifiers that a
 * share recipient has no business seeing.
 *
 * <p><b>Absent means withheld, and nothing says which.</b> A section the owner
 * did not share arrives as null or empty, exactly as it would for a meeting that
 * has none. The page renders what it was given without announcing "the summary
 * was hidden from you", because that sentence tells a recipient there is
 * something worth asking for.
 */
public record SharedMeetingResponse(
        String title,
        Instant meetingDate,
        Integer durationSeconds,
        String shortSummary,
        String detailedSummary,
        List<String> keyPoints,
        List<SharedActionItem> actionItems,
        /** Null unless the owner opted into sharing the verbatim transcript. */
        String transcript,
        /**
         * Short-lived presigned media URL, null unless the recording was
         * shared. Presigned rather than proxied so the audio does not stream
         * through the API, and short-lived so a copied {@code <audio src>}
         * stops working long before the link does.
         */
        String audioUrl,

        /** Set when this link points at one excerpt: the player and the
         *  transcript are both bounded to it. */
        Double startSeconds,
        Double endSeconds,
        /** The words the excerpt was made from, as they read when it was shared. */
        String quote
) {

    public record SharedActionItem(String title, String ownerName, String dueDate) {}
}
