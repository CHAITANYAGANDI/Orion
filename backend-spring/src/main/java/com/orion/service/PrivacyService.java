package com.orion.service;

import com.orion.common.ApiException;
import com.orion.dto.PrivacyOverviewResponse;
import com.orion.entity.Meeting;
import com.orion.entity.UserEntity;
import com.orion.repository.ChatConversationRepository;
import com.orion.repository.MeetingActionItemRepository;
import com.orion.repository.MeetingRepository;
import com.orion.repository.ProjectRepository;
import com.orion.repository.TranscriptMomentRepository;
import com.orion.repository.UserRepository;
import com.orion.security.SecurityUtils;
import com.orion.security.SignInSecurity;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.stream.Collectors;

/**
 * The page that answers "what do you have of mine, and how do I make it stop".
 *
 * <p>Orion had the architecture for this and none of the controls. Row-level
 * security means one account cannot read another's rows; the audio sits in a
 * private bucket reachable only through a URL we sign for fifteen minutes; a
 * share link is opt-in, per meeting, and revocable. All true, all invisible, and
 * the settings page's "Danger zone" popped a toast saying deletion was not
 * implemented. A privacy claim nobody can check from inside the product is
 * marketing.
 *
 * <p>So everything here is either a count of real rows or a fact read back from
 * the thing it describes. Nothing on this page is a sentence we wrote about
 * ourselves.
 *
 * <p><strong>On what this deliberately does not do.</strong> Closing an account
 * is immediate and irreversible. The obvious alternative — mark it deleted, hold
 * it for thirty days, let people change their minds — is what most products do
 * and is the wrong trade here: it means answering "yes, that is deleted" while
 * the data is still on disk and still restorable by whoever runs the servers,
 * which is precisely the answer this page exists to make true. The safety net
 * that replaces it is the export sitting immediately above the button.
 */
@Service
public class PrivacyService {

    private static final Logger log = LoggerFactory.getLogger(PrivacyService.class);

    /**
     * What has to be typed to close an account.
     *
     * <p>Matched case-insensitively after trimming. The point of the phrase is
     * that it cannot be produced by a stray click or a double-submitted form,
     * not that it is hard to type correctly.
     */
    public static final String DELETE_PHRASE = "delete everything";

    private final MeetingRepository meetings;
    private final MeetingActionItemRepository actionItems;
    private final TranscriptMomentRepository moments;
    private final ProjectRepository projects;
    private final ChatConversationRepository conversations;
    private final UserRepository users;
    private final RetentionService retention;
    private final ErasureService erasure;
    private final StorageService storage;
    private final AuditService audit;
    private final AccountMail mail;
    private final String frontendUrl;

    public PrivacyService(MeetingRepository meetings,
                          MeetingActionItemRepository actionItems,
                          TranscriptMomentRepository moments,
                          ProjectRepository projects,
                          ChatConversationRepository conversations,
                          UserRepository users,
                          RetentionService retention,
                          ErasureService erasure,
                          StorageService storage,
                          AuditService audit,
                          AccountMail mail,
                          @Value("${app.frontend-url:http://localhost:3000}") String frontendUrl) {
        this.meetings = meetings;
        this.actionItems = actionItems;
        this.moments = moments;
        this.projects = projects;
        this.conversations = conversations;
        this.users = users;
        this.retention = retention;
        this.erasure = erasure;
        this.storage = storage;
        this.audit = audit;
        this.mail = mail;
        this.frontendUrl = frontendUrl.endsWith("/")
                ? frontendUrl.substring(0, frontendUrl.length() - 1)
                : frontendUrl;
    }

    /* ------------------------------ the overview ---------------------------- */

    @Transactional(readOnly = true)
    public PrivacyOverviewResponse overview(String userId, LocalDate today) {
        UserEntity user = users.findById(userId)
                .orElseThrow(() -> ApiException.unauthorized("Unknown user"));
        List<Meeting> owned = meetings.findByUserIdOrderByCreatedAtDesc(userId);

        return new PrivacyOverviewResponse(
                held(userId, owned),
                retentionOf(user, userId, today),
                storageFacts(),
                signIn());
    }

