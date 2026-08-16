package com.recallix.service;

import com.recallix.common.DueDates;
import com.recallix.common.IdGenerator;
import com.recallix.common.SentenceLocator;
import com.recallix.domain.MeetingStatus;
import com.recallix.dto.StatusEvent;
import com.recallix.dto.callback.AiActionItem;
import com.recallix.dto.callback.AiInsight;
import com.recallix.dto.callback.AiSegment;
import com.recallix.dto.callback.MeetingBriefResult;
import com.recallix.dto.callback.StatusCallbackRequest;
import com.recallix.entity.Meeting;
import com.recallix.entity.MeetingActionItem;
import com.recallix.entity.MeetingInsight;
import com.recallix.entity.MeetingSummary;
import com.recallix.entity.MeetingTranscript;
import com.recallix.entity.TranscriptSegment;
import com.recallix.entity.UserEntity;
import com.recallix.event.MeetingReadyEvent;
import com.recallix.repository.MeetingActionItemRepository;
import com.recallix.repository.MeetingInsightRepository;
import com.recallix.repository.MeetingRepository;
import com.recallix.repository.MeetingSummaryRepository;
import com.recallix.repository.MeetingTranscriptRepository;
import com.recallix.repository.TranscriptSegmentRepository;
import com.recallix.repository.UserRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;

/**
 * Handles internal callbacks from the FastAPI worker: relays status updates to
 * the frontend and persists the final {@link MeetingBriefResult}. Idempotent —
 * re-running the pipeline (reprocess) replaces prior results.
 */
@Service
public class CallbackService {

    private static final Logger log = LoggerFactory.getLogger(CallbackService.class);

    private final MeetingRepository meetings;
    private final MeetingTranscriptRepository transcripts;
    private final TranscriptSegmentRepository segments;
    private final MeetingSummaryRepository summaries;
    private final MeetingActionItemRepository actionItems;
    private final MeetingInsightRepository insights;
    private final StatusPublisher statusPublisher;
    private final UsageLimitService usage;
    private final ApplicationEventPublisher events;
    private final NotificationService notifications;
    private final UserRepository users;

    public CallbackService(MeetingRepository meetings,
                           MeetingTranscriptRepository transcripts,
                           TranscriptSegmentRepository segments,
                           MeetingSummaryRepository summaries,
                           MeetingActionItemRepository actionItems,
                           MeetingInsightRepository insights,
                           StatusPublisher statusPublisher,
                           UsageLimitService usage,
                           ApplicationEventPublisher events,
                           NotificationService notifications,
                           UserRepository users) {
        this.notifications = notifications;
        this.users = users;
        this.meetings = meetings;
        this.transcripts = transcripts;
        this.segments = segments;
        this.summaries = summaries;
        this.actionItems = actionItems;
        this.insights = insights;
        this.statusPublisher = statusPublisher;
        this.usage = usage;
        this.events = events;
    }

    @Transactional
    public void applyStatus(String meetingId, StatusCallbackRequest req) {
        MeetingStatus status = parseStatus(req.status());
        meetings.findById(meetingId).ifPresent(m -> {
            if (status != null) {
                m.setStatus(status);
            }
            if (status == MeetingStatus.FAILED) {
                m.setErrorMessage(req.message());
                // The one people most need. An upload that failed while the tab
                // was closed is otherwise indistinguishable from one still
                // running, for as long as nobody goes looking.
                notifications.processingFailed(m, req.message());
            }
            // READY is the worker's last word: the brief is persisted AND the
            // transcript is indexed into pgvector. Only now can Meeting Memory
            // retrieve evidence from this meeting, so this is where it fires.
            if (status == MeetingStatus.READY) {
                events.publishEvent(new MeetingReadyEvent(meetingId, m.getUserId()));
            }
        });
        int progress = req.progress() == null ? 0 : req.progress();
        statusPublisher.publish(new StatusEvent(
                meetingId,
                status == null ? MeetingStatus.TRANSCRIBING : status,
                progress,
                req.message() == null ? "" : req.message()));
    }

    @Transactional
    public void applyResult(String meetingId, MeetingBriefResult result) {
        Meeting meeting = meetings.findById(meetingId).orElse(null);
        if (meeting == null) {
            log.warn("Result callback for unknown meeting {}", meetingId);
            return;
        }

        replaceTranscript(meetingId, result);
        replaceSegments(meetingId, result.segmentsOrEmpty());
        replaceSummary(meetingId, result);
        replaceActionItems(meeting, result.actionItemsOrEmpty(), result.segmentsOrEmpty());
        replaceInsights(meeting, result.insightsOrEmpty());

        meeting.setStatus(MeetingStatus.READY);
        meeting.setErrorMessage(null);
        // Denormalised from the transcript so list views don't need a join.
        if (result.language() != null && !result.language().isBlank()) {
            meeting.setLanguage(result.language().trim());
        }

        // A URL import starts with a placeholder title and no duration, because
        // neither is known until the worker has fetched the video. Only the
        // placeholder is overwritten — a title the user chose survives both the
        // first run and any later reprocess.
        if (result.title() != null && !result.title().isBlank()
                && MeetingService.IMPORT_PLACEHOLDER_TITLE.equals(meeting.getTitle())) {
            meeting.setTitle(result.title().trim());
        }
        if (result.durationSeconds() != null && result.durationSeconds() > 0
                && meeting.getDurationSeconds() == null) {
            meeting.setDurationSeconds(result.durationSeconds());
        }

        if (meeting.getDurationSeconds() != null && meeting.getDurationSeconds() > 0) {
            usage.addAiMinutes(meeting.getUserId(), Math.round(meeting.getDurationSeconds() / 60.0f));
        }
        announce(meeting, result);
        log.info("Persisted brief for meeting {} ({} actions).", meetingId, result.actionItemsOrEmpty().size());
    }

