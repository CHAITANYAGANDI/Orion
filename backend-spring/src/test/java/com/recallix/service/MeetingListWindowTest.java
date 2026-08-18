package com.recallix.service;

import com.recallix.domain.MeetingStatus;
import com.recallix.entity.Meeting;
import com.recallix.repository.MeetingInsightRepository;
import com.recallix.repository.MeetingRepository;
import com.recallix.repository.MeetingSummaryRepository;
import com.recallix.repository.MeetingTranscriptRepository;
import com.recallix.repository.MeetingTranslationRepository;
import com.recallix.repository.ProjectRepository;
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

import java.time.Instant;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * Narrowing the meeting list to a stretch of time.
 *
 * <p>The bug this guards against is the tempting shortcut: fetch a page and
 * filter it afterwards. That answers "meetings from July" with whichever of the
 * twenty most recent happen to fall in July, reports a total that counts the
 * ones it just hid, and looks completely correct until somebody has more than
 * one page of meetings.
 *
 * <p>The window is half-open so that one day is midnight to midnight. Inclusive
 * on both ends, a meeting recorded exactly at midnight would appear under two
 * different days.
 */
@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class MeetingListWindowTest {

    private static final String USER = "usr_1";

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
    @Mock private KnownSpeakerService knownSpeakers;
    @Mock private VocabularyService vocabulary;
    @Mock private ProjectRepository projects;
    @Mock private MeetingTranslationRepository translations;
    @Mock private NotificationService notifications;
    @Mock private ErasureService erasure;
    @Mock private UserService users;

    private MeetingService service;

    @BeforeEach
    void setUp() {
        service = new MeetingService(meetings, transcripts, segments, summaries,
                insights, storage, usage, outbox, audit, ai, templates, knownSpeakers,
                vocabulary, projects, translations, notifications, erasure, users);

        when(meetings.search(anyString(), any(), any(), any(), any(), any(), any()))
                .thenReturn(new org.springframework.data.domain.PageImpl<>(List.<Meeting>of()));
    }

    private Instant[] windowSentToTheQuery() {
        ArgumentCaptor<Instant> from = ArgumentCaptor.forClass(Instant.class);
        ArgumentCaptor<Instant> to = ArgumentCaptor.forClass(Instant.class);
        verify(meetings).search(anyString(), any(), any(), any(),
                from.capture(), to.capture(), any());
        return new Instant[] { from.getValue(), to.getValue() };
    }

    @Test
    @DisplayName("the window goes to the query, not to a filter over the page")
    void narrowsInTheQuery() {
        Instant from = Instant.parse("2026-07-01T00:00:00Z");
        Instant to = Instant.parse("2026-08-01T00:00:00Z");

        service.list(USER, 0, 20, null, null, null, from, to);

        assertThat(windowSentToTheQuery()).containsExactly(from, to);
    }

    @Test
    @DisplayName("no window asks for no window")
    void bothEndsOptional() {
        service.list(USER, 0, 20, null, null, null, null, null);

        // Nulls rather than a pair of sentinel dates: "any time" has to mean the
        // filter is absent, or the earliest bound anybody hard-codes becomes the
        // oldest meeting the product can show.
        verify(meetings).search(anyString(), isNull(), isNull(), isNull(),
                isNull(), isNull(), any());
    }

    @Test
    @DisplayName("one end is enough")
    void openEnded() {
        Instant from = Instant.parse("2026-08-01T00:00:00Z");

        service.list(USER, 0, 20, null, null, null, from, null);

        assertThat(windowSentToTheQuery()).containsExactly(from, null);
    }

    @Test
    @DisplayName("the window sits alongside the filters that were already there")
    void combinesWithTheOtherFilters() {
        Instant from = Instant.parse("2026-08-01T00:00:00Z");

        service.list(USER, 0, 20, "sprint", "planning", MeetingStatus.READY, from, null);

        verify(meetings).search(USER, "sprint", "READY", "planning", from, null,
                org.springframework.data.domain.PageRequest.of(0, 20));
    }

    @Test
    @DisplayName("a blank search is no search, as before")
    void blankStringsStayNull() {
        service.list(USER, 0, 20, "   ", "  ", null, null, null);

        verify(meetings).search(anyString(), isNull(), isNull(), isNull(),
                isNull(), isNull(), any());
    }
}
