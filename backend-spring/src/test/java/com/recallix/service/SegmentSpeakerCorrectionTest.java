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
import org.mockito.InOrder;
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
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.inOrder;
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
            verify(ai).reindex(anyString(), anyString(), anyInt(), anyString(), captor.capture());

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
            verify(ai, never()).reindex(anyString(), anyString(), anyInt(), anyString(), any());
        }
    }

    @Nested
    @DisplayName("the acoustic cache, after a correction")
    class Voiceprints {

        /**
         * The bug this covers, in the shape it actually occurs.
         *
         * <p>Voiceprints are keyed on {@code (meeting_id, speaker_key)} and are
         * an average of the spans that key owned when they were computed. If one
         * of those spans was somebody else's — which is precisely what the user
         * is here to correct — the average is a blend of two people. Correcting
         * the transcript does not change the average, so the next rematch
         * compares a blended vector against the account's real profiles and can
         * put a real person's name on the wrong voice.
         *
         * <p>The reprocess path has always dropped them for the same reason.
         * Manual correction changes which audio belongs to which key just as
         * surely, and now says so.
         */
        @Test
        @DisplayName("a whole-segment move drops this meeting's voiceprints")
        void wholeSegmentMoveInvalidates() {
            service.setSegmentSpeaker(USER, MEETING, "seg_1",
                    new SegmentSpeakerRequest("spk_1", null, null));

            verify(speakerIdentity).invalidateMeetingVoiceprintsRequired(USER, MEETING);
        }

        @Test
        @DisplayName("a partial move drops them too — it is the same corruption")
        void partialMoveInvalidates() {
            // "Yes, sir." leaves spk_2 and joins spk_1. Both keys' spans change,
            // so both keys' voiceprints are now averages of the wrong audio.
            moveTheReply();

            verify(speakerIdentity).invalidateMeetingVoiceprintsRequired(USER, MEETING);
        }

        @Test
        @DisplayName("a no-op keeps them, because nothing moved")
        void aNoOpKeepsThem() {
            // Not pedantry: dropping them costs a full re-embed of the recording
            // on the next rematch, and a request that changed nothing has not
            // invalidated anything.
            service.setSegmentSpeaker(USER, MEETING, "seg_1",
                    new SegmentSpeakerRequest("spk_2", null, null));

            verify(speakerIdentity, never())
                    .invalidateMeetingVoiceprintsRequired(anyString(), anyString());
        }

        @Test
        @DisplayName("a partial move that covers the whole line is still a no-op if nothing changes")
        void aFullRangeNoOpKeepsThem() {
            service.setSegmentSpeaker(USER, MEETING, "seg_1",
                    new SegmentSpeakerRequest("spk_2", 0, 9));

            verify(speakerIdentity, never())
                    .invalidateMeetingVoiceprintsRequired(anyString(), anyString());
        }

        @Test
        @DisplayName("correcting a speaker teaches the account nothing about that person")
        void correctionNeverLearns() {
            // The distinction the comments in setSegmentSpeaker now spell out.
            // The user has said WHERE a voice belongs, not WHOSE it is; learning
            // from it would fold a span they just disowned into a real person's
            // stored voice. Naming is renameSpeakers, and that is the only path
            // that enrols.
            moveTheReply();

            verify(ai, never()).learnSpeaker(anyString(), anyString(), any(),
                    anyString(), anyString(), any());
        }

        @Test
        @DisplayName("and leaves the account's named profiles exactly where they were")
        void namedProfilesAreUntouched() {
            // The invalidation drops voiceprints for one meeting and nothing
            // else: a meeting id, no profile id.
            // The named profiles were built by a separate, explicit act in other
            // meetings, and a correction here must not reach them.
            moveTheReply();

            verify(speakerIdentity, never()).forgetEverything(anyString());
            verify(speakerIdentity, never()).deleteProfile(anyString(), anyString());
            verify(ai, never()).forgetSpeakers(anyString(), any(), any());
        }

        @Test
        @DisplayName("the reindex and the stale summary still happen")
        void theRestOfTheTailIsUnchanged() {
            // The invalidation is an addition, not a replacement.
            moveTheReply();

            verify(ai).reindex(anyString(), anyString(), anyInt(), anyString(), any());
            verify(summaries).findFirstByMeetingIdOrderByCreatedAtDesc(MEETING);
        }

        @Test
        @DisplayName("and it happens before a single row is written")
        void invalidationComesFirst() {
            // Order is the whole guarantee. Invalidate-then-write can fail with
            // nothing saved; write-then-invalidate can fail with the correction
            // committed and the stale vector still there, which is the state
            // this entire nested class exists to prevent.
            InOrder order = inOrder(speakerIdentity, segments, ai);

            moveTheReply();

            order.verify(speakerIdentity).invalidateMeetingVoiceprintsRequired(USER, MEETING);
            order.verify(segments).saveAll(any());
            order.verify(ai).reindex(anyString(), anyString(), anyInt(), anyString(), any());
        }
    }

    @Nested
    @DisplayName("when the voiceprints cannot be invalidated")
    class InvalidationFails {

        /**
         * The ai-service is unreachable, or reachable and unable to confirm.
         *
         * <p>Both arrive here as the same 503 from
         * {@code SpeakerIdentityService}, because the caller's choice is the
         * same either way: it does not know the cache is empty, so it must not
         * save an edit that depends on it being empty.
         */
        @BeforeEach
        void theInvalidationRefuses() {
            doThrow(ApiException.serviceUnavailable("Speaker matching data could not be updated"))
                    .when(speakerIdentity).invalidateMeetingVoiceprintsRequired(USER, MEETING);
        }

        @Test
        @DisplayName("the correction is refused rather than quietly saved")
        void theCorrectionIsRefused() {
            assertThatThrownBy(SegmentSpeakerCorrectionTest.this::moveTheReply)
                    .isInstanceOf(ApiException.class)
                    .hasMessageContaining("Speaker matching data");

            // Nothing split, nothing stored.
            assertThat(rows).hasSize(2);
            verify(segments, never()).saveAll(any());
            verify(segments, never()).delete(any());
        }

        @Test
        @DisplayName("a whole-line move leaves the line exactly as it was")
        void theSegmentIsNotHalfMoved() {
            // The one that catches an ordering regression. `moveWholeSegment`
            // writes straight through to a managed entity, so if the invalidation
            // were attempted after it, this line would already say spk_1 and the
            // correction would survive as far as the persistence context --
            // undone only by a rollback, and only if nothing had flushed.
            assertThatThrownBy(() -> service.setSegmentSpeaker(USER, MEETING, "seg_1",
                    new SegmentSpeakerRequest("spk_1", null, null)))
                    .isInstanceOf(ApiException.class);

            assertThat(merged.getSpeakerKey()).isEqualTo("spk_2");
            assertThat(merged.getSpeaker()).isEqualTo("Speaker 2");
            assertThat(merged.getSpeakerStatus()).isEqualTo("attributed");
            assertThat(merged.getWords()).allMatch(w -> "spk_2".equals(w.speaker()));
        }

        @Test
        @DisplayName("the flat transcript, the index and the summary are all left alone")
        void nothingDownstreamMoves() {
            String before = transcript.getTranscriptText();

            assertThatThrownBy(SegmentSpeakerCorrectionTest.this::moveTheReply)
                    .isInstanceOf(ApiException.class);

            // A partial failure here is worse than the bug: the export would
            // disagree with the segments, and chat would cite an attribution the
            // transcript no longer shows.
            assertThat(transcript.getTranscriptText()).isEqualTo(before);
            verify(ai, never()).reindex(anyString(), anyString(), anyInt(), anyString(), any());
            verify(summaries, never()).findFirstByMeetingIdOrderByCreatedAtDesc(anyString());
            verify(audit, never()).record(anyString(), anyString(), anyString(), anyString());
        }

        @Test
        @DisplayName("and the account's named profiles are still not touched")
        void namedProfilesSurviveTheFailure() {
            assertThatThrownBy(SegmentSpeakerCorrectionTest.this::moveTheReply)
                    .isInstanceOf(ApiException.class);

            // A failure path is exactly where an over-broad "clean up" would get
            // written. There is no reach from here to a named voice, failing or
            // succeeding.
            verify(speakerIdentity, never()).forgetEverything(anyString());
            verify(speakerIdentity, never()).deleteProfile(anyString(), anyString());
            verify(ai, never()).forgetSpeakers(anyString(), any(), any());
        }

        @Test
        @DisplayName("a no-op still succeeds, because it never needed the invalidation")
        void aNoOpIsUnaffected() {
            // Nothing moved, so nothing went stale, so there is nothing to
            // confirm -- and refusing here would break editing for a whole
            // deployment whenever the speaker service blinked.
            var response = service.setSegmentSpeaker(USER, MEETING, "seg_1",
                    new SegmentSpeakerRequest("spk_2", null, null));

            assertThat(response).isNotNull();
            verify(speakerIdentity, never())
                    .invalidateMeetingVoiceprintsRequired(anyString(), anyString());
        }
    }
}
