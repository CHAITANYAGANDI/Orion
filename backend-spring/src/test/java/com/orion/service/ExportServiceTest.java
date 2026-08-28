package com.orion.service;

import com.orion.common.ApiException;
import com.orion.domain.ExportFormat;
import com.orion.domain.ExportOptions;
import com.orion.domain.SourceType;
import com.orion.domain.SummarySection;
import com.orion.dto.AudioDownloadResponse;
import com.orion.dto.TranslationResponse;
import com.orion.entity.Meeting;
import com.orion.entity.MeetingActionItem;
import com.orion.entity.MeetingSummary;
import com.orion.entity.TranscriptSegment;
import com.orion.export.DocumentRenderer;
import com.orion.export.ExportDocument;
import com.orion.export.ExportFile;
import com.orion.repository.MeetingActionItemRepository;
import com.orion.repository.MeetingRepository;
import com.orion.repository.MeetingSummaryRepository;
import com.orion.repository.TranscriptSegmentRepository;
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

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * Assembling a meeting into a document.
 *
 * <p>These tests are about what goes into the file and what it says, which is
 * the part that has to be decided once for all four formats. The renderers are
 * stood in for by one that keeps whatever it was handed, so an assertion here is
 * about the document rather than about markdown's asterisks.
 *
 * <p>Two themes run through them. One is that an export is a record: an empty
 * section keeps its heading, a finished task is still in the list, and the words
 * somebody used for a deadline survive. The other is that a translated export
 * must not overstate itself — the audio was not translated, the speakers were
 * not translated, and a line recorded since is shown as it was said.
 */
