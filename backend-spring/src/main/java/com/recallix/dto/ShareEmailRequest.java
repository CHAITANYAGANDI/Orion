package com.recallix.dto;

import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.Size;

import java.util.List;

/**
 * Send an existing share link to some people.
 *
 * <p><b>This is delivery, not access control.</b> Naming an address does not
 * grant that address anything — the link is a capability URL and works for
 * whoever holds it, forwarded or not. Calling it an invitation would be a lie
 * the recipient could not detect and the owner would rely on; the UI says
 * "email this link" for the same reason.
 *
 * <p>The recipient cap is not a product limit. An authenticated endpoint that
 * sends arbitrary text to arbitrary addresses from the workspace's own mail
 * server is a spam relay with extra steps, and a small ceiling keeps one
 * compromised account from being worth much.
 */
public record ShareEmailRequest(
        @NotEmpty(message = "Add at least one email address")
        @Size(max = 10, message = "You can send this to at most 10 addresses at once")
        List<@Email(message = "That does not look like an email address") String> to,

        /** A line of context — "here's the call from Tuesday". */
        @Size(max = 500) String message
) {
}