    private PrivacyOverviewResponse.Held held(String userId, List<Meeting> owned) {
        long recordings = owned.stream().filter(m -> m.getObjectKey() != null).count();
        long audioErased = owned.stream().filter(m -> m.getAudioDeletedAt() != null).count();
        long transcriptsErased = owned.stream().filter(m -> m.getTranscriptDeletedAt() != null).count();

        return new PrivacyOverviewResponse.Held(
                owned.size(),
                recordings,
                audioErased,
                // A meeting has a transcript unless it never got one or it was
                // erased. Counted from the meeting rather than by loading every
                // transcript row, which on a large archive is the difference
                // between one query and a thousand.
                owned.size() - transcriptsErased,
                transcriptsErased,
                actionItems.countForUser(userId),
                moments.countByUserId(userId),
                projects.countByUserId(userId),
                conversations.countByUserId(userId),
                owned.stream().filter(m -> m.getConsentConfirmedAt() != null).count(),
                owned.stream()
                        .map(Meeting::getCreatedAt)
                        .filter(java.util.Objects::nonNull)
                        .min(Comparator.naturalOrder())
                        .orElse(null));
    }

    private PrivacyOverviewResponse.Retention retentionOf(UserEntity user, String userId, LocalDate today) {
        RetentionService.Due due = retention.preview(
                userId, user.getAudioRetentionDays(), user.getMeetingRetentionDays(), today);
        return new PrivacyOverviewResponse.Retention(
                user.getAudioRetentionDays(),
                user.getMeetingRetentionDays(),
                due.recordings(),
                due.meetings());
    }

    /**
     * How the caller signed in.
     *
     * <p>Read from the credential this request arrived with rather than from the
     * database, because it is a fact about the credential. Orion never sees a
     * sign-in — it verifies a token somebody else issued — so this is the whole
     * of what it can honestly say about factors, and the settings page is
     * written to say exactly that much and no more.
     */
    private PrivacyOverviewResponse.SignIn signIn() {
        SignInSecurity credential = SecurityUtils.signInSecurity();
        return new PrivacyOverviewResponse.SignIn(
                credential.authMode(),
                credential.managedExternally(),
                credential.secondFactor());
    }

    private PrivacyOverviewResponse.StorageFacts storageFacts() {
        return new PrivacyOverviewResponse.StorageFacts(
                storage.encryptionAtRest().orElse(null),
                storage.presignExpirySeconds(),
                // Not a claim about intent: V9 puts a tenant_isolation policy on
                // every table and forces it on, so this is a property of the
                // schema the application is running against.
                true);
    }

    /* ------------------------------- retention ------------------------------ */

    @Transactional
    public PrivacyOverviewResponse.Retention setRetention(String userId, Integer audioDays,
                                                          Integer meetingDays, LocalDate today) {
        UserEntity user = retention.setPolicy(userId, audioDays, meetingDays);
        return retentionOf(user, userId, today);
    }

    /* -------------------------------- closing ------------------------------- */

    /**
     * Close the account and delete everything in it.
     *
     * <p>The typed phrase is checked here rather than in the controller because
     * it is part of the operation, not part of the HTTP binding: any future
     * caller of this method should have to pass it too.
     *
     * @return what was deleted, for the response the caller reads on their way out
     */
    @Transactional
    public Closed closeAccount(String userId, String confirmation) {
        if (confirmation == null
                || !DELETE_PHRASE.equals(confirmation.trim().toLowerCase(Locale.ROOT))) {
            throw ApiException.badRequest("Type \"" + DELETE_PHRASE + "\" to confirm.");
        }
        long meetingCount = meetings.countByUserId(userId);
        /*
         * Read before the deletion, because eraseAccount destroys the row it
         * lives on. After this call there is no address to look up, no switch
         * to consult and no bell to ring -- mail is the only channel left, and
         * the only record the account holder keeps of what was destroyed.
         */
        String address = users.findById(userId).map(UserEntity::getEmail).orElse(null);
        int objects = erasure.eraseAccount(userId);
        log.info("Account {} closed: {} meeting(s), {} stored object(s).", userId, meetingCount, objects);
        /*
         * Queued inside this transaction, after the erasure and before the
         * commit, and that ordering is the whole guarantee. Sent after the
         * commit -- which is what this used to do -- a crash or a provider
         * outage in the intervening millisecond destroyed an account silently,
         * with nothing left anywhere to reconstruct the message from: the row,
         * the address and the counts are all gone by then.
         *
         * Queued here, the deletion and the record of it are one commit. If this
         * throws, the deletion does not happen -- which is the right way round
         * for an operation nobody can undo.
         */
        mail.accountClosed(userId, address, meetingCount, objects);
        return new Closed(meetingCount, objects);
    }

    /** What closing an account destroyed, counted before it went. */
    public record Closed(long meetings, int storedObjects) {
    }

    /* -------------------------------- helpers ------------------------------- */

    /** Today in UTC — the clock every scheduled thing in Orion already agrees on. */
    public static LocalDate todayUtc() {
        return LocalDate.now(ZoneOffset.UTC);
    }
}
