package com.recallix.service;

import com.recallix.common.ApiException;
import com.recallix.common.IdGenerator;
import com.recallix.dto.ShareCreateRequest;
import com.recallix.dto.ShareEmailRequest;
import com.recallix.dto.ShareResponse;
import com.recallix.dto.SharedMeetingResponse;
import com.recallix.entity.Meeting;
import com.recallix.entity.MeetingShare;
import com.recallix.entity.MeetingSummary;
import com.recallix.entity.TranscriptSegment;
import com.recallix.entity.UserEntity;
import com.recallix.repository.MeetingActionItemRepository;
import com.recallix.repository.MeetingRepository;
import com.recallix.repository.MeetingShareRepository;
import com.recallix.repository.MeetingSummaryRepository;
import com.recallix.repository.MeetingTranscriptRepository;
import com.recallix.repository.TranscriptSegmentRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;
import com.recallix.event.ShareViewedEvent;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.security.SecureRandom;
import java.time.Instant;
import java.time.LocalDate;
import java.time.temporal.ChronoUnit;
import java.util.Base64;
import java.util.List;
import java.util.Optional;

/**
 * Read-only public share links.
 *
 * <p>Sharing for an individual user is not a permissions problem — there is no
 * org to grant access within. It is a capability URL: an unguessable token that
 * resolves to a redacted view of one meeting and can be withdrawn at any time.
 *
 * <p>Consequences that shape this class: the token is the only credential, so it
 * comes from {@link SecureRandom} with 192 bits of entropy and is never derived
 * from the meeting id; resolution deliberately does not distinguish "revoked",
 * "expired" and "never existed", so a probe learns nothing; and what a link
 * reveals is decided per link, because one policy for every recipient is wrong
 * in both directions.
 *
 * <p><b>What is not here, and cannot be.</b> Commenter and editor roles. Those
 * describe what a <em>person</em> may do, which presumes an account to attribute
 * the writing to and to check on the next request. Everyone holding a link is
 * the same anonymous reader, so the only role a link can carry is viewer — and
 * what varies instead is content.
 */
@Service
public class ShareService {

    private static final Logger log = LoggerFactory.getLogger(ShareService.class);

    private static final SecureRandom RANDOM = new SecureRandom();
    private static final int TOKEN_BYTES = 24; // 192 bits, URL-safe base64

    /**
     * Kept private to this service rather than published as a bean.
     *
     * <p>A share password is not a login credential and must not start being
     * used as one by something else that finds a {@code PasswordEncoder} in the
     * context. The default work factor is deliberate: about a tenth of a second
     * per attempt is imperceptible to a reader typing one password and is the
     * whole rate limit against someone trying thousands.
     */
    private static final PasswordEncoder PASSWORDS = new BCryptPasswordEncoder();

    /** A moment link with no bound would be a whole-meeting link with extra steps. */
    private static final double MIN_MOMENT_SECONDS = 0.5;

    private final MeetingShareRepository shares;
    private final MeetingRepository meetings;
    private final MeetingSummaryRepository summaries;
    private final MeetingActionItemRepository actionItems;
    private final MeetingTranscriptRepository transcripts;
    private final TranscriptSegmentRepository segments;
    private final StorageService storage;
    private final EmailService email;
    private final AuditService audit;
    private final ApplicationEventPublisher events;
    private final UserService users;
    private final String frontendUrl;

    public ShareService(MeetingShareRepository shares,
                        MeetingRepository meetings,
                        MeetingSummaryRepository summaries,
                        MeetingActionItemRepository actionItems,
                        MeetingTranscriptRepository transcripts,
                        TranscriptSegmentRepository segments,
                        StorageService storage,
                        EmailService email,
                        AuditService audit,
                        ApplicationEventPublisher events,
                        UserService users,
                        @Value("${app.frontend-url:http://localhost:3000}") String frontendUrl) {
        this.shares = shares;
        this.meetings = meetings;
        this.summaries = summaries;
        this.actionItems = actionItems;
        this.transcripts = transcripts;
        this.segments = segments;
        this.storage = storage;
        this.email = email;
        this.audit = audit;
        this.events = events;
        this.users = users;
        this.frontendUrl = stripTrailingSlash(frontendUrl);
    }

