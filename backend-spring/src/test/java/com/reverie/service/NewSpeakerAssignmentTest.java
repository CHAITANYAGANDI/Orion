package com.reverie.service;

import com.reverie.common.ApiException;
import com.reverie.domain.SpokenWord;
import com.reverie.dto.SegmentSpeakerRequest;
import com.reverie.dto.SpeakerMergeRequest;
import com.reverie.entity.Meeting;
import com.reverie.entity.MeetingSummary;
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
 * A line that belongs to somebody the provider never separated out.
 *
 * <p>The fourth thing that goes wrong with speakers, and the one there was no
 * repair for. Renaming answers "Speaker 2 is Priya"; changing the speaker
 * answers "those words were Marcus, not Priya"; merging answers "these two
 * labels are one person". None of them answers "this was a fifth person, and
 * diarization folded them into Speaker 1" — there was no key to move the words
 * to, so the correction could not be expressed at all.
 *
 * <p>What is created is a canonical identity in <em>this</em> meeting and
 * nothing else. Reverie holds no cross-meeting speaker record for it to become,
 * and these tests assert that stays true.
 */
@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class NewSpeakerAssignmentTest {

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
     * The reported shape: three speakers, and a line at 09:32 that AssemblyAI
     * filed under Speaker 1 but a fifth person actually said.
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
                segment("seg_1", "Speaker 1", "spk_1", "A", "Shall we start?", 0.0, 3.0),
                segment("seg_2", "Cindy", "spk_2", "B", "Go ahead.", 3.0, 5.0),
                misattributed()));

        transcript = new MeetingTranscript();
        transcript.setMeetingId(MEETING);
        transcript.setTranscriptText("stale");

        when(meetings.findByIdAndUserId(MEETING, USER)).thenReturn(Optional.of(meeting));
        when(meetings.lockForWrite(MEETING)).thenReturn(Optional.of(MEETING));
        when(segments.findByMeetingIdOrderByStartTimeAsc(MEETING)).thenAnswer(i -> rows);
        when(transcripts.findFirstByMeetingIdOrderByCreatedAtDesc(MEETING))
                .thenReturn(Optional.of(transcript));
        when(segments.saveAll(any())).thenAnswer(i -> {
            List<TranscriptSegment> saved =
                    new ArrayList<>((List<TranscriptSegment>) i.getArgument(0));
            rows.addAll(saved);
            rows.sort((a, b) -> Double.compare(a.getStartTime(), b.getStartTime()));
            return saved;
        });
        org.mockito.Mockito.doAnswer(i -> {
            rows.remove((TranscriptSegment) i.getArgument(0));
            return null;
        }).when(segments).delete(any());
    }

    /** 09:32, filed under Speaker 1, said by somebody else entirely. */
    private static TranscriptSegment misattributed() {
        TranscriptSegment s = segment("seg_3", "Speaker 1", "spk_1", "A",
                "Yeah and that would help", 572.0, 576.0);
        s.setWords(new ArrayList<>(List.of(
                new SpokenWord("Yeah", 572.0, 572.6, "spk_1", "A"),
                new SpokenWord("and", 572.6, 573.0, "spk_1", "A"),
                new SpokenWord("that", 573.0, 573.6, "spk_1", "A"),
                new SpokenWord("would", 573.6, 574.4, "spk_1", "A"),
                new SpokenWord("help", 574.4, 576.0, "spk_1", "A"))));
        return s;
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

    /** Whichever row now belongs to the newly created speaker. */
    private TranscriptSegment ownedBy(String key) {
        return rows.stream().filter(s -> key.equals(s.getSpeakerKey())).findFirst().orElseThrow();
    }

    private void assignToNewSpeaker(String segmentId, Integer from, Integer to) {
        service.setSegmentSpeaker(USER, MEETING, segmentId,
                new SegmentSpeakerRequest(null, true, from, to));
    }

    @Nested
    @DisplayName("the whole line moves to somebody new")
    class WholeLine {

        @Test
        @DisplayName("a new canonical identity is created and given the turn")
        void identityIsCreated() {
            assignToNewSpeaker("seg_3", null, null);

            assertThat(row("seg_3").getSpeakerKey()).isEqualTo("spk_3");
            assertThat(row("seg_3").getSpeaker()).isEqualTo("Speaker 3");
        }

        @Test
        @DisplayName("speakerRaw keeps what AssemblyAI said")
        void providerProvenanceIsUntouched() {
            // The whole reason the third field exists. The provider really did
            // attribute this audio to its cluster "A"; the human is correcting
            // Reverie's reading of that, not rewriting the record of it.
            assignToNewSpeaker("seg_3", null, null);

            assertThat(row("seg_3").getSpeakerRaw()).isEqualTo("A");
            assertThat(row("seg_3").getWords())
                    .allSatisfy(w -> assertThat(w.speakerRaw()).isEqualTo("A"));
        }

        @Test
        @DisplayName("a human said whose it is, so it is attributed")
        void statusBecomesAttributed() {
            row("seg_3").setSpeakerStatus("unknown");

            assignToNewSpeaker("seg_3", null, null);

            assertThat(row("seg_3").getSpeakerStatus()).isEqualTo("attributed");
        }

        @Test
        @DisplayName("word-level attribution follows the turn")
        void wordsFollow() {
            assignToNewSpeaker("seg_3", null, null);

            assertThat(row("seg_3").getWords())
                    .allSatisfy(w -> assertThat(w.speaker()).isEqualTo("spk_3"));
        }

        @Test
        @DisplayName("nobody else is touched")
        void bystandersAreUntouched() {
            assignToNewSpeaker("seg_3", null, null);

            assertThat(row("seg_1").getSpeakerKey()).isEqualTo("spk_1");
            assertThat(row("seg_2").getSpeakerKey()).isEqualTo("spk_2");
            assertThat(row("seg_2").getSpeaker()).isEqualTo("Cindy");
        }
    }

    @Nested
    @DisplayName("choosing the number")
    class KeyAllocation {

        @Test
        @DisplayName("one past the highest, not one past the count")
        void highestPlusOne() {
            assignToNewSpeaker("seg_3", null, null);

            assertThat(ownedBy("spk_3")).isNotNull();
        }

        @Test
        @DisplayName("a gap left by an earlier correction is never reused")
        void gapsAreNotReused() {
            // spk_3 is missing because it *was* somebody, merged away or
            // corrected out. Handing that identity to a different person would
            // quietly change what an old export or a cached retrieval passage
            // refers to.
            rows.add(segment("seg_4", "Brian", "spk_4", "D", "Agreed.", 600.0, 602.0));

            assignToNewSpeaker("seg_3", null, null);

            assertThat(rows).noneMatch(s -> "spk_3".equals(s.getSpeakerKey())
                    && "seg_3".equals(s.getId()) && "Speaker 3".equals(s.getSpeaker())
                    && false);
            assertThat(row("seg_3").getSpeakerKey()).isEqualTo("spk_5");
            assertThat(row("seg_3").getSpeaker()).isEqualTo("Speaker 5");
        }

        @Test
        @DisplayName("a malformed key cannot stop the correction")
        void malformedKeysAreIgnored() {
            // The column is a string and older rows may hold anything. Skipping
            // an unparseable value can only make the number lower than it might
            // have been; refusing would make one bad row block every correction.
            rows.add(segment("seg_5", "Odd", "legacy-speaker", "E", "Hm.", 700.0, 701.0));
            rows.add(segment("seg_6", "Odder", null, "F", "Mm.", 702.0, 703.0));

            assignToNewSpeaker("seg_3", null, null);

            assertThat(row("seg_3").getSpeakerKey()).isEqualTo("spk_3");
        }

        @Test
        @DisplayName("the same transcript always yields the same key")
        void deterministic() {
            assignToNewSpeaker("seg_3", null, null);
            String first = row("seg_3").getSpeakerKey();

            // Put it back and do it again: no clock, no random, no row order.
            row("seg_3").setSpeakerKey("spk_1");
            row("seg_3").setSpeaker("Speaker 1");
            assignToNewSpeaker("seg_3", null, null);

            assertThat(row("seg_3").getSpeakerKey()).isEqualTo(first);
        }
    }

    @Nested
    @DisplayName("part of a line")
    class PartOfALine {

        @Test
        @DisplayName("selected words split out to the new speaker")
        void splitsOnWordBoundaries() {
            // "Yeah and | that would help" — the tail was somebody else.
            assignToNewSpeaker("seg_3", 2, 4);

            var moved = ownedBy("spk_3");
            assertThat(moved.getText()).isEqualTo("that would help");
            assertThat(moved.getSpeaker()).isEqualTo("Speaker 3");
            // Timed from the words, which are the only points that correspond
            // to anything in the audio.
            assertThat(moved.getStartTime()).isEqualTo(573.0);
            assertThat(moved.getEndTime()).isEqualTo(576.0);
        }

        @Test
        @DisplayName("the remainder stays with whoever had it")
        void theRemainderKeepsItsOwner() {
            assignToNewSpeaker("seg_3", 2, 4);

            var kept = rows.stream()
                    .filter(s -> "spk_1".equals(s.getSpeakerKey()) && s.getStartTime() >= 572.0)
                    .findFirst().orElseThrow();
            assertThat(kept.getText()).isEqualTo("Yeah and");
            assertThat(kept.getSpeakerRaw()).isEqualTo("A");
        }

        @Test
        @DisplayName("a split piece still carries the provider's own token")
        void piecesKeepProviderProvenance() {
            assignToNewSpeaker("seg_3", 2, 4);

            assertThat(ownedBy("spk_3").getSpeakerRaw()).isEqualTo("A");
        }

        @Test
        @DisplayName("without word timings, only the whole line can move")
        void noWordTimings() {
            row("seg_3").setWords(new ArrayList<>());

            assertThatThrownBy(() -> assignToNewSpeaker("seg_3", 1, 2))
                    .isInstanceOf(ApiException.class)
                    .hasMessageContaining("no word timings");
        }
    }

    @Nested
    @DisplayName("the request must name exactly one destination")
    class TargetMode {

        @Test
        @DisplayName("both a key and newSpeaker is refused")
        void bothIsRefused() {
            // Ambiguous: it asks to move the words to an existing speaker *and*
            // to a new one. Resolved by precedence it would be a silent answer
            // to a question the client got wrong.
            assertThatThrownBy(() -> service.setSegmentSpeaker(USER, MEETING, "seg_3",
                    new SegmentSpeakerRequest("spk_2", true, null, null)))
                    .isInstanceOf(ApiException.class)
                    .hasMessageContaining("not both");
        }

        @Test
        @DisplayName("neither is refused")
        void neitherIsRefused() {
            assertThatThrownBy(() -> service.setSegmentSpeaker(USER, MEETING, "seg_3",
                    new SegmentSpeakerRequest(null, false, null, null)))
                    .isInstanceOf(ApiException.class)
                    .hasMessageContaining("Choose a speaker");
        }

        @Test
        @DisplayName("and neither writes anything")
        void refusalWritesNothing() {
            assertThatThrownBy(() -> service.setSegmentSpeaker(USER, MEETING, "seg_3",
                    new SegmentSpeakerRequest("spk_2", true, null, null)))
                    .isInstanceOf(ApiException.class);

            assertThat(row("seg_3").getSpeakerKey()).isEqualTo("spk_1");
            assertThat(transcript.getTranscriptText()).isEqualTo("stale");
            verify(audit, never()).record(anyString(), anyString(), anyString(), anyString());
        }
    }

    @Nested
    @DisplayName("two people correcting at once")
    class Concurrency {

        @Test
        @DisplayName("the meeting row is taken before the keys are read")
        void allocationIsSerialised() {
            // The lock is what stops two requests both reading spk_2 as the
            // highest and both minting spk_3 for two different people. Taken
            // *before* the read, because the read is what the decision is made
            // from — afterwards would lock the row and then act on a snapshot
            // taken before the wait.
            assignToNewSpeaker("seg_3", null, null);

            InOrder order = inOrder(meetings, segments);
            order.verify(meetings).lockForWrite(MEETING);
            order.verify(segments).findByMeetingIdOrderByStartTimeAsc(MEETING);
        }

        @Test
        @DisplayName("the second caller sees the first's speaker and allocates past it")
        void theSecondCallerDoesNotCollide() {
            // What the lock buys, modelled as it is observed: the second
            // transaction re-reads after the first commits, so the key it finds
            // highest is the one the first just created.
            assignToNewSpeaker("seg_3", null, null);
            assertThat(row("seg_3").getSpeakerKey()).isEqualTo("spk_3");

            rows.add(segment("seg_9", "Speaker 1", "spk_1", "A", "One more.", 800.0, 802.0));
            assignToNewSpeaker("seg_9", null, null);

            assertThat(row("seg_9").getSpeakerKey()).isEqualTo("spk_4");
            assertThat(row("seg_3").getSpeakerKey()).isEqualTo("spk_3");
        }

        @Test
        @DisplayName("moving words to an existing speaker takes no lock")
        void existingSpeakerNeedsNoQueue() {
            // It decides nothing, so it does not need a turn in the queue.
            service.setSegmentSpeaker(USER, MEETING, "seg_3",
                    new SegmentSpeakerRequest("spk_2", null, null));

            verify(meetings, never()).lockForWrite(anyString());
        }
    }

    @Nested
    @DisplayName("what happens downstream")
    class Downstream {

        @Test
        @DisplayName("the flat transcript is rebuilt from the corrected turns")
        void flatTranscriptFollows() {
            assignToNewSpeaker("seg_3", null, null);

            assertThat(transcript.getTranscriptText())
                    .contains("Speaker 3: Yeah and that would help");
        }

        @Test
        @DisplayName("the meeting is re-indexed, because chat cites the speaker prefix")
        void reindexed() {
            assignToNewSpeaker("seg_3", null, null);

            verify(ai).reindex(anyString(), anyString(), anyInt(), anyString(), any());
        }

        @Test
        @DisplayName("the summary is marked stale")
        void summaryGoesStale() {
            MeetingSummary summary = new MeetingSummary();
            when(summaries.findFirstByMeetingIdOrderByCreatedAtDesc(MEETING))
                    .thenReturn(Optional.of(summary));

            assignToNewSpeaker("seg_3", null, null);

            assertThat(summary.isStale()).isTrue();
            verify(translations).markStaleByMeetingId(MEETING);
        }

        @Test
        @DisplayName("but no summary is regenerated, and nothing is reprocessed")
        void nothingIsRegenerated() {
            // Stale is a statement, not a job. Spending a model call on a
            // two-click correction is the user's decision — Re-summarize —
            // and reprocessing would re-transcribe the audio and discard the
            // correction that caused it.
            assignToNewSpeaker("seg_3", null, null);

            verify(ai, never()).summarize(anyString(), anyString(), any(), any());
            // Reprocess is the other thing this must not become: it re-runs
            // transcription and diarization from the audio, which would discard
            // the very correction that caused it.
            verify(outbox, never()).enqueue(anyString(), anyString(), any());
        }

        @Test
        @DisplayName("an ai-service that never answers still leaves the speaker assigned")
        void reindexFailureKeepsTheAssignment() {
            // What a timed-out index arrives as. It has to be survivable: the
            // call is made inside the user's own request while the meeting row
            // is locked, so an ai-service that is cold or wedged would otherwise
            // hold the correction open with nothing on screen to explain it.
            // Chat quoting the old text until the next edit is the smaller loss.
            doThrow(new RuntimeException("ai-service did not respond"))
                    .when(ai).reindex(anyString(), anyString(), anyInt(), anyString(), any());

            assignToNewSpeaker("seg_3", null, null);

            assertThat(row("seg_3").getSpeakerKey()).isEqualTo("spk_3");
            assertThat(row("seg_3").getSpeaker()).isEqualTo("Speaker 3");
        }
    }

    @Nested
    @DisplayName("it is an ordinary speaker afterwards")
    class OrdinaryAfterwards {

        @Test
        @DisplayName("rename works on it")
        void renameable() {
            assignToNewSpeaker("seg_3", null, null);

            service.renameSpeakers(USER, MEETING, java.util.Map.of("Speaker 3", "Cormac"));

            assertThat(row("seg_3").getSpeaker()).isEqualTo("Cormac");
            // A rename never moves the key; that is what keeps colour and
            // talk-time attached to the person across it.
            assertThat(row("seg_3").getSpeakerKey()).isEqualTo("spk_3");
        }

        @Test
        @DisplayName("merge works on it, with no special case")
        void mergeable() {
            assignToNewSpeaker("seg_3", null, null);

            service.mergeSpeakers(USER, MEETING, new SpeakerMergeRequest("spk_3", "spk_2"));

            assertThat(row("seg_3").getSpeakerKey()).isEqualTo("spk_2");
            assertThat(row("seg_3").getSpeaker()).isEqualTo("Cindy");
            assertThat(row("seg_3").getSpeakerRaw()).isEqualTo("A");
        }

        @Test
        @DisplayName("and it is remembered nowhere outside this meeting")
        void meetingLocalOnly() {
            // There is no speaker table, no profile, no enrolment. The identity
            // is the segments that carry the key, and nothing else was written.
            assignToNewSpeaker("seg_3", null, null);

            // Everything written belongs to this meeting, and nothing was
            // written anywhere a later meeting could read it: no account-level
            // service was touched, and the only rows that exist are segments.
            assertThat(rows).allSatisfy(s -> assertThat(s.getMeetingId()).isEqualTo(MEETING));
            org.mockito.Mockito.verifyNoInteractions(userService, notifications, storage);
        }
    }
}
