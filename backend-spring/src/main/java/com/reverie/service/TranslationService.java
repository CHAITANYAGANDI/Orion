package com.reverie.service;

import com.reverie.common.ApiException;
import com.reverie.common.IdGenerator;
import com.reverie.domain.Language;
import com.reverie.domain.SummarySection;
import com.reverie.domain.TranslatedLine;
import com.reverie.domain.TranslatedTask;
import com.reverie.dto.TranslationResponse;
import com.reverie.entity.MeetingActionItem;
import com.reverie.entity.MeetingSummary;
import com.reverie.entity.MeetingTranslation;
import com.reverie.entity.TranscriptSegment;
import com.reverie.repository.MeetingActionItemRepository;
import com.reverie.repository.MeetingRepository;
import com.reverie.repository.MeetingSummaryRepository;
import com.reverie.repository.MeetingTranslationRepository;
import com.reverie.repository.TranscriptSegmentRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * A whole meeting in another language.
 *
 * <p>Three decisions shape everything here.
 *
 * <p><strong>The brief and the transcript are translated separately.</strong>
 * One is a few hundred words and the other is several thousand, so translating
 * both whenever somebody picks a language would spend most of the cost on the
 * part most readers never open. Choosing a language does the brief; the
 * transcript is asked for.
 *
 * <p><strong>Everything is translated in one batch per part.</strong> The
 * summary, its sections, the key points and the action items go into a single
 * list of lines and come back as a single list — see {@link Batch}. The
 * alternative, a call per field, was what the old implementation did for three
 * fields and it does not scale to a templated brief with six sections.
 *
 * <p><strong>Nothing that claims to be verbatim is translated.</strong>
 * Quotations stay in the original language, and a task whose wording has been
 * corrected since is shown in the original rather than as a translation of the
 * sentence it used to be.
 */
@Service
public class TranslationService {

    private static final Logger log = LoggerFactory.getLogger(TranslationService.class);

    private final MeetingRepository meetings;
    private final MeetingSummaryRepository summaries;
    private final MeetingActionItemRepository actionItems;
    private final TranscriptSegmentRepository segments;
    private final MeetingTranslationRepository translations;
    private final AiClient ai;
    /** Only to refuse a translation that has not been paid for. See {@link #translate}. */
    private final UsageLimitService usage;

    public TranslationService(MeetingRepository meetings,
                              MeetingSummaryRepository summaries,
                              MeetingActionItemRepository actionItems,
                              TranscriptSegmentRepository segments,
                              MeetingTranslationRepository translations,
                              AiClient ai,
                              UsageLimitService usage) {
        this.usage = usage;
        this.meetings = meetings;
        this.summaries = summaries;
        this.actionItems = actionItems;
        this.segments = segments;
        this.translations = translations;
        this.ai = ai;
    }

    /** Which languages this meeting has already been translated into. */
    @Transactional(readOnly = true)
    public List<TranslationResponse.Available> available(String userId, String meetingId) {
        requireMeeting(userId, meetingId);
        return translations.findByMeetingIdOrderByLanguageAsc(meetingId).stream()
                .map(TranslationResponse.Available::from)
                .toList();
    }

    @Transactional(readOnly = true)
    public TranslationResponse get(String userId, String meetingId, String rawLanguage) {
        requireMeeting(userId, meetingId);
        Language language = require(rawLanguage);
        MeetingTranslation stored = translations
                .findByMeetingIdAndLanguage(meetingId, language.code())
                .orElseThrow(() -> ApiException.notFound("This meeting has not been translated into "
                        + language.englishName()));
        return render(meetingId, stored);
    }

