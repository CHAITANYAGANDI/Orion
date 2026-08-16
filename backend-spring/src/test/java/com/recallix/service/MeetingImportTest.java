package com.recallix.service;

import com.recallix.common.ApiException;
import com.recallix.config.KafkaTopicsConfig;
import com.recallix.domain.MeetingStatus;
import com.recallix.domain.SourceType;
import com.recallix.dto.MeetingImportRequest;
import com.recallix.dto.MeetingResponse;
import com.recallix.entity.Meeting;
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
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
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
 * URL imports.
 *
 * <p>The URL is user-supplied and is fetched server-side by the worker, so the
 * host allowlist is a security boundary rather than a convenience: anything
 * that gets past it becomes a server-side request forgery against whatever the
 * worker can reach — MinIO, the Spring actuator, or a cloud metadata endpoint.
 * Most of these tests are about what must be turned away.
 */
@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class MeetingImportTest {

    private static final String USER = "usr_1";
    private static final String MEETING_ID = "mtg_1";
    private static final String VIDEO = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

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

    @BeforeEach
    void setUp() {
        service = new MeetingService(meetings, transcripts, segments, summaries,
                actionItems, insights, storage, usage, outbox, audit, ai, templates, knownSpeakers, vocabulary, projects, translations);
        // The picker's validation is exercised in SummaryTemplateServiceTest;
        // here it stands in for "whatever the user chose is fine".
        when(templates.requireKnown(any())).thenReturn("general");
        when(meetings.findByUserIdAndSourceUrl(anyString(), anyString())).thenReturn(Optional.empty());
        when(meetings.save(any(Meeting.class))).thenAnswer(inv -> inv.getArgument(0));
    }

    // --- the allowlist -------------------------------------------------------- //

    @ParameterizedTest
    @ValueSource(strings = {
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            "https://youtube.com/watch?v=dQw4w9WgXcQ",
            "https://m.youtube.com/watch?v=dQw4w9WgXcQ",
            "https://music.youtube.com/watch?v=dQw4w9WgXcQ",
            "https://youtu.be/dQw4w9WgXcQ",
    })
    @DisplayName("YouTube hosts are accepted")
    void youtubeHostsAccepted(String url) {
        assertThat(service.importFromUrl(USER, request(url))).isNotNull();
    }

    @ParameterizedTest
    @ValueSource(strings = {
            // Internal services the worker can reach but the user must not steer it to.
            "http://localhost:8080/actuator/env",
            "http://127.0.0.1/admin",
            "http://169.254.169.254/latest/meta-data/",
            "http://minio:9000/recallix",
            "http://ai-service:8000/ai/process-meeting",
            // Non-HTTP schemes would read the worker's own filesystem.
            "file:///etc/passwd",
            "ftp://youtube.com/video",
            // Hosts that merely look like YouTube.
            "https://youtube.com.attacker.test/watch?v=1",
            "https://evil-youtube.com/watch?v=1",
            "https://notyoutube.com/watch?v=1",
            // Other sites yt-dlp would happily accept.
            "https://vimeo.com/12345",
    })
    @DisplayName("everything else is refused before it reaches the worker")
    void nonYoutubeUrlsRefused(String url) {
        assertThatThrownBy(() -> service.importFromUrl(USER, request(url)))
                .isInstanceOf(ApiException.class);
        // Nothing may be persisted or enqueued for a rejected URL.
        verify(meetings, never()).save(any());
        verify(outbox, never()).enqueue(anyString(), anyString(), any());
    }

    @Test
    @DisplayName("a rejected URL does not consume the user's quota")
    void rejectedUrlDoesNotChargeQuota() {
        assertThatThrownBy(() -> service.importFromUrl(USER, request("https://vimeo.com/1")))
                .isInstanceOf(ApiException.class);
        verify(usage, never()).incrementMeetingsOrThrow(anyString());
    }

    // --- the happy path ------------------------------------------------------- //

    @Test
    @DisplayName("an import is queued immediately — there is no upload to wait for")
    void importIsQueuedWithoutAnUpload() {
        MeetingResponse res = service.importFromUrl(USER, request(VIDEO));

        assertThat(res.status()).isEqualTo(MeetingStatus.QUEUED);
        assertThat(res.sourceType()).isEqualTo(SourceType.YOUTUBE);
        assertThat(res.sourceUrl()).isEqualTo(VIDEO);
    }

    @Test
    @DisplayName("the worker is told where to fetch from")
    void outboxCarriesTheSource() {
        service.importFromUrl(USER, request(VIDEO));

        @SuppressWarnings("unchecked")
        ArgumentCaptor<Map<String, Object>> payload = ArgumentCaptor.forClass(Map.class);
        verify(outbox).enqueue(eq(KafkaTopicsConfig.MEETING_UPLOADED), anyString(), payload.capture());

        assertThat(payload.getValue())
                .containsEntry("sourceType", "YOUTUBE")
                .containsEntry("sourceUrl", VIDEO)
                // No object key: nothing was uploaded, the worker downloads it.
                .containsEntry("objectKey", "");
    }

    @Test
    @DisplayName("without a title the meeting gets the placeholder the worker replaces")
    void placeholderTitleIsUsedWhenNoneGiven() {
        MeetingResponse res = service.importFromUrl(USER, request(VIDEO));
        assertThat(res.title()).isEqualTo(MeetingService.IMPORT_PLACEHOLDER_TITLE);
    }

    @Test
    @DisplayName("a title the user typed is kept, so the worker will not overwrite it")
    void suppliedTitleSurvives() {
        MeetingResponse res = service.importFromUrl(USER,
                new MeetingImportRequest(VIDEO, "Team offsite recording", null, null));

        assertThat(res.title()).isEqualTo("Team offsite recording");
        assertThat(res.title()).isNotEqualTo(MeetingService.IMPORT_PLACEHOLDER_TITLE);
    }

    @Test
    @DisplayName("surrounding whitespace in a pasted URL is tolerated")
    void pastedUrlIsTrimmed() {
        MeetingResponse res = service.importFromUrl(USER, request("  " + VIDEO + "  "));
        assertThat(res.sourceUrl()).isEqualTo(VIDEO);
    }

    // --- duplicates ----------------------------------------------------------- //

    @Test
    @DisplayName("re-importing the same video is refused rather than billed twice")
    void duplicateImportIsRefused() {
        Meeting existing = new Meeting();
        existing.setTitle("Already here");
        when(meetings.findByUserIdAndSourceUrl(USER, VIDEO)).thenReturn(Optional.of(existing));

        assertThatThrownBy(() -> service.importFromUrl(USER, request(VIDEO)))
                .isInstanceOf(ApiException.class)
                .hasMessageContaining("Already here");

        verify(usage, never()).incrementMeetingsOrThrow(anyString());
        verify(outbox, never()).enqueue(anyString(), anyString(), any());
    }

    @Test
    @DisplayName("another user importing the same video is unaffected")
    void duplicateCheckIsScopedToTheOwner() {
        Meeting mine = new Meeting();
        mine.setTitle("Mine");
        when(meetings.findByUserIdAndSourceUrl(USER, VIDEO)).thenReturn(Optional.of(mine));
        when(meetings.findByUserIdAndSourceUrl("usr_2", VIDEO)).thenReturn(Optional.empty());

        assertThat(service.importFromUrl("usr_2", request(VIDEO))).isNotNull();
    }

    // --- reprocess ------------------------------------------------------------ //

    @Test
    @DisplayName("an imported meeting can be reprocessed even though nothing was uploaded")
    void importedMeetingIsReprocessable() {
        Meeting imported = new Meeting();
        imported.setId(MEETING_ID);
        imported.setUserId(USER);
        imported.setSourceType(SourceType.YOUTUBE);
        imported.setSourceUrl(VIDEO);   // no objectKey: the worker re-downloads
        when(meetings.findByIdAndUserId(MEETING_ID, USER)).thenReturn(Optional.of(imported));

        assertThat(service.reprocess(USER, MEETING_ID).status()).isEqualTo(MeetingStatus.QUEUED);
    }

    @Test
    @DisplayName("a meeting with neither an upload nor a URL cannot be reprocessed")
    void meetingWithNoSourceIsRefused() {
        Meeting empty = new Meeting();
        empty.setId(MEETING_ID);
        empty.setUserId(USER);
        when(meetings.findByIdAndUserId(MEETING_ID, USER)).thenReturn(Optional.of(empty));

        assertThatThrownBy(() -> service.reprocess(USER, MEETING_ID))
                .isInstanceOf(ApiException.class);
    }

    private static MeetingImportRequest request(String url) {
        return new MeetingImportRequest(url, null, null, null);
    }
}
