package com.recallix.dto;

import com.recallix.domain.MomentRange;
import jakarta.validation.constraints.Size;

import java.util.List;

/**
 * Marking a passage, or a moment, in a transcript.
 *
 * <p>The client sends the ranges because only the client knows them: they come
 * from a DOM selection over rendered word spans, and the server has no view of
 * where the user's mouse stopped. It sends the quote for the same reason —
 * reconstructing it from the offsets would mean re-reading the segments to
 * produce text the browser already had, and would disagree with what the user
 * saw the moment either side rounds a boundary differently.
 *
 * <p>{@code kind} is required on create and ignored on update, matching
 * {@link InsightRequest}: turning a highlight into a note is not an edit to the
 * highlight, and letting it happen would move an annotation out of the list the
 * user expects to find it in.
 */
public record MomentRequest(
        String kind,
        List<MomentRange> ranges,
        @Size(max = 5000) String quote,
        @Size(max = 5000) String body,
        String speaker,
        Double startSeconds,
        Double endSeconds
) {
    public String normalizedKind() {
        String k = kind == null ? "" : kind.trim().toUpperCase();
        return switch (k) {
            case "BOOKMARK" -> "BOOKMARK";
            case "NOTE" -> "NOTE";
            case "REACTION" -> "REACTION";
            default -> "HIGHLIGHT";
        };
    }
}
