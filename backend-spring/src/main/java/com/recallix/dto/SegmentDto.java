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
        List<SpokenWord> words
) {
    public static SegmentDto from(TranscriptSegment s) {
        return new SegmentDto(
                s.getId(),
                s.getStartTime() == null ? 0.0 : s.getStartTime(),
                s.getEndTime() == null ? 0.0 : s.getEndTime(),
                s.getSpeaker(),
                s.getText(),
                s.getWords() == null ? List.of() : s.getWords()
        );
    }
}