    // --- owner operations ---------------------------------------------------- //

    /**
     * Create the meeting's share link, or update the existing one.
     *
     * <p>Idempotent for the meeting link by design: pressing "Share" twice must
     * not silently mint a second live URL that the owner then cannot see or
     * revoke, so options on a repeat call update the link rather than replacing
     * it and a URL already sent keeps working.
     *
     * <p>A moment link is the exception and always new. Sharing three excerpts
     * with three people is the point of having them, and folding the second
     * request into the first would silently re-point a link somebody already
     * holds at a different part of the meeting.
     */
    @Transactional
    public ShareResponse createOrUpdate(String userId, String meetingId, ShareCreateRequest req) {
        requireOwnedMeeting(userId, meetingId);

        MeetingShare share = (req != null && req.isMoment())
                ? newShare(userId, meetingId)
                : shares.findFirstByMeetingIdAndRevokedFalseAndStartSecondsIsNull(meetingId)
                        .orElseGet(() -> newShare(userId, meetingId));

        apply(share, req);
        shares.save(share);
        audit.record(userId, share.isMoment() ? "SHARE_MOMENT_CREATED" : "SHARE_UPDATED",
                "meeting", meetingId);
        return ShareResponse.from(share, frontendUrl);
    }

    /** Every live link for this meeting: the meeting's own, then its moments. */
    @Transactional(readOnly = true)
    public List<ShareResponse> list(String userId, String meetingId) {
        requireOwnedMeeting(userId, meetingId);
        return shares.findByMeetingIdAndRevokedFalseOrderByCreatedAtDesc(meetingId).stream()
                .filter(MeetingShare::isActive)
                .sorted((a, b) -> Boolean.compare(a.isMoment(), b.isMoment()))
                .map(s -> ShareResponse.from(s, frontendUrl))
                .toList();
    }

    @Transactional(readOnly = true)
    public Optional<ShareResponse> current(String userId, String meetingId) {
        requireOwnedMeeting(userId, meetingId);
        return shares.findFirstByMeetingIdAndRevokedFalseAndStartSecondsIsNull(meetingId)
                .map(s -> ShareResponse.from(s, frontendUrl));
    }

    /** Withdraw the meeting's link. The row is kept so the history stays answerable. */
    @Transactional
    public void revoke(String userId, String meetingId) {
        requireOwnedMeeting(userId, meetingId);
        shares.findFirstByMeetingIdAndRevokedFalseAndStartSecondsIsNull(meetingId)
                .ifPresent(s -> {
                    s.setRevoked(true);
                    audit.record(userId, "SHARE_REVOKED", "meeting", meetingId);
                });
    }

    /** Withdraw one link by id — how a single moment link is taken back. */
    @Transactional
    public void revokeById(String userId, String shareId) {
        MeetingShare share = shares.findByIdAndUserId(shareId, userId)
                .orElseThrow(() -> ApiException.notFound("Link not found"));
        share.setRevoked(true);
        audit.record(userId, "SHARE_REVOKED", "meeting", share.getMeetingId());
    }