    /**
     * Translate the meeting, or refresh a translation the meeting has outgrown.
     *
     * <p>Idempotent by design: asking again for a language already translated
     * returns what is stored without spending a model call. The exceptions are a
     * stale translation, and a request for the transcript when only the brief
     * has been done — both of which are real work that has not happened yet.
     */
    @Transactional
    public TranslationResponse translate(String userId, String meetingId,
                                         String rawLanguage, boolean includeTranscript) {
        requireMeeting(userId, meetingId);
        Language language = require(rawLanguage);

        MeetingTranslation existing = translations
                .findByMeetingIdAndLanguage(meetingId, language.code())
                .orElse(null);

        // Refused only when it would cost something, and refused before
        // anything is written.
        //
        // A language already translated comes back from storage without a model
        // call, and that has to keep working: the work is paid for and the
        // result is the user's. Closing it would be taking a page away rather
        // than declining to write a new one -- which is the line the whole
        // allowance is drawn along. See UsageLimitService.
        if (wouldAskTheModel(existing, includeTranscript)) {
            usage.requireAiOrThrow(userId, UsageLimitService.AiFeature.TRANSLATION);
        }

        MeetingTranslation stored = existing != null ? existing : translations.save(blank(meetingId, language));

        boolean refresh = stored.isStale();
        if (refresh && !includeTranscript) {
            // The stored transcript describes text that has changed. Dropping it
            // rather than keeping it is what lets `stale` be cleared honestly:
            // a translation that is half up to date has no truthful flag.
            stored.setSegments(new ArrayList<>());
            stored.setTranscriptTranslatedAt(null);
        }

        if (refresh || !stored.hasBrief()) {
            translateBrief(meetingId, language, stored);
        }
        if (includeTranscript && (refresh || !stored.hasTranscript())) {
            translateTranscript(meetingId, language, stored);
        }
        stored.setStale(false);

        return render(meetingId, stored);
    }

    /**
     * Whether serving this request means asking the model for something new.
     *
     * <p>Deliberately the same four conditions the two calls below are guarded
     * by, read one step earlier. They have to agree: answering yes here and no
     * there refuses a request that would have cost nothing, and answering no
     * here and yes there lets a spent account buy another translation.
     */
    private static boolean wouldAskTheModel(MeetingTranslation stored, boolean includeTranscript) {
        if (stored == null) return true;
        if (stored.isStale()) return true;
        if (!stored.hasBrief()) return true;
        return includeTranscript && !stored.hasTranscript();
    }

    private static MeetingTranslation blank(String meetingId, Language language) {
        MeetingTranslation fresh = new MeetingTranslation();
        fresh.setId(IdGenerator.translation());
        fresh.setMeetingId(meetingId);
        fresh.setLanguage(language.code());
        return fresh;
    }

    @Transactional
    public void delete(String userId, String meetingId, String rawLanguage) {
        requireMeeting(userId, meetingId);
        Language language = require(rawLanguage);
        translations.findByMeetingIdAndLanguage(meetingId, language.code())
                .ifPresent(translations::delete);
    }

    /* ------------------------------ the work ------------------------------ */

    /**
     * Summary, sections and action items, in one round of calls.
     *
     * <p>The prose is added to the same batch as the bullets: a paragraph is
     * split on its newlines going in and rejoined coming out, so a multi-line
     * detailed summary keeps its shape without needing a call of its own.
     */
    private void translateBrief(String meetingId, Language language, MeetingTranslation stored) {
        MeetingSummary summary = summaries.findFirstByMeetingIdOrderByCreatedAtDesc(meetingId)
                .orElseThrow(() -> ApiException.notFound("Summary not ready"));
        List<MeetingActionItem> tasks = actionItems.findByMeetingId(meetingId);

        Batch batch = new Batch();
        int shortId = batch.add(summary.getShortSummary());
        int detailedId = batch.add(summary.getDetailedSummary());

        List<Integer> keyPointIds = new ArrayList<>();
        for (String point : orEmpty(summary.getKeyPoints())) {
            keyPointIds.add(batch.add(point));
        }

        List<SectionSlots> sectionSlots = new ArrayList<>();
        for (SummarySection section : orEmpty(summary.getSections())) {
            sectionSlots.add(SectionSlots.of(section, batch));
        }

        List<TaskSlots> taskSlots = new ArrayList<>();
        for (MeetingActionItem task : tasks) {
            taskSlots.add(new TaskSlots(task, batch.add(task.getTitle()), batch.add(task.getDueDate())));
        }

        batch.run(ai, language);

        stored.setShortSummary(batch.get(shortId));
        stored.setDetailedSummary(batch.get(detailedId));
        stored.setKeyPoints(keyPointIds.stream().map(batch::get).toList());
        stored.setSections(sectionSlots.stream().map(s -> s.rebuild(batch)).toList());
        stored.setActionItems(taskSlots.stream().map(s -> s.rebuild(batch)).toList());
        stored.setBriefTranslatedAt(Instant.now());

        log.info("Translated the brief of {} into {} ({} lines).",
                meetingId, language.code(), batch.size());
    }

