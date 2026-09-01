package com.reverie.service;

import com.reverie.common.ApiException;
import com.reverie.domain.MeetingStatus;
import com.reverie.dto.StatusEvent;
import com.reverie.dto.callback.AiInsight;
import com.reverie.dto.callback.AiSegment;
import com.reverie.dto.callback.MeetingBriefResult;
import com.reverie.dto.callback.StatusCallbackRequest;
import com.reverie.entity.Meeting;
import com.reverie.entity.MeetingSummary;
import com.reverie.entity.MeetingTranscript;
import com.reverie.event.MeetingReadyEvent;
import com.reverie.repository.MeetingActionItemRepository;
import com.reverie.repository.MeetingInsightRepository;
import com.reverie.repository.MeetingRepository;
import com.reverie.repository.MeetingSummaryRepository;
import com.reverie.repository.MeetingTranscriptRepository;
import com.reverie.repository.TranscriptSegmentRepository;
import com.reverie.repository.UserRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.mockito.junit.jupiter.MockitoSettings;
import org.mockito.quality.Strictness;
import org.springframework.context.ApplicationEventPublisher;

import java.time.Instant;
import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

/**
 * A result that comes back after the meeting has moved on.
 *
 * <p><strong>The sequence this exists for.</strong> Run 1 finishes and Spring
 * commits everything it produced — READY, the brief, the AI-minute charge. The
 * HTTP response is lost on the way back, so the worker cannot know that, holds
 * its Kafka offset, and the message stays on the topic. Meanwhile a person
 * looks at the transcript, decides it is wrong, and presses reprocess: the
 * meeting is now on run 2 and a second job is queued behind the first. Kafka
 * redelivers run 1's message first, and run 1's result arrives at Spring for a
 * second time — while run 2 is in flight.
 *
 * <p>Before the attempt travelled with the message, that arrival read
 * {@code processing_attempt} off the meeting row and so <em>became</em> run 2.
 * It spent run 2's AI-minute claim, took run 2's notification keys, and wrote
 * the old transcript over whatever run 2 had produced — and run 2, arriving
 * afterwards, found its own effects already claimed and landed in silence. The
 * account was charged once for two transcriptions and the user was shown the
 * transcript they had just asked to be replaced.
 *
 * <p>The fix is that a callback says which run it is, and this is where that is
 * checked. These tests hold the three answers apart: the current run is applied,
 * an older one does nothing at all, and one from a run the meeting has never
 * reached is refused rather than believed.
 */
