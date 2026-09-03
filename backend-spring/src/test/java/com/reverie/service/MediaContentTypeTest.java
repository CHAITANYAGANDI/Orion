package com.reverie.service;

import com.reverie.common.ApiException;
import com.reverie.domain.SourceType;
import com.reverie.dto.MeetingResponse;
import com.reverie.dto.UploadUrlRequest;
import com.reverie.entity.Meeting;
import com.reverie.repository.MeetingActionItemRepository;
import com.reverie.repository.MeetingInsightRepository;
import com.reverie.repository.MeetingRepository;
import com.reverie.repository.ProjectRepository;
import com.reverie.repository.MeetingTranslationRepository;
import com.reverie.repository.MeetingSummaryRepository;
import com.reverie.repository.MeetingTranscriptRepository;
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

import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * Remembering what kind of media a meeting is.
 *
 * <p>Video uploads were always accepted and always transcribed — the provider
 * demuxes the audio itself — but the type was discarded after validation, so the
 * meeting page had no way to know it was holding a video and played every
 * recording through an audio element. The failure was silent and looked like a
 * working feature: sound, no picture.
 *
 * <p>These pin the round trip, and pin the null case, because every meeting
 * recorded before this existed has no content type and must keep playing rather
 * than break.
 */
@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class MediaContentTypeTest {

    private static final String USER = "usr_1";

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
    // Speaker identification is not what these tests are about; it is here
    // because MeetingService now consults it on a rename. Doing nothing is the
    // right behaviour for an account that has not opted in.

    private MeetingService service;

    @BeforeEach
    void setUp() {
        service = new MeetingService(meetings, transcripts, segments, summaries,
                insights, storage, usage, outbox, audit, ai, templates, projects, translations, notifications, erasure, userService);
        when(storage.presignUpload(anyString(), anyString())).thenReturn("https://example/put");
        when(storage.presignDownload(anyString())).thenReturn("https://example/get");
        when(storage.presignExpirySeconds()).thenReturn(900L);
    }

    private Meeting captureSaved() {
        ArgumentCaptor<Meeting> saved = ArgumentCaptor.forClass(Meeting.class);
        verify(meetings).save(saved.capture());
        return saved.getValue();
    }

    @Test
    @DisplayName("a video upload stores its content type")
    void videoTypeIsPersisted() {
        service.createUploadUrl(USER, new UploadUrlRequest("standup.mp4", "video/mp4", 4_000_000));

        Meeting saved = captureSaved();
        assertThat(saved.getContentType()).isEqualTo("video/mp4");
        // Still an AUDIO source: it has a soundtrack to transcribe, unlike a PDF.
        assertThat(saved.getSourceType()).isEqualTo(SourceType.AUDIO);
    }

    @Test
    @DisplayName("an audio upload stores its content type")
    void audioTypeIsPersisted() {
        service.createUploadUrl(USER, new UploadUrlRequest("call.m4a", "audio/mp4", 2_000_000));
        assertThat(captureSaved().getContentType()).isEqualTo("audio/mp4");
    }

    @Test
    @DisplayName("a PDF is refused, because a document is not a meeting")
    void pdfIsRefused() {
        // Accepted once, as a DOCUMENT source that skipped transcription. Every
        // feature downstream — speakers, timestamps, playback, moments — had to
        // special-case it into meaninglessness, and nobody attended a PDF.
        assertThatThrownBy(() -> service.createUploadUrl(USER,
                new UploadUrlRequest("notes.pdf", "application/pdf", 100_000)))
                .isInstanceOf(ApiException.class)
                .hasMessageContaining("audio and video");

        verify(meetings, never()).save(any());
    }

    @Test
    @DisplayName("an uploaded recording is an AUDIO source, the only kind there is")
    void uploadsAreAudioSources() {
        service.createUploadUrl(USER, new UploadUrlRequest("call.m4a", "audio/mp4", 2_000_000));

        assertThat(captureSaved().getSourceType()).isEqualTo(SourceType.AUDIO);
    }

    @Test
    @DisplayName("a rejected type is never stored")
    void rejectedTypeIsNotPersisted() {
        assertThatThrownBy(() -> service.createUploadUrl(USER,
                new UploadUrlRequest("payload.exe", "application/x-msdownload", 10)))
                .isInstanceOf(ApiException.class);

        // Validation runs before the row is built, so nothing reaches the table —
        // which is what lets the player trust the stored value without re-checking.
        verify(meetings, org.mockito.Mockito.never()).save(org.mockito.ArgumentMatchers.any());
    }

    @Test
    @DisplayName("the content type reaches the API response")
    void contentTypeIsExposed() {
        Meeting m = new Meeting();
        m.setId("mtg_1");
        m.setUserId(USER);
        m.setTitle("Sprint review");
        m.setObjectKey("meetings/usr_1/mtg_1/standup.mp4");
        m.setContentType("video/mp4");
        when(meetings.findByIdAndUserId("mtg_1", USER)).thenReturn(Optional.of(m));

        MeetingResponse res = service.get(USER, "mtg_1");
        assertThat(res.contentType()).isEqualTo("video/mp4");
    }

    @Test
    @DisplayName("a meeting from before this column still resolves, as audio")
    void legacyMeetingHasNoContentType() {
        Meeting m = new Meeting();
        m.setId("mtg_old");
        m.setUserId(USER);
        m.setTitle("Recorded last year");
        m.setObjectKey("meetings/usr_1/mtg_old/call.mp3");
        when(meetings.findByIdAndUserId("mtg_old", USER)).thenReturn(Optional.of(m));

        // Null rather than a guess: the UI reads null as audio, which is exactly
        // how these meetings already played. Inferring from the ".mp3" here would
        // mean trusting a user-supplied filename to pick a player.
        assertThat(service.get(USER, "mtg_old").contentType()).isNull();
    }
}
