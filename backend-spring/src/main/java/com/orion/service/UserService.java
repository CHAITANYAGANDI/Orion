package com.orion.service;

import com.orion.common.ApiException;
import com.orion.common.IdGenerator;
import com.orion.domain.Language;
import com.orion.domain.NotificationKind;
import com.orion.entity.UserEntity;
import com.orion.repository.UserRepository;
import org.springframework.beans.factory.annotation.Value;
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

    /**
     * {@code clerk} or {@code dev}, and the only thing that decides whether the
     * account address may be edited here.
     *
     * <p>Under a provider the column is a cache of the provider's fact:
     * {@link #provision} rewrites it from the token on the very next request.
     * Accepting an edit there would be a control that appeared to work and
     * silently reverted, which is worse than one that says no.
     */
    private final String authMode;

    public UserService(UserRepository users,
                       @Value("${orion.auth-mode:dev}") String authMode) {
        this.users = users;
        this.authMode = authMode == null ? "dev" : authMode;
    }

    /** True when sign-in belongs to somebody else, so the address does too. */
    private boolean addressOwnedByProvider() {
        return "clerk".equalsIgnoreCase(authMode);
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

    /**
     * Apply a partial preferences update. A null field is left alone; a blank
     * {@code recapEmail} or {@code displayName} clears it — recaps then fall
     * back to the account address, and My tasks goes back to not knowing who
     * you are.
     */
    @Transactional
    public UserEntity updatePreferences(String userId, PreferencesPatch patch) {
        UserEntity user = require(userId);
        if (patch.displayName() != null) {
            user.setDisplayName(patch.displayName().isBlank() ? null : patch.displayName().trim());
        }
        if (patch.department() != null) {
            user.setDepartment(patch.department().isBlank() ? null : patch.department().trim());
        }
        if (patch.jobRole() != null) {
            user.setJobRole(patch.jobRole().isBlank() ? null : patch.jobRole().trim());
        }
        if (patch.pronouns() != null) {
            user.setPronouns(patch.pronouns().isBlank() ? null : patch.pronouns().trim());
        }
        if (patch.email() != null) {
            user.setEmail(cleanAccountEmail(patch.email(), user.getEmail()));
        }
        if (patch.avatarUrl() != null) {
            user.setAvatarUrl(cleanAvatar(patch.avatarUrl()));
        }
        if (patch.defaultLanguage() != null) {
            user.setDefaultLanguage(resolveLanguage(patch.defaultLanguage()));
        }
        if (Boolean.TRUE.equals(patch.chatReadsEverything())) {
            user.setChatHistoryDays(null);
        } else if (patch.chatHistoryDays() != null) {
            user.setChatHistoryDays(patch.chatHistoryDays());
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
                        "Orion cannot transcribe " + raw.trim() + " yet."));
    }

    /**
     * The account address, when this deployment is allowed to change it.
     *
     * <p>Unchanged input is waved through rather than refused, because the
     * profile form sends every field it shows: a person editing their name
     * under an identity provider would otherwise be told they cannot change an
     * address they did not touch.
     */
    private String cleanAccountEmail(String raw, String current) {
        String value = raw.trim();
        if (value.equalsIgnoreCase(current == null ? "" : current)) {
            return current;
        }
        if (addressOwnedByProvider()) {
            throw ApiException.badRequest(
                    "Your email address is managed by your sign-in provider — change it there");
        }
        if (value.isBlank()) {
            throw ApiException.badRequest("An account needs an email address");
        }
        return value;
    }

    /**
     * A profile picture, or nothing, and never anything else.
     *
     * <p>This string is rendered straight into an {@code <img src>}, so what it
     * is allowed to be matters more than what it is allowed to weigh. Only an
     * inline base64 image passes.
     *
     * <p>An ordinary {@code https://} URL is rejected along with everything
     * else, and that is the point rather than an oversight: a remote image in a
     * profile is a tracking pixel that fires for every colleague who opens the
     * page, reporting their IP and the time they looked, to a host the account
     * owner chose. {@code javascript:} and {@code data:text/html} are the
     * sharper versions of the same hole.
     *
     * <p>No SVG either. It is an image everywhere else in a product and a
     * script host here: an uploaded SVG can carry a {@code script} element, and
     * it would run against whoever viewed the profile.
     */
    private String cleanAvatar(String raw) {
        String value = raw == null ? "" : raw.trim();
        if (value.isBlank()) {
            return null;  // an explicit "remove my picture"
        }
        for (String allowed : AVATAR_TYPES) {
            if (value.startsWith(allowed)) {
                return value;
            }
        }
        throw ApiException.badRequest("That is not an image Orion can store");
    }

    /** The inline image types a browser will render and this app produces. */
    private static final List<String> AVATAR_TYPES = List.of(
            "data:image/png;base64,",
            "data:image/jpeg;base64,",
            "data:image/webp;base64,");

    /**
     * The mutable half of the preferences, as its own type.
     *
     * <p>Twenty nullable arguments in a row is a call nobody can read and a
     * transposition nobody can see; this one is named at the call site.
     */
    public record PreferencesPatch(
            String displayName,
            String department,
            String jobRole,
            /** How this person asks to be referred to. Blank clears it. */
            String pronouns,
            /** The account address. Rejected when a provider owns it. */
            String email,
            /** A data-URL image, or blank to remove the picture. */
            String avatarUrl,
            String defaultLanguage,
            /** Null leaves the window; {@code chatReadsEverything} clears it. */
            Integer chatHistoryDays,
            Boolean chatReadsEverything,
            /** Bell kinds to switch off. Null leaves them; empty turns all on. */
            List<String> mutedNotifications
    ) {
    }
}
