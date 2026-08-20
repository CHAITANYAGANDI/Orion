package com.recallix.dto;

import com.recallix.domain.SpokenWord;
import com.recallix.entity.TranscriptSegment;

import java.util.List;

/** Transcript segment — matches api-contracts §5 (start/end/speaker/text). */
public record SegmentDto(
        /** Addresses this segment when the user edits its text. */
        String id,
        double start,
        double end,
        String speaker,
        String text,
        /**
         * Per-word timings. Empty for transcripts recorded before V13, which
         * the client renders by estimating from the segment span instead.
         */
        List<SpokenWord> words,
        /**
         * Set only when this line is in a different language from the meeting's.
         * Null for the overwhelmingly common monolingual case, so the UI marks
         * exceptions rather than tagging every line.
         */
        String language,
        /**
         * Meeting-local speaker identity ("spk_2"), stable across renames.
         *
         * <p>The client colours by this rather than by the display name, so
         * renaming Speaker 2 to Sarah does not also recolour her. Null for
         * transcripts recorded before V46, where the client falls back to the
         * name and behaves exactly as it did.
         */
        String speakerKey,
        /**
         * {@code attributed} or {@code unknown}. An unknown turn is drawn as
         * unattributed rather than being given a speaker number it has no
         * claim to.
         */
        String speakerStatus
) {
    public static SegmentDto from(TranscriptSegment s) {
        return new SegmentDto(
                s.getId(),
                s.getStartTime() == null ? 0.0 : s.getStartTime(),
                s.getEndTime() == null ? 0.0 : s.getEndTime(),
                s.getSpeaker(),
                s.getText(),
                s.getWords() == null ? List.of() : s.getWords(),
                s.getLanguage(),
                s.getSpeakerKey(),
                s.getSpeakerStatus()
        );
    }
}
