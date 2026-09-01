package com.reverie.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

import java.util.List;

/**
 * A question asked across the whole workspace.
 *
 * <p>{@code meetingIds} is optional — when present the search is narrowed to
 * those meetings, otherwise it spans every meeting the user owns.
 *
 * <p>{@code conversationId} is optional and means "add this to that thread".
 * Omitting it continues whichever thread was last used, or starts one.
 *
 * <p>{@code meetingIds} is also what the composer's "Add context" produces: a
 * question asked with three calls picked out is the same question narrowed, not
 * a different endpoint.
 */
public record WorkspaceAskRequest(
        @NotBlank @Size(max = 2000) String question,
        @Size(max = 50) List<String> meetingIds,
        String conversationId,
        /**
         * How hard to look — {@code express} or {@code advanced}.
         *
         * <p>Null means express, which is exactly what every caller got before
         * this field existed. See {@link com.reverie.domain.ChatMode}.
         */
        String mode
) {
}
