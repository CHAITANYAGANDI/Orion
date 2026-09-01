package com.reverie.dto;

import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.NotBlank;

import java.util.List;

/**
 * PATCH /api/v1/meetings/{id}/segments — correct what the transcriber heard.
 *
 * <p>A batch of edits rather than one per request: a user fixing a recurring
 * misheard name changes six lines in one pass, and each save re-indexes the
 * meeting for retrieval. Six requests would mean six re-indexes of the same
 * transcript to reach the same end state.
 *
 * <p>Segments are addressed by id, not by position. Position would be wrong the
 * moment anything reordered them, and an edit landing on the wrong line is a
 * silent corruption of the record.
 */
public record TranscriptEditRequest(
        @NotEmpty(message = "Nothing to save") List<SegmentEdit> edits
) {
    /**
     * One corrected line. Text only: timings come from the recording and the
     * speaker has its own rename flow, so neither is a typing correction.
     */
    public record SegmentEdit(
            @NotBlank(message = "A segment cannot be emptied") String id,
            @NotBlank(message = "A segment cannot be emptied") String text
    ) {
    }
}
