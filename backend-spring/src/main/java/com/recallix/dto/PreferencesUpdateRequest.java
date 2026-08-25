package com.recallix.dto;

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
         * How to refer to this person. Blank clears it.
         *
         * <p>Short by design: it holds "she/her", not a sentence. Nothing
         * validates the shape beyond the length, because there is no correct
         * list to check against.
         */
        @Size(max = 40, message = "Pronouns are shorter than that")
        String pronouns,
        /**
         * The account address itself, not {@code recapEmail}.
         *
         * <p>Accepted only where Recallix owns it. Under an identity provider
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

        /**
         * Days until a new link expires. The same bound as the per-link field,
         * so a default cannot be set that creating a link would then refuse.
        @Min(value = 1, message = "A link has to last at least a day")
        @Max(value = 365, message = "A link can last at most a year")

        /** How far back workspace chat reads. {@code chatReadsEverything} clears it. */
        @Min(value = 1, message = "Chat has to be able to read at least a day")
        @Max(value = 3650, message = "Ten years is the most Recallix will look back")
        Integer chatHistoryDays,
        Boolean chatReadsEverything,

        /** "Event reminder": the every-morning deadline mail. */
        Boolean taskReminders,
        /**
         * "Weekly digest": the Monday review (V43).
         *
         * <p>Its own switch rather than a cadence for {@code taskReminders}. The
         * pair used to be exclusive, which meant somebody who wanted a daily
         * prompt and a weekly look back could have only one of them.
         */
        Boolean weeklyDigest,

        /**
         * The master switch over automatic email (V40).
         *
         * <p>Deliberately does not clear the switches underneath it. Somebody
         * turning everything off for a fortnight and back on again expects to
         * find their choices where they left them, and a master that rewrote
         * them would make that a one-way door.
         */
        Boolean emailsEnabled,
        /** Recap for imported meetings; {@code autoEmailRecap} covers recorded ones. */
        Boolean recapForImports,

        /** "Comments": email when a comment lands on an action item (V43). */
        Boolean commentEmail,
        /** "Highlights": email when a highlight is added to a transcript (V43). */
        Boolean highlightEmail,

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