    /**
     * Mail an existing link to some people.
     *
     * <p>Sends the link that already exists rather than creating one: an endpoint
     * that both publishes a meeting and posts the URL to arbitrary addresses is
     * one mistaken click from a leak, and there is nothing to undo afterwards.
     *
     * @return how many messages were accepted by the mail server.
     */
    @Transactional
    public int emailLink(String userId, String meetingId, ShareEmailRequest req) {
        Meeting meeting = requireOwnedMeeting(userId, meetingId);
        MeetingShare share = shares.findFirstByMeetingIdAndRevokedFalseAndStartSecondsIsNull(meetingId)
                .filter(MeetingShare::isActive)
                .orElseThrow(() -> ApiException.badRequest(
                        "Create a share link before emailing it."));

        String url = frontendUrl + "/shared/" + share.getToken();
        String subject = "Meeting notes: " + meeting.getTitle();
        StringBuilder body = new StringBuilder();
        if (req.message() != null && !req.message().isBlank()) {
            body.append(req.message().trim()).append("\n\n");
        }
        body.append(meeting.getTitle()).append("\n").append(url).append("\n\n");
        // Said in the mail because it is the recipient who is about to be
        // stopped by it, and they cannot ask the link why it wants a password.
        if (share.isPasswordProtected()) {
            body.append("This link is password protected. "
                    + "Whoever sent it to you will have the password.\n\n");
        }
        if (share.getExpiresAt() != null) {
            body.append("The link stops working on ").append(share.getExpiresAt()).append(".\n\n");
        }
        body.append("Shared read-only via Recallix AI.");

        int sent = 0;
        for (String to : req.to()) {
            if (email.send(to, subject, body.toString())) {
                sent++;
            }
        }
        audit.record(userId, "SHARE_EMAILED", "meeting", meetingId);
        return sent;
    }

    // --- public resolution ---------------------------------------------------- //

    /**
     * Resolve a token to its redacted meeting view.
     *
     * <p>Every failure returns the same 404 — an invalid token, a revoked one and
     * an expired one are indistinguishable to the caller. A password-protected
     * link is the one exception and answers 401, because a reader who is meant to
     * have it needs to be told to type it; that this token exists is already
     * known to anybody holding it.
     *
     * @param password null when the caller has not supplied one yet.
     */
    @Transactional
    public SharedMeetingResponse resolve(String token, String password) {
        MeetingShare share = shares.findByToken(token)
                .filter(MeetingShare::isActive)
                .orElseThrow(() -> ApiException.notFound("This link is no longer available"));

        if (share.isPasswordProtected()) {
            if (password == null || password.isEmpty()) {
                throw ApiException.unauthorized("This link is password protected");
            }
            if (!PASSWORDS.matches(password, share.getPasswordHash())) {
                throw ApiException.unauthorized("That password is not right");
            }
        }

        Meeting meeting = meetings.findById(share.getMeetingId())
                .orElseThrow(() -> ApiException.notFound("This link is no longer available"));

        // Counted only once the reader is actually through: a wrong password is
        // not a view, and counting it would make the owner's number a measure of
        // how often the link was found rather than read.
        share.setViewCount(share.getViewCount() + 1);
        share.setLastViewedAt(Instant.now());
        // Told to the owner after this commits, on another thread: see
        // ShareViewedEvent for why a public page must not carry that work.
        events.publishEvent(new ShareViewedEvent(
                share.getId(), meeting.getId(), meeting.getUserId()));

        String meetingId = meeting.getId();
        MeetingSummary summary = share.isIncludeSummary()
                ? summaries.findFirstByMeetingIdOrderByCreatedAtDesc(meetingId).orElse(null)
                : null;

        List<SharedMeetingResponse.SharedActionItem> sharedActions = share.isIncludeActionItems()
                ? actionItems.findByMeetingId(meetingId).stream()
                        .map(a -> new SharedMeetingResponse.SharedActionItem(
                                a.getTitle(), a.getOwnerName(), a.getDueDate(), a.getPriority()))
                        .toList()
                : List.of();

        String transcript = share.isIncludeTranscript() ? transcriptFor(share, meetingId) : null;

        String audioUrl = null;
        if (share.isIncludeAudio() && meeting.getObjectKey() != null) {
            audioUrl = storage.presignDownload(meeting.getObjectKey());
        }

        return new SharedMeetingResponse(
                meeting.getTitle(),
                meeting.getCreatedAt(),
                share.isMoment() ? null : meeting.getDurationSeconds(),
                summary == null ? null : summary.getShortSummary(),
                summary == null ? null : summary.getDetailedSummary(),
                summary == null ? List.of() : summary.getKeyPoints(),
                sharedActions,
                transcript,
                audioUrl,
                share.getStartSeconds(),
                share.getEndSeconds(),
                share.getQuote());
    }

