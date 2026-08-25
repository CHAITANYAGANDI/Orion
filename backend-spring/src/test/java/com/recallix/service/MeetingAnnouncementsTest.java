package com.recallix.service;

import com.recallix.domain.MeetingStatus;
import com.recallix.dto.callback.AiSegment;
import com.recallix.dto.callback.MeetingBriefResult;
import com.recallix.dto.callback.StatusCallbackRequest;
import com.recallix.entity.Meeting;
import com.recallix.entity.MeetingActionItem;
import com.recallix.entity.UserEntity;
import com.recallix.repository.MeetingActionItemRepository;
import com.recallix.repository.MeetingInsightRepository;
import com.recallix.repository.MeetingRepository;
import com.recallix.repository.MeetingSummaryRepository;
import com.recallix.repository.MeetingTranscriptRepository;
import com.recallix.repository.TranscriptSegmentRepository;
import com.recallix.repository.UserRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.mockito.junit.jupiter.MockitoSettings;
import org.mockito.quality.Strictness;
import org.springframework.context.ApplicationEventPublisher;

import java.util.List;
import java.util.Optional;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * What the pipeline announces when a meeting lands.
 *
 * <p>The worker returns the transcript, the notes and the action items in one
 * callback, so "transcript ready" and "summary ready" are the same instant and
 * the same link. Both kinds exist for good reasons, but ringing twice to say one
 * thing is exactly how a bell stops being read — so these tests pin down which
 * one wins, and that the other still fires when it is the only true thing to
 * say.
 *
 * <p>The mention is different in kind and gets its own line: it is about the
 * reader rather than about the meeting. It also cannot be guessed — nothing
 * relates an account to a "Priya" in a transcript except a display name the
 * person typed, and a wrong guess here is the product telling somebody they owe
 * work they never agreed to.
 */
@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class MeetingAnnouncementsTest {

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
    private Meeting meeting;
    private UserEntity user;

    @BeforeEach
    void setUp() {
        service = new CallbackService(meetings, transcripts, segments, summaries, actionItems,
                insights, statusPublisher, usage, events, notifications, users);

        meeting = new Meeting();
        meeting.setId(MEETING);
        meeting.setUserId(USER);
        meeting.setTitle("Sprint planning");

        user = new UserEntity();
        user.setId(USER);

        when(meetings.findById(MEETING)).thenReturn(Optional.of(meeting));
        when(users.findById(USER)).thenReturn(Optional.of(user));
        when(actionItems.findByMeetingId(MEETING)).thenReturn(List.of());
        when(summaries.findFirstByMeetingIdOrderByCreatedAtDesc(MEETING)).thenReturn(Optional.empty());
        when(transcripts.findFirstByMeetingIdOrderByCreatedAtDesc(MEETING)).thenReturn(Optional.empty());
    }

    @Test
    void announcesTheNotesRatherThanTheTranscriptWhenBothLand() {
        service.applyResult(MEETING, result("We agreed to move billing to Stripe."));

        // The notes imply the transcript, so saying both would be two bells for
        // one arrival — and the second is the one that gets a bell ignored.
        verify(notifications).summaryReady(meeting, 1);
        verify(notifications, never()).transcriptReady(any(), anyInt());
    }

    @Test
    void announcesTheTranscriptWhenThatIsAllThereIs() {
        service.applyResult(MEETING, result(""));

        // A run where summarization produced nothing still produced something
        // worth reading, and silence would look like a meeting that vanished.
        verify(notifications).transcriptReady(meeting, 1);
        verify(notifications, never()).summaryReady(any(), anyInt());
    }

    @Test
    void saysWhenWorkWasAssignedToTheReaderByName() {
        user.setDisplayName("Priya");
        when(actionItems.findByMeetingId(MEETING)).thenReturn(List.of(
                task("Finish the JWT validation", "Priya"),
                task("Draft the rollout plan", "Marcus")));

        service.applyResult(MEETING, result("short"));

        verify(notifications).mentionedIn(eq(meeting), org.mockito.ArgumentMatchers.argThat(
                items -> items.size() == 1
                        && items.get(0).getTitle().equals("Finish the JWT validation")));
    }

    @Test
    void matchesANameWithoutCaringAboutCaseOrSpacing() {
        user.setDisplayName("  priya ");
        when(actionItems.findByMeetingId(MEETING)).thenReturn(List.of(
                task("Finish the JWT validation", "Priya")));

        service.applyResult(MEETING, result("short"));

        verify(notifications).mentionedIn(eq(meeting), org.mockito.ArgumentMatchers.argThat(
                items -> items.size() == 1));
    }

    @Test
    void saysNothingAboutMentionsWhenNobodyHasSaidWhoTheyAre() {
        when(actionItems.findByMeetingId(MEETING)).thenReturn(List.of(
                task("Finish the JWT validation", "Priya")));

        service.applyResult(MEETING, result("short"));

        // A guess here tells somebody they owe work they never agreed to.
        verify(notifications).mentionedIn(eq(meeting), org.mockito.ArgumentMatchers.argThat(List::isEmpty));
    }

    @Test
    void saysSoWhenProcessingFails() {
        service.applyStatus(MEETING, new StatusCallbackRequest("FAILED", 0, "the audio was unreadable", 1));

        // The one that has to survive a closed tab: a failed upload is
        // otherwise indistinguishable from one still running.
        verify(notifications).processingFailed(meeting, "the audio was unreadable", 1);
    }

    @Test
    void staysQuietWhileTheWorkIsStillRunning() {
        service.applyStatus(MEETING, new StatusCallbackRequest("TRANSCRIBING", 40, "Transcribing...", 1));

        // Progress belongs on the socket the meeting page already listens to.
        // A notification per stage is four rows per upload.
        verify(notifications, never()).processingFailed(any(), anyString(), anyInt());
    }

    @Test
    void saysNothingAboutAMeetingItDoesNotKnow() {
        when(meetings.findById("mtg_gone")).thenReturn(Optional.empty());

        service.applyResult("mtg_gone", result("short"));

        verify(notifications, never()).summaryReady(any(), anyInt());
        verify(notifications, never()).transcriptReady(any(), anyInt());
    }

    private static MeetingBriefResult result(String shortSummary) {
        return new MeetingBriefResult(
                MEETING, "full text", "en",
                List.of(new AiSegment(0.0, 8.0, "Priya", "Right, shall we start?", null, null)),
                shortSummary, "detailed", List.of(), List.of(), List.of(),
                "general", List.of(), List.of(), List.of(), null, null, 1);
    }

    private static MeetingActionItem task(String title, String owner) {
        MeetingActionItem a = new MeetingActionItem();
        a.setId("ai_" + Math.abs(title.hashCode()));
        a.setMeetingId(MEETING);
        a.setTitle(title);
        a.setOwnerName(owner);
        a.setStatus("OPEN");
        return a;
    }

    @Test
    void leavesTheMeetingReadyEvenWhenNothingIsAnnounced() {
        service.applyResult(MEETING, result(""));

        org.assertj.core.api.Assertions.assertThat(meeting.getStatus()).isEqualTo(MeetingStatus.READY);
    }
}
