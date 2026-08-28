package com.orion.service;

import com.orion.domain.SpokenWord;
import com.orion.dto.SegmentDto;
import com.orion.dto.callback.AiSegment;
import com.orion.dto.callback.MeetingBriefResult;
import com.orion.entity.Meeting;
import com.orion.entity.TranscriptSegment;
import com.orion.entity.UserEntity;
import com.orion.repository.MeetingActionItemRepository;
import com.orion.repository.MeetingInsightRepository;
import com.orion.repository.MeetingRepository;
import com.orion.repository.MeetingSummaryRepository;
import com.orion.repository.MeetingTranscriptRepository;
import com.orion.repository.TranscriptSegmentRepository;
import com.orion.repository.UserRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.mockito.junit.jupiter.MockitoSettings;
import org.mockito.quality.Strictness;
import org.springframework.context.ApplicationEventPublisher;

import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.atLeastOnce;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * Speaker identity has to survive the worker boundary.
 *
 * <p>It previously did not. The worker worked out which turns the provider had
 * declined to attribute and then dropped that on the way into
 * {@code AiSegment}, so an unattributed turn arrived looking exactly like a
 * confident one — and the canonical key that makes a speaker's colour stable
 * across a rename did not exist at all.
 *
 * <p>These are about the copying, not about the diarization. Whether
 * "Speaker 2" is the right answer is settled in
 * {@code ai-service/tests/test_diarization.py}; what is settled here is that
 * the answer is still intact by the time it reaches a row.
 */
@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class SpeakerIdentityPersistenceTest {

    private static final String MEETING = "mtg_1";
    private static final String USER = "usr_1";

    @Mock private MeetingRepository meetings;
    @Mock private MeetingTranscriptRepository transcripts;
    @Mock private TranscriptSegmentRepository segments;
    @Mock private MeetingSummaryRepository summaries;
    @Mock private MeetingActionItemRepository actionItems;
    @Mock private MeetingInsightRepository insights;
    @Mock private StatusPublisher statusPublisher;
    @Mock private UsageLimitService usage;
    @Mock private ApplicationEventPublisher events;
    @Mock private NotificationService notifications;
    @Mock private UserRepository users;

    private CallbackService service;

    @BeforeEach
    void setUp() {
        service = new CallbackService(meetings, transcripts, segments, summaries, actionItems,
                insights, statusPublisher, usage, events, notifications, users);

        Meeting meeting = new Meeting();
        meeting.setId(MEETING);
        meeting.setUserId(USER);

        UserEntity user = new UserEntity();
        user.setId(USER);

        when(meetings.findById(MEETING)).thenReturn(Optional.of(meeting));
        when(users.findById(USER)).thenReturn(Optional.of(user));
        when(actionItems.findByMeetingId(MEETING)).thenReturn(List.of());
        when(summaries.findFirstByMeetingIdOrderByCreatedAtDesc(MEETING)).thenReturn(Optional.empty());
        when(transcripts.findFirstByMeetingIdOrderByCreatedAtDesc(MEETING)).thenReturn(Optional.empty());
    }

    @Test
    void keeps_the_canonical_key_the_raw_label_and_the_attribution() {
        service.applyResult(MEETING, result(List.of(
                new AiSegment(0.0, 8.0, "Speaker 1", "Shall we start?",
                        List.of(new SpokenWord("Shall", 0.0, 0.4, "Speaker 1", "D")),
                        null, "spk_1", "D", "attributed"),
                new AiSegment(8.0, 9.0, "Unknown speaker", "mm hm",
                        List.of(), null, null, null, "unknown"))));

        List<TranscriptSegment> saved = savedSegments();

        assertThat(saved).extracting(TranscriptSegment::getSpeakerKey)
                .containsExactly("spk_1", null);
        // The provider clustered the first voice as "D". That is kept, and it
        // is not what gets displayed — the display says Speaker 1 because that
        // voice spoke first.
        assertThat(saved).extracting(TranscriptSegment::getSpeakerRaw)
                .containsExactly("D", null);
        assertThat(saved).extracting(TranscriptSegment::getSpeakerStatus)
                .containsExactly("attributed", "unknown");
        assertThat(saved.get(0).getWords().get(0).speakerRaw()).isEqualTo("D");
    }

    @Test
    void an_older_worker_that_sends_no_identity_still_produces_an_attributed_turn() {
        // The six-field shape. Nothing about it should start rendering as
        // unattributed just because newer fields exist.
        service.applyResult(MEETING, result(List.of(
                new AiSegment(0.0, 8.0, "Speaker 1", "Shall we start?", null, null))));

        TranscriptSegment saved = savedSegments().get(0);

        assertThat(saved.getSpeakerStatus()).isEqualTo("attributed");
        // No key and no raw label: the client falls back to the display name
        // for grouping and colour, exactly as it always did.
        assertThat(saved.getSpeakerKey()).isNull();
        assertThat(saved.getSpeakerRaw()).isNull();
        assertThat(saved.getSpeaker()).isEqualTo("Speaker 1");
    }

    @Test
    void the_wire_shape_carries_identity_out_to_the_client() {
        TranscriptSegment segment = new TranscriptSegment();
        segment.setId("seg_1");
        segment.setSpeaker("Sarah");
        segment.setSpeakerKey("spk_2");
        segment.setSpeakerStatus("attributed");
        segment.setStartTime(0.0);
        segment.setEndTime(4.0);
        segment.setText("Exactly.");

        SegmentDto dto = SegmentDto.from(segment);

        // The key, not the name: renaming Speaker 2 to Sarah must not recolour
        // her, and the key is what the client hashes.
        assertThat(dto.speakerKey()).isEqualTo("spk_2");
        assertThat(dto.speaker()).isEqualTo("Sarah");
        assertThat(dto.speakerStatus()).isEqualTo("attributed");
    }

    @Test
    void the_raw_provider_label_is_not_sent_to_the_browser() {
        TranscriptSegment segment = new TranscriptSegment();
        segment.setId("seg_1");
        segment.setSpeaker("Speaker 1");
        segment.setSpeakerKey("spk_1");
        segment.setSpeakerRaw("D");
        segment.setStartTime(0.0);
        segment.setEndTime(4.0);
        segment.setText("Morning.");

        // It is a diagnostic, and putting a second speaker identifier on the
        // wire invites somebody to render it.
        assertThat(SegmentDto.from(segment).toString()).doesNotContain("\"D\"");
    }

    /** Segments are written one at a time, in the order the worker sent them. */
    private List<TranscriptSegment> savedSegments() {
        ArgumentCaptor<TranscriptSegment> captor = ArgumentCaptor.forClass(TranscriptSegment.class);
        verify(segments, atLeastOnce()).save(captor.capture());
        return captor.getAllValues();
    }

    private static MeetingBriefResult result(List<AiSegment> segs) {
        return new MeetingBriefResult(
                MEETING, "full text", "en", segs,
                "short", "detailed", List.of(), List.of(), List.of(),
                "general", List.of(), List.of(), List.of(), null, null, 1);
    }
}
