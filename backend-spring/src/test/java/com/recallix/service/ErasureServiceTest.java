package com.recallix.service;

import com.recallix.common.ApiException;
import com.recallix.domain.MeetingStatus;
import com.recallix.dto.StatusEvent;
import com.recallix.entity.Meeting;
import com.recallix.entity.UserEntity;
import com.recallix.repository.MeetingActionItemRepository;
import com.recallix.repository.MeetingRepository;
import com.recallix.repository.MeetingSummaryRepository;
import com.recallix.repository.MeetingTranscriptRepository;
import com.recallix.repository.MeetingTranslationRepository;
import com.recallix.repository.TranscriptChunkRepository;
import com.recallix.repository.TranscriptMomentRepository;
import com.recallix.repository.TranscriptSegmentRepository;
import com.recallix.repository.UserRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InOrder;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.mockito.junit.jupiter.MockitoSettings;
import org.mockito.quality.Strictness;

import java.time.Instant;
import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.inOrder;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * Deleting things, and what has to go with them.
 *
 * <p>The failure this class is written against is not "the delete button did
 * nothing". It is the far quieter one where the delete button worked and
 * something the user cannot see kept a copy: the embeddings that still let chat
 * quote a transcript, the highlight that stores the sentence it was made on, the
 * share link that hands a stranger a signed URL for an object that is meant to
 * be gone. Every test below is a version of "and that went too".
 */
