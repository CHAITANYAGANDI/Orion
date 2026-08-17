package com.recallix.dto;

import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.Size;

import java.util.List;

/**
 * Partial update of user preferences — a null field means "leave unchanged",
 * so the settings page can flip one toggle without resending the rest.
 */
public record PreferencesUpdateRequest(
        Boolean autoEmailRecap,
        @Email(message = "That doesn't look like an email address")
        @Size(max = 320, message = "That email address is too long")
        String recapEmail,
        /** What this user is called in their own transcripts; blank clears it. */
        @Size(max = 120, message = "That name is too long")
        String displayName,
        /** Descriptive; blank clears. */
        @Size(max = 120, message = "That department is too long")
        String department,
        @Size(max = 120, message = "That role is too long")
        String jobRole,
        /**
         * ISO-639-1 code of the language meetings are held in; blank restores
         * auto-detect. Checked against the Language enum in the service, so an
         * unknown code is a 400 rather than a transcript in the wrong language.
         */
        @Size(max = 8, message = "That is not a language code")
        String defaultLanguage,
        Boolean taskReminders,
        /**
         * Notification kinds to switch off, replacing whatever was muted before.
         *
         * <p>The whole set rather than a delta, because the settings page holds
         * every switch on screen at once: sending "add PROCESSING_STARTED" from
         * a page that also shows the other nine invites the two to disagree.
         * Null leaves them alone; an empty list turns everything back on.
         */
        List<String> mutedNotifications
) {
}
