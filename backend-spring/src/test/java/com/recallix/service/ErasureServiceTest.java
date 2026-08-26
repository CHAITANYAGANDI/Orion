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
import com.recallix.repository.SpeakerProfileRepository;
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
import org.springframework.http.HttpStatus;

import java.time.Instant;
import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.assertj.core.api.Assertions.catchThrowable;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doThrow;
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

            verify(storage).deleteOrThrow("meetings/usr_1/mtg_1/audio.mp3");
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
        @DisplayName("and takes the voiceprints computed from it")
        void takesTheVoiceprints() {
            // The documented model: erasing a recording erases the templates
            // derived from the voices on it. An embedding is not audio and
            // cannot be turned back into audio, which is the argument for
            // keeping one -- and it is a technicality, because the embedding is
            // exactly what makes those voices findable again.
            service.eraseAudio(USER, MEETING);

            verify(speakerIdentity).invalidateMeetingVoiceprintsRequired(USER, MEETING);
        }

        @Test
        @DisplayName("and takes them first, before the object it cannot roll back")
        void theVoiceprintsGoFirst() {
            // The ordering decision. Object storage is not in the transaction,
            // so one of the two has to be able to fail with the other already
            // done. Deleting the derived data first means a failure leaves the
            // audio in place and honest; the other way round leaves a template
            // stranded with no recording it can ever be checked against.
            InOrder order = inOrder(speakerIdentity, storage);

            service.eraseAudio(USER, MEETING);

            order.verify(speakerIdentity).invalidateMeetingVoiceprintsRequired(USER, MEETING);
            order.verify(storage).deleteOrThrow(anyString());
        }

        @Test
        @DisplayName("only this meeting is named")
        void onlyThisMeetingIsNamed() {
            service.eraseAudio(USER, MEETING);

            // A meeting id and nothing wider. Another meeting of the same
            // account keeps its cache: its recording was not the one deleted,
            // and its voiceprints still describe audio that is still there.
            verify(speakerIdentity)
                    .invalidateMeetingVoiceprintsRequired(USER, MEETING);
            verify(speakerIdentity, never())
                    .invalidateMeetingVoiceprintsRequired(eq(USER), eq("mtg_other"));
            verify(speakerIdentity, never()).forgetEverything(anyString());
            verify(speakerIdentity, never()).deleteProfile(anyString(), anyString());
        }

        @Test
        @DisplayName("asking twice is not an error, and does not delete twice")
        void isIdempotent() {
            Instant first = service.eraseAudio(USER, MEETING);
            Instant second = service.eraseAudio(USER, MEETING);

            assertThat(second).isEqualTo(first);
            verify(storage).deleteOrThrow(anyString());
        }

        @Test
        @DisplayName("but a second press does re-confirm the derived data is gone")
        void aSecondPressReChecksTheVoiceprints() {
            // Cheap, and the only way an erasure that half-finished can ever be
            // completed: the timestamp is set, so every other step is skipped,
            // and returning it without checking would keep reporting success
            // over a template that is still there. Deleting nothing is a
            // confirmed success, so on the ordinary path this costs one round
            // trip and changes nothing.
            service.eraseAudio(USER, MEETING);
            service.eraseAudio(USER, MEETING);

            verify(speakerIdentity, times(2)).invalidateMeetingVoiceprintsRequired(USER, MEETING);
        }

        @Test
        @DisplayName("somebody else's meeting is simply not found")
        void refusesAnotherAccount() {
            when(meetings.findByIdAndUserId(MEETING, "usr_2")).thenReturn(Optional.empty());

            assertThatThrownBy(() -> service.eraseAudio("usr_2", MEETING))
                    .isInstanceOf(ApiException.class)
                    .hasMessageContaining("not found");
            verify(storage, never()).deleteOrThrow(anyString());
            // Not even the deletion. Ownership is checked before anything is
            // asked of another service, so a wrong id cannot be used to clear
            // a stranger's cache.
            verify(speakerIdentity, never())
                    .invalidateMeetingVoiceprintsRequired(anyString(), anyString());
        }
    }

    @Nested
    @DisplayName("erasing the recording, when something refuses")
    class AudioFailures {

        @Test
        @DisplayName("an unconfirmed voiceprint deletion leaves the recording alone")
        void aFailedInvalidationStopsEverything() {
            doThrow(ApiException.serviceUnavailable("Speaker matching data could not be updated"))
                    .when(speakerIdentity).invalidateMeetingVoiceprintsRequired(USER, MEETING);

            assertThatThrownBy(() -> service.eraseAudio(USER, MEETING))
                    .isInstanceOf(ApiException.class);

            // Nothing after it ran, so the meeting is exactly as it was: the
            // recording is still there and still claimed. That is the safe end
            // of this trade -- the user is told the erasure did not happen
            // rather than told it did.
            verify(storage, never()).deleteOrThrow(anyString());
            assertThat(meeting.getObjectKey()).isEqualTo("meetings/usr_1/mtg_1/audio.mp3");
            assertThat(meeting.getAudioDeletedAt()).isNull();
            verify(audit, never()).record(anyString(), anyString(), anyString(), anyString());
        }

        @Test
        @DisplayName("a failed object deletion does not claim the recording is gone")
        void aFailedObjectDeleteIsReported() {
            // StorageService.delete swallows failures, which is right for the
            // callers that must finish. This path must not: the row it is about
            // to write is a claim about the object.
            doThrow(new RuntimeException("S3 unavailable"))
                    .when(storage).deleteOrThrow(anyString());

            Throwable thrown = catchThrowable(() -> service.eraseAudio(USER, MEETING));

            assertThat(thrown).isInstanceOf(ApiException.class);
            assertThat(((ApiException) thrown).getStatus())
                    .isEqualTo(HttpStatus.SERVICE_UNAVAILABLE);
            assertThat(thrown).hasMessageContaining("still here");
            // The meeting still says it has its recording, because it does.
            assertThat(meeting.getObjectKey()).isEqualTo("meetings/usr_1/mtg_1/audio.mp3");
            assertThat(meeting.getAudioUrl()).isNull();
            assertThat(meeting.getAudioDeletedAt()).isNull();
            verify(audit, never()).record(anyString(), anyString(), anyString(), anyString());
        }

        @Test
        @DisplayName("the voiceprints stay deleted when the object deletion fails")
        void deletedVoiceprintsAreNotPutBack() {
            doThrow(new RuntimeException("S3 unavailable"))
                    .when(storage).deleteOrThrow(anyString());

            assertThatThrownBy(() -> service.eraseAudio(USER, MEETING))
                    .isInstanceOf(ApiException.class);

            // They were deleted, and nothing here tries to undo that. The
            // leftover is "audio present, cache absent", which costs a re-embed
            // on the next rematch and retains nothing. Recreating them to match
            // the rolled-back row would mean writing biometric-adjacent data
            // back out during a failed deletion.
            verify(speakerIdentity).invalidateMeetingVoiceprintsRequired(USER, MEETING);
            verify(speakerIdentity, never()).forgetMeeting(anyString(), anyString());
        }

        @Test
        @DisplayName("retrying after a partial failure finishes the job")
        void aRetryCompletesIt() {
            doThrow(new RuntimeException("S3 unavailable"))
                    .when(storage).deleteOrThrow(anyString());

            assertThatThrownBy(() -> service.eraseAudio(USER, MEETING))
                    .isInstanceOf(ApiException.class);

            // The bucket comes back.
            org.mockito.Mockito.reset(storage);

            Instant at = service.eraseAudio(USER, MEETING);

            assertThat(at).isNotNull();
            assertThat(meeting.getObjectKey()).isNull();
            assertThat(meeting.getAudioDeletedAt()).isEqualTo(at);
            // Asked again on the retry, and harmless: the rows are already gone,
            // so the far end deletes nothing and confirms it.
            verify(speakerIdentity, times(2)).invalidateMeetingVoiceprintsRequired(USER, MEETING);
        }
    }

    @Nested
    @DisplayName("erasing the recording, all the way down to the ai-service")
    class AudioWithTheRealIdentityService {

        // The same path with the real SpeakerIdentityService in it, so what is
        // under test is the whole contract rather than a mock agreeing with
        // itself. It is the layer below that knows the difference between "no
        // rows to delete" and "no database to delete them from" -- and that
        // difference is the entire reason this is strict.
        @Mock private SpeakerProfileRepository profiles;
        @Mock private AiClient ai;

        private ErasureService erasing;

        @BeforeEach
        void wireTheRealThing() {
            SpeakerIdentityService identity =
                    new SpeakerIdentityService(users, profiles, ai, audit);
            erasing = new ErasureService(meetings, transcripts, segments, summaries, actionItems,
                    translations, moments, chunks, users, storage, audit, statusPublisher,
                    identity);
        }

        @Test
        @DisplayName("a meeting with nothing cached still loses its recording")
        void nothingCachedIsStillASuccess() {
            // The common case by a distance: voiceprints are computed on demand,
            // so a meeting nobody ever rematched has none. Zero rows removed,
            // confirmed -- and the requirement, that no template survives, is
            // met. Reading zero as failure here would make audio erasure
            // impossible for most meetings in the product.
            when(ai.forgetMeetingVoiceprints(USER, MEETING))
                    .thenReturn(new AiClient.ForgetResult(0, true));

            Instant at = erasing.eraseAudio(USER, MEETING);

            assertThat(at).isNotNull();
            assertThat(meeting.getObjectKey()).isNull();
            verify(storage).deleteOrThrow("meetings/usr_1/mtg_1/audio.mp3");
        }

        @Test
        @DisplayName("a meeting with cached voiceprints loses both")
        void bothGo() {
            when(ai.forgetMeetingVoiceprints(USER, MEETING))
                    .thenReturn(new AiClient.ForgetResult(3, true));

            Instant at = erasing.eraseAudio(USER, MEETING);

            assertThat(at).isNotNull();
            verify(ai).forgetMeetingVoiceprints(USER, MEETING);
            verify(storage).deleteOrThrow("meetings/usr_1/mtg_1/audio.mp3");
            assertThat(meeting.getAudioDeletedAt()).isEqualTo(at);
        }

        @Test
        @DisplayName("an unconfirmed deletion stops the erasure")
        void unconfirmedRefuses() {
            // The state this whole audit exists to make unreachable: audio
            // deleted, row says erased, template still in the database, nobody
            // told. `deleted: 0, confirmed: false` is what a service with no
            // database behind it answers, and it is indistinguishable from the
            // test above by the count alone.
            when(ai.forgetMeetingVoiceprints(USER, MEETING))
                    .thenReturn(new AiClient.ForgetResult(0, false));

            Throwable thrown = catchThrowable(() -> erasing.eraseAudio(USER, MEETING));

            assertThat(thrown).isInstanceOf(ApiException.class);
            assertThat(((ApiException) thrown).getStatus())
                    .isEqualTo(HttpStatus.SERVICE_UNAVAILABLE);
            verify(storage, never()).deleteOrThrow(anyString());
            assertThat(meeting.getAudioDeletedAt()).isNull();
        }

        @Test
        @DisplayName("an unreachable ai-service stops it the same way")
        void anExceptionRefuses() {
            doThrow(new RuntimeException("connection refused"))
                    .when(ai).forgetMeetingVoiceprints(USER, MEETING);

            assertThatThrownBy(() -> erasing.eraseAudio(USER, MEETING))
                    .isInstanceOf(ApiException.class);

            verify(storage, never()).deleteOrThrow(anyString());
            assertThat(meeting.getObjectKey()).isEqualTo("meetings/usr_1/mtg_1/audio.mp3");
        }

        @Test
        @DisplayName("the named profiles survive it")
        void namedProfilesSurvive() {
            when(ai.forgetMeetingVoiceprints(USER, MEETING))
                    .thenReturn(new AiClient.ForgetResult(2, true));

            erasing.eraseAudio(USER, MEETING);

            // A named voice belongs to the account and was created by a separate,
            // explicit act about a person. Deleting one because a file was
            // deleted would take away the thing the account holder switched the
            // feature on for -- and it is the reason a rematch can put the names
            // back on every other meeting afterwards.
            verify(profiles, never()).deleteByUserId(anyString());
            verify(profiles, never()).delete(any());
            verify(ai, never()).forgetSpeakers(anyString(), anyString(), any());
            verify(ai, never()).forgetSpeakers(anyString(), any(), any());
        }

        @Test
        @DisplayName("another meeting's voiceprints are not in scope")
        void anotherMeetingIsUntouched() {
            when(ai.forgetMeetingVoiceprints(USER, MEETING))
                    .thenReturn(new AiClient.ForgetResult(1, true));

            erasing.eraseAudio(USER, MEETING);

            // One meeting id crosses the wire. The other meeting's cache still
            // describes audio that is still there, and dropping it would cost a
            // re-embed for a recording nobody deleted.
            verify(ai).forgetMeetingVoiceprints(USER, MEETING);
            verify(ai, never()).forgetMeetingVoiceprints(eq(USER), eq("mtg_other"));
        }

        @Test
        @DisplayName("and one account cannot reach another's")
        void tenantIsolation() {
            when(meetings.findByIdAndUserId(MEETING, "usr_2")).thenReturn(Optional.empty());

            assertThatThrownBy(() -> erasing.eraseAudio("usr_2", MEETING))
                    .isInstanceOf(ApiException.class)
                    .hasMessageContaining("not found");

            // Ownership is settled before anything is asked of the ai-service,
            // so a guessed meeting id cannot be used to clear somebody else's
            // cache. The far end is scoped too -- every statement it runs is
            // filtered by user_id, under a row-level policy -- but the request
            // is never made.
            verify(ai, never()).forgetMeetingVoiceprints(anyString(), anyString());
            verify(storage, never()).deleteOrThrow(anyString());
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
