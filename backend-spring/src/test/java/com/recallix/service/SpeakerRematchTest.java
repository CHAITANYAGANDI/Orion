package com.recallix.service;

import com.recallix.common.ApiException;
import com.recallix.dto.SpeakerRematchRequest;
import com.recallix.entity.Meeting;
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
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * Rematching speakers: fixing diarization rather than naming.
 *
 * <p>What matters here is not that the label changes — it is that everything
 * derived from the label changes with it. The flat transcript carries speaker
 * prefixes and the export reads it; the RAG chunks carry them too and chat
 * reads those. A rematch that updates only the segments leaves both quoting a
 * speaker the transcript no longer names.
 */
@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class SpeakerRematchTest {

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
    @Mock private NotificationService notifications;
    @Mock private ErasureService erasure;
    @Mock private UserService userService;

    private MeetingService service;
    private MeetingTranscript transcript;
    private TranscriptSegment first;
    private TranscriptSegment second;
    private TranscriptSegment third;

    @BeforeEach
    void setUp() {
        service = new MeetingService(meetings, transcripts, segments, summaries,
                insights, storage, usage, outbox, audit, ai, templates,
                knownSpeakers, vocabulary, projects, translations, notifications, erasure, userService);

        Meeting meeting = new Meeting();
        meeting.setId(MEETING);
        meeting.setUserId(USER);

        first = segment("seg_1", "Speaker 1", "We should ship on Friday.", 0.0, 4.0);
        second = segment("seg_2", "Speaker 2", "Agreed, Friday works.", 4.0, 7.0);
        third = segment("seg_3", "Speaker 3", "I will prepare the release notes.", 7.0, 11.0);

        transcript = new MeetingTranscript();
        transcript.setId("txr_1");
        transcript.setMeetingId(MEETING);
        transcript.setTranscriptText("Speaker 1: We should ship on Friday.");

        when(meetings.findByIdAndUserId(MEETING, USER)).thenReturn(Optional.of(meeting));
        when(segments.findByMeetingIdOrderByStartTimeAsc(MEETING))
                .thenReturn(List.of(first, second, third));
        when(transcripts.findFirstByMeetingIdOrderByCreatedAtDesc(MEETING))
                .thenReturn(Optional.of(transcript));
    }

    // --- merging a split label ---------------------------------------------- //

    @Test
    @DisplayName("merging folds every turn of one label into another")
    void merge_moves_all_turns() {
        service.rematchSpeaker(USER, MEETING,
                new SpeakerRematchRequest("Speaker 3", "Speaker 1", null));

        assertThat(first.getSpeaker()).isEqualTo("Speaker 1");
        assertThat(third.getSpeaker()).isEqualTo("Speaker 1");
        // Untouched: merging two labels must not sweep up a third speaker.
        assertThat(second.getSpeaker()).isEqualTo("Speaker 2");
    }

    @Test
    @DisplayName("merging rebuilds the flat transcript the export reads")
    void merge_rewrites_the_denormalised_transcript() {
        service.rematchSpeaker(USER, MEETING,
                new SpeakerRematchRequest("Speaker 3", "Speaker 1", null));

        assertThat(transcript.getTranscriptText())
                .contains("Speaker 1: I will prepare the release notes.")
                .doesNotContain("Speaker 3");
    }

    @Test
    @DisplayName("merging re-indexes so chat stops attributing quotes to the old label")
    void merge_reindexes() {
        service.rematchSpeaker(USER, MEETING,
                new SpeakerRematchRequest("Speaker 3", "Speaker 1", null));

        verify(ai).reindex(eq(USER), eq(MEETING), anyString(), any());
    }

    @Test
    @DisplayName("merging a label nothing is using is refused rather than silently doing nothing")
    void merge_from_an_unknown_label_is_rejected() {
        assertThatThrownBy(() -> service.rematchSpeaker(USER, MEETING,
                new SpeakerRematchRequest("Speaker 9", "Speaker 1", null)))
                .isInstanceOf(ApiException.class)
                .hasMessageContaining("Speaker 9");
    }

    // --- reassigning individual turns ---------------------------------------- //

    @Test
    @DisplayName("reassigning moves only the named turns")
    void reassign_moves_only_those_segments() {
        service.rematchSpeaker(USER, MEETING,
                new SpeakerRematchRequest(null, "Speaker 1", List.of("seg_2")));

        assertThat(second.getSpeaker()).isEqualTo("Speaker 1");
        assertThat(third.getSpeaker()).isEqualTo("Speaker 3");
    }

    @Test
    @DisplayName("an unknown segment id fails the whole batch")
    void reassign_rejects_a_stale_segment_id() {
        // Half-applying a batch would leave the user believing corrections
        // landed that did not.
        assertThatThrownBy(() -> service.rematchSpeaker(USER, MEETING,
                new SpeakerRematchRequest(null, "Speaker 1", List.of("seg_2", "seg_gone"))))
                .isInstanceOf(ApiException.class)
                .hasMessageContaining("reload the transcript");
    }

    // --- request shape -------------------------------------------------------- //

    @Test
    @DisplayName("sending both a merge and a reassignment is refused")
    void both_modes_at_once_is_rejected() {
        // The result would depend on which was applied first.
        assertThatThrownBy(() -> service.rematchSpeaker(USER, MEETING,
                new SpeakerRematchRequest("Speaker 2", "Speaker 1", List.of("seg_3"))))
                .isInstanceOf(ApiException.class)
                .hasMessageContaining("not both");
    }

    @Test
    @DisplayName("sending neither is refused")
    void neither_mode_is_rejected() {
        assertThatThrownBy(() -> service.rematchSpeaker(USER, MEETING,
                new SpeakerRematchRequest(null, "Speaker 1", List.of())))
                .isInstanceOf(ApiException.class);
    }

    @Test
    @DisplayName("merging a speaker into themselves is refused")
    void self_merge_is_rejected() {
        assertThatThrownBy(() -> service.rematchSpeaker(USER, MEETING,
                new SpeakerRematchRequest("Speaker 1", "Speaker 1", null)))
                .isInstanceOf(ApiException.class);
    }

    @Test
    @DisplayName("a no-op reassignment does not re-index")
    void reassigning_a_turn_to_its_current_speaker_changes_nothing() {
        // Re-indexing costs a model round trip; doing it for a no-op would make
        // an accidental double-click expensive.
        service.rematchSpeaker(USER, MEETING,
                new SpeakerRematchRequest(null, "Speaker 2", List.of("seg_2")));

        verify(ai, never()).reindex(anyString(), anyString(), anyString(), any());
    }

    @Test
    @DisplayName("the applied name is remembered for future renames")
    void the_target_name_is_remembered() {
        service.rematchSpeaker(USER, MEETING,
                new SpeakerRematchRequest("Speaker 3", "Priya", null));

        verify(knownSpeakers).remember(USER, List.of("Priya"));
    }

    private static TranscriptSegment segment(String id, String speaker, String text,
                                             double start, double end) {
        var segment = new TranscriptSegment();
        segment.setId(id);
        segment.setMeetingId(MEETING);
        segment.setSpeaker(speaker);
        segment.setText(text);
        segment.setStartTime(start);
        segment.setEndTime(end);
        return segment;
    }
}
