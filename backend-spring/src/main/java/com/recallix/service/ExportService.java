package com.recallix.service;

import com.recallix.common.ApiException;
import com.recallix.domain.ExportFormat;
import com.recallix.domain.ExportOptions;
import com.recallix.domain.Language;
import com.recallix.domain.SourceType;
import com.recallix.domain.SummarySection;
import com.recallix.dto.AudioDownloadResponse;
import com.recallix.dto.TranslationResponse;
import com.recallix.entity.Meeting;
import com.recallix.entity.MeetingActionItem;
import com.recallix.entity.MeetingSummary;
import com.recallix.entity.TranscriptSegment;
import com.recallix.export.DocumentRenderer;
import com.recallix.export.Downloads;
import com.recallix.export.ExportDocument;
import com.recallix.export.ExportFile;
import com.recallix.export.ExportLabels;
import com.recallix.repository.MeetingActionItemRepository;
import com.recallix.repository.MeetingRepository;
import com.recallix.repository.MeetingSummaryRepository;
import com.recallix.repository.TranscriptSegmentRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.DateTimeException;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.time.format.FormatStyle;
import java.util.ArrayList;
import java.util.EnumMap;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.function.Function;
import java.util.stream.Collectors;

/**
 * A meeting, as a file.
 *
 * <p>All the deciding happens here and none of it happens in the renderers:
 * which parts of the meeting go in, what the empty ones say, how a deadline
 * reads beside its owner, what the file is called. The renderers are handed a
 * finished {@link ExportDocument} and only decide how to draw it — which is what
 * keeps the PDF and the plain text saying the same thing about the same meeting.
 *
 * <p><strong>Exporting a translation does not translate anything.</strong> A
 * download is a GET and a model call is not free, so asking for a language the
 * meeting has not been translated into is a 404 pointing at the endpoint that
 * would do it, not a five-second wait and a surprise on the bill. In practice
 * the reader has already switched the page into that language, which is what
 * created it.
 *
 * <p><strong>The transcript is opt-in.</strong> It is ten to a hundred times the
 * length of everything else, and somebody exporting a PDF to attach to an email
 * usually wants the two pages, not the forty.
 */
@Service
public class ExportService {

    private final MeetingRepository meetings;
    private final MeetingSummaryRepository summaries;
    private final MeetingActionItemRepository actionItems;
    private final TranscriptSegmentRepository segments;
    private final TranslationService translations;
    private final StorageService storage;
    private final Map<ExportFormat, DocumentRenderer> renderers = new EnumMap<>(ExportFormat.class);

    public ExportService(MeetingRepository meetings,
                         MeetingSummaryRepository summaries,
                         MeetingActionItemRepository actionItems,
                         TranscriptSegmentRepository segments,
                         TranslationService translations,
                         StorageService storage,
                         List<DocumentRenderer> renderers) {
        this.meetings = meetings;
        this.summaries = summaries;
        this.actionItems = actionItems;
        this.segments = segments;
        this.translations = translations;
        this.storage = storage;
        renderers.forEach(r -> this.renderers.put(r.format(), r));
    }

    /**
     * Render the meeting.
     *
     * @param rawLanguage a language the meeting has already been translated
     *                    into, or null for the meeting's own words
     * @param zone        the reader's time zone, so the date on the document is
     *                    the date they saw in the app; UTC when unparseable
     */
    @Transactional(readOnly = true)
    public ExportFile render(String userId, String meetingId, ExportFormat format,
                             boolean includeTranscript, String rawLanguage, String zone) {
        return render(userId, meetingId, format,
                ExportOptions.withTranscript(includeTranscript), rawLanguage, zone);
    }

