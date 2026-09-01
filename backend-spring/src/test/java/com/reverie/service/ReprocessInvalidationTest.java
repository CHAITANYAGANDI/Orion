package com.reverie.service;

import com.reverie.common.ApiException;
import com.reverie.domain.MeetingStatus;
import com.reverie.entity.Meeting;
import com.reverie.entity.UserEntity;
import com.reverie.repository.MeetingInsightRepository;
import com.reverie.repository.MeetingRepository;
import com.reverie.repository.MeetingSummaryRepository;
import com.reverie.repository.MeetingTranscriptRepository;
import com.reverie.repository.MeetingTranslationRepository;
import com.reverie.repository.ProjectRepository;
import com.reverie.repository.TranscriptSegmentRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InOrder;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.mockito.junit.jupiter.MockitoSettings;
import org.mockito.quality.Strictness;
import org.springframework.http.HttpStatus;

import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.assertj.core.api.Assertions.catchThrowable;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.inOrder;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

/**
 * Reprocessing a meeting, and the cache that has to go with it.
 *
 * <p>A reprocess re-derives the meeting-local speaker keys from scratch, by
 * first appearance. The audio is the same audio, but who ends up as
 * {@code spk_1} is not guaranteed to be the same person: a re-clustering that
 * splits an early interjection differently is enough to swap them.
 *
 * <pre>
 *   before:  spk_1 = Alice   spk_2 = Cindy
 *   after:   spk_1 = Cindy   spk_2 = Alice
 * </pre>
 *
 * <p>So a cached voiceprint that survives a reprocess is not merely stale — it
 * is a perfectly good vector filed under a key that now belongs to somebody
 * else, and the next rematch will name each of them after the other with full
 * confidence. That has always been dropped here. What it had not been was
 * <em>required</em>: the deletion was best-effort, so a failure was logged and
 * the reprocess went ahead anyway, which is the same hole manual correction had.
 *
 * <p>These pin the refusal, and — just as much — pin that a refusal costs
 * nothing else.
 */
