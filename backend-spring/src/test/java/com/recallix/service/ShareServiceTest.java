package com.recallix.service;

import com.recallix.common.ApiException;
import com.recallix.dto.ShareCreateRequest;
import com.recallix.dto.ShareResponse;
import com.recallix.dto.SharedMeetingResponse;
import com.recallix.domain.MeetingStatus;
import com.recallix.entity.Meeting;
import com.recallix.entity.MeetingShare;
import com.recallix.entity.MeetingSummary;
import com.recallix.entity.MeetingTranscript;
import com.recallix.repository.MeetingActionItemRepository;
import com.recallix.repository.MeetingRepository;
import com.recallix.repository.MeetingShareRepository;
import com.recallix.repository.MeetingSummaryRepository;
import com.recallix.repository.MeetingTranscriptRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.mockito.junit.jupiter.MockitoSettings;
import org.mockito.quality.Strictness;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.HashSet;
import java.util.List;
import java.util.Optional;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.when;

/**
 * Share links are the only unauthenticated read path in the app, so these tests
 * concentrate on what a stranger holding a URL can and cannot reach: that a
 * withdrawn or lapsed link stops working, that the transcript stays private
 * unless explicitly shared, and that failures are indistinguishable from one
 * another so a probe learns nothing.
 */
@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class ShareServiceTest {

    private static final String USER = "usr_1";
    private static final String MEETING = "mtg_1";
    private static final String BASE = "http://localhost:3000";

    @Mock private MeetingShareRepository shares;
    @Mock private MeetingRepository meetings;
    @Mock private MeetingSummaryRepository summaries;
    @Mock private MeetingActionItemRepository actionItems;
    @Mock private MeetingTranscriptRepository transcripts;

    private ShareService service;

    @BeforeEach
    void setUp() {
        service = new ShareService(shares, meetings, summaries,
                actionItems, transcripts, BASE);
        when(meetings.findByIdAndUserId(MEETING, USER)).thenReturn(Optional.of(meeting()));
        when(meetings.findById(MEETING)).thenReturn(Optional.of(meeting()));
        when(shares.findByMeetingIdAndRevokedFalse(anyString())).thenReturn(Optional.empty());
        when(summaries.findFirstByMeetingIdOrderByCreatedAtDesc(anyString()))
                .thenReturn(Optional.of(summary()));
        when(actionItems.findByMeetingId(anyString())).thenReturn(List.of());
        when(transcripts.findFirstByMeetingIdOrderByCreatedAtDesc(anyString()))
                .thenReturn(Optional.of(transcript()));
    }

    // --- creating ------------------------------------------------------------ //

    @Test
    @DisplayName("creating a share returns an absolute, copy-pasteable URL")
    void createReturnsAbsoluteUrl() {
        ShareResponse res = service.createOrUpdate(USER, MEETING, new ShareCreateRequest(false, null));
        assertThat(res.url()).isEqualTo(BASE + "/shared/" + res.token());
        assertThat(res.includeTranscript()).isFalse();
        assertThat(res.expiresAt()).isNull();
    }

    @Test
    @DisplayName("sharing twice reuses the link instead of minting a second one")
    void createIsIdempotent() {
        MeetingShare existing = share("tok_existing", false, null, false);
        when(shares.findByMeetingIdAndRevokedFalse(MEETING)).thenReturn(Optional.of(existing));

        ShareResponse res = service.createOrUpdate(USER, MEETING, new ShareCreateRequest(true, null));

        // A URL already emailed to someone must keep working.
        assertThat(res.token()).isEqualTo("tok_existing");
        assertThat(res.includeTranscript()).isTrue();
    }

    @Test
    @DisplayName("tokens are unguessable and never repeat")
    void tokensAreUnpredictable() {
        Set<String> seen = new HashSet<>();
        for (int i = 0; i < 50; i++) {
            String token = service.createOrUpdate(USER, MEETING, null).token();
            assertThat(token).hasSizeGreaterThanOrEqualTo(32);
            // Must not be derived from anything the caller already knows.
            assertThat(token).doesNotContain(MEETING).doesNotContain(USER);
            assertThat(seen.add(token)).isTrue();
        }
    }

    @Test
    @DisplayName("another user's meeting cannot be shared")
    void cannotShareSomeoneElsesMeeting() {
        when(meetings.findByIdAndUserId(MEETING, "usr_other")).thenReturn(Optional.empty());
        assertThatThrownBy(() -> service.createOrUpdate("usr_other", MEETING, null))
                .isInstanceOf(ApiException.class);
    }

    @Test
    @DisplayName("an expiry is applied when requested")
    void expiryIsApplied() {
        ShareResponse res = service.createOrUpdate(USER, MEETING, new ShareCreateRequest(false, 7));
        assertThat(res.expiresAt()).isAfter(Instant.now().plus(6, ChronoUnit.DAYS));
    }

    // --- resolving ----------------------------------------------------------- //

    @Test
    @DisplayName("a live token resolves to the meeting")
    void liveTokenResolves() {
        when(shares.findByToken("tok")).thenReturn(Optional.of(share("tok", false, null, false)));
        SharedMeetingResponse res = service.resolve("tok");
        assertThat(res.title()).isEqualTo("Sprint planning");
        assertThat(res.shortSummary()).isEqualTo("Short summary");
    }

    @Test
    @DisplayName("the transcript is withheld unless the owner opted in")
    void transcriptIsWithheldByDefault() {
        when(shares.findByToken("tok")).thenReturn(Optional.of(share("tok", false, null, false)));
        assertThat(service.resolve("tok").transcript()).isNull();
    }

    @Test
    @DisplayName("the transcript is included when the owner opted in")
    void transcriptIncludedWhenOptedIn() {
        when(shares.findByToken("tok")).thenReturn(Optional.of(share("tok", true, null, false)));
        assertThat(service.resolve("tok").transcript()).isEqualTo("full verbatim transcript");
    }

    @Test
    @DisplayName("a revoked link stops working")
    void revokedTokenIsRejected() {
        when(shares.findByToken("tok")).thenReturn(Optional.of(share("tok", false, null, true)));
        assertThatThrownBy(() -> service.resolve("tok")).isInstanceOf(ApiException.class);
    }

    @Test
    @DisplayName("an expired link stops working")
    void expiredTokenIsRejected() {
        MeetingShare expired = share("tok", false, Instant.now().minusSeconds(60), false);
        when(shares.findByToken("tok")).thenReturn(Optional.of(expired));
        assertThatThrownBy(() -> service.resolve("tok")).isInstanceOf(ApiException.class);
    }

    @Test
    @DisplayName("an unknown token fails the same way a revoked one does")
    void unknownTokenIsIndistinguishable() {
        when(shares.findByToken("nope")).thenReturn(Optional.empty());
        when(shares.findByToken("revoked")).thenReturn(Optional.of(share("revoked", false, null, true)));

        String unknown = messageOf(() -> service.resolve("nope"));
        String revoked = messageOf(() -> service.resolve("revoked"));
        // A probe must not be able to tell "never existed" from "withdrawn".
        assertThat(unknown).isEqualTo(revoked);
    }

    @Test
    @DisplayName("viewing a shared meeting is counted")
    void viewsAreCounted() {
        MeetingShare live = share("tok", false, null, false);
        when(shares.findByToken("tok")).thenReturn(Optional.of(live));

        service.resolve("tok");
        service.resolve("tok");

        assertThat(live.getViewCount()).isEqualTo(2);
        assertThat(live.getLastViewedAt()).isNotNull();
    }

    @Test
    @DisplayName("revoking marks the link withdrawn rather than deleting the record")
    void revokeKeepsTheAuditTrail() {
        MeetingShare live = share("tok", false, null, false);
        when(shares.findByMeetingIdAndRevokedFalse(MEETING)).thenReturn(Optional.of(live));

        service.revoke(USER, MEETING);

        assertThat(live.isRevoked()).isTrue();
    }

    // --- helpers -------------------------------------------------------------- //

    private static String messageOf(Runnable r) {
        try {
            r.run();
            throw new AssertionError("expected a failure");
        } catch (ApiException e) {
            return e.getMessage();
        }
    }

    private static Meeting meeting() {
        Meeting m = new Meeting();
        m.setId(MEETING);
        m.setUserId(USER);
        m.setTitle("Sprint planning");
        m.setStatus(MeetingStatus.READY);
        m.setDurationSeconds(600);
        return m;
    }

    private static MeetingSummary summary() {
        MeetingSummary s = new MeetingSummary();
        s.setId("sum_1");
        s.setMeetingId(MEETING);
        s.setShortSummary("Short summary");
        s.setDetailedSummary("Detailed summary");
        return s;
    }

    private static MeetingTranscript transcript() {
        MeetingTranscript t = new MeetingTranscript();
        t.setId("txr_1");
        t.setMeetingId(MEETING);
        t.setTranscriptText("full verbatim transcript");
        return t;
    }

    private static MeetingShare share(String token, boolean includeTranscript,
                                      Instant expiresAt, boolean revoked) {
        MeetingShare s = new MeetingShare();
        s.setId("shr_1");
        s.setMeetingId(MEETING);
        s.setUserId(USER);
        s.setToken(token);
        s.setIncludeTranscript(includeTranscript);
        s.setExpiresAt(expiresAt);
        s.setRevoked(revoked);
        return s;
    }
}
