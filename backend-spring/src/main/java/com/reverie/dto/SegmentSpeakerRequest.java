package com.reverie.dto;

import jakarta.validation.constraints.Min;

/**
 * PATCH /api/v1/meetings/{id}/segments/{segmentId}/speaker — move one turn, or
 * part of one, to a different speaker.
 *
 * <p>Distinct from the rename flow on purpose. {@code PATCH /speakers} answers
 * "this voice is called Sarah" and changes every turn that voice has; this
 * answers "these words were not that voice" and changes nothing else. Merging
 * the two would mean a user correcting one misheard line could not avoid
 * relabelling the whole meeting.
 *
 * <h2>The word range</h2>
 *
 * <p>Omit {@code fromWord}/{@code toWord} and the whole segment moves. Supply
 * them and the segment is split so that only those words move, because the case
 * this exists for is a short reply the transcription provider buried inside
 * somebody else's turn — "Yes, sir." sitting at words 8-9 of a 24-word
 * utterance. Without a range there would be nothing a user could do about that
 * except retype two transcripts.
 *
 * <p>Indices are zero-based and inclusive of both ends, addressing the segment's
 * own {@code words} array as the client received it. A range on a segment with
 * no per-word timings is refused rather than guessed: there is nothing to split
 * on, and splitting by character offset would put the boundary in a place no
 * audio corresponds to.
 *
 * <h2>Two targets, exactly one of them</h2>
 *
 * <p>Usually the words belong to somebody already in the meeting, and
 * {@code speakerKey} names them. Sometimes they belong to a person diarization
 * never separated out at all — a fifth voice the provider folded into Speaker 1
 * — and there is no key to send. {@code newSpeaker} says so, and the server
 * allocates the next canonical identity for this meeting.
 *
 * <p>This is one operation with two ways of naming its destination rather than
 * two endpoints, because everything after the destination is decided is
 * identical: the same word range, the same split, the same re-index, the same
 * stale summary. A second endpoint would be a second copy of all of it.
 *
 * <p>Exactly one must be supplied. Both is ambiguous — it would be asking to
 * move words to an existing speaker *and* to a new one — and neither leaves the
 * server guessing at the destination. Both are refused rather than resolved by
 * precedence, because a precedence rule is a silent answer to a question the
 * client got wrong.
 */
public record SegmentSpeakerRequest(
        /**
         * The canonical speaker to move these words to ("spk_2"), which must
         * already exist in this meeting. Not a display name: names are not
         * unique — two people can both be called Chris — and the key is what
         * survives a rename.
         */
        String speakerKey,

        /**
         * Move the words to a person who is not in this meeting yet.
         *
         * <p>Null or false means {@code speakerKey} decides. True means the
         * server allocates the next canonical key and a matching
         * {@code Speaker N} display name — a meeting-local identity and nothing
         * more. Reverie has no cross-meeting speaker record for this to become,
         * and does not gain one here.
         */
        Boolean newSpeaker,

        /** First word to move, zero-based and inclusive. Null means the whole segment. */
        @Min(value = 0, message = "Word positions start at 0") Integer fromWord,

        /** Last word to move, zero-based and inclusive. Null means the whole segment. */
        @Min(value = 0, message = "Word positions start at 0") Integer toWord
) {
    /**
     * The ordinary shape: move words to a speaker who already exists.
     *
     * <p>Kept so that adding the new-speaker mode did not rewrite every caller
     * that only ever meant this one. JSON never uses it — deserialisation goes
     * through the canonical constructor — so it exists for readability at the
     * call sites that build a request by hand.
     */
    public SegmentSpeakerRequest(String speakerKey, Integer fromWord, Integer toWord) {
        this(speakerKey, null, fromWord, toWord);
    }

    /** True when only part of the turn is moving and the segment must be split. */
    public boolean isPartial() {
        return fromWord != null || toWord != null;
    }

    /** True when the destination is a speaker who does not exist yet. */
    public boolean isNewSpeaker() {
        return Boolean.TRUE.equals(newSpeaker);
    }

    public String trimmedKey() {
        return speakerKey == null ? "" : speakerKey.trim();
    }

    /**
     * @return an error message when this is not one of the two supported
     *         shapes, or null when it is.
     */
    public String targetProblem() {
        boolean existing = !trimmedKey().isEmpty();
        if (existing && isNewSpeaker()) {
            return "Send either speakerKey or newSpeaker, not both";
        }
        if (!existing && !isNewSpeaker()) {
            return "Choose a speaker";
        }
        return null;
    }
}