    /**
     * Say what landed.
     *
     * <p><strong>Why this is not two notifications.</strong> The worker returns
     * the transcript, the summary and the action items in a single result
     * callback, so in this pipeline "transcript ready" and "summary ready" are
     * the same instant and the same link. Both kinds exist because they are
     * genuinely different events — a transcript can land without notes, and a
     * summary can be rewritten later without a new transcript — but firing both
     * for one arrival would be a product ringing twice to say one thing. So the
     * notes win when there are notes, because notes imply a transcript.
     *
     * <p>Being assigned work is separate and worth its own line: it is about
     * you rather than about the meeting, and it is the one that has somebody
     * open the page rather than nod at it.
     */
    private void announce(Meeting meeting, MeetingBriefResult result) {
        boolean hasSummary = result.shortSummary() != null && !result.shortSummary().isBlank();
        if (hasSummary) {
            notifications.summaryReady(meeting);
        } else if (!result.segmentsOrEmpty().isEmpty()) {
            notifications.transcriptReady(meeting);
        }
        notifications.mentionedIn(meeting, assignedToMe(meeting));
    }

    /**
     * The action items this meeting just gave to the person who owns it.
     *
     * <p>Matched on the display name, which is the only fact relating an
     * account to a "Priya" in a transcript. No display name means no match and
     * no notification — a guess would be worse than silence, because the whole
     * value of this one is that it is about you.
     */
    private List<MeetingActionItem> assignedToMe(Meeting meeting) {
        String me = users.findById(meeting.getUserId())
                .map(UserEntity::getDisplayName)
                .filter(n -> n != null && !n.isBlank())
                .map(n -> n.trim().toLowerCase(Locale.ROOT))
                .orElse(null);
        if (me == null) {
            return List.of();
        }
        return actionItems.findByMeetingId(meeting.getId()).stream()
                .filter(a -> a.getOwnerName() != null
                        && a.getOwnerName().trim().toLowerCase(Locale.ROOT).equals(me))
                .toList();
    }

    // --- replace helpers (idempotent) --------------------------------------- //

    private void replaceTranscript(String meetingId, MeetingBriefResult result) {
        transcripts.deleteByMeetingId(meetingId);
        MeetingTranscript t = new MeetingTranscript();
        t.setId(IdGenerator.transcript());
        t.setMeetingId(meetingId);
        t.setTranscriptText(result.transcript() == null ? "" : result.transcript());
        t.setLanguage(result.language());
        transcripts.save(t);
    }

    private void replaceSegments(String meetingId, List<AiSegment> segs) {
        segments.deleteByMeetingId(meetingId);
        for (AiSegment s : segs) {
            TranscriptSegment seg = new TranscriptSegment();
            seg.setId(IdGenerator.segment());
            seg.setMeetingId(meetingId);
            seg.setStartTime(s.start());
            seg.setEndTime(s.end());
            seg.setSpeaker(s.speaker());
            seg.setText(s.text());
            seg.setWords(s.wordsOrEmpty());
            seg.setLanguage(s.language());
            segments.save(seg);
        }
    }

    private void replaceSummary(String meetingId, MeetingBriefResult result) {
        summaries.deleteByMeetingId(meetingId);
        MeetingSummary s = new MeetingSummary();
        s.setId(IdGenerator.summary());
        s.setMeetingId(meetingId);
        s.setShortSummary(result.shortSummary());
        s.setDetailedSummary(result.detailedSummary());
        s.setKeyPoints(result.keyPointsOrEmpty());
        s.setSections(result.sectionsOrEmpty());
        s.setQuotes(result.quotesOrEmpty());
        s.setSuggestions(result.suggestionsOrEmpty());
        s.setTemplateSlug(result.templateSlug());
        summaries.save(s);
    }

