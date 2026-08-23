package com.recallix.service;

import com.recallix.common.ApiException;
import com.recallix.config.KafkaTopicsConfig;
import com.recallix.domain.SummarySection;
import com.recallix.dto.SummaryResponse;
import com.recallix.dto.callback.AiInsight;
import com.recallix.entity.Meeting;
import com.recallix.entity.MeetingInsight;
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
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * Rewriting a summary under a different template.
 *
 * <p>The point of this path is what it does <em>not</em> do. Re-transcribing to
 * change the shape of the notes would cost minutes and money for no new
 * information, and re-extracting would let a presentation choice silently
 * rewrite the meeting's action items — so both are absent, and these tests
 * say so out loud.
 */
@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class ResummarizeTest {

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
    private Meeting meeting;

    @BeforeEach
    void setUp() {
        service = new MeetingService(meetings, transcripts, segments, summaries,
                insights, storage, usage, outbox, audit, ai, templates, projects, translations, notifications, erasure, userService);

        meeting = new Meeting();
        meeting.setId(MEETING);
        meeting.setUserId(USER);
        meeting.setTitle("Sprint review");
        meeting.setDurationSeconds(1800);
        meeting.setSummaryTemplate("general");

        MeetingTranscript transcript = new MeetingTranscript();
        transcript.setMeetingId(MEETING);
        transcript.setTranscriptText("Speaker 1: We should decide on the budget.");

        when(meetings.findByIdAndUserId(MEETING, USER)).thenReturn(Optional.of(meeting));
        when(transcripts.findFirstByMeetingIdOrderByCreatedAtDesc(MEETING))
                .thenReturn(Optional.of(transcript));
        when(summaries.findFirstByMeetingIdOrderByCreatedAtDesc(MEETING))
                .thenReturn(Optional.of(existingSummary()));
        when(segments.findByMeetingIdOrderByStartTimeAsc(MEETING)).thenReturn(List.of(
                segment("Speaker 1"), segment("Speaker 2"), segment("Speaker 1")));
        when(templates.requireKnown(anyString())).thenAnswer(inv -> inv.getArgument(0));
        when(ai.summarize(anyString(), anyString(), any(), any())).thenReturn(written());
    }

    private static MeetingSummary existingSummary() {
        MeetingSummary s = new MeetingSummary();
        s.setId("sum_1");
        s.setMeetingId(MEETING);
        s.setShortSummary("old short");
        s.setTemplateSlug("general");
        return s;
    }

    private static TranscriptSegment segment(String speaker) {
        TranscriptSegment seg = new TranscriptSegment();
        seg.setMeetingId(MEETING);
        seg.setSpeaker(speaker);
        return seg;
    }

    private static AiClient.SummaryResult written() {
        return new AiClient.SummaryResult(
                "The team agreed the budget.",
                "Overview\nThe team agreed the budget.",
                List.of("Budget signed off"),
                List.of(new SummarySection("budget", "Budget", "bullets", "",
                        List.of("Signed off at 40k"), List.of())),
                "executive",
                List.of(new AiInsight("DECISION", "Signed off at 40k", "decisions")),
                List.of("How was the 40k budget arrived at?"));
    }

    @Test
    @DisplayName("rewriting regenerates the starter questions")
    void suggestionsAreReplaced() {
        // They were drawn from the sections that have just been replaced, so
        // the old chips ask about headings the page no longer has.
        service.resummarize(USER, MEETING, "executive");

        ArgumentCaptor<MeetingSummary> saved = ArgumentCaptor.forClass(MeetingSummary.class);
        verify(summaries).save(saved.capture());
        assertThat(saved.getValue().getSuggestions())
                .containsExactly("How was the 40k budget arrived at?");
    }

    @Test
    @DisplayName("a worker that sends no questions leaves the existing ones alone")
    void emptySuggestionsDoNotClearExistingOnes() {
        MeetingSummary existing = existingSummary();
        existing.setSuggestions(List.of("An older but working question?"));
        when(summaries.findFirstByMeetingIdOrderByCreatedAtDesc(MEETING))
                .thenReturn(Optional.of(existing));
        when(ai.summarize(anyString(), anyString(), any(), any())).thenReturn(
                new AiClient.SummaryResult("s", "d", List.of(), List.of(), "executive",
                        List.of(), List.of()));

        service.resummarize(USER, MEETING, "executive");

        // Clearing good chips because the answer was silent is worse than
        // leaving slightly stale ones.
        assertThat(existing.getSuggestions()).containsExactly("An older but working question?");
    }

    @Test
    @DisplayName("rewriting replaces the decisions the old sections produced")
    void derivedInsightsAreReplaced() {
        // The rows were read out of the sections that have just been thrown
        // away. Leaving them puts the decision store and the notes on screen in
        // disagreement — which is the one thing deriving them was meant to make
        // impossible.
        service.resummarize(USER, MEETING, "executive");

        verify(insights).deleteDerivedByMeetingId(MEETING);

        ArgumentCaptor<MeetingInsight> saved = ArgumentCaptor.forClass(MeetingInsight.class);
        verify(insights).save(saved.capture());
        MeetingInsight row = saved.getValue();
        assertThat(row.getKind()).isEqualTo("DECISION");
        assertThat(row.getText()).isEqualTo("Signed off at 40k");
        assertThat(row.getSourceSection()).isEqualTo("decisions");
        // Denormalised from the meeting: without it the row is invisible to its
        // own owner, because the RLS policy tests this column.
        assertThat(row.getUserId()).isEqualTo(USER);
        assertThat(row.getMeetingId()).isEqualTo(MEETING);
        // Derived, not human-owned, so the next rewrite may replace it.
        assertThat(row.isEdited()).isFalse();
    }

    @Test
    @DisplayName("the stored transcript is reused instead of being regenerated")
    void transcriptIsReused() {
        service.resummarize(USER, MEETING, "executive");

        verify(ai).summarize(eq("Speaker 1: We should decide on the budget."),
                eq("executive"), eq(1800), eq(2));
        // Nothing is enqueued: a reprocess would re-download and re-transcribe.
        verify(outbox, never()).enqueue(eq(KafkaTopicsConfig.MEETING_UPLOADED), anyString(), any());
    }

    @Test
    @DisplayName("distinct voices are counted, not turns")
    void speakerCountIsDistinct() {
        service.resummarize(USER, MEETING, "executive");
        // Three segments, two speakers.
        verify(ai).summarize(anyString(), anyString(), any(), eq(2));
    }

    @Test
    @DisplayName("the new sections replace the old summary in place")
    void sectionsAreStored() {
        SummaryResponse response = service.resummarize(USER, MEETING, "executive");

        ArgumentCaptor<MeetingSummary> saved = ArgumentCaptor.forClass(MeetingSummary.class);
        verify(summaries).save(saved.capture());
        assertThat(saved.getValue().getId()).isEqualTo("sum_1");
        assertThat(saved.getValue().getTemplateSlug()).isEqualTo("executive");
        assertThat(saved.getValue().getSections()).singleElement()
                .extracting(SummarySection::title).isEqualTo("Budget");

        assertThat(response.templateSlug()).isEqualTo("executive");
        assertThat(response.shortSummary()).isEqualTo("The team agreed the budget.");
    }

    @Test
    @DisplayName("the action items are left untouched")
    void extractionsAreNotRewritten() {
        service.resummarize(USER, MEETING, "executive");

        // Action items are facts about the meeting. A change of layout has no
        // business rewriting them.
        verify(actionItems, never()).deleteByMeetingId(anyString());
    }

    @Test
    @DisplayName("the choice is remembered on the meeting so a reprocess keeps it")
    void choiceIsRemembered() {
        service.resummarize(USER, MEETING, "executive");
        assertThat(meeting.getSummaryTemplate()).isEqualTo("executive");
    }

    @Test
    @DisplayName("the meeting quota is not charged again")
    void quotaIsNotCharged() {
        service.resummarize(USER, MEETING, "executive");
        // The user already paid for this meeting; re-shaping its notes is not a
        // second meeting.
        verify(usage, never()).chargeMeetingOrThrow(anyString(), anyBoolean(), any());
    }

    @Test
    @DisplayName("a meeting with no transcript is refused")
    void noTranscriptIsRefused() {
        when(transcripts.findFirstByMeetingIdOrderByCreatedAtDesc(MEETING))
                .thenReturn(Optional.empty());

        assertThatThrownBy(() -> service.resummarize(USER, MEETING, "executive"))
                .isInstanceOf(ApiException.class)
                .hasMessageContaining("no transcript");
        verify(ai, never()).summarize(anyString(), anyString(), any(), any());
    }

    @Test
    @DisplayName("another user's meeting is not found")
    void otherUsersMeetingIsNotFound() {
        when(meetings.findByIdAndUserId(MEETING, "usr_2")).thenReturn(Optional.empty());

        assertThatThrownBy(() -> service.resummarize("usr_2", MEETING, "executive"))
                .isInstanceOf(ApiException.class);
        verify(ai, never()).summarize(anyString(), anyString(), any(), any());
    }

    @Test
    @DisplayName("a meeting with no diarization sends no speaker count")
    void undiarizedMeetingSendsNullCount() {
        when(segments.findByMeetingIdOrderByStartTimeAsc(MEETING)).thenReturn(List.of());

        service.resummarize(USER, MEETING, "executive");

        // Zero would be a claim that nobody spoke; absent says we do not know.
        verify(ai).summarize(anyString(), anyString(), any(), isNull());
    }

    @Test
    @DisplayName("a summary is created when one somehow does not exist yet")
    void missingSummaryIsCreated() {
        when(summaries.findFirstByMeetingIdOrderByCreatedAtDesc(MEETING)).thenReturn(Optional.empty());

        service.resummarize(USER, MEETING, "executive");

        ArgumentCaptor<MeetingSummary> saved = ArgumentCaptor.forClass(MeetingSummary.class);
        verify(summaries).save(saved.capture());
        assertThat(saved.getValue().getId()).isNotBlank();
        assertThat(saved.getValue().getMeetingId()).isEqualTo(MEETING);
    }
}
