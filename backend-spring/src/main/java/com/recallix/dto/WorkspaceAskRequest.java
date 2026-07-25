package com.recallix.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

import java.util.List;

/**
 * A question asked across the whole workspace.
 *
 * <p>{@code meetingIds} is optional — when present the search is narrowed to
 * those meetings, otherwise it spans every meeting the user owns.
 */
public record WorkspaceAskRequest(
        @NotBlank @Size(max = 2000) String question,
        @Size(max = 50) List<String> meetingIds
) {
}