@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class ErasureServiceTest {

    private static final String USER = "usr_1";
    private static final String MEETING = "mtg_1";

    @Mock private MeetingRepository meetings;
    @Mock private MeetingTranscriptRepository transcripts;
    @Mock private TranscriptSegmentRepository segments;
    @Mock private MeetingSummaryRepository summaries;
    @Mock private MeetingActionItemRepository actionItems;
    @Mock private MeetingTranslationRepository translations;
    @Mock private TranscriptMomentRepository moments;
    @Mock private TranscriptChunkRepository chunks;
    @Mock private UserRepository users;
    @Mock private StorageService storage;
    @Mock private AuditService audit;
    @Mock private StatusPublisher statusPublisher;
    // Erasing a recording erases the voiceprints derived from it.
    @Mock private SpeakerIdentityService speakerIdentity;

    private ErasureService service;
    private Meeting meeting;

    @BeforeEach
    void setUp() {
        service = new ErasureService(meetings, transcripts, segments, summaries, actionItems,
                translations, moments, chunks, users, storage, audit, statusPublisher,
                speakerIdentity);
        meeting = new Meeting();
        meeting.setId(MEETING);
        meeting.setUserId(USER);
        meeting.setTitle("Sprint planning");
        meeting.setObjectKey("meetings/usr_1/mtg_1/audio.mp3");
        when(meetings.findByIdAndUserId(MEETING, USER)).thenReturn(Optional.of(meeting));
    }

    @Nested
    @DisplayName("erasing the transcript of a meeting still being processed")
    class ErasingMidRun {

        @Test
        @DisplayName("takes the meeting out of the state the invalidation emptied")
        void doesNotLeaveItProcessingForever() {
            // Bumping the attempt is what stops the running worker writing its
            // transcript over the erasure -- every callback it makes from here
            // is recognised as an overtaken run and ignored. Which leaves the
            // status saying TRANSCRIBING with nothing left that will ever
            // change it: a progress bar for a run whose every report is
            // discarded on arrival.
            meeting.setStatus(MeetingStatus.TRANSCRIBING);

            service.eraseTranscript(USER, MEETING);

            assertThat(meeting.getStatus()).isEqualTo(MeetingStatus.FAILED);
            assertThat(meeting.getErrorMessage()).contains("transcript was erased");
        }

        @Test
        @DisplayName("and tells the page that is open, so the spinner stops")
        void publishesTheNewStatus() {
            meeting.setStatus(MeetingStatus.TRANSCRIBING);

            service.eraseTranscript(USER, MEETING);

            ArgumentCaptor<StatusEvent> sent = ArgumentCaptor.forClass(StatusEvent.class);
            verify(statusPublisher).publish(sent.capture());
            assertThat(sent.getValue().meetingId()).isEqualTo(MEETING);
            assertThat(sent.getValue().status()).isEqualTo(MeetingStatus.FAILED);
        }

        @Test
        @DisplayName("every stage of the pipeline counts, not just transcription")
        void coversTheWholePipeline() {
            for (MeetingStatus running : new MeetingStatus[]{
                    MeetingStatus.QUEUED, MeetingStatus.TRANSCRIBING,
                    MeetingStatus.SUMMARIZING, MeetingStatus.EXTRACTING}) {
                Meeting m = new Meeting();
                m.setId(MEETING);
                m.setUserId(USER);
                m.setStatus(running);

                service.eraseTranscript(m);

                assertThat(m.getStatus()).as("from %s", running).isEqualTo(MeetingStatus.FAILED);
            }
        }

        @Test
        @DisplayName("a finished meeting stays finished")
        void leavesAReadyMeetingAlone() {
            // Nothing was in flight, so nothing was invalidated. The summary,
            // the action items and the decisions are all still there and the
            // meeting is exactly what it says it is -- only the words are gone.
            meeting.setStatus(MeetingStatus.READY);

            service.eraseTranscript(USER, MEETING);

            assertThat(meeting.getStatus()).isEqualTo(MeetingStatus.READY);
            assertThat(meeting.getErrorMessage()).isNull();
            verify(statusPublisher, never()).publish(any());
        }

        @Test
        @DisplayName("the meeting can still be reprocessed afterwards")
        void staysReprocessable() {
            // FAILED rather than a new status precisely so this remains true:
            // it is a state the product already offers a way out of.
            meeting.setStatus(MeetingStatus.TRANSCRIBING);
            int before = meeting.getProcessingAttempt();

            service.eraseTranscript(USER, MEETING);

            assertThat(meeting.getStatus()).isEqualTo(MeetingStatus.FAILED);
            assertThat(meeting.getProcessingAttempt()).isEqualTo(before + 1);
        }
    }

    @Nested
    @DisplayName("erasing the recording")
    class Audio {

        @Test
        @DisplayName("removes the object and stops the page offering it")
        void removesTheObject() {
            Instant at = service.eraseAudio(USER, MEETING);

            verify(storage).delete("meetings/usr_1/mtg_1/audio.mp3");
            assertThat(meeting.getObjectKey()).isNull();
            assertThat(meeting.getAudioUrl()).isNull();
            assertThat(meeting.getAudioDeletedAt()).isEqualTo(at);
        }

        @Test
        @DisplayName("keeps everything drawn from it")
        void keepsTheNotes() {
            service.eraseAudio(USER, MEETING);

            verify(transcripts, never()).deleteByMeetingId(anyString());
            verify(summaries, never()).deleteByMeetingId(anyString());
            verify(actionItems, never()).deleteByMeetingId(anyString());
            assertThat(meeting.getTranscriptDeletedAt()).isNull();
        }

        @Test
        @DisplayName("asking twice is not an error, and does not delete twice")
        void isIdempotent() {
            Instant first = service.eraseAudio(USER, MEETING);
            Instant second = service.eraseAudio(USER, MEETING);

            assertThat(second).isEqualTo(first);
            verify(storage).delete(anyString());
        }

        @Test
        @DisplayName("somebody else's meeting is simply not found")
        void refusesAnotherAccount() {
            when(meetings.findByIdAndUserId(MEETING, "usr_2")).thenReturn(Optional.empty());

            assertThatThrownBy(() -> service.eraseAudio("usr_2", MEETING))
                    .isInstanceOf(ApiException.class)
                    .hasMessageContaining("not found");
            verify(storage, never()).delete(anyString());
        }
    }

    @Nested
    @DisplayName("erasing the transcript")
    class Transcript {

        @Test
        @DisplayName("takes the segments, the marks and the translations with it")
        void takesEverythingMadeOfTheWords() {
            service.eraseTranscript(USER, MEETING);

            verify(transcripts).deleteByMeetingId(MEETING);
            verify(segments).deleteByMeetingId(MEETING);
            verify(moments).deleteByMeetingId(MEETING);
            verify(translations).deleteByMeetingId(MEETING);
        }

        @Test
        @DisplayName("takes the embeddings, so chat cannot still quote it")
        void takesTheEmbeddings() {
            service.eraseTranscript(USER, MEETING);

            verify(chunks).deleteByMeetingId(MEETING);
        }

        @Test
        @DisplayName("keeps the summary, the tasks and the recording")
        void keepsWhatWasDerived() {
            service.eraseTranscript(USER, MEETING);

            verify(summaries, never()).deleteByMeetingId(anyString());
            verify(actionItems, never()).deleteByMeetingId(anyString());
            verify(storage, never()).delete(anyString());
            assertThat(meeting.getObjectKey()).isNotNull();
        }

        @Test
        @DisplayName("fails outright when the embeddings cannot be reached")
        void aVectorFailureFailsTheWholeErasure() {
            // This used to be caught, logged, and called a success. The
            // embeddings are the one leftover that can still speak — chat
            // answers in prose and cites the passage it read — so "erased,
            // except for the part that can quote it back to you" is not a
            // deletion, and the caller was given no way to find that out.
            //
            // It also could not do what its comment claimed. Every statement
            // here is in one transaction, and PostgreSQL refuses every
            // statement after a failed one, so the timestamp this returned was
            // never going to reach the database: the real behaviour was a
            // rollback under a log line announcing success.
            when(chunks.deleteByMeetingId(MEETING)).thenThrow(new IllegalStateException("pgvector down"));

            assertThatThrownBy(() -> service.eraseTranscript(USER, MEETING))
                    .isInstanceOf(IllegalStateException.class);
        }

        @Test
        @DisplayName("does not claim the transcript is gone when the embeddings are not")
        void aVectorFailureLeavesNoDeletionMark() {
            when(chunks.deleteByMeetingId(MEETING)).thenThrow(new IllegalStateException("pgvector down"));

            assertThatThrownBy(() -> service.eraseTranscript(USER, MEETING))
                    .isInstanceOf(IllegalStateException.class);

            // The mark is what the page reads to say "deleted". Set beside
            // surviving embeddings it is a false statement about the account
            // holder's data.
            assertThat(meeting.getTranscriptDeletedAt()).isNull();
        }

        @Test
        @DisplayName("takes the meeting row before any of the rows drawn from it")
        void locksTheMeetingFirst() {
            // Lock order, and the reason it matters is not theoretical: the
            // ai-service's indexer takes the meeting and then the chunks, so
            // taking the chunks first here deadlocks whenever a meeting is
            // erased while it is being indexed. Reproduced against a real
            // PostgreSQL before this line existed.
            service.eraseTranscript(USER, MEETING);

            InOrder order = inOrder(meetings, chunks);
            order.verify(meetings).lockForWrite(MEETING);
            order.verify(chunks).deleteByMeetingId(MEETING);
        }

        @Test
        @DisplayName("moves the processing attempt on, so a run in flight cannot undo it")
        void invalidatesRunsThatAreAlreadyGoing() {
            // A pipeline run that started before the erasure would otherwise
            // wake up afterwards, find the attempt it was given still current,
            // and put the transcript and its embeddings straight back —
            // `applyResult` replaces the transcript wholesale and the indexer
            // replaces the chunks. Moving the number makes both of them stale
            // by the check each already performs.
            meeting.setProcessingAttempt(3);

            service.eraseTranscript(USER, MEETING);

            assertThat(meeting.getProcessingAttempt()).isEqualTo(4);
        }

        @Test
        @DisplayName("erasing twice does not keep moving the attempt")
        void isStillIdempotent() {
            service.eraseTranscript(USER, MEETING);
            int after = meeting.getProcessingAttempt();

            service.eraseTranscript(USER, MEETING);

            assertThat(meeting.getProcessingAttempt()).isEqualTo(after);
            verify(chunks, times(1)).deleteByMeetingId(MEETING);
        }

    }

    @Nested
    @DisplayName("erasing the meeting")
    class WholeMeeting {

        @Test
        @DisplayName("removes the row and the object")
        void removesEverything() {
            service.eraseMeeting(USER, MEETING);

            verify(transcripts).deleteByMeetingId(MEETING);
            verify(segments).deleteByMeetingId(MEETING);
            verify(summaries).deleteByMeetingId(MEETING);
            verify(actionItems).deleteByMeetingId(MEETING);
            verify(translations).deleteByMeetingId(MEETING);
            verify(storage).delete("meetings/usr_1/mtg_1/audio.mp3");
            verify(meetings).delete(meeting);
        }

        @Test
        @DisplayName("is recorded in the audit log")
        void isAudited() {
            service.eraseMeeting(USER, MEETING);

            verify(audit).record(USER, "MEETING_DELETED", "meeting", MEETING);
        }
    }

    @Nested
    @DisplayName("closing the account")
    class Account {

        @Test
        @DisplayName("deletes every stored object, then the one row the rest cascades from")
        void deletesObjectsThenTheUser() {
            UserEntity user = new UserEntity();
            user.setId(USER);
            Meeting second = new Meeting();
            second.setId("mtg_2");
            second.setUserId(USER);
            second.setObjectKey("meetings/usr_1/mtg_2/audio.mp3");
            when(meetings.findByUserIdOrderByCreatedAtDesc(USER)).thenReturn(List.of(meeting, second));
            when(users.findById(USER)).thenReturn(Optional.of(user));

            int objects = service.eraseAccount(USER);

            assertThat(objects).isEqualTo(2);
            verify(storage).delete("meetings/usr_1/mtg_1/audio.mp3");
            verify(storage).delete("meetings/usr_1/mtg_2/audio.mp3");
            verify(users).delete(user);
        }

        @Test
        @DisplayName("does not count a meeting that never had a recording")
        void skipsMeetingsWithoutObjects() {
            UserEntity user = new UserEntity();
            user.setId(USER);
            Meeting imported = new Meeting();
            imported.setId("mtg_2");
            imported.setUserId(USER);
            imported.setSourceUrl("https://youtu.be/x");
            when(meetings.findByUserIdOrderByCreatedAtDesc(USER)).thenReturn(List.of(imported));
            when(users.findById(USER)).thenReturn(Optional.of(user));

            assertThat(service.eraseAccount(USER)).isZero();
            verify(storage, never()).delete(anyString());
        }

        @Test
        @DisplayName("writes the audit line before the log it lives in cascades away")
        void auditsBeforeDeleting() {
            UserEntity user = new UserEntity();
            user.setId(USER);
            when(meetings.findByUserIdOrderByCreatedAtDesc(USER)).thenReturn(List.of());
            when(users.findById(USER)).thenReturn(Optional.of(user));

            service.eraseAccount(USER);

            var order = org.mockito.Mockito.inOrder(audit, users);
            order.verify(audit).record(USER, "ACCOUNT_ERASED", "user", USER);
            order.verify(users).delete(user);
        }
    }
}
