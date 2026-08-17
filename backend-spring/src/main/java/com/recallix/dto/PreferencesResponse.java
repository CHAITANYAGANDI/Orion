package com.recallix.dto;

import com.recallix.entity.UserEntity;

import java.util.List;

/** Server-side user preferences (settings page). */
public record PreferencesResponse(
        /**
         * The address the sign-in provider gave us, or null.
         *
         * <p>Read-only here on purpose: it is Clerk's fact, not ours, and a dev
         * session has no provider and therefore no address at all. The editable
         * one is {@code recapEmail} — where mail should actually go.
         */
        String email,
        boolean autoEmailRecap,
        /** The override address, or null when recaps go to the account email. */
        String recapEmail,
        /** Where recaps would actually be sent — shown so the choice is unambiguous. */
        String effectiveRecapEmail,
        /**
         * What this user is called in their own meetings, or null if never said.
         * The only thing that can turn a list of owners into "my tasks".
         */
        String displayName,
        /** Descriptive only — nothing routes by either. See V38. */
        String department,
        String jobRole,
        /** ISO-639-1 spoken language, or null for auto-detect. */
        String defaultLanguage,
        boolean taskReminders,
        /** Notification kinds switched off. Everything absent from this is on. */
        List<String> mutedNotifications
) {
    public static PreferencesResponse from(UserEntity user) {
        return new PreferencesResponse(
                user.getEmail(),
                user.isAutoEmailRecap(),
                user.getRecapEmail(),
                user.effectiveRecapEmail(),
                user.getDisplayName(),
                user.getDepartment(),
                user.getJobRole(),
                user.getDefaultLanguage(),
                user.isTaskReminders(),
                user.getMutedNotifications());
    }
}