    public ExportFile render(String userId, String meetingId, ExportFormat format,
                             ExportOptions options, String rawLanguage, String zone) {
        Meeting meeting = meetings.findByIdAndUserId(meetingId, userId)
                .orElseThrow(() -> ApiException.notFound("Meeting not found"));

        if (options.empty()) {
            throw ApiException.badRequest("Choose at least one thing to export.");
        }

        TranslationResponse translation = rawLanguage == null || rawLanguage.isBlank()
                ? null
                : translations.get(userId, meetingId, rawLanguage);

        ExportDocument document = assemble(meeting, translation, options, zoneOf(zone));
        DocumentRenderer renderer = renderers.get(format);
        if (renderer == null) {
            throw ApiException.badRequest("No renderer for " + format);
        }

        String filename = Downloads.slug(meeting.getTitle()) + "." + format.extension();
        return new ExportFile(filename, format.mediaType(), renderer.render(document));
    }

    /**
     * A link to the recording itself, named after the meeting.
     *
     * <p>Presigned rather than proxied through the API: the file is tens or
     * hundreds of megabytes, and streaming it through a request thread to add
     * nothing to it would be a denial-of-service tool with a login. The
     * disposition is signed into the URL, which is what makes the browser save
     * {@code sprint-planning.mp3} rather than open an object key.
     */
    @Transactional(readOnly = true)
    public AudioDownloadResponse audio(String userId, String meetingId) {
        Meeting meeting = meetings.findByIdAndUserId(meetingId, userId)
                .orElseThrow(() -> ApiException.notFound("Meeting not found"));

        if (meeting.getSourceType() == SourceType.DOCUMENT) {
            throw ApiException.badRequest("This meeting was imported from a document, so there is no recording.");
        }
        if (meeting.getObjectKey() == null || meeting.getObjectKey().isBlank()) {
            throw ApiException.notFound("This meeting has no stored recording.");
        }

        String filename = Downloads.slug(meeting.getTitle())
                + mediaExtension(meeting.getContentType(), meeting.getObjectKey());
        return new AudioDownloadResponse(
                storage.presignDownload(meeting.getObjectKey(), filename),
                filename,
                meeting.getContentType(),
                storage.presignExpirySeconds());
    }

    /* ------------------------------ assembly ------------------------------ */

    private ExportDocument assemble(Meeting meeting, TranslationResponse translation,
                                    ExportOptions options, ZoneId zone) {
        Language language = translation != null
                ? Language.find(translation.language()).orElse(null)
                : Language.find(meeting.getLanguage()).orElse(null);
        ExportLabels labels = ExportLabels.of(language);
        Locale locale = language == null ? Locale.ENGLISH : Locale.forLanguageTag(language.code());

        MeetingSummary summary = summaries.findFirstByMeetingIdOrderByCreatedAtDesc(meeting.getId())
                .orElse(null);
        List<MeetingActionItem> tasks = actionItems.findByMeetingId(meeting.getId());

        List<ExportDocument.Block> blocks = new ArrayList<>();
        if (options.summary()) {
            blocks.addAll(summaryBlocks(summary, translation, labels, options));
        }
        if (options.actionItems()) {
            blocks.addAll(taskBlocks(tasks, translation, labels));
        }
        if (options.transcript()) {
            blocks.addAll(transcriptBlocks(meeting.getId(), translation, labels, options));
        }

        return new ExportDocument(
                meeting.getTitle(),
                meta(meeting, zone, locale),
                notice(meeting, translation),
                language,
                blocks);
    }

