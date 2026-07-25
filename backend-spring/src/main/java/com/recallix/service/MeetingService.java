package com.recallix.service;

import com.recallix.common.ApiException;
import com.recallix.common.IdGenerator;
import com.recallix.config.KafkaTopicsConfig;
import com.recallix.domain.MeetingStatus;
import com.recallix.dto.MeetingCreateRequest;
import com.recallix.dto.DecisionResponse;
import com.recallix.dto.MeetingResponse;
import com.recallix.dto.PageResponse;
import com.recallix.dto.ReprocessResponse;
import com.recallix.dto.RiskResponse;
import com.recallix.dto.SegmentDto;
import com.recallix.dto.SummaryResponse;
import com.recallix.dto.TranscriptResponse;
import com.recallix.dto.UploadUrlRequest;
import com.recallix.dto.UploadUrlResponse;
import com.recallix.entity.Meeting;
import com.recallix.repository.MeetingActionItemRepository;
import com.recallix.repository.MeetingDecisionRepository;
import com.recallix.repository.MeetingRepository;
import com.recallix.repository.MeetingRiskRepository;
import com.recallix.repository.MeetingSummaryRepository;
import com.recallix.repository.MeetingTranscriptRepository;
import com.recallix.repository.TranscriptSegmentRepository;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.Map;

/**
 * Core meeting lifecycle: presigned upload, record creation (with quota check),
 * search, detail reads, delete, and reprocess. Processing is triggered by
 * enqueuing {@code meeting_uploaded} through the transactional outbox.
 */
@Service
public class MeetingService {

    private static final List<String> ALLOWED_PREFIXES = List.of("audio/", "video/");

    private final MeetingRepository meetings;
    private final MeetingTranscriptRepository transcripts;
    private final TranscriptSegmentRepository segments;
    private final MeetingSummaryRepository summaries;
    private final MeetingDecisionRepository decisions;
    private final MeetingActionItemRepository actionItems;
    private final MeetingRiskRepository risks;
    private final StorageService storage;
    private final UsageLimitService usage;
    private final OutboxService outbox;
    private final AuditService audit;

    public MeetingService(MeetingRepository meetings,
                          MeetingTranscriptRepository transcripts,
                          TranscriptSegmentRepository segments,
                          MeetingSummaryRepository summaries,
                          MeetingDecisionRepository decisions,
                          MeetingActionItemRepository actionItems,
                          MeetingRiskRepository risks,
                          StorageService storage,
                          UsageLimitService usage,
                          OutboxService outbox,
                          AuditService audit) {
        this.meetings = meetings;
        this.transcripts = transcripts;
        this.segments = segments;
        this.summaries = summaries;
        this.decisions = decisions;
        this.actionItems = actionItems;
        this.risks = risks;
        this.storage = storage;
        this.usage = usage;
        this.outbox = outbox;
        this.audit = audit;
    }

    // --- upload + create ---------------------------------------------------- //

    @Transactional
    public UploadUrlResponse createUploadUrl(String userId, UploadUrlRequest req) {
        validateContentType(req.contentType());
        String meetingId = IdGenerator.meeting();
        String objectKey = "meetings/" + userId + "/" + meetingId + "/" + sanitize(req.filename());

        Meeting meeting = new Meeting();
        meeting.setId(meetingId);
        meeting.setUserId(userId);
        meeting.setTitle(stripExtension(req.filename()));
        meeting.setStatus(MeetingStatus.CREATED);
        meeting.setObjectKey(objectKey);
        meetings.save(meeting);

        String uploadUrl = storage.presignUpload(objectKey, req.contentType());
        return new UploadUrlResponse(meetingId, uploadUrl, objectKey, storage.presignExpirySeconds());
    }

    @Transactional
    public MeetingResponse createMeeting(String userId, MeetingCreateRequest req) {
        Meeting meeting = meetings.findByObjectKeyAndUserId(req.objectKey(), userId)
                .orElseThrow(() -> ApiException.notFound("No pending upload for that objectKey"));

        // Quota is charged at confirmation (not at presign) so abandoned uploads are free.
        usage.incrementMeetingsOrThrow(userId);

        meeting.setTitle(req.title());
        meeting.setParticipants(req.participantsOrEmpty());
        meeting.setTags(req.tagsOrEmpty());
        if (req.durationSeconds() != null) {
            meeting.setDurationSeconds(req.durationSeconds());
        }
        meeting.setStatus(MeetingStatus.QUEUED);

        enqueueProcessing(meeting);
        audit.record(userId, "MEETING_CREATED", "meeting", meeting.getId());
        return toResponse(meeting);
    }

    private void enqueueProcessing(Meeting meeting) {
        // The worker fetches by objectKey via its internal S3 endpoint. We send an
        // empty audioUrl on purpose: a browser-facing presigned URL points at the
        // public (localhost) endpoint, which is unreachable from inside the worker.
        outbox.enqueue(KafkaTopicsConfig.MEETING_UPLOADED, meeting.getId(), Map.of(
                "meetingId", meeting.getId(),
                "userId", meeting.getUserId(),
                "audioUrl", "",
                "objectKey", meeting.getObjectKey() == null ? "" : meeting.getObjectKey()
        ));
    }

    // --- reads -------------------------------------------------------------- //

