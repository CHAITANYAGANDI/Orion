package com.recallix.service;

import com.recallix.dto.MeetingCreateRequest;
import com.recallix.dto.MeetingUpdateRequest;
import com.recallix.dto.callback.AiSegment;
import com.recallix.dto.callback.MeetingBriefResult;
import com.recallix.entity.Meeting;
import com.recallix.entity.UserEntity;
import com.recallix.repository.MeetingActionItemRepository;
import com.recallix.repository.MeetingInsightRepository;
import com.recallix.repository.MeetingRepository;
import com.recallix.repository.MeetingSummaryRepository;
import com.recallix.repository.MeetingTranscriptRepository;
import com.recallix.repository.MeetingTranslationRepository;
import com.recallix.repository.ProjectRepository;
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
import org.springframework.context.ApplicationEventPublisher;

import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.when;

/**
 * Naming a recording after what was said in it.
 *
 * <p>A browser recording is saved as {@code Recording — 20/08/2026, 05:03:43},
 * because when it is saved the date really is all anybody knows. It is a fine
 * placeholder and a poor name: a dozen of them in a list cannot be scanned,
 * searched, or told apart without opening each one.
 *
 * <p>The summarizer reads the whole transcript anyway, so it now returns a title
 * from the same pass. What is tested here is not the naming — that is the
 * model's job — but the three gates that decide whether a name is allowed to
 * land, because each one is a way this feature could quietly do harm.
 *
 * <ul>
 *   <li><strong>An uploaded file keeps its name.</strong> A filename, however
 *       dull, is a decision somebody made. Overwriting it would be the product
 *       renaming a user's own file.</li>
 *   <li><strong>A manual rename wins.</strong> The window is small and easy to
 *       miss: somebody can type a name while the recording is still being
 *       transcribed, and the model's title arrives after theirs.</li>
 *   <li><strong>Silence keeps the timestamp.</strong> A meeting called "Team
 *       Sync" that was ninety seconds of nobody talking is worse than the date
 *       it replaced, because the date never claimed a meeting happened.</li>
 * </ul>
 */
