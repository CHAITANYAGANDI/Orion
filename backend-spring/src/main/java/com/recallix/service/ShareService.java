package com.recallix.service;

import com.recallix.common.ApiException;
import com.recallix.common.IdGenerator;
import com.recallix.dto.ShareCreateRequest;
import com.recallix.dto.ShareResponse;
import com.recallix.dto.SharedMeetingResponse;
import com.recallix.entity.Meeting;
import com.recallix.entity.MeetingShare;
import com.recallix.entity.MeetingSummary;
import com.recallix.repository.MeetingActionItemRepository;
import com.recallix.repository.MeetingRepository;
import com.recallix.repository.MeetingShareRepository;
import com.recallix.repository.MeetingSummaryRepository;
import com.recallix.repository.MeetingTranscriptRepository;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.security.SecureRandom;
import java.time.Instant;
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
 * from the meeting id; and resolution deliberately does not distinguish
 * "revoked", "expired" and "never existed", so a probe learns nothing.
 */
@Service
public class ShareService {

    private static final SecureRandom RANDOM = new SecureRandom();
    private static final int TOKEN_BYTES = 24; // 192 bits, URL-safe base64

    private final MeetingShareRepository shares;
    private final MeetingRepository meetings;
    private final MeetingSummaryRepository summaries;
    private final MeetingActionItemRepository actionItems;
    private final MeetingTranscriptRepository transcripts;
    private final String frontendUrl;

    public ShareService(MeetingShareRepository shares,
                        MeetingRepository meetings,
                        MeetingSummaryRepository summaries,
                        MeetingActionItemRepository actionItems,
                        MeetingTranscriptRepository transcripts,
                        @Value("${app.frontend-url:http://localhost:3000}") String frontendUrl) {
        this.shares = shares;
        this.meetings = meetings;
        this.summaries = summaries;
        this.actionItems = actionItems;
        this.transcripts = transcripts;
        this.frontendUrl = stripTrailingSlash(frontendUrl);
    }

    // --- owner operations ---------------------------------------------------- //

    /**
     * Create the meeting's share link, or return the existing one.
     *
     * <p>Idempotent by design: pressing "Share" twice must not silently mint a
     * second live URL that the owner then cannot see or revoke. Options on a
     * repeat call update the existing link rather than replacing it, so a URL
     * already sent to someone keeps working.
     */
    @Transactional
    public ShareResponse createOrUpdate(String userId, String meetingId, ShareCreateRequest req) {
        requireOwnedMeeting(userId, meetingId);

        boolean includeTranscript = req != null && Boolean.TRUE.equals(req.includeTranscript());
        Instant expiresAt = (req == null || req.expiresInDays() == null)
                ? null
                : Instant.now().plus(req.expiresInDays(), ChronoUnit.DAYS);

        MeetingShare share = shares.findByMeetingIdAndRevokedFalse(meetingId)
                .orElseGet(() -> {
                    MeetingShare fresh = new MeetingShare();
                    fresh.setId(IdGenerator.generate("shr_"));
                    fresh.setMeetingId(meetingId);
                    fresh.setUserId(userId);
                    fresh.setToken(newToken());
                    return fresh;
                });
        share.setIncludeTranscript(includeTranscript);
        share.setExpiresAt(expiresAt);
        shares.save(share);

        return ShareResponse.from(share, frontendUrl);
    }

    @Transactional(readOnly = true)
    public Optional<ShareResponse> current(String userId, String meetingId) {
        requireOwnedMeeting(userId, meetingId);
        return shares.findByMeetingIdAndRevokedFalse(meetingId)
                .map(s -> ShareResponse.from(s, frontendUrl));
    }

    /** Withdraw the link. The row is kept so the history stays answerable. */
    @Transactional
    public void revoke(String userId, String meetingId) {
        requireOwnedMeeting(userId, meetingId);
        shares.findByMeetingIdAndRevokedFalse(meetingId).ifPresent(s -> s.setRevoked(true));
    }

    // --- public resolution ---------------------------------------------------- //

    /**
     * Resolve a token to its redacted meeting view.
     *
     * <p>Every failure returns the same 404 — an invalid token, a revoked one and
     * an expired one are indistinguishable to the caller.
     */
    @Transactional
    public SharedMeetingResponse resolve(String token) {
        MeetingShare share = shares.findByToken(token)
                .filter(MeetingShare::isActive)
                .orElseThrow(() -> ApiException.notFound("This link is no longer available"));

        Meeting meeting = meetings.findById(share.getMeetingId())
                .orElseThrow(() -> ApiException.notFound("This link is no longer available"));

        share.setViewCount(share.getViewCount() + 1);
        share.setLastViewedAt(Instant.now());

        String meetingId = meeting.getId();
        MeetingSummary summary = summaries.findFirstByMeetingIdOrderByCreatedAtDesc(meetingId).orElse(null);


        List<SharedMeetingResponse.SharedActionItem> sharedActions =
                actionItems.findByMeetingId(meetingId).stream()
                        .map(a -> new SharedMeetingResponse.SharedActionItem(
                                a.getTitle(), a.getOwnerName(), a.getDueDate(), a.getPriority()))
                        .toList();


        String transcript = null;
        if (share.isIncludeTranscript()) {
            transcript = transcripts.findFirstByMeetingIdOrderByCreatedAtDesc(meetingId)
                    .map(t -> t.getTranscriptText())
                    .orElse(null);
        }

        return new SharedMeetingResponse(
                meeting.getTitle(),
                meeting.getCreatedAt(),
                meeting.getDurationSeconds(),
                summary == null ? null : summary.getShortSummary(),
                summary == null ? null : summary.getDetailedSummary(),
                summary == null ? List.of() : summary.getKeyPoints(),
                sharedActions,
                transcript);
    }

    // --- helpers --------------------------------------------------------------- //

    private static String newToken() {
        byte[] bytes = new byte[TOKEN_BYTES];
        RANDOM.nextBytes(bytes);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }

    private void requireOwnedMeeting(String userId, String meetingId) {
        meetings.findByIdAndUserId(meetingId, userId)
                .orElseThrow(() -> ApiException.notFound("Meeting not found"));
    }

    private static String stripTrailingSlash(String url) {
        return url != null && url.endsWith("/") ? url.substring(0, url.length() - 1) : url;
    }
}
