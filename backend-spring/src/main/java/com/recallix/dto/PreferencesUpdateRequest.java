package com.recallix.dto;

import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.Size;

/**
 * Partial update of user preferences — a null field means "leave unchanged",
 * so the settings page can flip one toggle without resending the rest.
 */
public record PreferencesUpdateRequest(
        Boolean autoEmailRecap,
        @Email(message = "That doesn't look like an email address")
        @Size(max = 320, message = "That email address is too long")
        String recapEmail
) {
}
