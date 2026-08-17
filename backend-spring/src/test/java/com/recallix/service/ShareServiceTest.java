package com.recallix.service;

import com.recallix.common.ApiException;
import com.recallix.domain.MeetingStatus;
import com.recallix.dto.ShareCreateRequest;
import com.recallix.dto.ShareEmailRequest;
import com.recallix.dto.ShareResponse;
import com.recallix.dto.SharedMeetingResponse;
import com.recallix.entity.Meeting;
import com.recallix.entity.MeetingActionItem;
import com.recallix.entity.MeetingShare;
import com.recallix.entity.MeetingSummary;
import com.recallix.entity.MeetingTranscript;
import com.recallix.entity.TranscriptSegment;
import com.recallix.repository.MeetingActionItemRepository;
import com.recallix.repository.MeetingRepository;
import com.recallix.repository.MeetingShareRepository;
import com.recallix.repository.MeetingSummaryRepository;
import com.recallix.repository.MeetingTranscriptRepository;
import com.recallix.repository.TranscriptSegmentRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
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
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * Share links are the only unauthenticated read path in the app, so these tests
 * concentrate on what a stranger holding a URL can and cannot reach: that a
 * withdrawn or lapsed link stops working, that nothing the owner did not share
 * comes back with it, and that failures are indistinguishable from one another
 * so a probe learns nothing.
 *
 * <p>The recording gets the most attention of the new dials. A transcript that
 * leaks is bad; audio that leaks is everyone in the room's actual voice, and it
 * is the one field here that a bug could attach to a response nobody asked to
 * have it in.
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
    @Mock private TranscriptSegmentRepository segments;
    @Mock private StorageService storage;
    @Mock private EmailService email;
    @Mock private AuditService audit;
    @Mock private org.springframework.context.ApplicationEventPublisher events;
    @Mock private UserService users;

    private ShareService service;

    @BeforeEach
    void setUp() {
        service = new ShareService(shares, meetings, summaries, actionItems, transcripts,
                segments, storage, email, audit, events, users, BASE);
        // A fresh link starts from the account's defaults. The stock entity is
        // set to exactly the constants this replaced, so every existing
        // expectation below still describes an untouched account.
        when(users.require(anyString())).thenReturn(new com.recallix.entity.UserEntity());
        when(meetings.findByIdAndUserId(MEETING, USER)).thenReturn(Optional.of(meeting()));
        when(meetings.findById(MEETING)).thenReturn(Optional.of(meeting()));
        when(shares.findFirstByMeetingIdAndRevokedFalseAndStartSecondsIsNull(anyString()))
                .thenReturn(Optional.empty());
        when(summaries.findFirstByMeetingIdOrderByCreatedAtDesc(anyString()))
                .thenReturn(Optional.of(summary()));
        when(actionItems.findByMeetingId(anyString())).thenReturn(List.of(actionItem()));
        when(transcripts.findFirstByMeetingIdOrderByCreatedAtDesc(anyString()))
                .thenReturn(Optional.of(transcript()));
        when(segments.findByMeetingIdOrderByStartTimeAsc(anyString())).thenReturn(List.of(
                segment("Priya", "We should move billing to Stripe.", 10, 20),
                segment("Marcus", "Before the freeze?", 20, 26),
                segment("Priya", "Yes, in Q4.", 26, 32)));
        when(storage.presignDownload(anyString())).thenReturn("https://storage/signed.mp3");
        when(email.send(anyString(), anyString(), anyString())).thenReturn(true);
    }

    /** Named options, so a twelve-field record does not have to be counted out. */
    private static Options opts() {
        return new Options();
    }

    private static final class Options {
        private Boolean summary;
        private Boolean actions;
        private Boolean transcript;
        private Boolean audio;
        private Integer expiresInDays;
        private Boolean neverExpires;
        private String password;
        private Boolean removePassword;
        private String label;
        private Double from;
        private Double to;
        private String quote;

        Options summary(boolean v) { this.summary = v; return this; }
        Options actions(boolean v) { this.actions = v; return this; }
        Options transcript(boolean v) { this.transcript = v; return this; }
        Options audio(boolean v) { this.audio = v; return this; }
        Options expiresInDays(int v) { this.expiresInDays = v; return this; }
        Options neverExpires() { this.neverExpires = true; return this; }
        Options password(String v) { this.password = v; return this; }
        Options removePassword() { this.removePassword = true; return this; }
        Options moment(double from, double to, String quote) {
            this.from = from;
            this.to = to;
            this.quote = quote;
            return this;
        }

        ShareCreateRequest build() {
            return new ShareCreateRequest(summary, actions, transcript, audio, expiresInDays,
                    neverExpires, password, removePassword, label, from, to, quote);
        }
    }

    // --- creating ------------------------------------------------------------ //

    @Nested
    class Creating {

        @Test
        @DisplayName("creating a share returns an absolute, copy-pasteable URL")
        void createReturnsAbsoluteUrl() {
            ShareResponse res = service.createOrUpdate(USER, MEETING, opts().build());

            assertThat(res.url()).isEqualTo(BASE + "/shared/" + res.token());
            assertThat(res.expiresAt()).isNull();
        }

        @Test
        @DisplayName("the summary and action items are shared by default, the transcript and audio are not")
        void defaultsAreConservative() {
            ShareResponse res = service.createOrUpdate(USER, MEETING, null);

            assertThat(res.includeSummary()).isTrue();
            assertThat(res.includeActionItems()).isTrue();
            // A summary is a written account somebody can stand behind; the
            // recording is everyone's unedited voice.
            assertThat(res.includeTranscript()).isFalse();
            assertThat(res.includeAudio()).isFalse();
            assertThat(res.passwordProtected()).isFalse();
        }

        @Test
        @DisplayName("sharing twice reuses the link instead of minting a second one")
        void createIsIdempotent() {
            MeetingShare existing = share("tok_existing");
            when(shares.findFirstByMeetingIdAndRevokedFalseAndStartSecondsIsNull(MEETING))
                    .thenReturn(Optional.of(existing));

            ShareResponse res = service.createOrUpdate(USER, MEETING, opts().transcript(true).build());

            // A URL already emailed to someone must keep working.
            assertThat(res.token()).isEqualTo("tok_existing");
            assertThat(res.includeTranscript()).isTrue();
        }

        @Test
        @DisplayName("an omitted option leaves the existing setting alone")
        void omittedOptionsSurvive() {
            MeetingShare existing = share("tok_existing");
            existing.setIncludeTranscript(true);
            when(shares.findFirstByMeetingIdAndRevokedFalseAndStartSecondsIsNull(MEETING))
                    .thenReturn(Optional.of(existing));

            // Turning the audio on must not silently turn the transcript off.
            ShareResponse res = service.createOrUpdate(USER, MEETING, opts().audio(true).build());

            assertThat(res.includeAudio()).isTrue();
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
        @DisplayName("an expiry is applied when requested, and can be lifted again")
        void expiryIsAppliedAndRemovable() {
            MeetingShare existing = share("tok");
            when(shares.findFirstByMeetingIdAndRevokedFalseAndStartSecondsIsNull(MEETING))
                    .thenReturn(Optional.of(existing));

            ShareResponse dated = service.createOrUpdate(USER, MEETING, opts().expiresInDays(7).build());
            assertThat(dated.expiresAt()).isAfter(Instant.now().plus(6, ChronoUnit.DAYS));

            // A null date cannot say "remove the expiry", so a flag does.
            ShareResponse forever = service.createOrUpdate(USER, MEETING, opts().neverExpires().build());
            assertThat(forever.expiresAt()).isNull();
        }
    }

    // --- what a link reveals -------------------------------------------------- //

    @Nested
    class Revealing {

        @Test
        @DisplayName("a live token resolves to the meeting")
        void liveTokenResolves() {
            when(shares.findByToken("tok")).thenReturn(Optional.of(share("tok")));

            SharedMeetingResponse res = service.resolve("tok", null);

            assertThat(res.title()).isEqualTo("Sprint planning");
            assertThat(res.shortSummary()).isEqualTo("Short summary");
        }

        @Test
        @DisplayName("the transcript is withheld unless the owner opted in")
        void transcriptIsWithheldByDefault() {
            when(shares.findByToken("tok")).thenReturn(Optional.of(share("tok")));
            assertThat(service.resolve("tok", null).transcript()).isNull();
        }

        @Test
        @DisplayName("the transcript is included when the owner opted in")
        void transcriptIncludedWhenOptedIn() {
            MeetingShare s = share("tok");
            s.setIncludeTranscript(true);
            when(shares.findByToken("tok")).thenReturn(Optional.of(s));

            assertThat(service.resolve("tok", null).transcript())
                    .isEqualTo("full verbatim transcript");
        }

        @Test
        @DisplayName("the recording is withheld unless the owner opted in")
        void audioIsWithheldByDefault() {
            when(shares.findByToken("tok")).thenReturn(Optional.of(share("tok")));

            assertThat(service.resolve("tok", null).audioUrl()).isNull();
            // Not merely absent from the payload — never signed at all, so there
            // is no URL in a log for anyone to lift.
            verify(storage, never()).presignDownload(anyString());
        }

        @Test
        @DisplayName("the recording is a presigned URL when the owner opted in")
        void audioIsSignedWhenOptedIn() {
            MeetingShare s = share("tok");
            s.setIncludeAudio(true);
            when(shares.findByToken("tok")).thenReturn(Optional.of(s));

            assertThat(service.resolve("tok", null).audioUrl()).isEqualTo("https://storage/signed.mp3");
        }

        @Test
        @DisplayName("the summary can be withheld while the action items are shared")
        void summaryCanBeWithheld() {
            MeetingShare s = share("tok");
            s.setIncludeSummary(false);
            when(shares.findByToken("tok")).thenReturn(Optional.of(s));

            SharedMeetingResponse res = service.resolve("tok", null);

            // "Here is what you owe me" without the discussion that produced it
            // is a real thing to want to send.
            assertThat(res.shortSummary()).isNull();
            assertThat(res.keyPoints()).isEmpty();
            assertThat(res.actionItems()).hasSize(1);
        }

        @Test
        @DisplayName("the action items can be withheld while the summary is shared")
        void actionItemsCanBeWithheld() {
            MeetingShare s = share("tok");
            s.setIncludeActionItems(false);
            when(shares.findByToken("tok")).thenReturn(Optional.of(s));

            SharedMeetingResponse res = service.resolve("tok", null);

            assertThat(res.actionItems()).isEmpty();
            assertThat(res.shortSummary()).isEqualTo("Short summary");
        }
    }

    // --- one moment ----------------------------------------------------------- //

    @Nested
    class Moments {

        @Test
        @DisplayName("a moment link is always new, never the meeting's link")
        void momentsDoNotReuseTheMeetingLink() {
            MeetingShare existing = share("tok_meeting");
            when(shares.findFirstByMeetingIdAndRevokedFalseAndStartSecondsIsNull(MEETING))
                    .thenReturn(Optional.of(existing));

            ShareResponse res = service.createOrUpdate(USER, MEETING,
                    opts().moment(10, 26, "We should move billing to Stripe.").build());

            // Folding it into the meeting's link would silently re-point a URL
            // somebody already holds at ten seconds of the call.
            assertThat(res.token()).isNotEqualTo("tok_meeting");
            assertThat(res.startSeconds()).isEqualTo(10);
            assertThat(res.endSeconds()).isEqualTo(26);
        }

        @Test
        @DisplayName("a moment shows only the utterances inside it")
        void transcriptIsClipped() {
            MeetingShare s = share("tok");
            s.setIncludeTranscript(true);
            s.setStartSeconds(10.0);
            s.setEndSeconds(21.0);
            when(shares.findByToken("tok")).thenReturn(Optional.of(s));

            String text = service.resolve("tok", null).transcript();

            // Clipped in the query, not in the browser: sending the whole hour
            // and hiding all but ten seconds is not sharing a moment.
            assertThat(text).contains("We should move billing to Stripe.");
            assertThat(text).contains("Before the freeze?");
            assertThat(text).doesNotContain("Yes, in Q4.");
            assertThat(text).doesNotContain("full verbatim transcript");
        }

        @Test
        @DisplayName("a moment whose words have since been edited away falls back to the quote")
        void survivesAReprocess() {
            MeetingShare s = share("tok");
            s.setIncludeTranscript(true);
            s.setStartSeconds(9000.0);
            s.setEndSeconds(9100.0);
            s.setQuote("We should move billing to Stripe.");
            when(shares.findByToken("tok")).thenReturn(Optional.of(s));

            // Better than a blank page: it shows what was shared rather than
            // quietly quoting whatever now occupies those seconds.
            assertThat(service.resolve("tok", null).transcript())
                    .isEqualTo("We should move billing to Stripe.");
        }

        @Test
        @DisplayName("a moment with no duration is refused")
        void rejectsAnEmptyMoment() {
            assertThatThrownBy(() -> service.createOrUpdate(USER, MEETING,
                    opts().moment(10, 10, "x").build()))
                    .isInstanceOf(ApiException.class);
        }
    }

    // --- passwords ------------------------------------------------------------ //

    @Nested
    class Passwords {

        private MeetingShare protectedShare() {
            when(shares.findFirstByMeetingIdAndRevokedFalseAndStartSecondsIsNull(MEETING))
                    .thenReturn(Optional.of(share("tok")));
            service.createOrUpdate(USER, MEETING, opts().password("hunter2").build());
            MeetingShare s = share("tok");
            s.setPasswordHash(passwordHashOf("hunter2"));
            return s;
        }

        /** Round-trips through the service so the test never hard-codes a hash. */
        private String passwordHashOf(String raw) {
            MeetingShare fresh = share("tmp");
            when(shares.findFirstByMeetingIdAndRevokedFalseAndStartSecondsIsNull(MEETING))
                    .thenReturn(Optional.of(fresh));
            service.createOrUpdate(USER, MEETING, opts().password(raw).build());
            return fresh.getPasswordHash();
        }

        @Test
        @DisplayName("the password is stored hashed, never in the clear")
        void passwordIsHashed() {
            MeetingShare s = share("tok");
            when(shares.findFirstByMeetingIdAndRevokedFalseAndStartSecondsIsNull(MEETING))
                    .thenReturn(Optional.of(s));

            service.createOrUpdate(USER, MEETING, opts().password("hunter2").build());

            // People reuse passwords; a plaintext column here would be a
            // plaintext column of other systems' passwords.
            assertThat(s.getPasswordHash()).isNotNull().doesNotContain("hunter2");
            assertThat(s.getPasswordHash()).startsWith("$2");
        }

        @Test
        @DisplayName("the owner never gets the password back, only whether there is one")
        void responseCarriesNoSecret() {
            MeetingShare s = share("tok");
            when(shares.findFirstByMeetingIdAndRevokedFalseAndStartSecondsIsNull(MEETING))
                    .thenReturn(Optional.of(s));

            ShareResponse res = service.createOrUpdate(USER, MEETING, opts().password("hunter2").build());

            assertThat(res.passwordProtected()).isTrue();
            assertThat(res.toString()).doesNotContain("hunter2");
        }

        @Test
        @DisplayName("a protected link needs the password")
        void requiresThePassword() {
            MeetingShare s = protectedShare();
            when(shares.findByToken("tok")).thenReturn(Optional.of(s));

            assertThatThrownBy(() -> service.resolve("tok", null)).isInstanceOf(ApiException.class);
            assertThatThrownBy(() -> service.resolve("tok", "wrong")).isInstanceOf(ApiException.class);
            assertThat(service.resolve("tok", "hunter2").title()).isEqualTo("Sprint planning");
        }

        @Test
        @DisplayName("a failed attempt is not a view")
        void wrongPasswordIsNotCounted() {
            MeetingShare s = protectedShare();
            when(shares.findByToken("tok")).thenReturn(Optional.of(s));

            assertThatThrownBy(() -> service.resolve("tok", "wrong")).isInstanceOf(ApiException.class);

            // Otherwise the owner's number measures how often the link was found
            // rather than how often it was read.
            assertThat(s.getViewCount()).isZero();
        }

        @Test
        @DisplayName("a password can be taken off again")
        void passwordCanBeRemoved() {
            MeetingShare s = share("tok");
            s.setPasswordHash("$2a$10$something");
            when(shares.findFirstByMeetingIdAndRevokedFalseAndStartSecondsIsNull(MEETING))
                    .thenReturn(Optional.of(s));

            service.createOrUpdate(USER, MEETING, opts().removePassword().build());

            assertThat(s.getPasswordHash()).isNull();
        }
    }

    // --- withdrawing ----------------------------------------------------------- //

    @Nested
    class Withdrawing {

        @Test
        @DisplayName("a revoked link stops working")
        void revokedTokenIsRejected() {
            MeetingShare s = share("tok");
            s.setRevoked(true);
            when(shares.findByToken("tok")).thenReturn(Optional.of(s));

            assertThatThrownBy(() -> service.resolve("tok", null)).isInstanceOf(ApiException.class);
        }

        @Test
        @DisplayName("an expired link stops working")
        void expiredTokenIsRejected() {
            MeetingShare s = share("tok");
            s.setExpiresAt(Instant.now().minusSeconds(60));
            when(shares.findByToken("tok")).thenReturn(Optional.of(s));

            assertThatThrownBy(() -> service.resolve("tok", null)).isInstanceOf(ApiException.class);
        }

        @Test
        @DisplayName("an unknown token fails the same way a revoked one does")
        void unknownTokenIsIndistinguishable() {
            MeetingShare revoked = share("revoked");
            revoked.setRevoked(true);
            when(shares.findByToken("nope")).thenReturn(Optional.empty());
            when(shares.findByToken("revoked")).thenReturn(Optional.of(revoked));

            String unknownMessage = messageOf(() -> service.resolve("nope", null));
            String revokedMessage = messageOf(() -> service.resolve("revoked", null));

            // A probe must not be able to tell "never existed" from "withdrawn".
            assertThat(unknownMessage).isEqualTo(revokedMessage);
        }

        @Test
        @DisplayName("viewing a shared meeting is counted")
        void viewsAreCounted() {
            MeetingShare live = share("tok");
            when(shares.findByToken("tok")).thenReturn(Optional.of(live));

            service.resolve("tok", null);
            service.resolve("tok", null);

            assertThat(live.getViewCount()).isEqualTo(2);
            assertThat(live.getLastViewedAt()).isNotNull();
        }

        @Test
        @DisplayName("revoking marks the link withdrawn rather than deleting the record")
        void revokeKeepsTheAuditTrail() {
            MeetingShare live = share("tok");
            when(shares.findFirstByMeetingIdAndRevokedFalseAndStartSecondsIsNull(MEETING))
                    .thenReturn(Optional.of(live));

            service.revoke(USER, MEETING);

            assertThat(live.isRevoked()).isTrue();
        }

        @Test
        @DisplayName("one moment link can be revoked without touching the others")
        void revokeOneById() {
            MeetingShare moment = share("tok_moment");
            when(shares.findByIdAndUserId("shr_1", USER)).thenReturn(Optional.of(moment));

            service.revokeById(USER, "shr_1");

            assertThat(moment.isRevoked()).isTrue();
        }

        @Test
        @DisplayName("another user's link cannot be revoked")
        void cannotRevokeSomeoneElsesLink() {
            when(shares.findByIdAndUserId("shr_1", "usr_other")).thenReturn(Optional.empty());

            assertThatThrownBy(() -> service.revokeById("usr_other", "shr_1"))
                    .isInstanceOf(ApiException.class);
        }
    }

    // --- emailing -------------------------------------------------------------- //

    @Nested
    class Emailing {

        @Test
        @DisplayName("the link is mailed to each address")
        void sendsToEveryone() {
            when(shares.findFirstByMeetingIdAndRevokedFalseAndStartSecondsIsNull(MEETING))
                    .thenReturn(Optional.of(share("tok")));

            int sent = service.emailLink(USER, MEETING,
                    new ShareEmailRequest(List.of("a@example.com", "b@example.com"), "Here it is"));

            assertThat(sent).isEqualTo(2);
            verify(email).send(eq("a@example.com"), anyString(), anyString());
            verify(email).send(eq("b@example.com"), anyString(), anyString());
        }

        @Test
        @DisplayName("emailing does not create a link")
        void willNotPublishByItself() {
            // An endpoint that both publishes a meeting and posts the URL to
            // arbitrary addresses is one mistaken click from a leak.
            assertThatThrownBy(() -> service.emailLink(USER, MEETING,
                    new ShareEmailRequest(List.of("a@example.com"), null)))
                    .isInstanceOf(ApiException.class);
            verify(email, never()).send(anyString(), anyString(), anyString());
        }

        @Test
        @DisplayName("the mail warns that a password will be needed")
        void mentionsThePassword() {
            MeetingShare s = share("tok");
            s.setPasswordHash("$2a$10$something");
            when(shares.findFirstByMeetingIdAndRevokedFalseAndStartSecondsIsNull(MEETING))
                    .thenReturn(Optional.of(s));

            service.emailLink(USER, MEETING, new ShareEmailRequest(List.of("a@example.com"), null));

            // The recipient is the one about to be stopped by it, and they
            // cannot ask the link why it wants a password.
            verify(email).send(eq("a@example.com"), anyString(),
                    org.mockito.ArgumentMatchers.contains("password protected"));
        }

        @Test
        @DisplayName("the mail never carries the password itself")
        void doesNotLeakThePassword() {
            MeetingShare s = share("tok");
            when(shares.findFirstByMeetingIdAndRevokedFalseAndStartSecondsIsNull(MEETING))
                    .thenReturn(Optional.of(s));
            service.createOrUpdate(USER, MEETING, opts().password("hunter2").build());

            service.emailLink(USER, MEETING, new ShareEmailRequest(List.of("a@example.com"), null));

            // Mailing the password with the link it protects would make it
            // decorative — one forwarded message and both are gone.
            verify(email).send(anyString(), anyString(),
                    org.mockito.ArgumentMatchers.argThat(body -> !body.contains("hunter2")));
        }
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
        m.setObjectKey("meetings/usr_1/mtg_1/audio.mp3");
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

    private static MeetingActionItem actionItem() {
        MeetingActionItem a = new MeetingActionItem();
        a.setId("ai_1");
        a.setMeetingId(MEETING);
        a.setTitle("Draft the rollout plan");
        a.setOwnerName("Marcus");
        return a;
    }

    private static MeetingTranscript transcript() {
        MeetingTranscript t = new MeetingTranscript();
        t.setId("txr_1");
        t.setMeetingId(MEETING);
        t.setTranscriptText("full verbatim transcript");
        return t;
    }

    private static TranscriptSegment segment(String speaker, String text, double start, double end) {
        TranscriptSegment s = new TranscriptSegment();
        s.setId("seg_" + start);
        s.setMeetingId(MEETING);
        s.setSpeaker(speaker);
        s.setText(text);
        s.setStartTime(start);
        s.setEndTime(end);
        return s;
    }

    private static MeetingShare share(String token) {
        MeetingShare s = new MeetingShare();
        s.setId("shr_1");
        s.setMeetingId(MEETING);
        s.setUserId(USER);
        s.setToken(token);
        return s;
    }

    /**
     * Telling the owner their link was opened (V40).
     *
     * <p>Opt-in, and rate-limited to one a day per link. A link posted to a
     * mailing list is opened dozens of times in an afternoon, and the whole
     * value of the message is lost the moment it becomes forty messages.
     */
    @org.junit.jupiter.api.Nested
    @DisplayName("share open email")
    class OpenEmail {

        private static final java.time.LocalDate TODAY = java.time.LocalDate.of(2026, 8, 17);

        private com.recallix.entity.UserEntity owner(boolean wants, boolean masterOn) {
            com.recallix.entity.UserEntity u = new com.recallix.entity.UserEntity();
            u.setId(USER);
            u.setEmail("ana@example.com");
            u.setShareOpenedEmail(wants);
            u.setEmailsEnabled(masterOn);
            return u;
        }

        private Meeting meeting() {
            Meeting m = new Meeting();
            m.setId(MEETING);
            m.setUserId(USER);
            m.setTitle("Sprint planning");
            return m;
        }

        @Test
        @DisplayName("says nothing unless the owner asked for it")
        void offByDefault() {
            when(users.require(USER)).thenReturn(owner(false, true));

            assertThat(service.emailOwnerOnOpen(USER, "shr_1", meeting(), TODAY)).isFalse();
            verify(email, never()).send(anyString(), anyString(), anyString());
        }

        @Test
        @DisplayName("mails the owner the first time a link is opened")
        void mailsOnFirstOpen() {
            MeetingShare s = share("tok_1");
            when(users.require(USER)).thenReturn(owner(true, true));
            when(shares.findById("shr_1")).thenReturn(java.util.Optional.of(s));
            when(email.send(anyString(), anyString(), anyString())).thenReturn(true);

            assertThat(service.emailOwnerOnOpen(USER, "shr_1", meeting(), TODAY)).isTrue();
            assertThat(s.getOpenEmailedOn()).isEqualTo(TODAY);
        }

        @Test
        @DisplayName("does not mail twice in one day however often the link is opened")
        void oncePerDay() {
            MeetingShare s = share("tok_1");
            s.setOpenEmailedOn(TODAY);
            when(users.require(USER)).thenReturn(owner(true, true));
            when(shares.findById("shr_1")).thenReturn(java.util.Optional.of(s));

            assertThat(service.emailOwnerOnOpen(USER, "shr_1", meeting(), TODAY)).isFalse();
            verify(email, never()).send(anyString(), anyString(), anyString());
        }

        @Test
        @DisplayName("leaves the day unstamped when the mail did not go out")
        void failureLeavesItEligible() {
            MeetingShare s = share("tok_1");
            when(users.require(USER)).thenReturn(owner(true, true));
            when(shares.findById("shr_1")).thenReturn(java.util.Optional.of(s));
            when(email.send(anyString(), anyString(), anyString())).thenReturn(false);

            // An SMTP server down for a minute must not cost the owner the day's
            // one notice.
            assertThat(service.emailOwnerOnOpen(USER, "shr_1", meeting(), TODAY)).isFalse();
            assertThat(s.getOpenEmailedOn()).isNull();
        }

        @Test
        @DisplayName("the master switch silences it")
        void masterSwitchWins() {
            when(users.require(USER)).thenReturn(owner(true, false));

            assertThat(service.emailOwnerOnOpen(USER, "shr_1", meeting(), TODAY)).isFalse();
            verify(email, never()).send(anyString(), anyString(), anyString());
        }
    }
}