    // --- helpers --------------------------------------------------------------- //

    /**
     * Mail the owner that somebody opened their link (V40).
     *
     * <p>Off by default and deliberately so. The bell absorbs a link that a
     * mailing list opens forty times in an afternoon; an inbox does not. This is
     * for the other case — a link sent to one person, where the thing the sender
     * wants to know is whether it was read.
     *
     * <p>Once a day per link, stamped on the share rather than reusing the
     * notification's dedupe key. The two are separately switchable, and the
     * bell's key is only ever written when its kind is unmuted — so borrowing it
     * would mail somebody on every open the moment they silenced the bell.
     *
     * @return true when a message was sent
     */
    @Transactional
    public boolean emailOwnerOnOpen(String ownerUserId, String shareId, Meeting meeting, LocalDate today) {
        UserEntity owner = users.require(ownerUserId);
        if (!owner.isEmailsEnabled() || !owner.isShareOpenedEmail()) {
            return false;
        }
        String to = owner.effectiveRecapEmail();
        if (to == null || to.isBlank()) {
            return false;
        }
        MeetingShare share = shares.findById(shareId).orElse(null);
        if (share == null || today.equals(share.getOpenEmailedOn())) {
            return false;
        }

        String title = meeting == null ? "a meeting" : meeting.getTitle();
        String where = meeting == null ? frontendUrl + "/meetings" : frontendUrl + "/meetings/" + meeting.getId();
        boolean sent = email.send(to,
                "Somebody opened your shared link",
                "The link you shared for \"" + title + "\" has been opened.\n\n"
                        + "Opened " + share.getViewCount() + " time"
                        + (share.getViewCount() == 1 ? "" : "s") + " in total.\n"
                        + where + "\n\n"
                        + "You will not be emailed again about this link today, however many "
                        + "times it is opened.\n\n"
                        + "—\nSent automatically by Recallix because \"Conversation shared\" "
                        + "is on. Turn it off in Account Settings → Emails.");
        if (sent) {
            // Only on success, so a mail server that was down for a minute does
            // not cost the owner the day's one notice.
            share.setOpenEmailedOn(today);
        }
        return sent;
    }

    /**
     * The text this link is allowed to show.
     *
     * <p>A whole-meeting link gets the stored transcript as the worker wrote it.
     * A moment link is assembled from the segments that overlap its range and
     * labelled by speaker — clipped in the query rather than in the browser,
     * because sending the whole hour and hiding all but ten seconds of it is not
     * sharing a moment, it is sharing the meeting with a stylesheet.
     */
    private String transcriptFor(MeetingShare share, String meetingId) {
        if (!share.isMoment()) {
            return transcripts.findFirstByMeetingIdOrderByCreatedAtDesc(meetingId)
                    .map(t -> t.getTranscriptText())
                    .orElse(null);
        }

        double from = share.getStartSeconds();
        double to = share.getEndSeconds();
        List<TranscriptSegment> inRange = segments.findByMeetingIdOrderByStartTimeAsc(meetingId).stream()
                .filter(s -> s.getStartTime() != null && s.getEndTime() != null)
                .filter(s -> s.getEndTime() >= from && s.getStartTime() <= to)
                .toList();

        if (inRange.isEmpty()) {
            // The segments behind it were edited or replaced by a reprocess. The
            // quote is what was shared, so it stands in rather than the link
            // going blank.
            return share.getQuote().isBlank() ? null : share.getQuote();
        }
        StringBuilder text = new StringBuilder();
        for (TranscriptSegment s : inRange) {
            if (text.length() > 0) {
                text.append("\n\n");
            }
            if (s.getSpeaker() != null && !s.getSpeaker().isBlank()) {
                text.append(s.getSpeaker()).append(": ");
            }
            text.append(s.getText() == null ? "" : s.getText());
        }
        return text.toString();
    }