    private void translateTranscript(String meetingId, Language language, MeetingTranslation stored) {
        List<TranscriptSegment> lines = segments.findByMeetingIdOrderByStartTimeAsc(meetingId);
        if (lines.isEmpty()) {
            throw ApiException.notFound("This meeting has no transcript to translate");
        }

        List<String> source = lines.stream()
                .map(s -> s.getText() == null ? "" : s.getText())
                .toList();
        List<String> translated = ai.translateLines(source, language.englishName());

        List<TranslatedLine> out = new ArrayList<>(lines.size());
        for (int i = 0; i < lines.size(); i++) {
            out.add(new TranslatedLine(lines.get(i).getId(), translated.get(i)));
        }
        stored.setSegments(out);
        stored.setTranscriptTranslatedAt(Instant.now());

        log.info("Translated {} utterance(s) of {} into {}.", out.size(), meetingId, language.code());
    }

    /* ------------------------------ rendering ----------------------------- */

    /**
     * Join the stored translation to the live meeting.
     *
     * <p>Read through the current action items rather than served straight from
     * the row, so a task added since — or retitled since — is shown as it is now
     * rather than omitted or shown as it used to be.
     */
    private TranslationResponse render(String meetingId, MeetingTranslation stored) {
        Map<String, TranslatedTask> byId = new HashMap<>();
        for (TranslatedTask task : orEmpty(stored.getActionItems())) {
            byId.put(task.id(), task);
        }

        List<TranslationResponse.TranslatedTaskResponse> tasks = new ArrayList<>();
        for (MeetingActionItem live : actionItems.findByMeetingId(meetingId)) {
            TranslatedTask t = byId.get(live.getId());
            boolean usable = t != null && live.getTitle().equals(t.sourceTitle());
            tasks.add(new TranslationResponse.TranslatedTaskResponse(
                    live.getId(),
                    usable ? t.title() : live.getTitle(),
                    live.getOwnerName(),
                    usable ? t.dueDate() : live.getDueDate(),
                    usable));
        }

        List<TranslationResponse.TranslatedSegmentResponse> lines =
                orEmpty(stored.getSegments()).stream()
                        .map(s -> new TranslationResponse.TranslatedSegmentResponse(s.id(), s.text()))
                        .toList();

        return TranslationResponse.from(stored, tasks, lines);
    }

    /* ------------------------------- helpers ------------------------------ */

    private void requireMeeting(String userId, String meetingId) {
        meetings.findByIdAndUserId(meetingId, userId)
                .orElseThrow(() -> ApiException.notFound("Meeting not found"));
    }

    /**
     * The target language, or a 400 naming what is on offer.
     *
     * <p>Refused rather than passed through to the model. "Klingon" would come
     * back as something, and a translation into a language nobody asked for is
     * indistinguishable from a bug at the point somebody reads it.
     */
    private static Language require(String raw) {
        return Language.find(raw).orElseThrow(() -> ApiException.badRequest(
                "Unsupported language. Reverie works in: "
                        + String.join(", ", Language.all().stream().map(Language::englishName).toList())));
    }

    private static <T> List<T> orEmpty(List<T> list) {
        return list == null ? List.of() : list;
    }

