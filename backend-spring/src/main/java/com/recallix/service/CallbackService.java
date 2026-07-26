package com.recallix.service;

import com.recallix.common.IdGenerator;
import com.recallix.domain.MeetingStatus;
import com.recallix.dto.StatusEvent;
import com.recallix.dto.callback.AiActionItem;
import com.recallix.dto.callback.AiDecision;
import com.recallix.dto.callback.AiRisk;
import com.recallix.dto.callback.AiSegment;
import com.recallix.dto.callback.MeetingBriefResult;
import com.recallix.dto.callback.StatusCallbackRequest;
import com.recallix.entity.Meeting;
import com.recallix.entity.MeetingActionItem;
import com.recallix.entity.MeetingDecision;
import com.recallix.entity.MeetingRisk;
import com.recallix.entity.MeetingSummary;
import com.recallix.entity.MeetingTranscript;
import com.recallix.entity.TranscriptSegment;
import com.recallix.event.MeetingReadyEvent;
import com.recallix.repository.MeetingActionItemRepository;
import com.recallix.repository.MeetingDecisionRepository;
import com.recallix.repository.MeetingRepository;
import com.recallix.repository.MeetingRiskRepository;
import com.recallix.repository.MeetingSummaryRepository;
import com.recallix.repository.MeetingTranscriptRepository;
import com.recallix.repository.TranscriptSegmentRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;

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
    private final MeetingDecisionRepository decisions;
    private final MeetingActionItemRepository actionItems;
    private final MeetingRiskRepository risks;
    private final StatusPublisher statusPublisher;
    private final UsageLimitService usage;
    private final ApplicationEventPublisher events;

    public CallbackService(MeetingRepository meetings,
                           MeetingTranscriptRepository transcripts,
                           TranscriptSegmentRepository segments,
                           MeetingSummaryRepository summaries,
                           MeetingDecisionRepository decisions,
                           MeetingActionItemRepository actionItems,
                           MeetingRiskRepository risks,
                           StatusPublisher statusPublisher,
                           UsageLimitService usage,
                           ApplicationEventPublisher events) {
        this.meetings = meetings;
        this.transcripts = transcripts;
        this.segments = segments;
        this.summaries = summaries;
        this.decisions = decisions;
        this.actionItems = actionItems;
        this.risks = risks;
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
        replaceDecisions(meetingId, result.decisionsOrEmpty());
        replaceActionItems(meetingId, result.actionItemsOrEmpty());
        replaceRisks(meetingId, result.risksOrEmpty());

        meeting.setStatus(MeetingStatus.READY);
        meeting.setErrorMessage(null);

        if (meeting.getDurationSeconds() != null && meeting.getDurationSeconds() > 0) {
            usage.addAiMinutes(meeting.getUserId(), Math.round(meeting.getDurationSeconds() / 60.0f));
        }
        log.info("Persisted brief for meeting {} ({} actions).", meetingId, result.actionItemsOrEmpty().size());
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
        summaries.save(s);
    }

    private void replaceDecisions(String meetingId, List<AiDecision> list) {
        decisions.deleteByMeetingId(meetingId);
        for (AiDecision d : list) {
            MeetingDecision e = new MeetingDecision();
            e.setId(IdGenerator.decision());
            e.setMeetingId(meetingId);
            e.setDecisionText(d.decision());
            e.setConfidence(d.confidence());
            e.setSourceSentence(d.sourceSentence());
            decisions.save(e);
        }
    }

    private void replaceActionItems(String meetingId, List<AiActionItem> list) {
        actionItems.deleteByMeetingId(meetingId);
        for (AiActionItem a : list) {
            MeetingActionItem e = new MeetingActionItem();
            e.setId(IdGenerator.actionItem());
            e.setMeetingId(meetingId);
            e.setTitle(a.taskTitle());
            e.setOwnerName(a.ownerName());
            e.setDueDate(a.dueDate());
            e.setPriority(a.priority() == null ? "medium" : a.priority());
            e.setStatus("OPEN");
            e.setSourceSentence(a.sourceSentence());
            actionItems.save(e);
        }
    }

    private void replaceRisks(String meetingId, List<AiRisk> list) {
        risks.deleteByMeetingId(meetingId);
        for (AiRisk r : list) {
            MeetingRisk e = new MeetingRisk();
            e.setId(IdGenerator.risk());
            e.setMeetingId(meetingId);
            e.setRiskText(r.risk());
            e.setSeverity(r.severity() == null ? "medium" : r.severity());
            e.setSourceSentence(r.sourceSentence());
            risks.save(e);
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
