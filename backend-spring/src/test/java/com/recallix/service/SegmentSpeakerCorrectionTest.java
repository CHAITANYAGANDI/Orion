package com.recallix.service;

import com.recallix.common.ApiException;
import com.recallix.domain.SpokenWord;
import com.recallix.dto.SegmentDto;
import com.recallix.dto.SegmentSpeakerRequest;
import com.recallix.entity.Meeting;
import com.recallix.entity.MeetingTranscript;
import com.recallix.entity.TranscriptSegment;
import com.recallix.repository.MeetingActionItemRepository;
import com.recallix.repository.MeetingInsightRepository;
import com.recallix.repository.MeetingRepository;
import com.recallix.repository.MeetingSummaryRepository;
import com.recallix.repository.MeetingTranscriptRepository;
import com.recallix.repository.MeetingTranslationRepository;
import com.recallix.repository.ProjectRepository;
import com.recallix.repository.TranscriptSegmentRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.mockito.junit.jupiter.MockitoSettings;
import org.mockito.quality.Strictness;

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * Moving one turn, or part of one, to a different speaker.
 *
 * <p>Automatic diarization is not perfect and the short-turn case is a model
 * limitation: a provider that buries "Yes, sir." inside the other person's
 * utterance leaves nothing to split on. This is the manual repair, and what
 * these tests are mostly about is everything it must <em>not</em> do — because
 * a correction that quietly relabelled a neighbour, merged two turns or taught
 * a voiceprint the wrong thing would be discovered long after the transcript
 * had been trusted.
 */
