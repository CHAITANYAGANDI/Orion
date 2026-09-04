package com.reverie.dto;

import jakarta.validation.constraints.NotBlank;

/**
 * POST /api/v1/meetings/{id}/speakers/merge — two labels, one person.
 *
 * <p>Diarization splits one voice across two speakers more often than it merges
 * two into one, usually across a long pause, a change in mic level, or somebody
 * moving away from the microphone and back. The transcript then shows a person
 * apparently interrupting themselves.
 *
 * <p>Renaming cannot fix that. {@code PATCH /speakers} changes what a speaker is
 * <em>called</em>; renaming both labels to "Priya" leaves two canonical speakers
 * wearing one name, which is the state that gives one person two colours, two
 * talk-time rows, and — because {@code app.naming} refuses a name claimed by two
 * speakers — no inferred name at all. This changes who owns the turns.
 *
 * <h2>Keys, not names</h2>
 *
 * <p>Both sides are {@code speaker_key}s ("spk_3"), for the same reason
 * {@link SegmentSpeakerRequest} takes one: display names are not unique — two
 * people in a meeting can both be called Chris — and the key is the identity
 * that survives a rename.
 *
 * <h2>What it does not touch</h2>
 *
 * <p>{@code speaker_raw} stays exactly as the provider set it on every moved
 * turn. It is the record of what the transcription service actually said, and a
 * merge is Reverie's decision rather than a correction to that record — keeping
 * it is what makes a mistaken merge diagnosable afterwards.
 *
 * <p>There is no un-merge. The two labels become one and the original boundary
 * between them is not stored, so the way back is Reprocess meeting, which
 * re-runs diarization from the audio.
 */
public record SpeakerMergeRequest(
        /** The speaker being folded away. Every turn it owns moves. */
        @NotBlank(message = "Choose the speaker to merge") String fromSpeakerKey,

        /** The speaker that absorbs them, and whose name the merged turns take. */
        @NotBlank(message = "Choose the speaker to merge into") String intoSpeakerKey
) {

    public String from() {
        return fromSpeakerKey == null ? "" : fromSpeakerKey.trim();
    }

    public String into() {
        return intoSpeakerKey == null ? "" : intoSpeakerKey.trim();
    }

    /** Merging somebody into themselves is a typo, not an operation. */
    public boolean isSelfMerge() {
        return from().equals(into());
    }
}
