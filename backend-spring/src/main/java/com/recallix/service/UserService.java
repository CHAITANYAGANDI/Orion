package com.recallix.service;

import com.recallix.common.ApiException;
import com.recallix.common.IdGenerator;
import com.recallix.domain.Language;
import com.recallix.domain.NotificationKind;
import com.recallix.entity.UserEntity;
import com.recallix.repository.UserRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.stream.Collectors;

/** Maps Clerk (or dev) identities to local user rows and provisions on first use. */
@Service
public class UserService {

    private final UserRepository users;

    public UserService(UserRepository users) {
        this.users = users;
    }

    /** Upsert a local user for the given Clerk (or dev) subject; returns local user id. */
    @Transactional
    public String provision(String clerkUserId, String email) {
        UserEntity user = users.findByClerkUserId(clerkUserId).orElseGet(() -> {
            UserEntity u = new UserEntity();
            u.setId(IdGenerator.user());
            u.setClerkUserId(clerkUserId);
            u.setEmail(email);
            u.setPlan("FREE");
            return users.save(u);
        });
        if (email != null && !email.equals(user.getEmail())) {
            user.setEmail(email);
        }
        return user.getId();
    }

    @Transactional(readOnly = true)
    public UserEntity require(String userId) {
        return users.findById(userId)
                .orElseThrow(() -> ApiException.unauthorized("Unknown user"));
    }

    @Transactional
    public void updatePlan(String userId, String plan) {
        UserEntity user = require(userId);
        user.setPlan(plan);
    }

    /**
     * Apply a partial preferences update. A null field is left alone; a blank
     * {@code recapEmail} or {@code displayName} clears it — recaps then fall
     * back to the account address, and My tasks goes back to not knowing who
     * you are.
     */
    @Transactional
    public UserEntity updatePreferences(String userId, PreferencesPatch patch) {
        UserEntity user = require(userId);
        if (patch.autoEmailRecap() != null) {
            user.setAutoEmailRecap(patch.autoEmailRecap());
        }
        if (patch.recapEmail() != null) {
            user.setRecapEmail(patch.recapEmail().isBlank() ? null : patch.recapEmail().trim());
        }
        if (patch.displayName() != null) {
            user.setDisplayName(patch.displayName().isBlank() ? null : patch.displayName().trim());
        }
        if (patch.department() != null) {
            user.setDepartment(patch.department().isBlank() ? null : patch.department().trim());
        }
        if (patch.jobRole() != null) {
            user.setJobRole(patch.jobRole().isBlank() ? null : patch.jobRole().trim());
        }
        if (patch.defaultLanguage() != null) {
            user.setDefaultLanguage(resolveLanguage(patch.defaultLanguage()));
        }
        if (patch.shareIncludeSummary() != null) {
            user.setShareIncludeSummary(patch.shareIncludeSummary());
        }
        if (patch.shareIncludeActionItems() != null) {
            user.setShareIncludeActionItems(patch.shareIncludeActionItems());
        }
        if (patch.shareIncludeTranscript() != null) {
            user.setShareIncludeTranscript(patch.shareIncludeTranscript());
        }
        if (patch.shareIncludeAudio() != null) {
            user.setShareIncludeAudio(patch.shareIncludeAudio());
        }
        // "Never" and "unchanged" are both an absent number, so the flag is
        // what distinguishes them — the same problem, and the same answer, as
        // removing a password from a share link.
        if (Boolean.TRUE.equals(patch.shareNeverExpires())) {
            user.setShareExpiryDays(null);
        } else if (patch.shareExpiryDays() != null) {
            user.setShareExpiryDays(patch.shareExpiryDays());
        }
        if (Boolean.TRUE.equals(patch.chatReadsEverything())) {
            user.setChatHistoryDays(null);
        } else if (patch.chatHistoryDays() != null) {
            user.setChatHistoryDays(patch.chatHistoryDays());
        }
        if (patch.taskReminders() != null) {
            user.setTaskReminders(patch.taskReminders());
            // Turning them back on should send today's digest rather than wait
            // for tomorrow, so the switch visibly does something.
            if (patch.taskReminders()) {
                user.setTaskReminderSentOn(null);
            }
        }
        if (patch.mutedNotifications() != null) {
            // Stored as the enum's own spelling and nothing else. An unknown
            // string here would be a mute nobody could ever undo from the
            // settings page, because the switch it belongs to does not exist.
            user.setMutedNotifications(patch.mutedNotifications().stream()
                    .map(NotificationKind::find)
                    .flatMap(Optional::stream)
                    .filter(NotificationKind::mutable)
                    .map(NotificationKind::name)
                    .distinct()
                    .collect(Collectors.toCollection(ArrayList::new)));
        }
        return user;
    }

    /**
     * The language meetings are held in, normalised, or null for auto-detect.
     *
     * <p>Refused rather than ignored when it is not a language transcription
     * supports. Silently dropping it would leave the settings page showing a
     * choice the pipeline never received, and the difference is a transcript in
     * the wrong language — the exact failure the setting exists to prevent.
     */
    private String resolveLanguage(String raw) {
        if (raw.isBlank()) {
            return null;
        }
        return Language.find(raw)
                .map(Language::code)
                .orElseThrow(() -> ApiException.badRequest(
                        "Recallix cannot transcribe " + raw.trim() + " yet."));
    }

    /**
     * The mutable half of the preferences, as its own type.
     *
     * <p>Sixteen nullable arguments in a row is a call nobody can read and a
     * transposition nobody can see; this one is named at the call site.
     */
    public record PreferencesPatch(
            Boolean autoEmailRecap,
            String recapEmail,
            String displayName,
            String department,
            String jobRole,
            String defaultLanguage,
            Boolean shareIncludeSummary,
            Boolean shareIncludeActionItems,
            Boolean shareIncludeTranscript,
            Boolean shareIncludeAudio,
            /** Null leaves the expiry; {@code shareNeverExpires} clears it. */
            Integer shareExpiryDays,
            Boolean shareNeverExpires,
            /** Null leaves the window; {@code chatReadsEverything} clears it. */
            Integer chatHistoryDays,
            Boolean chatReadsEverything,
            Boolean taskReminders,
            /** Notification kinds to switch off. Null leaves them; empty turns all on. */
            List<String> mutedNotifications
    ) {
    }
}