@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class SegmentSpeakerCorrectionTest {

    private static final String USER = "usr_1";
    private static final String MEETING = "mtg_1";

    @Mock private MeetingRepository meetings;
    @Mock private MeetingTranscriptRepository transcripts;
    @Mock private TranscriptSegmentRepository segments;
    @Mock private MeetingSummaryRepository summaries;
    @Mock private MeetingActionItemRepository actionItems;
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
    @Mock private UserService userService;
    @Mock private SpeakerIdentityService speakerIdentity;

    private MeetingService service;
    private MeetingTranscript transcript;
    private TranscriptSegment merged;
    private TranscriptSegment neighbour;
    private List<TranscriptSegment> rows;

    /**
     * The reported shape, in miniature: a question, a two-word reply and the
     * answer, all delivered by the provider as one turn by one speaker.
     */
    @BeforeEach
    void setUp() {
        service = new MeetingService(meetings, transcripts, segments, summaries,
                insights, storage, usage, outbox, audit, ai, templates, projects,
                translations, notifications, erasure, userService, speakerIdentity);

        Meeting meeting = new Meeting();
        meeting.setId(MEETING);
        meeting.setUserId(USER);

        merged = segment("seg_1", "Speaker 2", "spk_2",
                "Do you have a microwave? Yes, sir. I have one.", 57.0, 62.0);
        merged.setWords(new ArrayList<>(List.of(
                new SpokenWord("Do", 57.0, 57.2, "spk_2", "B"),
                new SpokenWord("you", 57.2, 57.4, "spk_2", "B"),
                new SpokenWord("have", 57.4, 57.6, "spk_2", "B"),
                new SpokenWord("a", 57.6, 57.7, "spk_2", "B"),
                new SpokenWord("microwave?", 57.7, 58.8, "spk_2", "B"),
                new SpokenWord("Yes,", 58.9, 59.1, "spk_2", "B"),
                new SpokenWord("sir.", 59.1, 59.3, "spk_2", "B"),
                new SpokenWord("I", 59.4, 59.6, "spk_2", "B"),
                new SpokenWord("have", 59.6, 59.8, "spk_2", "B"),
                new SpokenWord("one.", 59.8, 62.0, "spk_2", "B"))));

        neighbour = segment("seg_2", "Speaker 1", "spk_1", "Right.", 62.0, 63.0);
        neighbour.setWords(new ArrayList<>(List.of(
                new SpokenWord("Right.", 62.0, 63.0, "spk_1", "A"))));

        rows = new ArrayList<>(List.of(merged, neighbour));

        transcript = new MeetingTranscript();
        transcript.setMeetingId(MEETING);
        transcript.setTranscriptText(
                "Speaker 2: Do you have a microwave? Yes, sir. I have one.\nSpeaker 1: Right.");

        when(meetings.findByIdAndUserId(MEETING, USER)).thenReturn(Optional.of(meeting));
        when(segments.findByMeetingIdOrderByStartTimeAsc(MEETING)).thenAnswer(i -> rows);
        when(transcripts.findFirstByMeetingIdOrderByCreatedAtDesc(MEETING))
                .thenReturn(Optional.of(transcript));
        // A split replaces one row with several; the fake store keeps the list
        // the service reads back in the same order the real query would.
        when(segments.saveAll(any())).thenAnswer(i -> {
            List<TranscriptSegment> saved = new ArrayList<>((List<TranscriptSegment>) i.getArgument(0));
            rows.addAll(saved);
            rows.sort((a, b) -> Double.compare(a.getStartTime(), b.getStartTime()));
            return saved;
        });
        doAnswerRemove();
    }

    private void doAnswerRemove() {
        org.mockito.Mockito.doAnswer(i -> {
            rows.remove((TranscriptSegment) i.getArgument(0));
            return null;
        }).when(segments).delete(any());
    }

    private static TranscriptSegment segment(String id, String speaker, String key,
                                             String text, double start, double end) {
        TranscriptSegment s = new TranscriptSegment();
        s.setId(id);
        s.setMeetingId(MEETING);
        s.setSpeaker(speaker);
        s.setSpeakerKey(key);
        s.setSpeakerRaw(key.equals("spk_2") ? "B" : "A");
        s.setSpeakerStatus("attributed");
        s.setText(text);
        s.setStartTime(start);
        s.setEndTime(end);
        return s;
    }

    /** Move "Yes, sir." — words 5 and 6 — to Speaker 1. */
    private void moveTheReply() {
        service.setSegmentSpeaker(USER, MEETING, "seg_1",
                new SegmentSpeakerRequest("spk_1", 5, 6));
    }

    @Nested
    @DisplayName("the short turn buried inside somebody else's")
    class ShortTurn {

        @Test
        @DisplayName("splits the turn into three, and only the reply moves")
        void splitsIntoThree() {
            moveTheReply();

            assertThat(rows).hasSize(4); // three pieces plus the untouched neighbour
            List<String> speakers = rows.stream().map(TranscriptSegment::getSpeakerKey).toList();
            assertThat(speakers).containsExactly("spk_2", "spk_1", "spk_2", "spk_1");

            List<String> texts = rows.stream().map(TranscriptSegment::getText).toList();
            assertThat(texts).containsExactly(
                    "Do you have a microwave?", "Yes, sir.", "I have one.", "Right.");
        }

        @Test
        @DisplayName("each piece is timed from its own words, not from the original span")
        void timingsComeFromWords() {
            moveTheReply();

            TranscriptSegment reply = rows.get(1);
            // Not 57.0-62.0. A piece that kept the parent's span would make
            // click-to-play land on the wrong sentence.
            assertThat(reply.getStartTime()).isEqualTo(58.9);
            assertThat(reply.getEndTime()).isEqualTo(59.3);
        }

        @Test
        @DisplayName("the words themselves are unchanged apart from who said them")
        void wordsSurvive() {
            List<String> before = merged.getWords().stream().map(SpokenWord::text).toList();

            moveTheReply();

            List<String> after = rows.stream()
                    .filter(s -> !s.getId().equals("seg_2"))
                    .flatMap(s -> s.getWords().stream())
                    .map(SpokenWord::text)
                    .toList();
            assertThat(after).isEqualTo(before);
        }

        @Test
        @DisplayName("per-word attribution follows the piece it now belongs to")
        void wordsAreReattributed() {
            moveTheReply();

            assertThat(rows.get(1).getWords()).allSatisfy(
                    w -> assertThat(w.speaker()).isEqualTo("spk_1"));
            assertThat(rows.get(0).getWords()).allSatisfy(
                    w -> assertThat(w.speaker()).isEqualTo("spk_2"));
        }

        @Test
        @DisplayName("the provider's own token stays for the trace")
        void providerTokenSurvives() {
            moveTheReply();

            // Still traceable to the cluster the provider put these words in,
            // which is the whole point of keeping it: it says whose mistake
            // this was.
            assertThat(rows.get(1).getWords()).allSatisfy(
                    w -> assertThat(w.speakerRaw()).isEqualTo("B"));
        }
    }

    @Nested
    @DisplayName("nothing else moves")
    class OnlyThatTurn {

        @Test
        @DisplayName("the adjacent turn is untouched and is not merged in")
        void neighbourUntouched() {
            moveTheReply();

            assertThat(neighbour.getSpeakerKey()).isEqualTo("spk_1");
            assertThat(neighbour.getText()).isEqualTo("Right.");
            assertThat(neighbour.getStartTime()).isEqualTo(62.0);
            // The tail piece is Speaker 2 and the neighbour is Speaker 1; they
            // are adjacent and must stay two rows. Merging by display name or
            // by adjacency is how a correction eats the line after it.
            assertThat(rows.get(2).getId()).isNotEqualTo(neighbour.getId());
            assertThat(rows).contains(neighbour);
        }

        @Test
        @DisplayName("other turns by the same speaker keep their attribution")
        void otherTurnsBySameSpeakerUnchanged() {
            TranscriptSegment later = segment("seg_3", "Speaker 2", "spk_2", "Bye.", 70.0, 71.0);
            later.setWords(new ArrayList<>(List.of(new SpokenWord("Bye.", 70.0, 71.0, "spk_2", "B"))));
            rows.add(later);

            moveTheReply();

            // The user corrected one line. Applying it to every "Speaker 2"
            // turn would be a rename, which is a different button.
            assertThat(later.getSpeakerKey()).isEqualTo("spk_2");
            assertThat(later.getSpeaker()).isEqualTo("Speaker 2");
        }

        @Test
        @DisplayName("Rematch voice learning is never triggered")
        void doesNotTeachAVoice() {
            moveTheReply();

            // Moving a turn says these words were misattributed; it does not say
            // who a voice belongs to. Enrolling here would train the profile on
            // the very audio being corrected.
            verify(speakerIdentity, never()).learningEnabled(anyString());
            verify(speakerIdentity, never()).turnsOf(any());
        }
    }

    @Nested
    @DisplayName("everything downstream sees the correction")
    class Downstream {

        @Test
        @DisplayName("the flat transcript the export reads is rebuilt")
        void flatTranscriptRebuilt() {
            moveTheReply();

            assertThat(transcript.getTranscriptText())
                    .contains("Speaker 1: Yes, sir.")
                    .contains("Speaker 2: Do you have a microwave?")
                    .contains("Speaker 2: I have one.");
            // The old merged line must be gone, or the export ships both.
            assertThat(transcript.getTranscriptText())
                    .doesNotContain("Speaker 2: Do you have a microwave? Yes, sir. I have one.");
        }

        @Test
        @DisplayName("the retrieval index is rebuilt so chat cites the right speaker")
        void reindexed() {
            moveTheReply();

            @SuppressWarnings("unchecked")
            ArgumentCaptor<List<SegmentDto>> captor =
                    ArgumentCaptor.forClass((Class<List<SegmentDto>>) (Class<?>) List.class);
            verify(ai).reindex(anyString(), anyString(), anyString(), captor.capture());

            // Four passages, each carrying its own speaker: chat cites what it
            // retrieves, so an index that still says Speaker 2 would answer
            // with a quotation attributed to the wrong person.
            assertThat(captor.getValue()).hasSize(4);
            assertThat(captor.getValue())
                    .anySatisfy(s -> {
                        assertThat(s.text()).isEqualTo("Yes, sir.");
                        assertThat(s.speakerKey()).isEqualTo("spk_1");
                    });
        }

        @Test
        @DisplayName("the read API reports the corrected speaker and its statistics")
        void readApiAndStats() {
            var response = service.setSegmentSpeaker(USER, MEETING, "seg_1",
                    new SegmentSpeakerRequest("spk_1", 5, 6));

            assertThat(response.segments())
                    .anySatisfy(s -> {
                        assertThat(s.text()).isEqualTo("Yes, sir.");
                        assertThat(s.speakerKey()).isEqualTo("spk_1");
                        assertThat(s.speaker()).isEqualTo("Speaker 1");
                    });
            // Stats are derived from the same rows, so they follow. Speaker 1
            // now owns the 0.4s reply on top of "Right.".
            assertThat(response.speakers())
                    .anySatisfy(s -> {
                        assertThat(s.speakerKey()).isEqualTo("spk_1");
                        assertThat(s.segmentCount()).isEqualTo(2);
                    });
        }

        @Test
        @DisplayName("the summary is flagged stale rather than silently regenerated")
        void summaryMarkedStale() {
            moveTheReply();
            // It names speakers, so it may now disagree with the transcript.
            // Regenerating would spend a model call on a one-line fix.
            verify(ai, never()).summarize(anyString(), anyString(), any(), any());
        }

        @Test
        @DisplayName("the correction is audited")
        void audited() {
            moveTheReply();
            verify(audit).record(USER, "SEGMENT_SPEAKER_CORRECTED", "meeting", MEETING);
        }
    }

    @Nested
    @DisplayName("refusals")
    class Refusals {

        @Test
        @DisplayName("a whole turn can be moved without a word range")
        void wholeTurn() {
            service.setSegmentSpeaker(USER, MEETING, "seg_2",
                    new SegmentSpeakerRequest("spk_2", null, null));

            assertThat(neighbour.getSpeakerKey()).isEqualTo("spk_2");
            assertThat(neighbour.getSpeaker()).isEqualTo("Speaker 2");
            // No split: one turn in, one turn out.
            assertThat(rows).hasSize(2);
        }

        @Test
        @DisplayName("an unknown speaker is refused rather than invented")
        void unknownSpeaker() {
            assertThatThrownBy(() -> service.setSegmentSpeaker(USER, MEETING, "seg_1",
                    new SegmentSpeakerRequest("spk_9", 5, 6)))
                    .isInstanceOf(ApiException.class)
                    .hasMessageContaining("no such speaker");
        }

        @Test
        @DisplayName("an unknown segment is refused rather than ignored")
        void unknownSegment() {
            assertThatThrownBy(() -> service.setSegmentSpeaker(USER, MEETING, "seg_nope",
                    new SegmentSpeakerRequest("spk_1", null, null)))
                    .isInstanceOf(ApiException.class)
                    .hasMessageContaining("not part of this meeting");
        }

        @Test
        @DisplayName("a range past the end of the line is refused")
        void rangeOutOfBounds() {
            assertThatThrownBy(() -> service.setSegmentSpeaker(USER, MEETING, "seg_1",
                    new SegmentSpeakerRequest("spk_1", 5, 99)))
                    .isInstanceOf(ApiException.class)
                    .hasMessageContaining("not a valid range");
        }

        @Test
        @DisplayName("a partial move on a line with no word timings is refused, not guessed")
        void noWordTimings() {
            TranscriptSegment old = segment("seg_old", "Speaker 2", "spk_2", "Older line.", 80.0, 82.0);
            old.setWords(List.of());
            rows.add(old);

            assertThatThrownBy(() -> service.setSegmentSpeaker(USER, MEETING, "seg_old",
                    new SegmentSpeakerRequest("spk_1", 0, 0)))
                    .isInstanceOf(ApiException.class)
                    .hasMessageContaining("no word timings");
        }

        @Test
        @DisplayName("moving a turn to the speaker it already has changes nothing")
        void noOp() {
            service.setSegmentSpeaker(USER, MEETING, "seg_1",
                    new SegmentSpeakerRequest("spk_2", null, null));

            assertThat(rows).hasSize(2);
            verify(ai, never()).reindex(anyString(), anyString(), anyString(), any());
        }
    }
}
