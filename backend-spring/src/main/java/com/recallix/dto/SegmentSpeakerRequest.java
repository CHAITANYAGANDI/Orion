package com.recallix.dto;

import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;

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
 */
public record SegmentSpeakerRequest(
        /**
         * The canonical speaker to move these words to ("spk_2"), which must
         * already exist in this meeting. Not a display name: names are not
         * unique — two people can both be called Chris — and the key is what
         * survives a rename.
         */
        @NotBlank(message = "Choose a speaker") String speakerKey,

        /** First word to move, zero-based and inclusive. Null means the whole segment. */
        @Min(value = 0, message = "Word positions start at 0") Integer fromWord,

        /** Last word to move, zero-based and inclusive. Null means the whole segment. */
        @Min(value = 0, message = "Word positions start at 0") Integer toWord
) {
    /** True when only part of the turn is moving and the segment must be split. */
    public boolean isPartial() {
        return fromWord != null || toWord != null;
    }
}