@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class ReprocessInvalidationTest {

    private static final String USER = "usr_1";
    private static final String MEETING = "mtg_1";

    @Mock private MeetingRepository meetings;
    @Mock private MeetingTranscriptRepository transcripts;
    @Mock private TranscriptSegmentRepository segments;
    @Mock private MeetingSummaryRepository summaries;
    @Mock private MeetingInsightRepository insights;
    @Mock private StorageService storage;
    @Mock private UsageLimitService usage;
    @Mock private OutboxService outbox;
    @Mock private AuditService audit;
    @Mock private AiClient ai;
    @Mock private SummaryTemplateService templates;
    @Mock private ProjectRepository projects;
    @Mock private MeetingTranslationRepository translations;
    @Mock private NotificationService notifications;
    @Mock private ErasureService erasure;
    @Mock private UserService users;
    @Mock private SpeakerIdentityService speakerIdentity;

    private MeetingService service;
    private Meeting meeting;

    @BeforeEach
    void setUp() {
        service = new MeetingService(meetings, transcripts, segments, summaries,
                insights, storage, usage, outbox, audit, ai, templates, projects,
                translations, notifications, erasure, users, speakerIdentity);

        meeting = new Meeting();
        meeting.setId(MEETING);
        meeting.setUserId(USER);
        meeting.setTitle("Sprint review");
        meeting.setObjectKey("meetings/usr_1/mtg_1/audio.m4a");
        meeting.setStatus(MeetingStatus.READY);
        meeting.setProcessingAttempt(3);

        UserEntity user = new UserEntity();
        user.setId(USER);
        user.setDefaultLanguage("en");

        when(meetings.findByIdAndUserId(MEETING, USER)).thenReturn(Optional.of(meeting));
        when(meetings.lockAndReadAttempt(MEETING)).thenReturn(Optional.of(3));
        when(users.require(anyString())).thenReturn(user);
        when(templates.requireKnown(anyString())).thenReturn("general");
    }

    /** The ai-service could not confirm it deleted anything. */
    private void invalidationRefuses() {
        doThrow(ApiException.serviceUnavailable(
                "Speaker matching data could not be updated just now, so nothing "
                        + "was changed. Try again in a moment."))
                .when(speakerIdentity).invalidateMeetingVoiceprintsRequired(USER, MEETING);
    }

    @Nested
    @DisplayName("when the invalidation is confirmed")
    class Confirmed {

        @Test
        @DisplayName("the reprocess queues exactly as it always did")
        void itQueues() {
            // The mock returns normally, which is what a confirmed deletion
            // looks like from here.
            var response = service.reprocess(USER, MEETING);

            assertThat(response.status()).isEqualTo(MeetingStatus.QUEUED);
            assertThat(meeting.getStatus()).isEqualTo(MeetingStatus.QUEUED);
            assertThat(meeting.getProcessingAttempt()).isEqualTo(4);
            verify(speakerIdentity).invalidateMeetingVoiceprintsRequired(USER, MEETING);
            verify(outbox).enqueue(anyString(), eq(MEETING), any());
            verify(translations).markStaleByMeetingId(MEETING);
        }

        @Test
        @DisplayName("a meeting with nothing cached queues too")
        void zeroRowsIsNotAFailure() {
            // There is no separate signal for it and there should not be: the
            // service treats a confirmed deletion of zero rows as success, so
            // this path is identical to the one above. Pinned anyway, because
            // "no rows removed" is the state of every meeting nobody has ever
            // pressed Rematch on -- which is most of them, and refusing those
            // would break reprocessing for almost everybody.
            assertThatCode(() -> service.reprocess(USER, MEETING)).doesNotThrowAnyException();

            assertThat(meeting.getStatus()).isEqualTo(MeetingStatus.QUEUED);
        }

        @Test
        @DisplayName("it happens before the status moves, not after")
        void orderIsInvalidateThenQueue() {
            InOrder order = inOrder(usage, speakerIdentity, meetings, translations, outbox);

            service.reprocess(USER, MEETING);

            // The allowance check first, so a reprocess about to be refused for
            // a spent account does not cost the user a good cache on the way
            // out. Then the invalidation. Then -- and only then -- the row lock
            // and everything that writes.
            order.verify(usage).requireAiOrThrow(USER, UsageLimitService.AiFeature.REPROCESS);
            order.verify(speakerIdentity).invalidateMeetingVoiceprintsRequired(USER, MEETING);
            order.verify(meetings).lockAndReadAttempt(MEETING);
            order.verify(translations).markStaleByMeetingId(MEETING);
            order.verify(outbox).enqueue(anyString(), eq(MEETING), any());
        }

        @Test
        @DisplayName("the meeting row is not locked across the network call")
        void theLockIsTakenAfterwards() {
            // Deliberate, and the reason the invalidation sits above the lock
            // rather than beside the other writes. `lockAndReadAttempt` takes
            // FOR NO KEY UPDATE on the meeting row; holding that across an HTTP
            // round trip -- across a *timeout*, when the far end is what is
            // wrong -- would queue every other reprocess and erasure of this
            // meeting behind a service that is already failing.
            InOrder order = inOrder(speakerIdentity, meetings);

            service.reprocess(USER, MEETING);

            order.verify(speakerIdentity).invalidateMeetingVoiceprintsRequired(USER, MEETING);
            order.verify(meetings).lockAndReadAttempt(MEETING);
        }
    }

    @Nested
    @DisplayName("when it cannot be confirmed")
    class Unconfirmed {

        @BeforeEach
        void theInvalidationRefuses() {
            invalidationRefuses();
        }

        @Test
        @DisplayName("the reprocess is refused with a 503")
        void itRefuses() {
            Throwable thrown = catchThrowable(() -> service.reprocess(USER, MEETING));

            assertThat(thrown).isInstanceOf(ApiException.class);
            assertThat(((ApiException) thrown).getStatus())
                    .isEqualTo(HttpStatus.SERVICE_UNAVAILABLE);
        }

        @Test
        @DisplayName("the status does not move")
        void theStatusIsUnchanged() {
            // The whole pipeline keys off this. QUEUED over a job nobody
            // enqueued is a meeting that reads "Processing" for ever.
            assertThatThrownBy(() -> service.reprocess(USER, MEETING))
                    .isInstanceOf(ApiException.class);

            assertThat(meeting.getStatus()).isEqualTo(MeetingStatus.READY);
        }

        @Test
        @DisplayName("no job is enqueued")
        void nothingIsEnqueued() {
            assertThatThrownBy(() -> service.reprocess(USER, MEETING))
                    .isInstanceOf(ApiException.class);

            verify(outbox, never()).enqueue(anyString(), anyString(), any());
            // Nothing is announced either, and there is no longer a
            // "processing started" notification to check for -- see
            // NotificationKind#retired. The outbox is the enqueue.
            verifyNoInteractions(notifications);
        }

        @Test
        @DisplayName("no new attempt is allocated")
        void theRunNumberIsUnchanged() {
            // The attempt number is the identity every stale-callback check in
            // the system compares against. Burning one for a run that never
            // starts would make the *previous* run's results look stale and be
            // discarded when they land.
            assertThatThrownBy(() -> service.reprocess(USER, MEETING))
                    .isInstanceOf(ApiException.class);

            assertThat(meeting.getProcessingAttempt()).isEqualTo(3);
            verify(meetings, never()).lockAndReadAttempt(anyString());
        }

        @Test
        @DisplayName("translations are not marked stale")
        void translationsAreLeftAlone() {
            // A stale flag over a transcript that was never rewritten tells the
            // user their French page is out of date with an English page that
            // did not change -- and nothing later comes along to clear it.
            assertThatThrownBy(() -> service.reprocess(USER, MEETING))
                    .isInstanceOf(ApiException.class);

            verify(translations, never()).markStaleByMeetingId(anyString());
        }

        @Test
        @DisplayName("nothing is audited, because nothing happened")
        void noAuditTrail() {
            assertThatThrownBy(() -> service.reprocess(USER, MEETING))
                    .isInstanceOf(ApiException.class);

            verify(audit, never()).record(anyString(), eq("MEETING_REPROCESS"), anyString(), anyString());
        }

        @Test
        @DisplayName("and the account's named profiles are not touched")
        void namedProfilesSurvive() {
            assertThatThrownBy(() -> service.reprocess(USER, MEETING))
                    .isInstanceOf(ApiException.class);

            // Neither on the way through nor as cleanup on the way out. A
            // reprocess re-derives this meeting's speaker keys; it says nothing
            // about who the account knows.
            verify(speakerIdentity, never()).forgetEverything(anyString());
            verify(speakerIdentity, never()).deleteProfile(anyString(), anyString());
            verify(ai, never()).forgetSpeakers(anyString(), any(), any());
        }

        @Test
        @DisplayName("setting the language re-transcribes or does neither")
        void theLanguageSetterGoesWithIt() {
            // `setSpokenLanguage` writes the field and then reprocesses in the
            // same transaction, because a language that changed nothing on
            // screen is a control that does not work. The refusal has to take
            // the field with it: leaving "this meeting is French" on a
            // transcript still in English, with no run coming to fix it, is a
            // worse lie than refusing was.
            assertThatThrownBy(() -> service.setSpokenLanguage(USER, MEETING, "fr"))
                    .isInstanceOf(ApiException.class);

            verify(outbox, never()).enqueue(anyString(), anyString(), any());
            // In production the rollback is what undoes the field; here the
            // entity is a plain object with no transaction around it, so what
            // is asserted is the part this test can see -- that nothing was
            // queued and no run was started for a language that was set.
            assertThat(meeting.getStatus()).isEqualTo(MeetingStatus.READY);
        }
    }

    @Nested
    @DisplayName("the allowance check still comes first")
    class Allowance {

        @Test
        @DisplayName("a refused reprocess does not cost the cache")
        void aSpentAccountKeepsItsVoiceprints() {
            doThrow(ApiException.usageLimitReached("You have used all 300 transcription minutes"))
                    .when(usage).requireAiOrThrow(USER, UsageLimitService.AiFeature.REPROCESS);

            assertThatThrownBy(() -> service.reprocess(USER, MEETING))
                    .isInstanceOf(ApiException.class);

            // The ordering decision, asserted. Deleting a perfectly valid cache
            // for a reprocess that is then rejected would cost the user a
            // re-embed of the whole recording for an operation that did not
            // happen.
            verify(speakerIdentity, never())
                    .invalidateMeetingVoiceprintsRequired(anyString(), anyString());
            verify(speakerIdentity, never()).forgetMeeting(anyString(), anyString());
        }

        @Test
        @DisplayName("a meeting with no source never reaches either")
        void noSourceIsStillA400() {
            meeting.setObjectKey(null);
            meeting.setSourceUrl(null);

            assertThatThrownBy(() -> service.reprocess(USER, MEETING))
                    .isInstanceOf(ApiException.class)
                    .hasMessageContaining("no source");

            verify(usage, never()).requireAiOrThrow(anyString(), any());
            verify(speakerIdentity, never())
                    .invalidateMeetingVoiceprintsRequired(anyString(), anyString());
        }

        @Test
        @DisplayName("the allowance is checked, and nothing is charged here")
        void usageIsValidatedNotSpent() {
            service.reprocess(USER, MEETING);

            // Checked exactly once, for the right feature.
            verify(usage).requireAiOrThrow(USER, UsageLimitService.AiFeature.REPROCESS);
            // And spent by nobody at this point. The minutes are charged when
            // the run lands and its real length is known -- charging at enqueue
            // would bill for a job that may still fail, and bill twice for a
            // meeting reprocessed twice.
            verify(usage, never()).addAiMinutes(anyString(), anyInt());
            verify(usage, never()).chargeAiMinutesOnce(anyString(), anyString(), anyInt(), anyInt());
            verify(usage, never()).chargeMeetingOrThrow(anyString(), any(Boolean.class), any());
        }
    }
}
