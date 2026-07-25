package com.recallix.dto;

import com.recallix.entity.TranscriptSegment;

/** Transcript segment — matches api-contracts §5 (start/end/speaker/text). */
public record SegmentDto(
        double start,
        double end,
        String speaker,
        String text
) {
    public static SegmentDto from(TranscriptSegment s) {
        return new SegmentDto(
                s.getStartTime() == null ? 0.0 : s.getStartTime(),
                s.getEndTime() == null ? 0.0 : s.getEndTime(),
                s.getSpeaker(),
                s.getText()
        );
    }
}