@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class ExportServiceTest {

    private static final String USER = "usr_1";
    private static final String MEETING = "mtg_1";

    @Mock private MeetingRepository meetings;
    @Mock private MeetingSummaryRepository summaries;
    @Mock private MeetingActionItemRepository actionItems;
    @Mock private TranscriptSegmentRepository segments;
    @Mock private TranslationService translations;
    @Mock private StorageService storage;

    private Capturing renderer;
    private ExportService service;

    /** A renderer that renders nothing and keeps everything. */
    private static final class Capturing implements DocumentRenderer {
        private ExportDocument last;

        @Override
        public ExportFormat format() {
            return ExportFormat.MARKDOWN;
        }

        @Override
        public byte[] render(ExportDocument document) {
            this.last = document;
            return "rendered".getBytes(StandardCharsets.UTF_8);
        }
    }

    @BeforeEach
    void setUp() {
        renderer = new Capturing();
        service = new ExportService(meetings, summaries, actionItems, segments,
                translations, storage, List.of(renderer));

        when(meetings.findByIdAndUserId(MEETING, USER)).thenReturn(Optional.of(meeting()));
        when(summaries.findFirstByMeetingIdOrderByCreatedAtDesc(MEETING))
                .thenReturn(Optional.of(summary()));
        when(actionItems.findByMeetingId(MEETING)).thenReturn(tasks());
        when(segments.findByMeetingIdOrderByStartTimeAsc(MEETING)).thenReturn(transcript());
    }

    private ExportDocument exported(boolean transcript, String language) {
        service.render(USER, MEETING, ExportFormat.MARKDOWN, transcript, language, "Europe/London");
        return renderer.last;
    }

    private ExportDocument exported(ExportOptions options) {
        service.render(USER, MEETING, ExportFormat.MARKDOWN, options, null, "Europe/London");
        return renderer.last;
    }

    private static ExportOptions options(boolean summary, java.util.Set<String> sections,
                                         boolean actionItems, boolean transcript,
                                         boolean speakers, boolean timestamps,
                                         ExportOptions.Combine combine) {
        return new ExportOptions(summary, sections, actionItems, transcript,
                speakers, timestamps, combine);
    }

    private static List<ExportDocument.Utterance> utterances(List<ExportDocument.Block> blocks) {
        return blocks.stream()
                .filter(b -> b instanceof ExportDocument.Block.Transcript)
                .map(b -> ((ExportDocument.Block.Transcript) b).lines())
                .findFirst()
                .orElse(List.of());
    }

    /* ------------------------------ the brief ----------------------------- */

    @Nested
    @DisplayName("the brief")
    class Brief {

        @Test
        void writesTheTemplateSSectionsInOrder() {
            List<ExportDocument.Block> blocks = exported(false, null).blocks();

            assertThat(headings(blocks)).containsSubsequence("Decisions", "Budget", "Action items");
        }

        @Test
        void keepsASectionTheMeetingNeverReached() {
            List<ExportDocument.Block> blocks = exported(false, null).blocks();

            // A file is a record. "Budget" with a line saying it was not
            // discussed is a finding; dropping the heading loses it.
            int budget = headings(blocks).indexOf("Budget");
            assertThat(budget).isGreaterThanOrEqualTo(0);
            assertThat(blocks).anyMatch(b -> b instanceof ExportDocument.Block.Aside a
                    && a.text().equals("Not discussed."));
        }

        @Test
        void fallsBackToTheFlatSummaryWhenThereIsNoTemplate() {
            MeetingSummary flat = summary();
            flat.setSections(List.of());
            when(summaries.findFirstByMeetingIdOrderByCreatedAtDesc(MEETING))
                    .thenReturn(Optional.of(flat));

            List<ExportDocument.Block> blocks = exported(false, null).blocks();

            // Meetings summarised before templates existed have nothing else,
            // and an empty file for them would be a regression, not a tidy-up.
            assertThat(headings(blocks)).contains("Summary", "Key points");
            assertThat(blocks).anyMatch(b -> b instanceof ExportDocument.Block.Prose p
                    && p.text().equals("We agreed to move billing to Stripe."));
        }

        @Test
        void survivesAMeetingWithNoSummaryAtAll() {
            when(summaries.findFirstByMeetingIdOrderByCreatedAtDesc(MEETING)).thenReturn(Optional.empty());

            // Still worth exporting: the tasks and the transcript are the whole
            // meeting for somebody who reprocessed it and lost the notes.
            assertThat(headings(exported(true, null).blocks())).contains("Action items", "Transcript");
        }
    }

    /* ------------------------------- the tasks ---------------------------- */

    @Nested
    @DisplayName("action items")
    class Tasks {

        @Test
        void keepsTheWordsSomebodyUsedForADeadline() {
            ExportDocument.Task task = firstTask(exported(false, null));

            // "before the demo" is what was promised. Replacing it with a date
            // is putting a commitment in somebody's mouth they did not make.
            assertThat(task.detail()).isEqualTo("Priya · due friday");
        }

        @Test
        void keepsFinishedWorkInTheList() {
            List<ExportDocument.Task> all = allTasks(exported(false, null));

            // A list that empties as you work makes the work look like it never
            // happened, and a file is exactly where somebody looks it up.
            assertThat(all).hasSize(2);
            assertThat(all.get(1).done()).isTrue();
        }

        @Test
        void leavesTheHeadingOutWhenThereAreNoTasks() {
            when(actionItems.findByMeetingId(MEETING)).thenReturn(List.of());

            assertThat(headings(exported(false, null).blocks())).doesNotContain("Action items");
        }
    }

    /* ---------------------------- the transcript -------------------------- */

    @Nested
    @DisplayName("the transcript")
    class Transcript {

        @Test
        void isLeftOutUnlessItIsAskedFor() {
            assertThat(headings(exported(false, null).blocks())).doesNotContain("Transcript");
        }

        @Test
        void carriesTheTimeAndTheSpeakerWithEveryLine() {
            ExportDocument.Utterance first = utterances(exported(true, null)).get(0);

            assertThat(first.timecode()).isEqualTo("0:00");
            assertThat(first.speaker()).isEqualTo("Priya");
            assertThat(first.text()).isEqualTo("Right, shall we start?");
        }

        @Test
        void writesTimesOverAnHourAsHours() {
            TranscriptSegment late = segment("seg_3", 3725.0, "Marcus", "Still going.");
            when(segments.findByMeetingIdOrderByStartTimeAsc(MEETING)).thenReturn(List.of(late));

            assertThat(utterances(exported(true, null)).get(0).timecode()).isEqualTo("1:02:05");
        }

        @Test
        void namesAnUnidentifiedVoiceRatherThanLeavingAGap() {
            TranscriptSegment anonymous = segment("seg_9", 0.0, null, "Someone said this.");
            when(segments.findByMeetingIdOrderByStartTimeAsc(MEETING)).thenReturn(List.of(anonymous));

            assertThat(utterances(exported(true, null)).get(0).speaker()).isEqualTo("Speaker");
        }
    }

    /* ---------------------------- translations ---------------------------- */

    @Nested
    @DisplayName("read in another language")
    class Translated {

        @BeforeEach
        void translated() {
            when(translations.get(USER, MEETING, "es")).thenReturn(spanish());
        }

        @Test
        void writesTheDocumentInThatLanguage() {
            ExportDocument doc = exported(false, "es");

            assertThat(doc.language()).isEqualTo(com.orion.domain.Language.SPANISH);
            assertThat(headings(doc.blocks())).contains("Decisiones");
        }

        @Test
        void labelsItsOwnHeadingsInThatLanguageToo() {
            // "Action items" in the middle of a Spanish document reads as a
            // translation that gave up half way through.
            assertThat(headings(exported(true, "es").blocks())).contains("Tareas", "Transcripción");
        }

        @Test
        void saysWhatWasTranslatedAndWhatWasNot() {
            // Somebody who forgets they are reading a translation is exactly the
            // person about to quote a translated line as a thing said aloud.
            assertThat(exported(false, "es").notice())
                    .isEqualTo("Translated into Spanish. The recording is in English.");
        }

        @Test
        void takesTheSpeakerAndTheTimingFromTheLiveTranscript() {
            ExportDocument.Utterance line = utterances(exported(true, "es")).get(0);

            // Not stored with the translation: a speaker renamed afterwards has
            // to be renamed in every language, not only in the one regenerated.
            assertThat(line.speaker()).isEqualTo("Priya");
            assertThat(line.timecode()).isEqualTo("0:00");
            assertThat(line.text()).isEqualTo("¿Empezamos?");
        }

        @Test
        void showsALineRecordedSinceInTheOriginal() {
            // A gap would be worse than English: a missing line in a transcript
            // reads as a silence in the room.
            assertThat(utterances(exported(true, "es")).get(1).text())
                    .isEqualTo("I'll draft the rollout plan before the demo.");
        }

        @Test
        void showsATaskWhoseWordingHasMovedOnAsItIsNow() {
            ExportDocument.Task task = firstTask(exported(false, "es"));

            assertThat(task.title()).isEqualTo("Terminar la validación de JWT");
        }

        @Test
        void refusesALanguageTheMeetingWasNeverTranslatedInto() {
            when(translations.get(USER, MEETING, "de"))
                    .thenThrow(ApiException.notFound("This meeting has not been translated into German"));

            // A download is a GET, and translating on demand would make one
            // quietly cost a model call and five seconds.
            assertThatThrownBy(() -> exported(false, "de"))
                    .isInstanceOf(ApiException.class)
                    .hasMessageContaining("German");
        }
    }

    /* ------------------------------ the file ------------------------------ */

    @Nested
    @DisplayName("the file itself")
    class File {

        @Test
        void isNamedAfterTheMeeting() {
            ExportFile file = service.render(USER, MEETING, ExportFormat.MARKDOWN, false, null, null);

            assertThat(file.filename()).isEqualTo("sprint-planning.md");
            assertThat(file.mediaType()).isEqualTo("text/markdown;charset=UTF-8");
        }

        @Test
        void datesTheDocumentInTheReaderSTimeZone() {
            // 23:30 UTC is the next day in Tokyo. A file dated a day off from
            // what the app showed looks like the wrong meeting.
            service.render(USER, MEETING, ExportFormat.MARKDOWN, false, null, "Asia/Tokyo");

            assertThat(renderer.last.meta().get(0)).contains("2026");
            assertThat(renderer.last.meta().get(0)).isNotEqualTo(utcDate());
        }

        @Test
        void fallsBackToUtcRatherThanFailingOnANonsenseZone() {
            service.render(USER, MEETING, ExportFormat.MARKDOWN, false, null, "Middle/Earth");

            assertThat(renderer.last.meta().get(0)).isEqualTo(utcDate());
        }

        private String utcDate() {
            service.render(USER, MEETING, ExportFormat.MARKDOWN, false, null, "UTC");
            return renderer.last.meta().get(0);
        }

        @Test
        void saysHowLongTheMeetingWas() {
            assertThat(exported(false, null).meta()).contains("42 min", "planning");
        }

        @Test
        void belongsToItsOwner() {
            when(meetings.findByIdAndUserId(MEETING, "usr_2")).thenReturn(Optional.empty());

            assertThatThrownBy(() -> service.render("usr_2", MEETING, ExportFormat.PDF, false, null, null))
                    .isInstanceOf(ApiException.class)
                    .hasMessageContaining("not found");
        }
    }

    /* -------------------------------- audio ------------------------------- */

    @Nested
    @DisplayName("the recording")
    class Audio {

        @Test
        void isALinkNamedAfterTheMeeting() {
            when(storage.presignDownload(anyString(), anyString())).thenReturn("https://minio/signed");
            when(storage.presignExpirySeconds()).thenReturn(900L);

            AudioDownloadResponse response = service.audio(USER, MEETING);

            ArgumentCaptor<String> filename = ArgumentCaptor.forClass(String.class);
            verify(storage).presignDownload(eq("audio/mtg_1.mp3"), filename.capture());
            // Signed into the URL, because the browser fetches the object from
            // storage directly and never passes through us to be renamed.
            assertThat(filename.getValue()).isEqualTo("sprint-planning.mp3");
            assertThat(response.url()).isEqualTo("https://minio/signed");
            assertThat(response.expiresInSeconds()).isEqualTo(900L);
        }

        @Test
        void namesTheFileFromWhatWasActuallyUploaded() {
            Meeting video = meeting();
            video.setContentType("video/mp4");
            video.setObjectKey("audio/mtg_1.bin");
            when(meetings.findByIdAndUserId(MEETING, USER)).thenReturn(Optional.of(video));
            when(storage.presignDownload(anyString(), anyString())).thenReturn("https://minio/signed");

            assertThat(service.audio(USER, MEETING).filename()).isEqualTo("sprint-planning.mp4");
        }

        @Test
        void refusesAMeetingThatWasNeverARecording() {
            Meeting document = meeting();
            document.setSourceType(SourceType.DOCUMENT);
            when(meetings.findByIdAndUserId(MEETING, USER)).thenReturn(Optional.of(document));

            assertThatThrownBy(() -> service.audio(USER, MEETING))
                    .isInstanceOf(ApiException.class)
                    .hasMessageContaining("no recording");
            verify(storage, never()).presignDownload(anyString(), anyString());
        }

        @Test
        void refusesAMeetingWhoseAudioIsGone() {
            Meeting gone = meeting();
            gone.setObjectKey(null);
            when(meetings.findByIdAndUserId(MEETING, USER)).thenReturn(Optional.of(gone));

            assertThatThrownBy(() -> service.audio(USER, MEETING))
                    .isInstanceOf(ApiException.class)
                    .hasMessageContaining("no stored recording");
        }
    }

    /* ------------------------------ fixtures ------------------------------ */

    private static Meeting meeting() {
        Meeting m = new Meeting();
        m.setId(MEETING);
        m.setUserId(USER);
        m.setTitle("Sprint planning");
        m.setLanguage("en");
        m.setObjectKey("audio/mtg_1.mp3");
        m.setContentType("audio/mpeg");
        m.setSourceType(SourceType.AUDIO);
        m.setDurationSeconds(2520);
        m.setTags(List.of("planning"));
        // 23:30 UTC, so a reader in Tokyo is already on the following day.
        m.setCreatedAt(Instant.parse("2026-08-16T23:30:00Z"));
        return m;
    }

    private static MeetingSummary summary() {
        MeetingSummary s = new MeetingSummary();
        s.setMeetingId(MEETING);
        s.setShortSummary("We agreed to move billing to Stripe.");
        s.setDetailedSummary("We agreed to move billing to Stripe.");
        s.setKeyPoints(List.of("Stripe by Q4"));
        s.setSections(List.of(
                new SummarySection("decisions", "Decisions", "bullets", "",
                        List.of("Move billing to Stripe"), List.of()),
                new SummarySection("budget", "Budget", "bullets", "", List.of(), List.of())));
        return s;
    }

    private static List<MeetingActionItem> tasks() {
        MeetingActionItem open = new MeetingActionItem();
        open.setId("ai_1");
        open.setMeetingId(MEETING);
        open.setTitle("Finish the JWT validation");
        open.setOwnerName("Priya");
        open.setDueDate("friday");
        open.setStatus("OPEN");

        MeetingActionItem done = new MeetingActionItem();
        done.setId("ai_2");
        done.setMeetingId(MEETING);
        done.setTitle("Draft the rollout plan");
        done.setOwnerName("Marcus");
        done.setStatus("DONE");
        return List.of(open, done);
    }

    /* ---------------------------- what to include ------------------------- */

    @Nested
    @DisplayName("choosing what goes in the file")
    class Choosing {

        @Test
        @DisplayName("the summary can be left out and the transcript kept")
        void transcriptOnly() {
            List<ExportDocument.Block> blocks = exported(options(
                    false, Set.of(), false, true, true, true, ExportOptions.Combine.NONE)).blocks();

            // Somebody exporting to search the words does not want the brief
            // above them, and deleting it by hand is not an export.
            assertThat(headings(blocks)).doesNotContain("Decisions", "Action items");
            assertThat(utterances(blocks)).hasSize(2);
        }

        @Test
        @DisplayName("named sections are the only ones written")
        void sectionSubset() {
            List<ExportDocument.Block> blocks = exported(options(
                    true, Set.of("decisions"), false, false, true, true,
                    ExportOptions.Combine.NONE)).blocks();

            assertThat(headings(blocks)).contains("Decisions").doesNotContain("Budget");
        }

        @Test
        @DisplayName("naming no sections means all of them, not none")
        void noSectionsMeansEverything() {
            List<ExportDocument.Block> blocks = exported(options(
                    true, Set.of(), true, false, true, true, ExportOptions.Combine.NONE)).blocks();

            // The opposite reading turns "I did not touch the section filter"
            // into an empty file.
            assertThat(headings(blocks)).contains("Decisions", "Budget");
        }

        @Test
        @DisplayName("an export of nothing is refused rather than delivered empty")
        void nothingSelected() {
            assertThatThrownBy(() -> exported(options(
                    false, Set.of(), false, false, true, true, ExportOptions.Combine.NONE)))
                    .isInstanceOf(ApiException.class)
                    .hasMessageContaining("at least one");
        }

        @Test
        @DisplayName("the old two-argument call still writes the old file")
        void defaultsAreTheOldBehaviour() {
            // The account-wide data export calls this, and so does any
            // bookmarked download URL.
            List<ExportDocument.Block> blocks = exported(false, null).blocks();

            assertThat(headings(blocks)).contains("Decisions", "Action items");
            assertThat(utterances(blocks)).isEmpty();
        }
    }

    /* --------------------------- transcript layout ------------------------ */

    @Nested
    @DisplayName("how the transcript is laid out")
    class Layout {

        @Test
        @DisplayName("speaker and time are there by default")
        void bothByDefault() {
            List<ExportDocument.Utterance> lines = utterances(exported(options(
                    false, Set.of(), false, true, true, true, ExportOptions.Combine.NONE)).blocks());

            assertThat(lines.get(0).label()).isEqualTo("[0:00] Priya");
        }

        @Test
        @DisplayName("timestamps can be dropped, leaving the names")
        void withoutTimestamps() {
            List<ExportDocument.Utterance> lines = utterances(exported(options(
                    false, Set.of(), false, true, true, false, ExportOptions.Combine.NONE)).blocks());

            assertThat(lines.get(0).label()).isEqualTo("Priya");
        }

        @Test
        @DisplayName("names can be dropped, leaving the times")
        void withoutSpeakers() {
            List<ExportDocument.Utterance> lines = utterances(exported(options(
                    false, Set.of(), false, true, false, true, ExportOptions.Combine.NONE)).blocks());

            assertThat(lines.get(0).label()).isEqualTo("[0:00]");
        }

        @Test
        @DisplayName("with neither, an utterance is bare prose")
        void withNeither() {
            List<ExportDocument.Utterance> lines = utterances(exported(options(
                    false, Set.of(), false, true, false, false, ExportOptions.Combine.NONE)).blocks());

            // The renderers must not print an empty "[]  :" where the label was.
            assertThat(lines.get(0).label()).isEmpty();
            assertThat(lines.get(0).text()).isEqualTo("Right, shall we start?");
        }

        @Test
        @DisplayName("consecutive turns by one speaker become one block")
        void combineSameSpeaker() {
            when(segments.findByMeetingIdOrderByStartTimeAsc(MEETING)).thenReturn(List.of(
                    segment("s1", 0.0, "Priya", "Right, shall we start?"),
                    segment("s2", 4.0, "Priya", "I had one more thing."),
                    segment("s3", 9.0, "Marcus", "Go ahead.")));

            List<ExportDocument.Utterance> lines = utterances(exported(options(
                    false, Set.of(), false, true, true, true,
                    ExportOptions.Combine.SAME_SPEAKER)).blocks());

            // Diarisation splits a turn at every pause, so a minute of one
            // person arrives as a dozen fragments.
            assertThat(lines).hasSize(2);
            assertThat(lines.get(0).text()).isEqualTo("Right, shall we start? I had one more thing.");
            // The first utterance's time, which is when they started talking.
            assertThat(lines.get(0).timecode()).isEqualTo("0:00");
        }

        @Test
        @DisplayName("combining everything gives one unattributed block")
        void combineAll() {
            List<ExportDocument.Utterance> lines = utterances(exported(options(
                    false, Set.of(), false, true, true, true,
                    ExportOptions.Combine.ALL)).blocks());

            assertThat(lines).hasSize(1);
            // No name and no time: attributing the whole meeting to whoever
            // spoke first would be worse than attributing it to nobody.
            assertThat(lines.get(0).label()).isEmpty();
            assertThat(lines.get(0).text())
                    .isEqualTo("Right, shall we start? I'll draft the rollout plan before the demo.");
        }

        @Test
        @DisplayName("merging by speaker does not fold everything when names are hidden")
        void combineBySpeakerWithoutNames() {
            List<ExportDocument.Utterance> lines = utterances(exported(options(
                    false, Set.of(), false, true, false, true,
                    ExportOptions.Combine.SAME_SPEAKER)).blocks());

            // Every label is blank with names off, and comparing blanks would
            // silently turn this into Combine.ALL — which is a different choice
            // the user did not make.
            assertThat(lines).hasSize(2);
        }
    }

    private static List<TranscriptSegment> transcript() {
        return List.of(
                segment("seg_1", 0.0, "Priya", "Right, shall we start?"),
                segment("seg_2", 942.0, "Marcus", "I'll draft the rollout plan before the demo."));
    }

    private static TranscriptSegment segment(String id, double start, String speaker, String text) {
        TranscriptSegment s = new TranscriptSegment();
        s.setId(id);
        s.setMeetingId(MEETING);
        s.setStartTime(start);
        s.setSpeaker(speaker);
        s.setText(text);
        return s;
    }

    /** A translation of the brief, of one task, and of only the first utterance. */
    private static TranslationResponse spanish() {
        return new TranslationResponse(
                "es", "Spanish", false,
                "Acordamos pasar la facturación a Stripe.",
                "Acordamos pasar la facturación a Stripe.",
                List.of("Stripe para el cuarto trimestre"),
                List.of(new SummarySection("decisions", "Decisiones", "bullets", "",
                                List.of("Pasar la facturación a Stripe"), List.of()),
                        new SummarySection("budget", "Presupuesto", "bullets", "",
                                List.of(), List.of())),
                List.of(new TranslationResponse.TranslatedTaskResponse(
                        "ai_1", "Terminar la validación de JWT", "Priya", "viernes", true)),
                List.of(new TranslationResponse.TranslatedSegmentResponse("seg_1", "¿Empezamos?")),
                true, true, false, null, null);
    }

    /* ------------------------------- reading ------------------------------ */

    private static List<String> headings(List<ExportDocument.Block> blocks) {
        return blocks.stream()
                .filter(ExportDocument.Block.Heading.class::isInstance)
                .map(b -> ((ExportDocument.Block.Heading) b).text())
                .toList();
    }

    private static List<ExportDocument.Task> allTasks(ExportDocument doc) {
        return doc.blocks().stream()
                .filter(ExportDocument.Block.Tasks.class::isInstance)
                .flatMap(b -> ((ExportDocument.Block.Tasks) b).items().stream())
                .toList();
    }

    private static ExportDocument.Task firstTask(ExportDocument doc) {
        return allTasks(doc).get(0);
    }

    private static List<ExportDocument.Utterance> utterances(ExportDocument doc) {
        return doc.blocks().stream()
                .filter(ExportDocument.Block.Transcript.class::isInstance)
                .flatMap(b -> ((ExportDocument.Block.Transcript) b).lines().stream())
                .toList();
    }
}
