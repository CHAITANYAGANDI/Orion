package com.reverie.service;

import com.reverie.domain.MeetingStatus;
import com.reverie.entity.Meeting;
import com.reverie.repository.MeetingInsightRepository;
import com.reverie.repository.MeetingRepository;
import com.reverie.repository.MeetingSummaryRepository;
import com.reverie.repository.MeetingTranscriptRepository;
import com.reverie.repository.MeetingTranslationRepository;
import com.reverie.repository.ProjectRepository;
import com.reverie.repository.TranscriptSegmentRepository;
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
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
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
    @Mock private ProjectRepository projects;
    @Mock private MeetingTranslationRepository translations;
    @Mock private NotificationService notifications;
    @Mock private ErasureService erasure;
    // Consulted on a rename; does nothing for an account that has not opted in.
    @Mock private SpeakerIdentityService speakerIdentity;
    @Mock private UserService users;

    private MeetingService service;

    @BeforeEach
    void setUp() {
        service = new MeetingService(meetings, transcripts, segments, summaries,
                insights, storage, usage, outbox, audit, ai, templates, projects, translations, notifications, erasure, users, speakerIdentity);

        when(meetings.search(anyString(), any(), any(), any(), any(), any(), anyBoolean(), any()))
                .thenReturn(new org.springframework.data.domain.PageImpl<>(List.<Meeting>of()));
    }

    private Instant[] windowSentToTheQuery() {
        ArgumentCaptor<Instant> from = ArgumentCaptor.forClass(Instant.class);
        ArgumentCaptor<Instant> to = ArgumentCaptor.forClass(Instant.class);
        verify(meetings).search(anyString(), any(), any(), any(),
                from.capture(), to.capture(), anyBoolean(), any());
        return new Instant[] { from.getValue(), to.getValue() };
    }

    @Test
    @DisplayName("the window goes to the query, not to a filter over the page")
    void narrowsInTheQuery() {
        Instant from = Instant.parse("2026-07-01T00:00:00Z");
        Instant to = Instant.parse("2026-08-01T00:00:00Z");

        service.list(USER, 0, 20, null, null, null, from, to, false);

        assertThat(windowSentToTheQuery()).containsExactly(from, to);
    }

    @Test
    @DisplayName("no window asks for no window")
    void bothEndsOptional() {
        service.list(USER, 0, 20, null, null, null, null, null, false);

        // Nulls rather than a pair of sentinel dates: "any time" has to mean the
        // filter is absent, or the earliest bound anybody hard-codes becomes the
        // oldest meeting the product can show.
        verify(meetings).search(anyString(), isNull(), isNull(), isNull(),
                isNull(), isNull(), eq(false), any());
    }

    @Test
    @DisplayName("one end is enough")
    void openEnded() {
        Instant from = Instant.parse("2026-08-01T00:00:00Z");

        service.list(USER, 0, 20, null, null, null, from, null, false);

        assertThat(windowSentToTheQuery()).containsExactly(from, null);
    }

    @Test
    @DisplayName("the window sits alongside the filters that were already there")
    void combinesWithTheOtherFilters() {
        Instant from = Instant.parse("2026-08-01T00:00:00Z");

        service.list(USER, 0, 20, "sprint", "planning", MeetingStatus.READY, from, null, false);

        verify(meetings).search(USER, "sprint", "READY", "planning", from, null,
                false, org.springframework.data.domain.PageRequest.of(0, 20));
    }

    @Test
    @DisplayName("unfiled goes to the query too, rather than thinning the page")
    void unfiledNarrowsInTheQuery() {
        service.list(USER, 0, 20, null, null, null, null, null, true);

        // The same reason the window does. Home asks for fifty and keeps the
        // ones with no folder; done here, "conversations outside a folder"
        // would be answered with whichever of the fifty most recent happened to
        // be unfiled, and the total would count the ones it had just hidden.
        verify(meetings).search(anyString(), isNull(), isNull(), isNull(),
                isNull(), isNull(), eq(true), any());
    }

    @Test
    @DisplayName("everything in the workspace is the absence of that filter")
    void filedAndUnfiledTogether() {
        service.list(USER, 0, 20, null, null, null, null, null, false);

        // False rather than null: a meeting in a folder is still a meeting in
        // the workspace, and All has to show it.
        verify(meetings).search(anyString(), isNull(), isNull(), isNull(),
                isNull(), isNull(), eq(false), any());
    }

    @Test
    @DisplayName("a blank search is no search, as before")
    void blankStringsStayNull() {
        service.list(USER, 0, 20, "   ", "  ", null, null, null, false);

        verify(meetings).search(anyString(), isNull(), isNull(), isNull(),
                isNull(), isNull(), eq(false), any());
    }
}
