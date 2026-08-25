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
        /** "she/her", "they/them", or null. Free text, never inferred. */
        String pronouns,
        /** The profile picture as a data URL, or null for initials. */
        String avatarUrl,
        /** ISO-639-1 spoken language, or null for auto-detect. */
        String defaultLanguage,
        /** How far back workspace chat reads transcripts; null is everything. */
        Integer chatHistoryDays,
        /** "Event reminder": every morning, what is overdue or due soon. */
        boolean taskReminders,
        /** "Weekly digest": the Monday review. Independent of taskReminders since V43. */
        boolean weeklyDigest,
        /** The master switch over automatic email (V40). */
        boolean emailsEnabled,
        /** Recap for meetings imported as a file or link; autoEmailRecap covers recorded ones. */
        boolean recapForImports,
        /** "Conversation shared": somebody outside opened a link you published. */
        /** "Comments": a comment landed on an action item. At most one a day (V43). */
        boolean commentEmail,
        /** "Highlights": a highlight was added to a transcript. At most one a day (V43). */
        boolean highlightEmail,
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
                user.getPronouns(),
                user.getAvatarUrl(),
                user.getDefaultLanguage(),
                user.getChatHistoryDays(),
                user.isTaskReminders(),
                user.isWeeklyDigest(),
                user.isEmailsEnabled(),
                user.isRecapForImports(),
                user.isCommentEmail(),
                user.isHighlightEmail(),
                user.getMutedNotifications());
    }
}
