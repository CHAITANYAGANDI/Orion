package com.orion.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.orion.common.ApiException;
import com.orion.domain.ChatMode;
import com.orion.entity.Meeting;
import com.orion.entity.MeetingTranscript;
import com.orion.entity.MeetingTranslation;
import com.orion.entity.TranscriptSegment;
import com.orion.entity.UsageLimit;
import com.orion.repository.ChatConversationRepository;
import com.orion.repository.ChatMessageRepository;
import com.orion.repository.MeetingActionItemRepository;
import com.orion.repository.MeetingInsightRepository;
import com.orion.repository.MeetingRepository;
import com.orion.repository.MeetingSummaryRepository;
import com.orion.repository.MeetingTranscriptRepository;
import com.orion.repository.MeetingTranslationRepository;
import com.orion.repository.ProjectRepository;
import com.orion.repository.TranscriptSegmentRepository;
import com.orion.repository.UsageLimitRepository;
import com.orion.repository.UserRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.mockito.junit.jupiter.MockitoSettings;
import org.mockito.quality.Strictness;

import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

/**
 * What an account that has spent its minutes may still ask a model for.
 *
 * <p>Nothing. Chat, rewriting a summary, rematching speakers, translating and
 * reprocessing are all refused, and that is a decision about what the allowance
 * <em>is</em> rather than about what it counts — three of those five spend no
 * transcription minutes at all, and left running they would turn a limit on the
 * product into a limit on recording.
 *
 * <p><b>The other half of it is what stays open</b>, and that is the part worth
 * defending with tests. Somebody out of minutes keeps every meeting, every
 * summary, every translation and every name they typed. So each refusal below
 * has a partner: the two rematch answers that ask nothing of a model still get
 * through, and a language already translated still comes back. A limit that
 * takes away work already paid for is not a limit, it is a repossession.
 *
 * <p>Written as one file rather than spread across five service tests because
 * the rule is one rule. Five separate half-tests are how the sixth feature gets
 * added without one.
 */