    /**
     * The brief.
     *
     * <p>An empty section keeps its heading and gains a line saying it was not
     * discussed. Dropping it would leave the reader unable to tell a subject
     * that never came up from a template that never asked about it, and in a
     * file — which is a record rather than a screen — that difference is the
     * whole reason somebody kept the file.
     */
    private List<ExportDocument.Block> summaryBlocks(MeetingSummary summary,
                                                     TranslationResponse translation,
                                                     ExportLabels labels,
                                                     ExportOptions options) {
        List<SummarySection> sections = translation != null
                ? orEmpty(translation.sections())
                : (summary == null ? List.of() : orEmpty(summary.getSections()));

        List<ExportDocument.Block> blocks = new ArrayList<>();
        if (!sections.isEmpty()) {
            for (SummarySection section : sections) {
                // Filtered by the caller's choice, but only when they made one:
                // a request naming no sections wants the whole brief, not an
                // empty one. See ExportOptions.wants.
                if (!options.wants(section.key())) {
                    continue;
                }
                blocks.add(new ExportDocument.Block.Heading(1, section.title()));
                switch (section.kind() == null ? "" : section.kind()) {
                    case "prose" -> blocks.add(section.text() == null || section.text().isBlank()
                            ? new ExportDocument.Block.Aside(labels.notDiscussed())
                            : new ExportDocument.Block.Prose(section.text().strip()));
                    case "outline" -> {
                        if (section.groupsOrEmpty().isEmpty()) {
                            blocks.add(new ExportDocument.Block.Aside(labels.notDiscussed()));
                        }
                        for (SummarySection.OutlineGroup group : section.groupsOrEmpty()) {
                            blocks.add(new ExportDocument.Block.Heading(2, group.heading()));
                            blocks.add(new ExportDocument.Block.Bullets(group.bulletsOrEmpty()));
                        }
                    }
                    default -> blocks.add(section.bulletsOrEmpty().isEmpty()
                            ? new ExportDocument.Block.Aside(labels.notDiscussed())
                            : new ExportDocument.Block.Bullets(section.bulletsOrEmpty()));
                }
            }
            return blocks;
        }

        // No template: the flat summary, which is all a pre-template meeting has.
        String shortSummary = translation != null ? translation.shortSummary()
                : (summary == null ? null : summary.getShortSummary());
        String detailed = translation != null ? translation.detailedSummary()
                : (summary == null ? null : summary.getDetailedSummary());
        List<String> keyPoints = translation != null ? orEmpty(translation.keyPoints())
                : (summary == null ? List.of() : orEmpty(summary.getKeyPoints()));

        if (shortSummary != null && !shortSummary.isBlank()) {
            blocks.add(new ExportDocument.Block.Heading(1, labels.summary()));
            blocks.add(new ExportDocument.Block.Prose(shortSummary.strip()));
        }
        if (detailed != null && !detailed.isBlank() && !detailed.equals(shortSummary)) {
            blocks.add(new ExportDocument.Block.Prose(detailed.strip()));
        }
        if (!keyPoints.isEmpty()) {
            blocks.add(new ExportDocument.Block.Heading(1, labels.keyPoints()));
            blocks.add(new ExportDocument.Block.Bullets(keyPoints));
        }
        return blocks;
    }

    /**
     * The action items, in the language being read.
     *
     * <p>The owner, the deadline and the priority are joined here rather than in
     * each renderer. The deadline keeps the words that were said — "before the
     * demo" is what somebody committed to, and a file that silently replaced it
     * with a date would be putting a promise in their mouth they never made.
     */
    private List<ExportDocument.Block> taskBlocks(List<MeetingActionItem> tasks,
                                                  TranslationResponse translation,
                                                  ExportLabels labels) {
        if (tasks.isEmpty()) {
            return List.of();
        }
        Map<String, TranslationResponse.TranslatedTaskResponse> translated = translation == null
                ? Map.of()
                : orEmpty(translation.actionItems()).stream()
                        .collect(Collectors.toMap(TranslationResponse.TranslatedTaskResponse::id,
                                Function.identity(), (a, b) -> a, HashMap::new));

        List<ExportDocument.Task> items = new ArrayList<>(tasks.size());
        for (MeetingActionItem task : tasks) {
            TranslationResponse.TranslatedTaskResponse t = translated.get(task.getId());
            String title = t == null ? task.getTitle() : t.title();
            String due = t == null ? task.getDueDate() : t.dueDate();

            List<String> detail = new ArrayList<>(3);
            if (notBlank(task.getOwnerName())) {
                detail.add(task.getOwnerName());
            }
            if (notBlank(due)) {
                detail.add("due " + due);
            }
            if (notBlank(task.getPriority())) {
                detail.add(task.getPriority());
            }
            items.add(new ExportDocument.Task(task.isDone(), title, String.join(" · ", detail)));
        }
        return List.of(new ExportDocument.Block.Heading(1, labels.actionItems()),
                new ExportDocument.Block.Tasks(items));
    }