@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class ProcessingAttemptRaceTest {

    private static final String MEETING = "mtg_1";
    private static final String USER = "usr_1";

    @Mock private MeetingRepository meetings;
    @Mock private MeetingTranscriptRepository transcripts;
    @Mock private TranscriptSegmentRepository segments;
    @Mock private MeetingSummaryRepository summaries;
    @Mock private MeetingActionItemRepository actionItems;
    @Mock private MeetingInsightRepository insights;
    @Mock private StatusPublisher statusPublisher;
    @Mock private UsageLimitService usage;
    @Mock private ApplicationEventPublisher events;
    @Mock private NotificationService notifications;
    @Mock private UserRepository users;
    @Mock private AccountMail mail;

    private CallbackService service;
    private Meeting meeting;

    @BeforeEach
    void setUp() {
        service = new CallbackService(meetings, transcripts, segments, summaries, actionItems,
                insights, statusPublisher, usage, events, notifications, users, mail);

        meeting = new Meeting();
        meeting.setId(MEETING);
        meeting.setUserId(USER);
        meeting.setStatus(MeetingStatus.QUEUED);
        meeting.setCreatedAt(Instant.parse("2026-08-12T09:00:00Z"));
        meeting.setDurationSeconds(2400);   // forty minutes, so charging happens
        when(meetings.findById(MEETING)).thenReturn(Optional.of(meeting));
        when(actionItems.findEditedByMeetingId(anyString())).thenReturn(List.of());
        when(actionItems.findByMeetingId(anyString())).thenReturn(List.of());
        when(users.findById(USER)).thenReturn(Optional.empty());
        when(transcripts.save(any())).thenAnswer(i -> i.getArgument(0));
        when(summaries.save(any())).thenAnswer(i -> i.getArgument(0));
    }

    /** The brief one run produced, tagged with the run that produced it. */
    private static MeetingBriefResult result(String text, Integer attempt) {
        return new MeetingBriefResult(
                MEETING, text, "en",
                List.of(new AiSegment(0.0, 8.0, "Priya", text, null, null)),
                text + " summary", "detailed", List.of(), List.of(), List.of(),
                "general", List.of(),
                List.of(new AiInsight("DECISION", text + " decision", "Decisions")),
                List.of(), null, null, attempt);
    }

    /** Everything `applyResult` writes, so a no-op can be asserted as a whole. */
    private void assertNothingWasWritten() {
        verifyNoInteractions(transcripts, segments, summaries, insights, usage, notifications);
        verify(actionItems, never()).deleteDerivedByMeetingId(anyString());
        verify(actionItems, never()).save(any());
        verifyNoInteractions(events);
    }

    // ----------------------------------------------------------------------- //
    @Nested
    @DisplayName("a job that was never posted")
    class NeverPosted {

        /** The reconciler, wired to the real callback service above. */
        private RetiredMeetingJobReconciler reconciler;
        private final com.fasterxml.jackson.databind.ObjectMapper mapper =
                new com.fasterxml.jackson.databind.ObjectMapper();

        @org.junit.jupiter.api.BeforeEach
        void wire() {
            reconciler = new RetiredMeetingJobReconciler(service);
        }

        private com.reverie.event.OutboxEventRetired retired(int attempt) {
            var payload = mapper.createObjectNode()
                    .put("meetingId", MEETING)
                    .put("processingAttempt", attempt);
            return new com.reverie.event.OutboxEventRetired(
                    "obx_1", "meeting_uploaded", MEETING, payload,
                    "RecordTooLargeException: 2MB");
        }

        @Test
        @DisplayName("the meeting stops waiting for it")
        void failsTheCurrentRun() {
            // Phase 3 gave the relay the ability to abandon an event that can
            // never be published. Without this path the meeting it belonged to
            // waits in QUEUED for a message nobody will ever send, and nothing
            // in the system notices: every component did what it was told.
            meeting.setStatus(MeetingStatus.QUEUED);
            meeting.setProcessingAttempt(1);

            reconciler.onRetired(retired(1));

            assertThat(meeting.getStatus()).isEqualTo(MeetingStatus.FAILED);
            assertThat(meeting.getErrorMessage()).contains("could not be started");
            verify(notifications).processingFailed(eq(meeting), anyString(), eq(1));
        }

        @Test
        @DisplayName("a dead old job does not take a live new one down with it")
        void doesNotTouchANewerRun() {
            // The order that makes this reachable: attempt 1's event cannot be
            // published, the user gives up waiting and reprocesses, and only
            // then does the relay give up on attempt 1. The retirement is about
            // a run the meeting has already left behind.
            meeting.setStatus(MeetingStatus.TRANSCRIBING);
            meeting.setProcessingAttempt(2);

            reconciler.onRetired(retired(1));

            assertThat(meeting.getStatus()).isEqualTo(MeetingStatus.TRANSCRIBING);
            assertThat(meeting.getErrorMessage()).isNull();
            verify(notifications, never()).processingFailed(any(), anyString(), anyInt());
        }

        @Test
        @DisplayName("and neither does one too broken to say which run it was")
        void anAttemptlessEventCannotReachPastTheFirstRun() {
            meeting.setStatus(MeetingStatus.TRANSCRIBING);
            meeting.setProcessingAttempt(4);

            reconciler.onRetired(new com.reverie.event.OutboxEventRetired(
                    "obx_1", "meeting_uploaded", MEETING,
                    mapper.createObjectNode(), "JsonParseException: unrenderable"));

            // Read as attempt 1, which is stale against 4.
            assertThat(meeting.getStatus()).isEqualTo(MeetingStatus.TRANSCRIBING);
        }
    }

    // ----------------------------------------------------------------------- //
    @Nested
    @DisplayName("a transcript that comes back after an erasure")
    class AfterErasure {

        @Test
        @DisplayName("stops the meeting claiming its transcript was deleted")
        void clearsTheErasureMark() {
            // Erasing the transcript sets the mark and bumps the attempt; a
            // later reprocess produces a new transcript. The mark used to stay
            // put, so the meeting showed its words on one line and reported
            // them deleted on the next.
            meeting.setProcessingAttempt(2);
            meeting.setTranscriptDeletedAt(Instant.parse("2026-08-20T10:00:00Z"));

            service.applyResult(MEETING, result("the new transcript", 2));

            assertThat(meeting.getTranscriptDeletedAt()).isNull();
            assertThat(meeting.getStatus()).isEqualTo(MeetingStatus.READY);
        }

        @Test
        @DisplayName("but a stale run does not un-erase anything")
        void aStaleRunLeavesTheMarkStanding() {
            // The run that was invalidated BY the erasure reporting in. It
            // writes nothing, so there is no transcript, so the mark is still
            // the truth.
            meeting.setProcessingAttempt(3);
            Instant erased = Instant.parse("2026-08-20T10:00:00Z");
            meeting.setTranscriptDeletedAt(erased);

            service.applyResult(MEETING, result("the erased transcript", 2));

            assertThat(meeting.getTranscriptDeletedAt()).isEqualTo(erased);
            assertNothingWasWritten();
        }
    }

    // ----------------------------------------------------------------------- //
    @Nested
    @DisplayName("the run the meeting is on")
    class Current {

        @Test
        @DisplayName("is applied, and charged against its own attempt")
        void isApplied() {
            meeting.setProcessingAttempt(1);

            service.applyResult(MEETING, result("first", 1));

            assertThat(meeting.getStatus()).isEqualTo(MeetingStatus.READY);
            verify(usage).chargeAiMinutesOnce(USER, MEETING, 1, 40);
            verify(notifications).summaryReady(meeting, 1);
        }

        @Test
        @DisplayName("is applied after a reprocess, under the new attempt")
        void secondRunIsApplied() {
            meeting.setProcessingAttempt(2);

            service.applyResult(MEETING, result("second", 2));

            assertThat(meeting.getStatus()).isEqualTo(MeetingStatus.READY);
            // Charged again, deliberately: reprocessing really does transcribe
            // again, and the allowance counts minutes transcribed.
            verify(usage).chargeAiMinutesOnce(USER, MEETING, 2, 40);
            verify(notifications).summaryReady(meeting, 2);
        }

        @Test
        @DisplayName("stays idempotent when its own callback is redelivered")
        void duplicateOfTheCurrentRun() {
            meeting.setProcessingAttempt(2);

            service.applyResult(MEETING, result("second", 2));
            service.applyResult(MEETING, result("second", 2));

            // Both are applied here -- this class is the attempt gate, not the
            // duplicate gate. What makes the second harmless is that it claims
            // the same (meeting, attempt) row and the same notification keys,
            // which is ProcessingIdempotencyTest's subject.
            verify(usage, org.mockito.Mockito.times(2))
                    .chargeAiMinutesOnce(USER, MEETING, 2, 40);
            verify(usage, never()).chargeAiMinutesOnce(eq(USER), eq(MEETING), eq(3), anyInt());
        }
    }

    // ----------------------------------------------------------------------- //
    @Nested
    @DisplayName("a run a reprocess has overtaken")
    class Stale {

        @BeforeEach
        void reprocessHappened() {
            // Run 1 completed and its response was lost; the user reprocessed.
            meeting.setProcessingAttempt(2);
            meeting.setStatus(MeetingStatus.TRANSCRIBING);
            meeting.setErrorMessage(null);
        }

        @Test
        @DisplayName("writes nothing at all")
        void changesNothing() {
            service.applyResult(MEETING, result("stale", 1));

            assertNothingWasWritten();
        }

        @Test
        @DisplayName("does not spend the new run's AI minutes")
        void doesNotCharge() {
            service.applyResult(MEETING, result("stale", 1));

            verify(usage, never()).chargeAiMinutesOnce(anyString(), anyString(), anyInt(), anyInt());
        }

        @Test
        @DisplayName("does not take the new run's notification keys")
        void doesNotNotify() {
            service.applyResult(MEETING, result("stale", 1));

            verify(notifications, never()).summaryReady(any(), anyInt());
            verify(notifications, never()).transcriptReady(any(), anyInt());
        }

        @Test
        @DisplayName("does not overwrite the transcript, segments or summary")
        void doesNotOverwriteDerivedState() {
            service.applyResult(MEETING, result("stale", 1));

            verify(transcripts, never()).deleteByMeetingId(anyString());
            verify(transcripts, never()).save(any(MeetingTranscript.class));
            verify(segments, never()).deleteByMeetingId(anyString());
            verify(summaries, never()).deleteByMeetingId(anyString());
            verify(summaries, never()).save(any(MeetingSummary.class));
        }

        @Test
        @DisplayName("does not replace action items or insights")
        void doesNotReplaceExtraction() {
            service.applyResult(MEETING, result("stale", 1));

            verify(actionItems, never()).deleteDerivedByMeetingId(anyString());
            verify(insights, never()).deleteDerivedByMeetingId(anyString());
        }

        @Test
        @DisplayName("does not re-announce the meeting to Meeting Memory")
        void doesNotReindex() {
            // MeetingReadyEvent is what tells the rest of Spring this meeting's
            // transcript is queryable. Firing it for an obsolete run would point
            // retrieval at evidence that is on its way out.
            service.applyStatus(MEETING, new StatusCallbackRequest("READY", 100, "done", 1));

            verify(events, never()).publishEvent(any(MeetingReadyEvent.class));
        }

        @Test
        @DisplayName("does not move the meeting's status")
        void doesNotRegressStatus() {
            service.applyResult(MEETING, result("stale", 1));
            service.applyStatus(MEETING, new StatusCallbackRequest("READY", 100, "done", 1));

            assertThat(meeting.getStatus()).isEqualTo(MeetingStatus.TRANSCRIBING);
        }

        @Test
        @DisplayName("does not write an error onto a meeting that is running")
        void doesNotOverwriteTheErrorMessage() {
            service.applyStatus(MEETING,
                    new StatusCallbackRequest("FAILED", 100, "the old run gave up", 1));

            assertThat(meeting.getStatus()).isEqualTo(MeetingStatus.TRANSCRIBING);
            assertThat(meeting.getErrorMessage()).isNull();
            verify(notifications, never()).processingFailed(any(), anyString(), anyInt());
        }

        @Test
        @DisplayName("does not put the old run's progress bar back on screen")
        void doesNotPublishStatus() {
            service.applyStatus(MEETING,
                    new StatusCallbackRequest("TRANSCRIBING", 20, "Transcribing...", 1));

            verify(statusPublisher, never()).publish(any(StatusEvent.class));
        }

        @Test
        @DisplayName("is reported as handled, so its Kafka message can finish")
        void isASuccessfulNoOp() {
            // Not an error. The worker holds the offset until Spring accepts the
            // callback, and `meeting_uploaded` has one partition -- refusing this
            // with a retryable answer would queue every later meeting behind a
            // message that can never make progress.
            assertThatCode(() -> service.applyResult(MEETING, result("stale", 1)))
                    .doesNotThrowAnyException();
            assertThatCode(() -> service.applyStatus(MEETING,
                    new StatusCallbackRequest("READY", 100, "done", 1)))
                    .doesNotThrowAnyException();
        }

        @Test
        @DisplayName("is still stale many runs later")
        void staysStale() {
            meeting.setProcessingAttempt(9);

            service.applyResult(MEETING, result("ancient", 3));

            assertNothingWasWritten();
        }
    }

    // ----------------------------------------------------------------------- //
    @Nested
    @DisplayName("a run the meeting has never reached")
    class Ahead {

        @BeforeEach
        void meetingIsOnItsFirstRun() {
            meeting.setProcessingAttempt(1);
        }

        @Test
        @DisplayName("is refused rather than believed")
        void isRefused() {
            assertThatThrownBy(() -> service.applyResult(MEETING, result("impossible", 2)))
                    .isInstanceOf(ApiException.class)
                    .hasMessageContaining("ahead of meeting");
        }

        @Test
        @DisplayName("does not drag the meeting forward to match")
        void doesNotAdvanceTheMeeting() {
            assertThatThrownBy(() -> service.applyResult(MEETING, result("impossible", 5)))
                    .isInstanceOf(ApiException.class);

            // The number moves in exactly one place -- reprocess -- and a
            // callback is not allowed to be the second.
            assertThat(meeting.getProcessingAttempt()).isEqualTo(1);
        }

        @Test
        @DisplayName("mutates nothing on the way out")
        void changesNothing() {
            assertThatThrownBy(() -> service.applyResult(MEETING, result("impossible", 2)))
                    .isInstanceOf(ApiException.class);

            assertNothingWasWritten();
            assertThat(meeting.getStatus()).isEqualTo(MeetingStatus.QUEUED);
        }

        @Test
        @DisplayName("cannot arrive as a status either")
        void statusIsRefusedToo() {
            assertThatThrownBy(() -> service.applyStatus(MEETING,
                    new StatusCallbackRequest("READY", 100, "done", 4)))
                    .isInstanceOf(ApiException.class);

            assertThat(meeting.getStatus()).isEqualTo(MeetingStatus.QUEUED);
            verify(statusPublisher, never()).publish(any(StatusEvent.class));
            verify(events, never()).publishEvent(any(MeetingReadyEvent.class));
        }
    }

    // ----------------------------------------------------------------------- //
    @Nested
    @DisplayName("a callback that names no run at all")
    class Legacy {

        @Test
        @DisplayName("is taken as the first run, and applies to a meeting still on it")
        void appliesToAFirstRun() {
            // A worker deployed before the field existed. Live inspection found
            // no such events outstanding, but the rule has to be safe anyway.
            meeting.setProcessingAttempt(1);

            service.applyResult(MEETING, result("legacy", null));

            assertThat(meeting.getStatus()).isEqualTo(MeetingStatus.READY);
            verify(usage).chargeAiMinutesOnce(USER, MEETING, 1, 40);
        }

        @Test
        @DisplayName("is stale against a meeting that has been reprocessed")
        void cannotImpersonateAReprocess() {
            // The whole reason the default is 1 rather than "the current run".
            // Read as current, an old message would have been handed the new
            // run's identity -- which is precisely the race being closed.
            meeting.setProcessingAttempt(2);

            service.applyResult(MEETING, result("legacy", null));

            assertNothingWasWritten();
        }

        @Test
        @DisplayName("is taken as the first run even if it says zero or nonsense")
        void nonsenseFallsBackToTheFirstRun() {
            meeting.setProcessingAttempt(1);

            service.applyResult(MEETING, result("legacy", 0));

            assertThat(meeting.getStatus()).isEqualTo(MeetingStatus.READY);
            verify(usage).chargeAiMinutesOnce(USER, MEETING, 1, 40);
        }
    }

    // ----------------------------------------------------------------------- //
    @Test
    @DisplayName("a status for a meeting that no longer exists still reaches the socket")
    void unknownMeetingIsUnchanged() {
        // Deliberately untouched behaviour: with no meeting there is no run to
        // be stale against, and the frame is all the client will ever get.
        when(meetings.findById("mtg_gone")).thenReturn(Optional.empty());

        service.applyStatus("mtg_gone", new StatusCallbackRequest("TRANSCRIBING", 20, "...", 3));

        verify(statusPublisher).publish(any(StatusEvent.class));
    }
}