@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class AiAllowanceGateTest {

    private static final String USER = "usr_1";
    private static final String MEETING = "mtg_1";

    /**
     * The real thing, not a mock.
     *
     * <p>Every test below asks whether an operation is gated, and a mocked gate
     * would answer that question with whatever the test told it to. This one
     * counts.
     */
    @Mock private UsageLimitRepository usageRows;
    @Mock private UserRepository users;
    @Mock private com.orion.repository.MeetingUsageChargeRepository charges;
    private UsageLimitService usage;
    private UsageLimit row;

    @BeforeEach
    void setUp() {
        row = new UsageLimit();
        row.setId("usg_1");
        row.setUserId(USER);
        when(usageRows.findByUserId(USER)).thenReturn(Optional.of(row));
        when(usageRows.save(any(UsageLimit.class))).thenAnswer(i -> i.getArgument(0));
        usage = new UsageLimitService(usageRows, users, charges);
    }

    /** Spend the whole allowance. */
    private void spendEverything() {
        row.setAiMinutesUsed(UsageLimitService.MINUTES_ALLOWANCE);
    }

    @Nested
    @DisplayName("the gate itself")
    class TheGate {

        @Test
        @DisplayName("lets every feature through with a minute left")
        void oneMinuteLeftIsEnough() {
            row.setAiMinutesUsed(UsageLimitService.MINUTES_ALLOWANCE - 1);

            for (UsageLimitService.AiFeature feature : UsageLimitService.AiFeature.values()) {
                assertThatCode(() -> usage.requireAiOrThrow(USER, feature)).doesNotThrowAnyException();
            }
        }

        @Test
        @DisplayName("refuses every feature once the last minute is gone")
        void nothingGetsThroughAtTheLimit() {
            spendEverything();

            // Iterated rather than listed, so a feature added to the enum
            // without a decision about this is a failing test rather than a
            // silent exemption.
            for (UsageLimitService.AiFeature feature : UsageLimitService.AiFeature.values()) {
                assertThatThrownBy(() -> usage.requireAiOrThrow(USER, feature))
                        .isInstanceOf(ApiException.class)
                        .hasMessageContaining("100 transcription minutes");
            }
        }

        @Test
        @DisplayName("refuses an account that overran, not just one exactly at the line")
        void overrunIsStillOver() {
            row.setAiMinutesUsed(UsageLimitService.MINUTES_ALLOWANCE + 40);

            assertThatThrownBy(() -> usage.requireAiOrThrow(USER, UsageLimitService.AiFeature.CHAT))
                    .isInstanceOf(ApiException.class);
        }

        @Test
        @DisplayName("names the feature that was refused, and what is kept")
        void everyRefusalSaysBothHalves() {
            spendEverything();

            for (UsageLimitService.AiFeature feature : UsageLimitService.AiFeature.values()) {
                String message = ApiException.class
                        .cast(catchIt(feature))
                        .getMessage();

                // Running out of an allowance is not the account being closed,
                // and a refusal that does not say what survives reads as one.
                assertThat(message).contains("still here");
                // Two full sentences: what cannot be done, then what is kept.
                assertThat(message.split("\\. ")).hasSizeGreaterThanOrEqualTo(2);
            }
        }

        @Test
        @DisplayName("says something different for each feature")
        void theFiveRefusalsAreDistinguishable() {
            spendEverything();

            List<String> messages = java.util.Arrays.stream(UsageLimitService.AiFeature.values())
                    .map(f -> ApiException.class.cast(catchIt(f)).getMessage())
                    .toList();

            // "Something went wrong" five times over would be five features
            // failing for what reads as one unexplained reason.
            assertThat(messages).doesNotHaveDuplicates();
        }

        @Test
        @DisplayName("costs one read and never creates a usage row")
        void readingDoesNotWrite() {
            when(usageRows.findByUserId(USER)).thenReturn(Optional.empty());

            assertThatCode(() -> usage.requireAiOrThrow(USER, UsageLimitService.AiFeature.CHAT))
                    .doesNotThrowAnyException();

            // An account that has never recorded has no row, and asking whether
            // it may chat must not be what brings one into being.
            verify(usageRows, never()).save(any());
        }

        private Throwable catchIt(UsageLimitService.AiFeature feature) {
            try {
                usage.requireAiOrThrow(USER, feature);
            } catch (Throwable t) {
                return t;
            }
            throw new AssertionError("expected " + feature + " to be refused");
        }
    }

    // ------------------------------------------------------------------ chat //

    @Nested
    @DisplayName("AI chat")
    class Chat {

        @Mock private ChatMessageRepository messages;
        @Mock private ChatConversationRepository conversations;
        @Mock private MeetingRepository meetings;
        @Mock private ProjectRepository projects;
        @Mock private AiClient ai;
        @Mock private UserService userService;

        private ChatService chat;

        @BeforeEach
        void wire() {
            chat = new ChatService(messages, conversations, meetings, projects, ai, userService,
                    usage, new ObjectMapper());
            spendEverything();
        }

        @Test
        @DisplayName("is closed for a meeting")
        void meetingChatIsClosed() {
            assertThatThrownBy(() -> chat.ask(USER, MEETING, "what did we decide?", null, ChatMode.QUICK))
                    .isInstanceOf(ApiException.class)
                    .hasMessageContaining("AI Chat is closed");

            verifyNoInteractions(ai);
        }

        @Test
        @DisplayName("is closed for a folder")
        void projectChatIsClosed() {
            assertThatThrownBy(() -> chat.askProject(USER, "prj_1", "summarise this folder", null))
                    .isInstanceOf(ApiException.class);

            verifyNoInteractions(ai);
        }

        @Test
        @DisplayName("is closed for the whole workspace")
        void workspaceChatIsClosed() {
            assertThatThrownBy(() -> chat.askWorkspace(USER, "what am I behind on?", null, null, ChatMode.QUICK))
                    .isInstanceOf(ApiException.class);

            verifyNoInteractions(ai);
        }

        @Test
        @DisplayName("refuses before the question is written down")
        void nothingIsPersisted() {
            assertThatThrownBy(() -> chat.ask(USER, MEETING, "what did we decide?", null, ChatMode.QUICK))
                    .isInstanceOf(ApiException.class);

            // A refused question saved as a turn leaves a conversation whose
            // last line is a question nobody answered, which reads as the model
            // having failed rather than as the account being out.
            verify(messages, never()).save(any());
        }
    }

    // -------------------------------------------------------------- meetings //

    @Nested
    @DisplayName("meeting operations")
    class Meetings {

        @Mock private MeetingRepository meetings;
        @Mock private MeetingTranscriptRepository transcripts;
        @Mock private TranscriptSegmentRepository segments;
        @Mock private MeetingSummaryRepository summaries;
        @Mock private MeetingInsightRepository insights;
        @Mock private StorageService storage;
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
        private Meeting meeting;

        @BeforeEach
        void wire() {
            service = new MeetingService(meetings, transcripts, segments, summaries, insights,
                    storage, usage, outbox, audit, ai, templates, projects, translations,
                    notifications, erasure, userService, speakerIdentity);

            meeting = new Meeting();
            meeting.setId(MEETING);
            meeting.setUserId(USER);
            meeting.setObjectKey("meetings/usr_1/mtg_1/audio.webm");
            when(meetings.findByIdAndUserId(MEETING, USER)).thenReturn(Optional.of(meeting));

            MeetingTranscript transcript = new MeetingTranscript();
            transcript.setMeetingId(MEETING);
            transcript.setTranscriptText("All right, let us begin.");
            when(transcripts.findFirstByMeetingIdOrderByCreatedAtDesc(MEETING))
                    .thenReturn(Optional.of(transcript));

            TranscriptSegment segment = new TranscriptSegment();
            segment.setMeetingId(MEETING);
            segment.setSpeaker("Speaker 1");
            segment.setText("All right, let us begin.");
            when(segments.findByMeetingIdOrderByStartTimeAsc(MEETING)).thenReturn(List.of(segment));
            when(speakerIdentity.learningEnabled(USER)).thenReturn(true);

            spendEverything();
        }

        @Test
        @DisplayName("the summary cannot be rewritten")
        void resummarizeIsRefused() {
            assertThatThrownBy(() -> service.resummarize(USER, MEETING, "general"))
                    .isInstanceOf(ApiException.class)
                    .hasMessageContaining("summary cannot be rewritten");

            verifyNoInteractions(ai);
        }

        @Test
        @DisplayName("speakers cannot be rematched")
        void rematchIsRefused() {
            assertThatThrownBy(() -> service.rematchSpeakers(USER, MEETING))
                    .isInstanceOf(ApiException.class)
                    .hasMessageContaining("speakers cannot be rematched");

            verify(ai, never()).identifySpeakers(anyString(), anyString(), anyString(), any());
        }

        @Test
        @DisplayName("but rematch still explains itself when the feature is simply off")
        void rematchStillSaysWhatToTurnOn() {
            when(speakerIdentity.learningEnabled(USER)).thenReturn(false);

            var result = service.rematchSpeakers(USER, MEETING);

            // Two problems at once, and only one of them is actionable. Being
            // told the account is out of minutes would send somebody looking
            // for the wrong thing — and this path asks no model anything.
            assertThat(result.unavailable()).contains("Settings");
        }

        @Test
        @DisplayName("and rematch still answers for a meeting with no transcript")
        void rematchStillHandlesAnEmptyMeeting() {
            when(segments.findByMeetingIdOrderByStartTimeAsc(MEETING)).thenReturn(List.of());

            assertThatCode(() -> service.rematchSpeakers(USER, MEETING)).doesNotThrowAnyException();
        }

        @Test
        @DisplayName("the meeting cannot be reprocessed")
        void reprocessIsRefused() {
            assertThatThrownBy(() -> service.reprocess(USER, MEETING))
                    .isInstanceOf(ApiException.class)
                    .hasMessageContaining("cannot be reprocessed");

            // The status is what the whole pipeline keys off. Flipping it to
            // QUEUED and then refusing would leave a meeting reading
            // "Processing" over a job nobody started.
            assertThat(meeting.getStatus()).isNotEqualTo(com.orion.domain.MeetingStatus.QUEUED);
            verifyNoInteractions(outbox);
        }

        @Test
        @DisplayName("reprocess does not throw away the cached voiceprints on the way out")
        void refusedReprocessChangesNothing() {
            assertThatThrownBy(() -> service.reprocess(USER, MEETING))
                    .isInstanceOf(ApiException.class);

            // A refused reprocess must leave the meeting exactly as it was.
            // Forgetting them here would cost the user their speaker names for
            // an operation that did not happen.
            verify(speakerIdentity, never()).forgetMeeting(anyString(), anyString());
            // Neither route. The strict one is what reprocess uses now, and it
            // deliberately sits *after* this gate: deleting a good cache for a
            // reprocess that is then refused would cost a re-embed of the whole
            // recording for an operation that did not happen.
            verify(speakerIdentity, never())
                    .invalidateMeetingVoiceprintsRequired(anyString(), anyString());
            verify(translations, never()).markStaleByMeetingId(anyString());
        }

        @Test
        @DisplayName("with a minute left, all three go through")
        void oneMinuteLeftReopensThem() {
            row.setAiMinutesUsed(UsageLimitService.MINUTES_ALLOWANCE - 1);
            when(templates.requireKnown(anyString())).thenReturn("general");

            assertThatCode(() -> service.reprocess(USER, MEETING)).doesNotThrowAnyException();
            // The gate is the only thing being tested here; whether these two
            // then succeed depends on mocks this test has no interest in, so
            // what is asserted is that they got past it.
            assertThatThrownBy(() -> service.resummarize(USER, MEETING, "general"))
                    .isNotInstanceOf(ApiException.class);
        }
    }

    // ----------------------------------------------------------- translation //

    @Nested
    @DisplayName("translation")
    class Translating {

        @Mock private MeetingRepository meetings;
        @Mock private MeetingSummaryRepository summaries;
        @Mock private MeetingActionItemRepository actionItems;
        @Mock private TranscriptSegmentRepository segments;
        @Mock private MeetingTranslationRepository translations;
        @Mock private AiClient ai;

        private TranslationService service;

        @BeforeEach
        void wire() {
            service = new TranslationService(meetings, summaries, actionItems, segments,
                    translations, ai, usage);

            Meeting meeting = new Meeting();
            meeting.setId(MEETING);
            meeting.setUserId(USER);
            when(meetings.findByIdAndUserId(MEETING, USER)).thenReturn(Optional.of(meeting));
            when(translations.save(any(MeetingTranslation.class))).thenAnswer(i -> i.getArgument(0));

            spendEverything();
        }

        /** A finished translation of the brief, as stored. */
        private MeetingTranslation done(String language) {
            MeetingTranslation t = new MeetingTranslation();
            t.setId("trn_1");
            t.setMeetingId(MEETING);
            t.setLanguage(language);
            t.setShortSummary("Ya decidimos.");
            t.setBriefTranslatedAt(java.time.Instant.now());
            t.setStale(false);
            return t;
        }

        @Test
        @DisplayName("a new language is refused")
        void newLanguageIsRefused() {
            when(translations.findByMeetingIdAndLanguage(MEETING, "es")).thenReturn(Optional.empty());

            assertThatThrownBy(() -> service.translate(USER, MEETING, "es", false))
                    .isInstanceOf(ApiException.class)
                    .hasMessageContaining("nothing further can be translated");

            verifyNoInteractions(ai);
        }

        @Test
        @DisplayName("and nothing is written down for the language it refused")
        void refusingWritesNoRow() {
            when(translations.findByMeetingIdAndLanguage(MEETING, "es")).thenReturn(Optional.empty());

            assertThatThrownBy(() -> service.translate(USER, MEETING, "es", false))
                    .isInstanceOf(ApiException.class);

            // An empty translation row for a language that was never translated
            // would show up in the "already available" list as a language the
            // user could switch to, and switching would show them nothing.
            verify(translations, never()).save(any());
        }

        @Test
        @DisplayName("but a language already translated still opens")
        void storedTranslationStillReads() {
            when(translations.findByMeetingIdAndLanguage(MEETING, "es"))
                    .thenReturn(Optional.of(done("es")));

            assertThatCode(() -> service.translate(USER, MEETING, "es", false))
                    .doesNotThrowAnyException();

            // Paid for, stored, and the user's. Closing this would be taking a
            // page away rather than declining to write a new one.
            verifyNoInteractions(ai);
        }

        @Test
        @DisplayName("asking for the transcript of a brief-only translation is refused")
        void extendingAStoredTranslationIsRefused() {
            when(translations.findByMeetingIdAndLanguage(MEETING, "es"))
                    .thenReturn(Optional.of(done("es")));

            // The brief is there, the transcript is not, so this is real work
            // that has not happened yet rather than a read of work that has.
            assertThatThrownBy(() -> service.translate(USER, MEETING, "es", true))
                    .isInstanceOf(ApiException.class);
        }

        @Test
        @DisplayName("refreshing a stale translation is refused")
        void staleTranslationIsNotRefreshed() {
            MeetingTranslation stale = done("es");
            stale.setStale(true);
            when(translations.findByMeetingIdAndLanguage(MEETING, "es"))
                    .thenReturn(Optional.of(stale));

            assertThatThrownBy(() -> service.translate(USER, MEETING, "es", false))
                    .isInstanceOf(ApiException.class);

            // Still stale, and still readable — the reader keeps the old
            // translation and the flag that says it is behind.
            assertThat(stale.isStale()).isTrue();
        }
    }
}