    /**
     * Replace the extracted action items, keeping anything a person owns.
     *
     * <p>This used to be a clean sweep, which was harmless while the rows were
     * read-only. It stopped being harmless the moment they could be ticked off:
     * reprocessing a meeting — the normal way to pick up a corrected transcript
     * — would silently un-complete every task and delete every one added by
     * hand, along with its comments. Rows marked {@code edited} are now spared,
     * exactly as {@link #replaceInsights} spares corrected decisions.
     *
     * <p>Each survivor then claims the incoming item it stands for, which is
     * skipped. Without that, an item somebody completed would be re-extracted as
     * a fresh OPEN duplicate of itself on every reprocess, and the tracker would
     * grow a second copy of the same promise each time.
     *
     * <p>Two things are resolved here rather than at read time, because both
     * depend on facts this callback has and later requests do not: the spoken
     * deadline against the meeting's own date, and the source sentence against
     * the segments that were just written.
     */
    private void replaceActionItems(Meeting meeting, List<AiActionItem> list, List<AiSegment> segs) {
        String meetingId = meeting.getId();
        actionItems.deleteDerivedByMeetingId(meetingId);
        List<MeetingActionItem> unclaimed = new ArrayList<>(actionItems.findEditedByMeetingId(meetingId));

        LocalDate reference = meeting.getCreatedAt().atZone(ZoneOffset.UTC).toLocalDate();
        List<SentenceLocator.Line> lines = segs.stream()
                .map(s -> new SentenceLocator.Line(s.start(), s.text()))
                .toList();

        for (AiActionItem a : list) {
            if (claim(unclaimed, a)) {
                continue;
            }
            MeetingActionItem e = new MeetingActionItem();
            e.setId(IdGenerator.actionItem());
            e.setMeetingId(meetingId);
            // Denormalised from the meeting since V36. This callback runs in
            // system context with no tenant of its own, so the owner has to be
            // carried across from the row that does know.
            e.setUserId(meeting.getUserId());
            e.setTitle(a.taskTitle());
            e.setOwnerName(a.ownerName());
            e.setDueDate(a.dueDate());
            e.setDueOn(DueDates.resolve(a.dueDate(), reference));
            e.setPriority(a.priority() == null ? "medium" : a.priority());
            e.setStatus("OPEN");
            e.setSourceSentence(a.sourceSentence());
            e.setSourceStartSeconds(SentenceLocator.locate(a.sourceSentence(), lines));
            actionItems.save(e);
        }
    }

    /**
     * Decide whether one of the surviving rows already is this extracted item,
     * and if so consume it.
     *
     * <p>Matched on the title <em>or</em> the sentence it came from. The title
     * alone is not enough: somebody who corrects a title — which is one of the
     * commonest edits — would get the extractor's original wording back beside
     * their correction on the next reprocess. The source sentence does not
     * change when a person edits a row, so it is the more stable identity of the
     * two, and either matching is enough.
     *
     * <p>Consumed rather than merely tested, so one survivor suppresses exactly
     * one incoming item. A meeting where somebody promised two things in one
     * breath yields two items quoting the same sentence, and editing one of them
     * must not delete the other.
     */
    private static boolean claim(List<MeetingActionItem> unclaimed, AiActionItem incoming) {
        String title = normalise(incoming.taskTitle());
        String sentence = normalise(incoming.sourceSentence());

        for (Iterator<MeetingActionItem> it = unclaimed.iterator(); it.hasNext(); ) {
            MeetingActionItem kept = it.next();
            boolean same = (!title.isEmpty() && title.equals(normalise(kept.getTitle())))
                    || (!sentence.isEmpty() && sentence.equals(normalise(kept.getSourceSentence())));
            if (same) {
                it.remove();
                return true;
            }
        }
        return false;
    }

    /** Case- and punctuation-insensitive, so "Draft the plan." and "draft the plan" are one task. */
    private static String normalise(String text) {
        return text == null ? "" : text.trim().toLowerCase().replaceAll("[^a-z0-9]+", " ").trim();
    }

    /**
     * Replace the derived decisions and risks, keeping anything a person owns.
     *
     * <p>Unlike every other replace here, this one is not a clean sweep. The
     * others hold only generated content, so deleting all of it and writing it
     * again is exactly right. These rows can be corrected by hand, and a
     * reprocess that wiped the corrections would bring the same wrong decision
     * back every time somebody fixed it.
     */
    private void replaceInsights(Meeting meeting, List<AiInsight> list) {
        insights.deleteDerivedByMeetingId(meeting.getId());
        for (AiInsight i : list) {
            MeetingInsight e = new MeetingInsight();
            e.setId(IdGenerator.insight());
            e.setMeetingId(meeting.getId());
            // Denormalised from the meeting: the RLS policy tests ownership on
            // this column, so a row without it is invisible to its own owner.
            e.setUserId(meeting.getUserId());
            e.setKind(i.kind());
            e.setText(i.text().trim());
            e.setSourceSection(i.sourceSection() == null ? "" : i.sourceSection());
            insights.save(e);
        }
    }

    private static MeetingStatus parseStatus(String raw) {
        if (raw == null || raw.isBlank()) {
            return null;
        }
        try {
            return MeetingStatus.valueOf(raw.trim().toUpperCase());
        } catch (IllegalArgumentException e) {
            return null;
        }
    }
}