    @Transactional(readOnly = true)
    public PageResponse<MeetingResponse> list(String userId, int page, int size,
                                              String search, String tag, MeetingStatus status) {
        Page<Meeting> result = meetings.search(
                userId,
                blankToNull(search),
                status == null ? null : status.name(),
                blankToNull(tag),
                PageRequest.of(page, size));
        List<MeetingResponse> content = result.getContent().stream().map(this::toResponse).toList();
        return PageResponse.from(result, content);
    }

    @Transactional(readOnly = true)
    public MeetingResponse get(String userId, String meetingId) {
        return toResponse(require(userId, meetingId));
    }

    @Transactional(readOnly = true)
    public Meeting require(String userId, String meetingId) {
        return meetings.findByIdAndUserId(meetingId, userId)
                .orElseThrow(() -> ApiException.notFound("Meeting not found"));
    }

    @Transactional(readOnly = true)
    public TranscriptResponse getTranscript(String userId, String meetingId) {
        require(userId, meetingId);
        var transcript = transcripts.findFirstByMeetingIdOrderByCreatedAtDesc(meetingId)
                .orElseThrow(() -> ApiException.notFound("Transcript not ready"));
        List<SegmentDto> segs = segments.findByMeetingIdOrderByStartTimeAsc(meetingId)
                .stream().map(SegmentDto::from).toList();
        return new TranscriptResponse(meetingId, transcript.getTranscriptText(),
                transcript.getLanguage(), segs);
    }

    @Transactional(readOnly = true)
    public SummaryResponse getSummary(String userId, String meetingId) {
        require(userId, meetingId);
        var summary = summaries.findFirstByMeetingIdOrderByCreatedAtDesc(meetingId)
                .orElseThrow(() -> ApiException.notFound("Summary not ready"));
        return new SummaryResponse(meetingId, summary.getShortSummary(),
                summary.getDetailedSummary(), summary.getKeyPoints());
    }

    @Transactional(readOnly = true)
    public List<DecisionResponse> getDecisions(String userId, String meetingId) {
        require(userId, meetingId);
        return decisions.findByMeetingId(meetingId).stream().map(DecisionResponse::from).toList();
    }

    @Transactional(readOnly = true)
    public List<RiskResponse> getRisks(String userId, String meetingId) {
        require(userId, meetingId);
        return risks.findByMeetingId(meetingId).stream().map(RiskResponse::from).toList();
    }

    /** Rename transcript speaker labels (e.g. {"S1":"Alice"}); returns updated segments. */
    @Transactional
    public TranscriptResponse renameSpeakers(String userId, String meetingId, Map<String, String> mapping) {
        require(userId, meetingId);
        var segs = segments.findByMeetingIdOrderByStartTimeAsc(meetingId);
        for (var seg : segs) {
            String mapped = mapping.get(seg.getSpeaker());
            if (mapped != null && !mapped.isBlank()) {
                seg.setSpeaker(mapped.trim());
            }
        }
        audit.record(userId, "SPEAKERS_RENAMED", "meeting", meetingId);
        return getTranscript(userId, meetingId);
    }

    // --- reprocess + delete ------------------------------------------------- //

    @Transactional
    public ReprocessResponse reprocess(String userId, String meetingId) {
        Meeting meeting = require(userId, meetingId);
        if (meeting.getObjectKey() == null) {
            throw ApiException.badRequest("Meeting has no uploaded audio to reprocess");
        }
        meeting.setStatus(MeetingStatus.QUEUED);
        meeting.setErrorMessage(null);
        enqueueProcessing(meeting);
        audit.record(userId, "MEETING_REPROCESS", "meeting", meetingId);
        return new ReprocessResponse(meetingId, MeetingStatus.QUEUED);
    }

    @Transactional
    public void delete(String userId, String meetingId) {
        Meeting meeting = require(userId, meetingId);
        transcripts.deleteByMeetingId(meetingId);
        segments.deleteByMeetingId(meetingId);
        summaries.deleteByMeetingId(meetingId);
        decisions.deleteByMeetingId(meetingId);
        actionItems.deleteByMeetingId(meetingId);
        risks.deleteByMeetingId(meetingId);
        storage.delete(meeting.getObjectKey());
        meetings.delete(meeting);
        audit.record(userId, "MEETING_DELETED", "meeting", meetingId);
    }

    // --- helpers ------------------------------------------------------------ //

    private MeetingResponse toResponse(Meeting m) {
        String audioUrl = m.getObjectKey() != null ? storage.presignDownload(m.getObjectKey()) : m.getAudioUrl();
        return new MeetingResponse(
                m.getId(), m.getTitle(), m.getStatus(),
                m.getParticipants(), m.getTags(), audioUrl,
                m.getDurationSeconds(), m.getCreatedAt(), m.getErrorMessage());
    }

    private void validateContentType(String contentType) {
        if (contentType == null || ALLOWED_PREFIXES.stream().noneMatch(contentType::startsWith)) {
            throw ApiException.badRequest("Only audio/* or video/* uploads are supported");
        }
    }

    private static String sanitize(String filename) {
        String base = filename == null ? "audio" : filename.replaceAll("[^a-zA-Z0-9._-]", "_");
        return base.isBlank() ? "audio" : base;
    }

    private static String stripExtension(String filename) {
        if (filename == null || filename.isBlank()) {
            return "Untitled meeting";
        }
        int dot = filename.lastIndexOf('.');
        return dot > 0 ? filename.substring(0, dot) : filename;
    }

    private static String blankToNull(String s) {
        return (s == null || s.isBlank()) ? null : s;
    }
}
