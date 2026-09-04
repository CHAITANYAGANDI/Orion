package com.reverie.service;

import com.reverie.common.ApiException;
import com.reverie.domain.SpokenWord;
import com.reverie.dto.SpeakerMergeRequest;
import com.reverie.entity.Meeting;
import com.reverie.entity.MeetingTranscript;
import com.reverie.entity.TranscriptSegment;
import com.reverie.repository.MeetingActionItemRepository;
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
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.mockito.junit.jupiter.MockitoSettings;
import org.mockito.quality.Strictness;

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * Two labels the provider gave one person, folded into one speaker.
 *
 * <p>Over-diarization is the common half of getting speakers wrong: a pause, a
 * change in mic level, somebody leaning away from the microphone, and one voice
 * comes back as a second speaker who appears to interrupt the first.
 *
 * <p>Renaming cannot repair it, and that is the point of this operation
 * existing separately. Renaming both labels to "Priya" leaves two canonical
 * speakers wearing one name: the turns stay apart, talk time counts her twice,
 * and {@code app.naming} refuses a name held by two speakers, so she stops
 * being nameable automatically at all. Ownership has to move, and these tests
 * are mostly about what must move with it and what must not.
 */
@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class SpeakerMergeTest {

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

    private MeetingService service;
    private MeetingTranscript transcript;
    private List<TranscriptSegment> rows;

    /**
     * One person split in two. Priya opens, pauses, and comes back as
     * "Speaker 3"; Marcus answers in between so the split is not just two
     * adjacent turns.
     */
    @BeforeEach
    void setUp() {
        service = new MeetingService(meetings, transcripts, segments, summaries,
                insights, storage, usage, outbox, audit, ai, templates, projects,
                translations, notifications, erasure, userService);

        Meeting meeting = new Meeting();
        meeting.setId(MEETING);
        meeting.setUserId(USER);

        rows = new ArrayList<>(List.of(
                segment("seg_1", "Priya", "spk_1", "A", "Shall we start?", 0.0, 3.0),
                segment("seg_2", "Marcus", "spk_2", "B", "Go ahead.", 3.0, 5.0),
                segment("seg_3", "Speaker 3", "spk_3", "C", "So the launch date.", 20.0, 24.0),
                segment("seg_4", "Marcus", "spk_2", "B", "Right.", 24.0, 25.0),
                segment("seg_5", "Speaker 3", "spk_3", "C", "And the budget.", 25.0, 28.0)));

        transcript = new MeetingTranscript();
        transcript.setMeetingId(MEETING);
        transcript.setTranscriptText("stale");

        when(meetings.findByIdAndUserId(MEETING, USER)).thenReturn(Optional.of(meeting));
        when(segments.findByMeetingIdOrderByStartTimeAsc(MEETING)).thenAnswer(i -> rows);
        when(transcripts.findFirstByMeetingIdOrderByCreatedAtDesc(MEETING))
                .thenReturn(Optional.of(transcript));
    }

    private static TranscriptSegment segment(String id, String speaker, String key,
                                             String raw, String text,
                                             double start, double end) {
        TranscriptSegment s = new TranscriptSegment();
        s.setId(id);
        s.setMeetingId(MEETING);
        s.setSpeaker(speaker);
        s.setSpeakerKey(key);
        s.setSpeakerRaw(raw);
        s.setSpeakerStatus("attributed");
        s.setText(text);
        s.setStartTime(start);
        s.setEndTime(end);
        s.setWords(new ArrayList<>(List.of(new SpokenWord(text, start, end, key, raw))));
        return s;
    }

    private TranscriptSegment row(String id) {
        return rows.stream().filter(s -> s.getId().equals(id)).findFirst().orElseThrow();
    }

    private void merge(String from, String into) {
        service.mergeSpeakers(USER, MEETING, new SpeakerMergeRequest(from, into));
    }

    @Nested
    @DisplayName("what a merge moves")
    class Moves {

        @Test
        @DisplayName("every turn of the folded speaker takes the other's identity")
        void ownershipMoves() {
            merge("spk_3", "spk_1");

            for (String id : List.of("seg_3", "seg_5")) {
                assertThat(row(id).getSpeakerKey()).as(id).isEqualTo("spk_1");
                assertThat(row(id).getSpeaker()).as(id).isEqualTo("Priya");
            }
        }

        @Test
        @DisplayName("the merged turns take the target's name, not the source's")
        void theTargetNameWins() {
            merge("spk_1", "spk_3");

            // Priya folded into Speaker 3: everything reads "Speaker 3". The
            // direction of the merge decides the name, which is why the client
            // sends the pair rather than a name.
            assertThat(row("seg_1").getSpeaker()).isEqualTo("Speaker 3");
            assertThat(row("seg_1").getSpeakerKey()).isEqualTo("spk_3");
        }

        @Test
        @DisplayName("word-level attribution follows the turn")
        void wordsFollow() {
            // Chat citations and the word highlight read these, so a turn whose
            // words still name the old speaker is a half-done merge.
            merge("spk_3", "spk_1");

            for (SpokenWord w : row("seg_3").getWords()) {
                // `SpokenWord.speaker` carries the canonical key, not the label.
                assertThat(w.speaker()).isEqualTo("spk_1");
            }
        }

        @Test
        @DisplayName("a merged turn is attributed even if the provider had given up")
        void statusBecomesAttributed() {
            row("seg_3").setSpeakerStatus("unknown");

            merge("spk_3", "spk_1");

            assertThat(row("seg_3").getSpeakerStatus()).isEqualTo("attributed");
        }
    }

    @Nested
    @DisplayName("what a merge leaves alone")
    class LeavesAlone {

        @Test
        @DisplayName("speakerRaw keeps what the provider actually said")
        void providerProvenanceSurvives() {
            // The whole point of the third field. A merge is Reverie's decision,
            // not a correction to the provider's record, and keeping the raw
            // token is what makes a mistaken merge diagnosable afterwards.
            merge("spk_3", "spk_1");

            assertThat(row("seg_3").getSpeakerRaw()).isEqualTo("C");
            assertThat(row("seg_3").getWords().get(0).speakerRaw()).isEqualTo("C");
        }

        @Test
        @DisplayName("nobody else moves")
        void bystandersAreUntouched() {
            merge("spk_3", "spk_1");

            assertThat(row("seg_2").getSpeakerKey()).isEqualTo("spk_2");
            assertThat(row("seg_2").getSpeaker()).isEqualTo("Marcus");
            assertThat(row("seg_4").getSpeakerKey()).isEqualTo("spk_2");
        }

        @Test
        @DisplayName("the text and the timings are not touched")
        void wordsAndClockSurvive() {
            merge("spk_3", "spk_1");

            assertThat(row("seg_3").getText()).isEqualTo("So the launch date.");
            assertThat(row("seg_3").getStartTime()).isEqualTo(20.0);
            assertThat(row("seg_3").getEndTime()).isEqualTo(24.0);
        }
    }

    @Nested
    @DisplayName("what it refuses")
    class Refusals {

        @Test
        @DisplayName("merging a speaker into themselves")
        void selfMerge() {
            assertThatThrownBy(() -> merge("spk_1", "spk_1"))
                    .isInstanceOf(ApiException.class)
                    .hasMessageContaining("two different speakers");
        }

        @Test
        @DisplayName("a source that is not in this meeting")
        void unknownSource() {
            // Reported rather than treated as a no-op success: an empty merge
            // means the client is working from a transcript that has moved on,
            // and "done" would leave them believing two speakers were joined.
            assertThatThrownBy(() -> merge("spk_9", "spk_1"))
                    .isInstanceOf(ApiException.class)
                    .hasMessageContaining("not in this meeting");
        }

        @Test
        @DisplayName("a destination that is not in this meeting")
        void unknownTarget() {
            assertThatThrownBy(() -> merge("spk_3", "spk_9"))
                    .isInstanceOf(ApiException.class)
                    .hasMessageContaining("no such speaker");
        }

        @Test
        @DisplayName("and writes nothing when it refuses")
        void refusalWritesNothing() {
            assertThatThrownBy(() -> merge("spk_9", "spk_1"))
                    .isInstanceOf(ApiException.class);

            assertThat(row("seg_1").getSpeakerKey()).isEqualTo("spk_1");
            assertThat(transcript.getTranscriptText()).isEqualTo("stale");
            verify(audit, never()).record(anyString(), anyString(), anyString(), anyString());
        }
    }

    @Nested
    @DisplayName("what it carries downstream")
    class Downstream {

        @Test
        @DisplayName("the flat transcript is rebuilt from the merged turns")
        void flatTranscriptFollows() {
            // The export reads this string and the summarizer was written from
            // it, so leaving it describing the old labels puts the transcript
            // and everything derived from it into permanent disagreement.
            merge("spk_3", "spk_1");

            assertThat(transcript.getTranscriptText())
                    .contains("Priya: So the launch date.")
                    .doesNotContain("Speaker 3");
        }

        @Test
        @DisplayName("the summary and translations are marked stale, not regenerated")
        void summaryGoesStale() {
            // The outline names speakers, so it now describes a label the
            // transcript no longer has. Saying so beats silently spending a
            // model call on a two-click fix.
            com.reverie.entity.MeetingSummary summary = new com.reverie.entity.MeetingSummary();
            when(summaries.findFirstByMeetingIdOrderByCreatedAtDesc(MEETING))
                    .thenReturn(Optional.of(summary));

            merge("spk_3", "spk_1");

            assertThat(summary.isStale()).isTrue();
            verify(translations).markStaleByMeetingId(MEETING);
        }

        @Test
        @DisplayName("it is audited")
        void audited() {
            merge("spk_3", "spk_1");

            verify(audit).record(USER, "SPEAKERS_MERGED", "meeting", MEETING);
        }
    }
}