@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class MeetingTitleTest {

    private static final String MEETING = "mtg_1";
    private static final String USER = "usr_1";
    private static final String PLACEHOLDER = "Recording — 20/08/2026, 05:03:43";
    private static final String KEY = "meetings/usr_1/mtg_1/audio.webm";

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

    @Mock private StorageService storage;
    @Mock private OutboxService outbox;
    @Mock private AuditService audit;
    @Mock private AiClient ai;
    @Mock private SummaryTemplateService templates;
    @Mock private ProjectRepository projects;
    @Mock private MeetingTranslationRepository translations;
    @Mock private ErasureService erasure;
    @Mock private UserService userService;
    // Speaker identification is not what these tests are about; it is here
    // because MeetingService now consults it on a rename. Doing nothing is the
    // right behaviour for an account that has not opted in.
    @Mock private SpeakerIdentityService speakerIdentity;

    private CallbackService callbacks;
    private MeetingService meetingService;
    private Meeting meeting;

    @BeforeEach
    void setUp() {
        callbacks = new CallbackService(meetings, transcripts, segments, summaries, actionItems,
                insights, statusPublisher, usage, events, notifications, users);
        meetingService = new MeetingService(meetings, transcripts, segments, summaries,
                insights, storage, usage, outbox, audit, ai, templates, projects, translations,
                notifications, erasure, userService, speakerIdentity);

        meeting = new Meeting();
        meeting.setId(MEETING);
        meeting.setUserId(USER);
        meeting.setTitle(PLACEHOLDER);
        meeting.setObjectKey(KEY);

        UserEntity user = new UserEntity();
        user.setId(USER);

        when(meetings.findById(MEETING)).thenReturn(Optional.of(meeting));
        when(meetings.findByIdAndUserId(MEETING, USER)).thenReturn(Optional.of(meeting));
        when(meetings.findByObjectKeyAndUserId(KEY, USER)).thenReturn(Optional.of(meeting));
        when(users.findById(USER)).thenReturn(Optional.of(user));
        when(actionItems.findByMeetingId(MEETING)).thenReturn(List.of());
        when(summaries.findFirstByMeetingIdOrderByCreatedAtDesc(MEETING)).thenReturn(Optional.empty());
        when(transcripts.findFirstByMeetingIdOrderByCreatedAtDesc(MEETING)).thenReturn(Optional.empty());
        when(templates.requireKnown(anyString())).thenReturn("general");
        when(templates.requireKnown(null)).thenReturn("general");
    }

    @Nested
    @DisplayName("what the worker is allowed to rename")
    class WhenTheBriefLands {

        @Test
        @DisplayName("a recording is named from its transcript")
        void aRecordingIsNamed() {
            meeting.setAutoTitle(true);

            callbacks.applyResult(MEETING, result("Q4 pricing decision"));

            assertThat(meeting.getTitle()).isEqualTo("Q4 pricing decision");
        }

        @Test
        @DisplayName("and is not renamed a second time")
        void theFlagIsSpentOnce() {
            meeting.setAutoTitle(true);
            callbacks.applyResult(MEETING, result("Q4 pricing decision"));

            // Re-summarizing under a different template runs this path again.
            // The name is the user's now, whether or not they chose the words.
            callbacks.applyResult(MEETING, result("Something else entirely"));

            assertThat(meeting.isAutoTitle()).isFalse();
            assertThat(meeting.getTitle()).isEqualTo("Q4 pricing decision");
        }

        @Test
        @DisplayName("an uploaded file keeps the name its owner gave it")
        void anUploadIsLeftAlone() {
            meeting.setTitle("Board pack review.m4a");
            meeting.setAutoTitle(false);

            callbacks.applyResult(MEETING, result("Q4 pricing decision"));

            assertThat(meeting.getTitle()).isEqualTo("Board pack review.m4a");
        }

        @Test
        @DisplayName("a recording with nothing in it keeps its timestamp")
        void silenceKeepsThePlaceholder() {
            meeting.setAutoTitle(true);

            // The model is told to return "" rather than invent a name over an
            // empty room, and this is the half of that instruction we control.
            callbacks.applyResult(MEETING, result(""));

            assertThat(meeting.getTitle()).isEqualTo(PLACEHOLDER);
            // Still eligible: nothing was spent, and a later re-summarize of a
            // meeting that does have words in it can still name it.
            assertThat(meeting.isAutoTitle()).isTrue();
        }

        @Test
        @DisplayName("a null title is the same as no title")
        void nullKeepsThePlaceholder() {
            meeting.setAutoTitle(true);

            callbacks.applyResult(MEETING, result(null));

            assertThat(meeting.getTitle()).isEqualTo(PLACEHOLDER);
        }

        @Test
        @DisplayName("whitespace is not a name")
        void blankKeepsThePlaceholder() {
            meeting.setAutoTitle(true);

            callbacks.applyResult(MEETING, result("   "));

            assertThat(meeting.getTitle()).isEqualTo(PLACEHOLDER);
        }

        @Test
        @DisplayName("an over-long title is cut rather than refused")
        void anOverLongTitleIsCut() {
            meeting.setAutoTitle(true);

            callbacks.applyResult(MEETING, result("x".repeat(400)));

            // The worker caps at 80 and the API refuses over 500. This is the
            // belt to those braces: the title is whatever a model returned, and
            // nothing between there and the column has checked it.
            assertThat(meeting.getTitle()).hasSize(200);
        }
    }

    @Nested
    @DisplayName("who is allowed to be renamed")
    class WhenTheMeetingIsCreated {

        @Test
        @DisplayName("a browser recording is, because its name is a date")
        void aRecordingIsEligible() {
            meetingService.createMeeting(USER, create(true));

            assertThat(meeting.isAutoTitle()).isTrue();
        }

        @Test
        @DisplayName("an uploaded file is not, because its name is a choice")
        void anUploadIsNot() {
            meetingService.createMeeting(USER, create(false));

            assertThat(meeting.isAutoTitle()).isFalse();
        }
    }

    @Nested
    @DisplayName("a name somebody typed")
    class WhenRenamedByHand {

        @Test
        @DisplayName("stops the worker renaming it afterwards")
        void aManualRenameWins() {
            meeting.setAutoTitle(true);

            // The window this closes: the transcript is still processing, and
            // the model's title lands after the one the user typed.
            meetingService.updateMeeting(USER, MEETING,
                    new MeetingUpdateRequest("Pricing with Acme", null));
            callbacks.applyResult(MEETING, result("Q4 pricing decision"));

            assertThat(meeting.getTitle()).isEqualTo("Pricing with Acme");
        }

        @Test
        @DisplayName("but editing only the tags leaves the worker free to name it")
        void tagsAloneDoNotClaimTheName() {
            meeting.setAutoTitle(true);

            meetingService.updateMeeting(USER, MEETING,
                    new MeetingUpdateRequest(null, List.of("sales")));
            callbacks.applyResult(MEETING, result("Q4 pricing decision"));

            // Filing a meeting is not naming it. Somebody who tagged a
            // still-processing recording has said nothing about what to call it.
            assertThat(meeting.getTitle()).isEqualTo("Q4 pricing decision");
        }
    }

    private static MeetingBriefResult result(String title) {
        return new MeetingBriefResult(
                MEETING, "full text", "en",
                List.of(new AiSegment(0.0, 8.0, "Speaker 1", "Right, shall we start?", null, null)),
                "short", "detailed", List.of(), List.of(), List.of(),
                "general", List.of(), List.of(), List.of(), title, null, 1);
    }

    private static MeetingCreateRequest create(boolean recorded) {
        return new MeetingCreateRequest(
                KEY, recorded ? PLACEHOLDER : null, List.of(), "audio/webm", 120,
                null, null, null, recorded, null, null);
    }
}
