package com.recallix.service;

import com.recallix.common.ApiException;
import com.recallix.entity.Meeting;
import com.recallix.entity.UserEntity;
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
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.mockito.junit.jupiter.MockitoSettings;
import org.mockito.quality.Strictness;

import java.util.Map;
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
 * Telling Recallix what language one meeting is in.
 *
 * <p>The account already had a default (V38) and it is the wrong grain for the
 * case this exists for: one French meeting in an English workspace. The failure
 * without it is not a missing feature, it is a workaround that leaves damage —
 * change the account default, reprocess, forget to change it back, and every
 * later upload is transcribed as French.
 *
 * <p>What these hold still is the precedence rule and the fact that the answer
 * survives. A per-meeting answer consumed by the run that used it would revert
 * to auto-detect on the next reprocess, silently undoing the correction.
 */
@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class MeetingLanguageTest {

    private static final String USER = "usr_1";
    private static final String MEETING = "mtg_1";

    @Mock private MeetingRepository meetings;
    @Mock private MeetingTranscriptRepository transcripts;
    @Mock private TranscriptSegmentRepository segments;
    @Mock private MeetingSummaryRepository summaries;
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
    @Mock private UserService users;

    private MeetingService service;
    private Meeting meeting;
    private UserEntity user;

    @BeforeEach
    void setUp() {
        service = new MeetingService(meetings, transcripts, segments, summaries,
                insights, storage, usage, outbox, audit, ai, templates, projects, translations, notifications, erasure, users);

        meeting = new Meeting();
        meeting.setId(MEETING);
        meeting.setUserId(USER);
        meeting.setTitle("Revue de sprint");
        meeting.setObjectKey("meetings/usr_1/mtg_1/audio.m4a");

        user = new UserEntity();
        user.setId(USER);
        user.setDefaultLanguage("en");

        when(meetings.findByIdAndUserId(MEETING, USER)).thenReturn(Optional.of(meeting));
        when(users.require(anyString())).thenReturn(user);
    }

    /** The language hint actually put on the job. */
    @SuppressWarnings("unchecked")
    private String enqueuedLanguage() {
        ArgumentCaptor<Map<String, Object>> payload = ArgumentCaptor.forClass(Map.class);
        verify(outbox).enqueue(anyString(), eq(MEETING), payload.capture());
        return String.valueOf(payload.getValue().get("language"));
    }

    @Nested
    class Setting {

        @Test
        @DisplayName("the meeting's own language is what the job is told")
        void overridesTheAccountDefault() {
            service.setSpokenLanguage(USER, MEETING, "fr");

            assertThat(meeting.getSpokenLanguage()).isEqualTo("fr");
            // The account still says English. This meeting does not.
            assertThat(enqueuedLanguage()).isEqualTo("fr");
        }

        @Test
        @DisplayName("setting it re-transcribes, because otherwise nothing on screen changes")
        void queuesTheWorkImmediately() {
            var out = service.setSpokenLanguage(USER, MEETING, "fr");

            assertThat(out.status()).isEqualTo(com.recallix.domain.MeetingStatus.QUEUED);
            // The transcript in front of the user is the one the wrong language
            // produced, and it is the reason they opened this.
            assertThat(meeting.getStatus()).isEqualTo(com.recallix.domain.MeetingStatus.QUEUED);
            verify(translations).markStaleByMeetingId(MEETING);
        }

        @Test
        @DisplayName("a language name is accepted as readily as its code")
        void acceptsWhateverThePickerSends() {
            service.setSpokenLanguage(USER, MEETING, "French");
            // Normalised on the way in, so what is stored is always the code the
            // worker expects rather than whatever the caller happened to type.
            assertThat(meeting.getSpokenLanguage()).isEqualTo("fr");
        }

        @Test
        @DisplayName("blank hands the meeting back to the account default")
        void blankClearsTheOverride() {
            meeting.setSpokenLanguage("fr");

            service.setSpokenLanguage(USER, MEETING, "  ");

            assertThat(meeting.getSpokenLanguage()).isNull();
            assertThat(enqueuedLanguage()).isEqualTo("en");
        }

        @Test
        @DisplayName("a language Recallix cannot transcribe is refused, not attempted")
        void unsupportedIsRefused() {
            // Passed through, this is an hour of audio transcribed as gibberish
            // and discovered twenty minutes later.
            assertThatThrownBy(() -> service.setSpokenLanguage(USER, MEETING, "Klingon"))
                    .isInstanceOf(ApiException.class)
                    .hasMessageContaining("can only transcribe");
            assertThat(meeting.getSpokenLanguage()).isNull();
            verify(outbox, never()).enqueue(anyString(), anyString(), any());
        }

        @Test
        @DisplayName("someone else's meeting is not found")
        void cannotSetOnAnotherUsersMeeting() {
            assertThatThrownBy(() -> service.setSpokenLanguage("usr_2", MEETING, "fr"))
                    .isInstanceOf(ApiException.class);
            verify(outbox, never()).enqueue(anyString(), anyString(), any());
        }
    }

    @Nested
    class Precedence {

        @Test
        @DisplayName("a plain reprocess still honours the meeting's own answer")
        void survivesALaterReprocess() {
            meeting.setSpokenLanguage("fr");

            service.reprocess(USER, MEETING);

            // Read at every enqueue rather than consumed by the run that used
            // it. Otherwise the next reprocess quietly undoes the correction.
            assertThat(enqueuedLanguage()).isEqualTo("fr");
        }

        @Test
        @DisplayName("without one, the account default is used as before")
        void fallsBackToTheAccount() {
            service.reprocess(USER, MEETING);

            assertThat(enqueuedLanguage()).isEqualTo("en");
        }

        @Test
        @DisplayName("with neither, the transcriber detects it")
        void fallsBackToDetection() {
            user.setDefaultLanguage(null);

            service.reprocess(USER, MEETING);

            assertThat(enqueuedLanguage()).isEmpty();
        }

        @Test
        @DisplayName("an unreadable profile still transcribes")
        void aBrokenProfileIsNotFatal() {
            when(users.require(anyString())).thenThrow(new IllegalStateException("gone"));

            service.reprocess(USER, MEETING);

            // Detection is the behaviour every account had before the setting
            // existed; refusing to transcribe an uploaded recording is not.
            assertThat(enqueuedLanguage()).isEmpty();
        }
    }
}
