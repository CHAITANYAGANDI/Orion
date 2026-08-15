package com.recallix.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

/**
 * A question about one meeting.
 *
 * <p>{@code conversationId} is optional and means "add this to that thread".
 * Omitting it continues whichever thread was last used, or starts one — the
 * chat box is the primary control on the page, so asking must never require
 * having picked a conversation first.
 */
public record ChatAskRequest(
        @NotBlank @Size(max = 2000) String question,
        String conversationId
) {
}
