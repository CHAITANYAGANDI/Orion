package com.orion.dto;

import com.orion.entity.UserEntity;

import java.util.List;

/** Server-side user preferences (settings page). */
public record PreferencesResponse(
        /**
         * The account address.
         *
         * <p>Editable only where Orion owns it. Under an identity provider
         * {@code provision} rewrites this column from the sign-in token on the
         * next request, so an edit made there would appear to save and undo
         * itself a second later.
         */
        String email,
        /**
         * What this user is called in their own meetings, or null if never said.
         * The only thing that can turn a list of owners into "my tasks".
         */
        String displayName,
        /** Descriptive only — nothing routes by either. See V38. */
        String department,
        String jobRole,
        /** "she/her", "they/them", or null. Free text, never inferred. */
        String pronouns,
        /** The profile picture as a data URL, or null for initials. */
        String avatarUrl,
        /** ISO-639-1 spoken language, or null for auto-detect. */
        String defaultLanguage,
        /** How far back workspace chat reads transcripts; null is everything. */
        Integer chatHistoryDays,
        /**
         * Notification kinds switched off — the bell. Independent of the five
         * email switches below: muting one channel leaves the other alone.
         */
        List<String> mutedNotifications,
        /**
         * The five messages Recallix sends by mail. See V64 for why these are
         * booleans rather than a muted-list like the bell above, and for the
         * two messages that deliberately have no switch.
         */
        boolean retentionWarningEmail,
        boolean retentionAppliedEmail,
        boolean taskReminderEmail,
        boolean notesReadyEmail,
        boolean allowanceEmail
) {
    public static PreferencesResponse from(UserEntity user) {
        return new PreferencesResponse(
                user.getEmail(),
                user.getDisplayName(),
                user.getDepartment(),
                user.getJobRole(),
                user.getPronouns(),
                user.getAvatarUrl(),
                user.getDefaultLanguage(),
                user.getChatHistoryDays(),
                user.getMutedNotifications(),
                user.isRetentionWarningEmail(),
                user.isRetentionAppliedEmail(),
                user.isTaskReminderEmail(),
                user.isNotesReadyEmail(),
                user.isAllowanceEmail());
    }
}
