package com.recallix.dto;

import jakarta.validation.constraints.NotBlank;

/**
 * DELETE /api/v1/privacy/account.
 *
 * <p>A body on a DELETE, which is unusual and is the point: the confirmation
 * has to be something a client constructed deliberately. A query parameter would
 * end up in a browser history, a proxy log and anything that follows a link, and
 * this is the one endpoint in Recallix that cannot be undone.
 */
public record AccountCloseRequest(
        /** Must read "delete everything", trimmed and case-insensitive. */
        @NotBlank String confirm
) {
}
