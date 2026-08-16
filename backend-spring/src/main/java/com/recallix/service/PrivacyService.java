package com.recallix.service;

import com.recallix.common.ApiException;
import com.recallix.dto.LiveLinkResponse;
import com.recallix.dto.PrivacyOverviewResponse;
import com.recallix.entity.Meeting;
import com.recallix.entity.MeetingShare;
import com.recallix.entity.UserEntity;
import com.recallix.repository.ChatConversationRepository;
import com.recallix.repository.MeetingActionItemRepository;
import com.recallix.repository.MeetingRepository;
import com.recallix.repository.MeetingShareRepository;
import com.recallix.repository.ProjectRepository;
import com.recallix.repository.TranscriptMomentRepository;
import com.recallix.repository.UserRepository;
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
 * <p>Recallix had the architecture for this and none of the controls. Row-level
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
    private final MeetingShareRepository shares;
    private final MeetingActionItemRepository actionItems;
    private final TranscriptMomentRepository moments;
    private final ProjectRepository projects;
    private final ChatConversationRepository conversations;
    private final UserRepository users;
    private final RetentionService retention;
    private final ErasureService erasure;
    private final StorageService storage;
    private final AuditService audit;
    private final String frontendUrl;

    public PrivacyService(MeetingRepository meetings,
                          MeetingShareRepository shares,
                          MeetingActionItemRepository actionItems,
                          TranscriptMomentRepository moments,
                          ProjectRepository projects,
                          ChatConversationRepository conversations,
                          UserRepository users,
                          RetentionService retention,
                          ErasureService erasure,
                          StorageService storage,
                          AuditService audit,
                          @Value("${app.frontend-url:http://localhost:3000}") String frontendUrl) {
        this.meetings = meetings;
        this.shares = shares;
        this.actionItems = actionItems;
        this.moments = moments;
        this.projects = projects;
        this.conversations = conversations;
        this.users = users;
        this.retention = retention;
        this.erasure = erasure;
        this.storage = storage;
        this.audit = audit;
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
                liveLinks(userId, owned));
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

    private PrivacyOverviewResponse.StorageFacts storageFacts() {
        return new PrivacyOverviewResponse.StorageFacts(
                storage.encryptionAtRest().orElse(null),
                storage.presignExpirySeconds(),
                // Not a claim about intent: V9 puts a tenant_isolation policy on
                // every table and forces it on, so this is a property of the
                // schema the application is running against.
                true);
    }

    /* -------------------------------- links --------------------------------- */

    /**
     * Every link in the workspace that a stranger holding the URL could open
     * right now.
     *
     * <p>Expired links are filtered out here rather than shown greyed: the
     * question this list answers is what is readable now, and an expired link is
     * not readable. Revoked ones never load — the query excludes them — but the
     * rows stay in the table so the history remains answerable.
     */
    @Transactional(readOnly = true)
    public List<LiveLinkResponse> links(String userId) {
        return liveLinks(userId, meetings.findByUserIdOrderByCreatedAtDesc(userId));
    }

    private List<LiveLinkResponse> liveLinks(String userId, List<Meeting> owned) {
        Map<String, String> titles = owned.stream()
                .collect(Collectors.toMap(Meeting::getId, Meeting::getTitle, (a, b) -> a));
        return shares.findByUserIdAndRevokedFalseOrderByCreatedAtDesc(userId).stream()
                .filter(MeetingShare::isActive)
                .map(s -> LiveLinkResponse.from(s, titles.get(s.getMeetingId()), frontendUrl))
                .toList();
    }

    /**
     * Withdraw every live link at once.
     *
     * <p>The button somebody reaches for after realising a link went somewhere
     * it should not have, when they cannot remember which of thirty meetings it
     * was. Revoking one too many costs a click to re-share; hunting for the
     * right one while it is being read costs the thing this page is for.
     *
     * @return how many links were withdrawn
     */
    @Transactional
    public int revokeAllLinks(String userId) {
        List<MeetingShare> live = shares.findByUserIdAndRevokedFalseOrderByCreatedAtDesc(userId);
        live.forEach(s -> s.setRevoked(true));
        if (!live.isEmpty()) {
            audit.record(userId, "SHARE_REVOKED_ALL", "user", userId);
            log.info("Revoked {} live link(s) for {}", live.size(), userId);
        }
        return live.size();
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
        int objects = erasure.eraseAccount(userId);
        log.info("Account {} closed: {} meeting(s), {} stored object(s).", userId, meetingCount, objects);
        return new Closed(meetingCount, objects);
    }

    /** What closing an account destroyed, counted before it went. */
    public record Closed(long meetings, int storedObjects) {
    }

    /* -------------------------------- helpers ------------------------------- */

    /** Today in UTC — the clock every scheduled thing in Recallix already agrees on. */
    public static LocalDate todayUtc() {
        return LocalDate.now(ZoneOffset.UTC);
    }
}
