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
        /** What a NEW share link is set to. Existing links keep their own. */
        boolean shareIncludeSummary,
        boolean shareIncludeActionItems,
        boolean shareIncludeTranscript,
        boolean shareIncludeAudio,
        /** Days until a new link expires, or null for never. */
        Integer shareExpiryDays,
        /** How far back workspace chat reads transcripts; null is everything. */
        Integer chatHistoryDays,
        boolean taskReminders,
        /** Mondays rather than every morning. Only read when taskReminders is on. */
        boolean digestWeekly,
        /** The master switch over automatic email (V40). */
        boolean emailsEnabled,
        /** Recap for meetings imported as a file or link; autoEmailRecap covers recorded ones. */
        boolean recapForImports,
        /** Email when somebody opens a link you published. */
        boolean shareOpenedEmail,
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
                user.isShareIncludeSummary(),
                user.isShareIncludeActionItems(),
                user.isShareIncludeTranscript(),
                user.isShareIncludeAudio(),
                user.getShareExpiryDays(),
                user.getChatHistoryDays(),
                user.isTaskReminders(),
                user.isDigestWeekly(),
                user.isEmailsEnabled(),
                user.isRecapForImports(),
                user.isShareOpenedEmail(),
                user.getMutedNotifications());
    }
}
