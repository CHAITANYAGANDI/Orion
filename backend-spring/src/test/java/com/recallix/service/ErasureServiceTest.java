package com.recallix.service;

import com.recallix.common.ApiException;
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
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.mockito.junit.jupiter.MockitoSettings;
import org.mockito.quality.Strictness;

import java.time.Instant;
import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.never;
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

    private ErasureService service;
    private Meeting meeting;

    @BeforeEach
    void setUp() {
        service = new ErasureService(meetings, transcripts, segments, summaries, actionItems,
                translations, moments, chunks, users, storage, audit);
        meeting = new Meeting();
        meeting.setId(MEETING);
        meeting.setUserId(USER);
        meeting.setTitle("Sprint planning");
        meeting.setObjectKey("meetings/usr_1/mtg_1/audio.mp3");
        when(meetings.findByIdAndUserId(MEETING, USER)).thenReturn(Optional.of(meeting));
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
        @DisplayName("still erases the transcript when the embeddings cannot be reached")
        void survivesAVectorFailure() {
            when(chunks.deleteByMeetingId(MEETING)).thenThrow(new IllegalStateException("pgvector down"));

            Instant at = service.eraseTranscript(USER, MEETING);

            assertThat(at).isNotNull();
            verify(segments).deleteByMeetingId(MEETING);
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
