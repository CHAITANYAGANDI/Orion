package com.orion.service;

import com.orion.domain.MeetingStatus;
import com.orion.dto.callback.MeetingJobState;
import com.orion.entity.Meeting;
import com.orion.repository.MeetingActionItemRepository;
import com.orion.repository.MeetingInsightRepository;
import com.orion.repository.MeetingRepository;
import com.orion.repository.MeetingSummaryRepository;
import com.orion.repository.MeetingTranscriptRepository;
import com.orion.repository.TranscriptSegmentRepository;
import com.orion.repository.UserRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.EnumSource;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.mockito.junit.jupiter.MockitoSettings;
import org.mockito.quality.Strictness;
import org.springframework.context.ApplicationEventPublisher;

import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

/**
 * What the worker is told before it decides to spend money.
 *
 * <p><strong>The sequence this exists for.</strong> Kafka delivery is
 * at-least-once and AssemblyAI bills per transcription. A consumer that was
 * evicted mid-run left its offset uncommitted, so the same
 * {@code meeting_uploaded} came back and the worker transcribed the recording
 * again — from the top, at full price, with the meeting's status walking
 * backwards from EXTRACTING to TRANSCRIBING in front of the person waiting for
 * it. One 42-minute upload was submitted to the provider three times.
 *
 * <p>The eviction itself is fixed in the ai-service, by keeping the blocking
 * speaker work off the event loop. This is the second line: even if a worker is
 * evicted again — a deploy, a broker rebalance, a network partition — the
 * redelivery costs one HTTP GET instead of a transcription.
 *
 * <p>The interesting cases are the ones where it must <em>not</em> skip, and
 * they are below in {@code MustStillRun}. A guard that is too eager here does
 * not cost money, it loses meetings, which is worse.
 */
@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class JobStateTest {

    private static final String MEETING = "mtg_1";

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

    @BeforeEach
    void setUp() {
        service = new CallbackService(meetings, transcripts, segments, summaries, actionItems,
                insights, statusPublisher, usage, events, notifications, users, mail);
    }

    private Meeting meeting(MeetingStatus status, int attempt) {
        Meeting m = new Meeting();
        m.setId(MEETING);
        m.setUserId("usr_1");
        m.setStatus(status);
        m.setProcessingAttempt(attempt);
        return m;
    }

    @Test
    @DisplayName("reports the status and the run together")
    void reportsBoth() {
        when(meetings.findById(MEETING))
                .thenReturn(Optional.of(meeting(MeetingStatus.TRANSCRIBING, 3)));

        MeetingJobState state = service.jobState(MEETING).orElseThrow();

        assertThat(state.status()).isEqualTo(MeetingStatus.TRANSCRIBING);
        assertThat(state.processingAttempt()).isEqualTo(3);
    }

    @Test
    @DisplayName("a meeting that is not there is empty, not an exception")
    void missingIsEmpty() {
        // What Stop leaves behind. The worker reads it as "nothing to do"
        // rather than as an error, because transcribing a recording somebody
        // has already cancelled is the thing being prevented.
        when(meetings.findById(MEETING)).thenReturn(Optional.empty());

        assertThat(service.jobState(MEETING)).isEmpty();
    }

    @Test
    @DisplayName("reads, and writes nothing at all")
    void writesNothing() {
        when(meetings.findById(MEETING))
                .thenReturn(Optional.of(meeting(MeetingStatus.QUEUED, 1)));

        service.jobState(MEETING);

        // It is on the same authenticated channel as applyStatus and
        // applyResult, and it must never become a way to move a meeting.
        verifyNoInteractions(transcripts, segments, summaries, insights, actionItems,
                usage, notifications, events, statusPublisher);
    }

    @Nested
    @DisplayName("terminal()")
    class Terminal {

        @Test
        @DisplayName("READY is finished")
        void ready() {
            assertThat(new MeetingJobState(MeetingStatus.READY, 1).terminal()).isTrue();
        }

        @Test
        @DisplayName("FAILED is finished too")
        void failed() {
            // A failed run has already reported itself and rung the bell.
            // Redelivering it would either fail identically at the same cost
            // or, worse, succeed and quietly overwrite an error a person has
            // already been shown and may have acted on.
            assertThat(new MeetingJobState(MeetingStatus.FAILED, 1).terminal()).isTrue();
        }

        @ParameterizedTest
        @EnumSource(value = MeetingStatus.class,
                names = {"CREATED", "UPLOADED", "QUEUED", "TRANSCRIBING", "SUMMARIZING",
                        "EXTRACTING"})
        @DisplayName("every other status still has work left in it")
        void everythingElseIsUnfinished(MeetingStatus status) {
            // Exhaustive by enum rather than by a list, so a status added later
            // has to be classified here instead of silently defaulting to
            // "keep going" — which is the safe direction, but should be a
            // decision rather than an accident.
            assertThat(new MeetingJobState(status, 1).terminal()).isFalse();
        }
    }

    @Nested
    @DisplayName("must still run")
    class MustStillRun {

        @Test
        @DisplayName("a reprocess, even though the meeting has been READY before")
        void reprocess() {
            // MeetingService.reprocess moves the status to QUEUED and bumps the
            // attempt in one transaction, and the outbox publishes only after
            // that commits — so this is what run 2's message finds. Skipping it
            // would leave the meeting on its old transcript with a QUEUED badge
            // and nobody coming back for it, having already charged for the run.
            when(meetings.findById(MEETING))
                    .thenReturn(Optional.of(meeting(MeetingStatus.QUEUED, 2)));

            MeetingJobState state = service.jobState(MEETING).orElseThrow();

            assertThat(state.terminal()).isFalse();
            assertThat(state.processingAttempt()).isEqualTo(2);
        }

        @Test
        @DisplayName("a first delivery of a brand new meeting")
        void firstDelivery() {
            when(meetings.findById(MEETING))
                    .thenReturn(Optional.of(meeting(MeetingStatus.QUEUED, 1)));

            assertThat(service.jobState(MEETING).orElseThrow().terminal()).isFalse();
        }
    }
}
