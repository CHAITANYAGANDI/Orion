package com.recallix.service;

import com.recallix.common.ApiException;
import com.recallix.domain.SpokenWord;
import com.recallix.dto.TranscriptEditRequest.SegmentEdit;
import com.recallix.entity.Meeting;
import com.recallix.entity.MeetingSummary;
import com.recallix.entity.MeetingTranscript;
import com.recallix.entity.TranscriptSegment;
import com.recallix.repository.MeetingActionItemRepository;
import com.recallix.repository.MeetingInsightRepository;
import com.recallix.repository.MeetingRepository;
import com.recallix.repository.ProjectRepository;
import com.recallix.repository.MeetingTranslationRepository;
import com.recallix.repository.MeetingSummaryRepository;
import com.recallix.repository.MeetingTranscriptRepository;
import com.recallix.repository.TranscriptSegmentRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.mockito.junit.jupiter.MockitoSettings;
import org.mockito.quality.Strictness;

import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * Correcting what the transcriber heard.
 *
 * <p>The edit itself is trivial; what these cover is everything an edit
 * invalidates. Each of those failures is silent — the text on screen looks
 * right while chat answers from the old wording, the export ships the old
 * wording, or the highlight lands on the wrong word.
 */
@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class TranscriptEditTest {

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
    @Mock private KnownSpeakerService knownSpeakers;
    @Mock private VocabularyService vocabulary;

    @Mock private ProjectRepository projects;
    @Mock private MeetingTranslationRepository translations;

    private MeetingService service;
    private MeetingTranscript transcript;
    private TranscriptSegment first;
    private TranscriptSegment second;

    @BeforeEach
    void setUp() {
        service = new MeetingService(meetings, transcripts, segments, summaries,
                actionItems, insights, storage, usage, outbox, audit, ai, templates, knownSpeakers, vocabulary, projects, translations);

        Meeting meeting = new Meeting();
        meeting.setId(MEETING);
        meeting.setUserId(USER);
        meeting.setTitle("Sprint review");

        first = segment("seg_1", "Speaker 1", "We should use Browserker for scanning.", 0.0, 4.0);
        first.setWords(List.of(
                new SpokenWord("We", 0.0, 0.2),
                new SpokenWord("should", 0.2, 0.6)));
        second = segment("seg_2", "Speaker 2", "Agreed.", 4.0, 5.0);

        transcript = new MeetingTranscript();
        transcript.setMeetingId(MEETING);
        transcript.setTranscriptText("Speaker 1: We should use Browserker for scanning.\nSpeaker 2: Agreed.");

        when(meetings.findByIdAndUserId(MEETING, USER)).thenReturn(Optional.of(meeting));
        when(segments.findByMeetingIdOrderByStartTimeAsc(MEETING)).thenReturn(List.of(first, second));
        when(transcripts.findFirstByMeetingIdOrderByCreatedAtDesc(MEETING))
                .thenReturn(Optional.of(transcript));
    }

    private static TranscriptSegment segment(String id, String speaker, String text,
                                             double start, double end) {
        TranscriptSegment s = new TranscriptSegment();
        s.setId(id);
        s.setMeetingId(MEETING);
        s.setSpeaker(speaker);
        s.setText(text);
        s.setStartTime(start);
        s.setEndTime(end);
        return s;
    }

    @Test
    @DisplayName("the corrected text replaces the segment")
    void textIsUpdated() {
        service.editSegments(USER, MEETING,
                List.of(new SegmentEdit("seg_1", "We should use Browser Cracker for scanning.")));

        assertThat(first.getText()).isEqualTo("We should use Browser Cracker for scanning.");
        assertThat(second.getText()).isEqualTo("Agreed.");
    }

    @Test
    @DisplayName("word timings are dropped for an edited segment")
    void wordTimingsAreCleared() {
        service.editSegments(USER, MEETING, List.of(new SegmentEdit("seg_1", "Different words entirely.")));

        // They describe words that were spoken. Once the text says something
        // else they point at the wrong ones, and the UI's estimate from the
        // segment span is the better answer.
        assertThat(first.getWords()).isEmpty();
    }

    @Test
    @DisplayName("an untouched segment keeps its word timings")
    void untouchedSegmentKeepsTimings() {
        service.editSegments(USER, MEETING, List.of(new SegmentEdit("seg_2", "Agreed, let's do it.")));
        assertThat(first.getWords()).hasSize(2);
    }

    @Test
    @DisplayName("the flat transcript is rebuilt so the export does not ship stale text")
    void flatTranscriptIsRebuilt() {
        service.editSegments(USER, MEETING,
                List.of(new SegmentEdit("seg_1", "We should use Browser Cracker for scanning.")));

        assertThat(transcript.getTranscriptText()).isEqualTo(
                "Speaker 1: We should use Browser Cracker for scanning.\nSpeaker 2: Agreed.");
    }

    @Test
    @DisplayName("the meeting is re-indexed so chat stops answering from the old text")
    void meetingIsReindexed() {
        service.editSegments(USER, MEETING, List.of(new SegmentEdit("seg_1", "Corrected line.")));

        ArgumentCaptor<String> sent = ArgumentCaptor.forClass(String.class);
        verify(ai).reindex(eq(USER), eq(MEETING), sent.capture(), any());
        assertThat(sent.getValue()).contains("Corrected line.");
        assertThat(sent.getValue()).doesNotContain("Browserker");
    }

    @Test
    @DisplayName("the summary and action items are left alone")
    void analysisIsNotRegenerated() {
        service.editSegments(USER, MEETING, List.of(new SegmentEdit("seg_1", "Corrected line.")));

        // Re-summarizing on every keystroke-sized fix would cost a model call
        // the user did not ask for; they have a button for it.
        verify(ai, never()).summarize(anyString(), anyString(), any(), any());
        verify(summaries, never()).save(any());
        verify(actionItems, never()).deleteByMeetingId(anyString());
    }

    @Test
    @DisplayName("an edit that changes nothing does not re-index")
    void noOpEditDoesNothing() {
        service.editSegments(USER, MEETING,
                List.of(new SegmentEdit("seg_1", "We should use Browserker for scanning.")));

        verify(ai, never()).reindex(anyString(), anyString(), anyString(), any());
    }

    @Test
    @DisplayName("a segment from another meeting is refused, not silently skipped")
    void unknownSegmentIsRefused() {
        assertThatThrownBy(() -> service.editSegments(USER, MEETING,
                List.of(new SegmentEdit("seg_from_elsewhere", "Anything."))))
                .isInstanceOf(ApiException.class)
                .hasMessageContaining("not part of this meeting");
        verify(ai, never()).reindex(anyString(), anyString(), anyString(), any());
    }

    @Test
    @DisplayName("another user's meeting is not found")
    void otherUsersMeetingIsNotFound() {
        when(meetings.findByIdAndUserId(MEETING, "usr_2")).thenReturn(Optional.empty());

        assertThatThrownBy(() -> service.editSegments("usr_2", MEETING,
                List.of(new SegmentEdit("seg_1", "Anything."))))
                .isInstanceOf(ApiException.class);
        assertThat(first.getText()).isEqualTo("We should use Browserker for scanning.");
    }

    @Test
    @DisplayName("a failed re-index still saves the correction")
    void reindexFailureDoesNotLoseTheEdit() {
        doThrow(new RuntimeException("ai-service down"))
                .when(ai).reindex(anyString(), anyString(), anyString(), any());

        service.editSegments(USER, MEETING, List.of(new SegmentEdit("seg_1", "Corrected line.")));

        // Refusing to save a correction because the search index could not be
        // updated is the wrong trade — the text is what the user came for.
        assertThat(first.getText()).isEqualTo("Corrected line.");
    }

    @Test
    @DisplayName("renaming a speaker re-indexes too")
    void renameAlsoReindexes() {
        // Retrieval passages are stored as "Speaker 1: ...", so a rename that
        // is not re-indexed leaves chat citing a name the transcript no longer
        // shows anywhere.
        service.renameSpeakers(USER, MEETING, java.util.Map.of("Speaker 1", "Cindy"));

        ArgumentCaptor<String> sent = ArgumentCaptor.forClass(String.class);
        verify(ai).reindex(eq(USER), eq(MEETING), sent.capture(), any());
        assertThat(sent.getValue()).startsWith("Cindy: ");
    }

    @Test
    @DisplayName("a rename that matches nobody does not re-index")
    void renameWithNoMatchDoesNothing() {
        service.renameSpeakers(USER, MEETING, java.util.Map.of("Speaker 9", "Nobody"));
        verify(ai, never()).reindex(anyString(), anyString(), anyString(), any());
    }

    // --- the summary going out of date ------------------------------------- //
    // An edit corrects the transcript and re-indexes it, so chat and search
    // answer from the corrected words immediately. The summary does not change:
    // rewriting it would put a model call behind every typo fix, and behind
    // each of the next nineteen. What must not happen is the two disagreeing
    // silently, with the notes still asserting the old version and nothing on
    // screen saying so.

    @Test
    @DisplayName("editing the transcript marks the summary out of date")
    void editMarksSummaryStale() {
        MeetingSummary summary = new MeetingSummary();
        summary.setMeetingId(MEETING);
        when(summaries.findFirstByMeetingIdOrderByCreatedAtDesc(MEETING))
                .thenReturn(Optional.of(summary));

        service.editSegments(USER, MEETING, List.of(new SegmentEdit("seg_1", "Corrected line.")));

        assertThat(summary.isStale()).isTrue();
    }

    @Test
    @DisplayName("renaming a speaker marks the summary out of date")
    void renameMarksSummaryStale() {
        // The outline names speakers by design, so after a rename it refers to
        // labels the transcript no longer contains.
        MeetingSummary summary = new MeetingSummary();
        summary.setMeetingId(MEETING);
        when(summaries.findFirstByMeetingIdOrderByCreatedAtDesc(MEETING))
                .thenReturn(Optional.of(summary));

        service.renameSpeakers(USER, MEETING, java.util.Map.of("Speaker 1", "Cindy"));

        assertThat(summary.isStale()).isTrue();
    }

    @Test
    @DisplayName("an edit that changes nothing leaves the summary alone")
    void noOpEditDoesNotMarkStale() {
        MeetingSummary summary = new MeetingSummary();
        summary.setMeetingId(MEETING);

        // Same text the segment already has: saving an unchanged transcript
        // must not put a "rewrite me" banner on notes that still match it.
        service.editSegments(USER, MEETING,
                List.of(new SegmentEdit("seg_1", first.getText())));

        assertThat(summary.isStale()).isFalse();
        verify(summaries, never()).findFirstByMeetingIdOrderByCreatedAtDesc(MEETING);
    }

    @Test
    @DisplayName("an edit before the summary exists does not fail")
    void editWithNoSummaryIsFine() {
        when(summaries.findFirstByMeetingIdOrderByCreatedAtDesc(MEETING))
                .thenReturn(Optional.empty());

        // Correcting a transcript while the brief is still being written must
        // not 500. There is nothing to have gone stale.
        service.editSegments(USER, MEETING, List.of(new SegmentEdit("seg_1", "Corrected line.")));

        assertThat(first.getText()).isEqualTo("Corrected line.");
    }
}