    private MeetingShare newShare(String userId, String meetingId) {
        MeetingShare fresh = new MeetingShare();
        fresh.setId(IdGenerator.generate("shr_"));
        fresh.setMeetingId(meetingId);
        fresh.setUserId(userId);
        fresh.setToken(newToken());
        applyAccountDefaults(fresh, userId);
        return fresh;
    }

    /**
     * Set a fresh link to whatever this account said new links should be.
     *
     * <p>Only on creation, and only before {@code apply} runs, so anything the
     * request asked for still wins. Never on an existing link: rewriting the
     * expiry of a URL somebody has already sent would revoke access nobody
     * asked to revoke.
     *
     * <p>Silent about a profile it cannot read. The defaults on the entity are
     * the same ones this would set, and failing to create a share link because
     * a preferences row was unreadable would be a worse outcome than a link
     * with the standard settings.
     */
    private void applyAccountDefaults(MeetingShare share, String userId) {
        try {
            UserEntity user = users.require(userId);
            share.setIncludeSummary(user.isShareIncludeSummary());
            share.setIncludeActionItems(user.isShareIncludeActionItems());
            share.setIncludeTranscript(user.isShareIncludeTranscript());
            share.setIncludeAudio(user.isShareIncludeAudio());
            if (user.getShareExpiryDays() != null) {
                share.setExpiresAt(Instant.now().plus(user.getShareExpiryDays(), ChronoUnit.DAYS));
            }
        } catch (RuntimeException e) {
            log.warn("Could not read share defaults for {}; using the built-in ones.", userId);
        }
    }

    /** Only what the caller sent. Omitted fields keep whatever the link had. */
    private void apply(MeetingShare share, ShareCreateRequest req) {
        if (req == null) {
            return;
        }
        if (req.includeSummary() != null) share.setIncludeSummary(req.includeSummary());
        if (req.includeActionItems() != null) share.setIncludeActionItems(req.includeActionItems());
        if (req.includeTranscript() != null) share.setIncludeTranscript(req.includeTranscript());
        if (req.includeAudio() != null) share.setIncludeAudio(req.includeAudio());
        if (req.label() != null) share.setLabel(req.label().trim());

        if (Boolean.TRUE.equals(req.neverExpires())) {
            share.setExpiresAt(null);
        } else if (req.expiresInDays() != null) {
            share.setExpiresAt(Instant.now().plus(req.expiresInDays(), ChronoUnit.DAYS));
        }

        if (Boolean.TRUE.equals(req.removePassword())) {
            share.setPasswordHash(null);
        } else if (req.wantsPassword()) {
            share.setPasswordHash(PASSWORDS.encode(req.password()));
        }

        if (req.isMoment()) {
            double from = Math.max(0, req.startSeconds());
            double to = req.endSeconds();
            if (to - from < MIN_MOMENT_SECONDS) {
                throw ApiException.badRequest("That moment is too short to share.");
            }
            share.setStartSeconds(from);
            share.setEndSeconds(to);
            share.setQuote(req.quote() == null ? "" : req.quote().trim());
        }
    }

    private static String newToken() {
        byte[] bytes = new byte[TOKEN_BYTES];
        RANDOM.nextBytes(bytes);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }

    private Meeting requireOwnedMeeting(String userId, String meetingId) {
        return meetings.findByIdAndUserId(meetingId, userId)
                .orElseThrow(() -> ApiException.notFound("Meeting not found"));
    }

    private static String stripTrailingSlash(String url) {
        return url != null && url.endsWith("/") ? url.substring(0, url.length() - 1) : url;
    }
}
