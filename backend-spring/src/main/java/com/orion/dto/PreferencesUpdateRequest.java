package com.orion.dto;

import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.Size;

import java.util.List;

/**
 * Partial update of user preferences — a null field means "leave unchanged",
 * so the settings page can flip one toggle without resending the rest.
 */
public record PreferencesUpdateRequest(
        /** What this user is called in their own transcripts; blank clears it. */
        @Size(max = 120, message = "That name is too long")
        String displayName,
        /** Descriptive; blank clears. */
        @Size(max = 120, message = "That department is too long")
        String department,
        @Size(max = 120, message = "That role is too long")
        String jobRole,
        /**
         * How to refer to this person. Blank clears it.
         *
         * <p>Short by design: it holds "she/her", not a sentence. Nothing
         * validates the shape beyond the length, because there is no correct
         * list to check against.
         */
        @Size(max = 40, message = "Pronouns are shorter than that")
        String pronouns,
        /**
         * The account address.
         *
         * <p>Accepted only where Orion owns it. Under an identity provider
         * the column is a cache of the provider's fact and is rewritten from
         * the token on the next request, so an edit is refused there rather
         * than accepted and quietly undone.
         */
        @Email(message = "That doesn't look like an email address")
        @Size(max = 320, message = "That email address is too long")
        String email,
        /**
         * A profile picture as a {@code data:image/...;base64,...} URL, or an
         * empty string to remove it.
         *
         * <p>The size bound is the real check and it is generous on purpose:
         * the browser downscales to 256px before sending, so anything near the
         * ceiling did not come from this app's own uploader.
         */
        @Size(max = 262144, message = "That picture is too large")
        String avatarUrl,
        /**
         * ISO-639-1 code of the language meetings are held in; blank restores
         * auto-detect. Checked against the Language enum in the service, so an
         * unknown code is a 400 rather than a transcript in the wrong language.
         */
        @Size(max = 8, message = "That is not a language code")
        String defaultLanguage,

        /** How far back workspace chat reads. {@code chatReadsEverything} clears it. */
        @Min(value = 1, message = "Chat has to be able to read at least a day")
        @Max(value = 3650, message = "Ten years is the most Orion will look back")
        Integer chatHistoryDays,
        Boolean chatReadsEverything,

        /**
         * The five messages Recallix will send by mail. Null leaves one alone.
         *
         * <p>Booleans rather than a list of what is on, unlike
         * {@code mutedNotifications}, and the difference is deliberate: a bell
         * kind added later should ship switched on and visible, while a new
         * <em>email</em> added later must ship off. A list of what is enabled is
         * the shape that gets that right.
         *
         * <p>Two messages have no switch here and cannot be turned off: the
         * allowance being fully spent, and the account being closed. Neither is
         * a notification about the contents of an account -- they are terminal
         * facts about the account itself, and the second is sent after the row
         * holding these very columns has been deleted.
         */
        Boolean retentionWarningEmail,
        Boolean retentionAppliedEmail,
        Boolean taskReminderEmail,
        Boolean notesReadyEmail,
        Boolean allowanceEmail,

        /**
         * Notification kinds to switch off, replacing whatever was muted before.
         *
         * <p>The whole set rather than a delta, because the settings page holds
         * every switch on screen at once: sending "add PROCESSING_STARTED" from
         * a page that also shows the other nine invites the two to disagree.
         * Null leaves them alone; an empty list turns everything back on.
         *
         * <p>The bell is the only channel these govern; the five booleans
         * above are the other one, and the two are independent on purpose.
         * Muting a bell must not silence an email somebody switched on.
         */
        List<String> mutedNotifications
) {
}