    /**
     * The transcript.
     *
     * <p>Timing and speaker come from the live segments even when a translation
     * is being read, and only the words come from the translation: a speaker
     * renamed after the meeting was translated is renamed in every language at
     * once rather than in none of them. A line recorded since the translation
     * was made is exported in the original, because a gap in a transcript reads
     * as a silence in the room.
     */
    private List<ExportDocument.Block> transcriptBlocks(String meetingId,
                                                        TranslationResponse translation,
                                                        ExportLabels labels,
                                                        ExportOptions options) {
        List<TranscriptSegment> lines = segments.findByMeetingIdOrderByStartTimeAsc(meetingId);
        if (lines.isEmpty()) {
            return List.of();
        }
        Map<String, String> words = translation == null
                ? Map.of()
                : orEmpty(translation.segments()).stream()
                        .collect(Collectors.toMap(TranslationResponse.TranslatedSegmentResponse::id,
                                TranslationResponse.TranslatedSegmentResponse::text,
                                (a, b) -> a, HashMap::new));

        List<ExportDocument.Utterance> utterances = new ArrayList<>(lines.size());
        for (TranscriptSegment line : lines) {
            String speaker = line.getSpeaker() == null || line.getSpeaker().isBlank()
                    ? "Speaker" : line.getSpeaker();
            String text = words.getOrDefault(
                    line.getId(), line.getText() == null ? "" : line.getText());
            utterances.add(new ExportDocument.Utterance(
                    // Suppressed by emptying the field rather than by a flag on
                    // the block: a renderer that has to ask what to draw ends up
                    // with four copies of the same decision, one per format.
                    options.timestamps() ? timecode(line.getStartTime()) : "",
                    options.speakerNames() ? speaker : "",
                    text));
        }

        return List.of(new ExportDocument.Block.Heading(1, labels.transcript()),
                new ExportDocument.Block.Transcript(combine(utterances, options.combine())));
    }

    /**
     * Merge consecutive utterances according to the caller's choice.
     *
     * <p>Worth having because diarisation splits a turn at every pause: one
     * person talking for a minute arrives as a dozen fragments, each with its
     * own timestamp and name, and a transcript read as a document rather than
     * scrubbed through is far harder to follow that way than it needs to be.
     *
     * <p>A merged block keeps the timestamp and speaker of its <em>first</em>
     * utterance, which is when that person started talking — the one moment in
     * the block a reader might want to jump to.
     */
    private static List<ExportDocument.Utterance> combine(List<ExportDocument.Utterance> lines,
                                                          ExportOptions.Combine mode) {
        if (mode == ExportOptions.Combine.NONE || lines.size() < 2) {
            return lines;
        }
        if (mode == ExportOptions.Combine.ALL) {
            String all = lines.stream()
                    .map(ExportDocument.Utterance::text)
                    .filter(t -> t != null && !t.isBlank())
                    .collect(Collectors.joining(" "));
            // No speaker and no time: this is one block of prose by
            // construction, and labelling it with the first speaker's name
            // would attribute the whole meeting to whoever opened it.
            return List.of(new ExportDocument.Utterance("", "", all));
        }

        List<ExportDocument.Utterance> merged = new ArrayList<>();
        for (ExportDocument.Utterance line : lines) {
            ExportDocument.Utterance last = merged.isEmpty() ? null : merged.get(merged.size() - 1);
            // Compared on the speaker as it will be printed. With names
            // suppressed every label is blank, so this would fold the entire
            // transcript into one block — which is the other mode, chosen
            // deliberately, not something to arrive at by accident.
            boolean sameSpeaker = last != null
                    && !last.speaker().isBlank()
                    && last.speaker().equals(line.speaker());
            if (sameSpeaker) {
                merged.set(merged.size() - 1, new ExportDocument.Utterance(
                        last.timecode(), last.speaker(),
                        (last.text() + " " + line.text()).strip()));
            } else {
                merged.add(line);
            }
        }
        return merged;
    }

