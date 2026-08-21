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
 *
 * <p>{@code mode} is Express or Advanced, the same choice the workspace chat
 * offers. Unparseable and absent both mean Express — see
 * {@link com.recallix.domain.ChatMode#of} — so a client that predates the field
 * keeps getting exactly the behaviour it got before.
 */
public record ChatAskRequest(
        @NotBlank @Size(max = 2000) String question,
        String conversationId,
        String mode
) {
}