    /**
     * A pile of strings to translate together, and a way to get them back.
     *
     * <p>Everything in a brief — a paragraph, a bullet, a heading, a task title
     * — goes in here, is translated as one list, and is read back out by the
     * token the caller was given. Multi-line values are split on their newlines
     * on the way in and rejoined on the way out, so prose and bullets can share
     * one call without the prose breaking the line alignment everything else
     * depends on.
     *
     * <p>Before {@link #run} it holds the source text, so reading a slot early
     * returns the original. That is also what happens when translation fails:
     * {@code AiClient.translateLines} returns the source it was given, and the
     * page shows untranslated text rather than nothing.
     */
    static final class Batch {

        private final List<String> lines = new ArrayList<>();
        /** One {start, length} per added value, indexed by the token handed out. */
        private final List<int[]> slots = new ArrayList<>();

        int add(String value) {
            String[] parts = (value == null ? "" : value).split("\n", -1);
            slots.add(new int[]{lines.size(), parts.length});
            lines.addAll(List.of(parts));
            return slots.size() - 1;
        }

        int size() {
            return lines.size();
        }

        void run(AiClient ai, Language language) {
            if (lines.isEmpty()) {
                return;
            }
            // The English name, not the code: "Translate into es" is a worse
            // instruction to a language model than "Translate into Spanish".
            List<String> translated = ai.translateLines(List.copyOf(lines), language.englishName());
            if (translated.size() != lines.size()) {
                // Already guarded twice downstream; a third check here because
                // the cost of being wrong is every field of the brief shifted
                // by one, which reads as nonsense rather than as a failure.
                log.warn("Translation returned {} lines for {}; keeping the original.",
                        translated.size(), lines.size());
                return;
            }
            for (int i = 0; i < translated.size(); i++) {
                lines.set(i, translated.get(i));
            }
        }

        String get(int token) {
            int[] slot = slots.get(token);
            return String.join("\n", lines.subList(slot[0], slot[0] + slot[1]));
        }

        List<String> getAll(List<Integer> tokens) {
            return tokens.stream().map(this::get).toList();
        }
    }

    /** Where each part of a section went in the batch, so it can be put back together. */
    private record SectionSlots(
            SummarySection source,
            int title,
            int text,
            List<Integer> bullets,
            List<GroupSlots> groups
    ) {
        static SectionSlots of(SummarySection section, Batch batch) {
            int title = batch.add(section.title());
            int text = batch.add(section.text());
            List<Integer> bullets = new ArrayList<>();
            for (String bullet : section.bulletsOrEmpty()) {
                bullets.add(batch.add(bullet));
            }
            List<GroupSlots> groups = new ArrayList<>();
            for (SummarySection.OutlineGroup group : section.groupsOrEmpty()) {
                List<Integer> groupBullets = new ArrayList<>();
                for (String bullet : group.bulletsOrEmpty()) {
                    groupBullets.add(batch.add(bullet));
                }
                // Carried through the slot rather than translated: it is a
                // position in the recording, not prose.
                groups.add(new GroupSlots(
                        batch.add(group.heading()), groupBullets, group.startSeconds()));
            }
            return new SectionSlots(section, title, text, bullets, groups);
        }

        SummarySection rebuild(Batch batch) {
            // `key` and `kind` are identifiers the UI switches on, not prose.
            // Translating them would render every section as an unknown shape.
            return new SummarySection(
                    source.key(),
                    batch.get(title),
                    source.kind(),
                    batch.get(text),
                    batch.getAll(bullets),
                    groups.stream()
                            // The timestamp survives translation untouched: it
                            // is a position in the recording, and the recording
                            // is in one language whatever the brief is read in.
                            .map(g -> new SummarySection.OutlineGroup(
                                    batch.get(g.heading()),
                                    batch.getAll(g.bullets()),
                                    g.startSeconds()))
                            .toList());
        }
    }

    private record GroupSlots(int heading, List<Integer> bullets, Double startSeconds) {
    }

    /** Titles and spoken deadlines are translated; a person's name is not. */
    private record TaskSlots(MeetingActionItem source, int title, int dueDate) {
        TranslatedTask rebuild(Batch batch) {
            return new TranslatedTask(
                    source.getId(),
                    source.getTitle(),
                    batch.get(title),
                    source.getOwnerName(),
                    source.getDueDate() == null ? null : batch.get(dueDate));
        }
    }
}