    /* ------------------------------- details ------------------------------ */

    private static List<String> meta(Meeting meeting, ZoneId zone, Locale locale) {
        List<String> meta = new ArrayList<>(3);
        if (meeting.getCreatedAt() != null) {
            meta.add(DateTimeFormatter
                    .ofLocalizedDateTime(FormatStyle.LONG, FormatStyle.SHORT)
                    .withLocale(locale)
                    .withZone(zone)
                    .format(meeting.getCreatedAt()));
        }
        if (meeting.getDurationSeconds() != null && meeting.getDurationSeconds() > 0) {
            meta.add(length(meeting.getDurationSeconds()));
        }
        if (meeting.getTags() != null && !meeting.getTags().isEmpty()) {
            meta.add(String.join(", ", meeting.getTags()));
        }
        return meta;
    }

    /**
     * The line that keeps a translated export honest.
     *
     * <p>Left in English on purpose. It is a note from Recallix about the
     * document rather than part of the meeting, and somebody who has forgotten
     * they are reading a translation is exactly the person who is about to quote
     * a translated sentence as a thing that was said aloud.
     */
    private static String notice(Meeting meeting, TranslationResponse translation) {
        if (translation == null) {
            return null;
        }
        String source = Language.find(meeting.getLanguage())
                .map(Language::englishName)
                .orElse(null);
        return "Translated into " + translation.languageName()
                + (source == null ? "." : ". The recording is in " + source + ".");
    }

    private static String length(int seconds) {
        int minutes = Math.round(seconds / 60f);
        return minutes < 60 ? minutes + " min" : (minutes / 60) + "h " + (minutes % 60) + "m";
    }

    private static String timecode(Double start) {
        int total = start == null ? 0 : (int) Math.floor(start);
        int hours = total / 3600;
        int minutes = (total % 3600) / 60;
        int secs = total % 60;
        return hours > 0
                ? String.format("%d:%02d:%02d", hours, minutes, secs)
                : String.format("%d:%02d", minutes, secs);
    }

    /** The reader's zone, or UTC — a bad one is not worth failing a download over. */
    private static ZoneId zoneOf(String zone) {
        if (zone == null || zone.isBlank()) {
            return ZoneOffset.UTC;
        }
        try {
            return ZoneId.of(zone.trim());
        } catch (DateTimeException e) {
            return ZoneOffset.UTC;
        }
    }

    /** {@code .mp3}, from what was declared on upload or failing that the key. */
    private static String mediaExtension(String contentType, String objectKey) {
        String type = contentType == null ? "" : contentType.toLowerCase(Locale.ROOT).split(";")[0].trim();
        String known = switch (type) {
            case "audio/mpeg", "audio/mp3" -> ".mp3";
            case "audio/wav", "audio/x-wav", "audio/wave" -> ".wav";
            case "audio/mp4", "audio/x-m4a" -> ".m4a";
            case "audio/aac" -> ".aac";
            case "audio/ogg", "audio/opus" -> ".ogg";
            case "audio/flac", "audio/x-flac" -> ".flac";
            case "audio/webm" -> ".webm";
            case "video/mp4" -> ".mp4";
            case "video/webm" -> ".webm";
            case "video/quicktime" -> ".mov";
            default -> "";
        };
        if (!known.isEmpty()) {
            return known;
        }
        int dot = objectKey.lastIndexOf('.');
        String fromKey = dot < 0 ? "" : objectKey.substring(dot).toLowerCase(Locale.ROOT);
        return fromKey.matches("\\.[a-z0-9]{2,5}") ? fromKey : ".audio";
    }

    private static boolean notBlank(String value) {
        return value != null && !value.isBlank();
    }

    private static <T> List<T> orEmpty(List<T> list) {
        return list == null ? List.of() : list;
    }
}
