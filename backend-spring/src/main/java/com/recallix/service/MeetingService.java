package com.recallix.service;

import com.recallix.common.ApiException;
import com.recallix.common.IdGenerator;
import com.recallix.config.KafkaTopicsConfig;
import com.recallix.domain.MeetingStatus;
import com.recallix.domain.SourceType;
import com.recallix.dto.MeetingCreateRequest;
import com.recallix.dto.MeetingImportRequest;
import com.recallix.dto.MeetingResponse;
import com.recallix.dto.PageResponse;
import com.recallix.dto.ReprocessResponse;
import com.recallix.dto.SegmentDto;
import com.recallix.dto.SpeakerRematchRequest;
import com.recallix.dto.SpeakerStatsDto;
import com.recallix.dto.SummaryResponse;
import com.recallix.dto.TranscriptEditRequest;
import com.recallix.dto.TranscriptResponse;
import com.recallix.dto.UploadUrlRequest;
import com.recallix.dto.UploadUrlResponse;
import com.recallix.entity.Meeting;
import com.recallix.entity.TranscriptSegment;
import com.recallix.repository.MeetingActionItemRepository;
import com.recallix.repository.MeetingRepository;
import com.recallix.repository.MeetingSummaryRepository;
import com.recallix.repository.MeetingTranscriptRepository;
import com.recallix.repository.TranscriptSegmentRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

/**
 * Core meeting lifecycle: presigned upload, record creation (with quota check),
 * search, detail reads, delete, and reprocess. Processing is triggered by
 * enqueuing {@code meeting_uploaded} through the transactional outbox.
 */
@Service
public class MeetingService {

    private static final Logger log = LoggerFactory.getLogger(MeetingService.class);

    private static final List<String> ALLOWED_PREFIXES = List.of("audio/", "video/");
    private static final String PDF = "application/pdf";

    /**
     * Stand-in title for a URL import, replaced by {@link CallbackService} once
     * the worker reports the video's real title. Only this exact value is
     * overwritten, so a title the user supplied is never lost.
     */
    public static final String IMPORT_PLACEHOLDER_TITLE = "YouTube import";

    /**
     * Hosts we accept for URL imports. The worker hands this straight to
     * yt-dlp, which supports a thousand-odd sites; narrowing it here keeps a
     * user-supplied URL from becoming a server-side request forgery primitive.
     */
    private static final List<String> YOUTUBE_HOSTS = List.of(
            "youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com",
            "youtu.be", "www.youtu.be");

    private final MeetingRepository meetings;
    private final MeetingTranscriptRepository transcripts;
    private final TranscriptSegmentRepository segments;
    private final MeetingSummaryRepository summaries;
    private final MeetingActionItemRepository actionItems;
    private final StorageService storage;
    private final UsageLimitService usage;
    private final OutboxService outbox;
    private final AuditService audit;
    private final AiClient ai;
    private final SummaryTemplateService templates;
    private final KnownSpeakerService knownSpeakers;
    private final VocabularyService vocabulary;

    public MeetingService(MeetingRepository meetings,
                          MeetingTranscriptRepository transcripts,
                          TranscriptSegmentRepository segments,
                          MeetingSummaryRepository summaries,
                          MeetingActionItemRepository actionItems,
                          StorageService storage,
                          UsageLimitService usage,
                          OutboxService outbox,
                          AuditService audit,
                          AiClient ai,
                          SummaryTemplateService templates,
                          KnownSpeakerService knownSpeakers,
                          VocabularyService vocabulary) {
        this.meetings = meetings;
        this.transcripts = transcripts;
        this.segments = segments;
        this.summaries = summaries;
        this.actionItems = actionItems;
        this.storage = storage;
        this.usage = usage;
        this.outbox = outbox;
        this.audit = audit;
        this.ai = ai;
        this.templates = templates;
        this.knownSpeakers = knownSpeakers;
        this.vocabulary = vocabulary;
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
        // Validated just above, so what is stored is always one of the types we
        // allow — the player reads this to decide between <video> and <audio>.
        meeting.setContentType(req.contentType());
        // A PDF has no audio track, so the worker must skip transcription.
        meeting.setSourceType(PDF.equals(req.contentType()) ? SourceType.DOCUMENT : SourceType.AUDIO);
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
        meeting.setSummaryTemplate(templates.requireKnown(req.summaryTemplate()));
        meeting.setStatus(MeetingStatus.QUEUED);

        enqueueProcessing(meeting);
        audit.record(userId, "MEETING_CREATED", "meeting", meeting.getId());
        return toResponse(meeting);
    }

    /**
     * Import a meeting from a URL. No upload, no presign — the worker fetches
     * the audio itself, so the meeting goes straight to QUEUED.
     */
    @Transactional
    public MeetingResponse importFromUrl(String userId, MeetingImportRequest req) {
        String url = req.trimmedUrl();
        validateYouTubeUrl(url);

        // The DB has a partial unique index on (user_id, source_url); checking
        // first turns a constraint violation into a useful message.
        meetings.findByUserIdAndSourceUrl(userId, url).ifPresent(existing -> {
            throw ApiException.badRequest("You already imported that video: " + existing.getTitle());
        });

        usage.incrementMeetingsOrThrow(userId);

        Meeting meeting = new Meeting();
        meeting.setId(IdGenerator.meeting());
        meeting.setUserId(userId);
        // Placeholder until the worker reports the video's real title.
        meeting.setTitle(req.title() == null || req.title().isBlank()
                ? IMPORT_PLACEHOLDER_TITLE : req.title().trim());
        meeting.setStatus(MeetingStatus.QUEUED);
        meeting.setSourceType(SourceType.YOUTUBE);
        meeting.setSourceUrl(url);
        meeting.setTags(req.tagsOrEmpty());
        meeting.setSummaryTemplate(templates.requireKnown(req.summaryTemplate()));
        meetings.save(meeting);

        enqueueProcessing(meeting);
        audit.record(userId, "MEETING_IMPORTED", "meeting", meeting.getId());
        return toResponse(meeting);
    }

    private void validateYouTubeUrl(String url) {
        java.net.URI uri;
        try {
            uri = java.net.URI.create(url);
        } catch (IllegalArgumentException e) {
            throw ApiException.badRequest("That doesn't look like a valid URL");
        }
        String scheme = uri.getScheme();
        if (scheme == null || !(scheme.equals("http") || scheme.equals("https"))) {
            throw ApiException.badRequest("That doesn't look like a valid URL");
        }
        String host = uri.getHost();
        if (host == null || YOUTUBE_HOSTS.stream().noneMatch(host.toLowerCase()::equals)) {
            throw ApiException.badRequest("Only YouTube links can be imported right now");
        }
    }

    private void enqueueProcessing(Meeting meeting) {
        // The worker fetches by objectKey via its internal S3 endpoint. We send an
        // empty audioUrl on purpose: a browser-facing presigned URL points at the
        // public (localhost) endpoint, which is unreachable from inside the worker.
        outbox.enqueue(KafkaTopicsConfig.MEETING_UPLOADED, meeting.getId(), Map.of(
                "meetingId", meeting.getId(),
                "userId", meeting.getUserId(),
                "audioUrl", "",
                "objectKey", meeting.getObjectKey() == null ? "" : meeting.getObjectKey(),
                "sourceType", meeting.getSourceType().name(),
                "sourceUrl", meeting.getSourceUrl() == null ? "" : meeting.getSourceUrl(),
                // Sent with the job so the worker summarizes in the shape the
                // user chose the first time, rather than producing General
                // notes that then have to be rewritten.
                "summaryTemplate", meeting.getSummaryTemplate() == null
                        ? SummaryTemplateService.DEFAULT_SLUG : meeting.getSummaryTemplate(),
                // Read at enqueue rather than fetched by the worker: the worker
                // runs as a system context with no user, and sending the list
                // with the job keeps that boundary intact. It also pins the
                // vocabulary to what it was when the job was queued, so a term
                // added mid-run cannot change a transcript halfway through.
                "vocabulary", vocabulary.boostTermsFor(meeting.getUserId())
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
        var rows = segments.findByMeetingIdOrderByStartTimeAsc(meetingId);
        List<SegmentDto> segs = rows.stream().map(SegmentDto::from).toList();
        return new TranscriptResponse(meetingId, transcript.getTranscriptText(),
                transcript.getLanguage(), segs, SpeakerStatsDto.from(rows));
    }

    @Transactional(readOnly = true)
    public SummaryResponse getSummary(String userId, String meetingId) {
        require(userId, meetingId);
        var summary = summaries.findFirstByMeetingIdOrderByCreatedAtDesc(meetingId)
                .orElseThrow(() -> ApiException.notFound("Summary not ready"));
        return new SummaryResponse(meetingId, summary.getShortSummary(),
                summary.getDetailedSummary(), summary.getKeyPoints(),
                summary.getSections(), summary.getQuotes(), summary.getTemplateSlug());
    }

    /**
     * Rewrite an existing summary under a different template.
     *
     * <p>Deliberately not a reprocess: the transcript is already stored, so
     * this re-runs only the summary call. Re-transcribing to change the shape
     * of the notes would cost minutes and money for no new information — and
     * would consume the user's quota a second time for a meeting they have
     * already paid for.
     *
     * <p>The action items are left alone for the same reason: they are facts
     * about the meeting, not a presentation choice, so a template switch has
     * no business changing them.
     */
    @Transactional
    public SummaryResponse resummarize(String userId, String meetingId, String templateSlug) {
        Meeting meeting = require(userId, meetingId);
        var transcript = transcripts.findFirstByMeetingIdOrderByCreatedAtDesc(meetingId)
                .orElseThrow(() -> ApiException.badRequest(
                        "This meeting has no transcript yet, so there is nothing to summarize"));

        String slug = templates.requireKnown(templateSlug);

        // Distinct voices, not turns: the summary prompt uses this to say how
        // many people were in the room.
        Integer speakerCount = (int) segments.findByMeetingIdOrderByStartTimeAsc(meetingId)
                .stream()
                .map(TranscriptSegment::getSpeaker)
                .filter(s -> s != null && !s.isBlank())
                .distinct()
                .count();
        if (speakerCount == 0) {
            speakerCount = null;
        }

        AiClient.SummaryResult written = ai.summarize(
                transcript.getTranscriptText(), slug, meeting.getDurationSeconds(), speakerCount);

        var summary = summaries.findFirstByMeetingIdOrderByCreatedAtDesc(meetingId)
                .orElseGet(() -> {
                    var fresh = new com.recallix.entity.MeetingSummary();
                    fresh.setId(IdGenerator.summary());
                    fresh.setMeetingId(meetingId);
                    return fresh;
                });
        summary.setShortSummary(written.shortSummary());
        summary.setDetailedSummary(written.detailedSummary());
        summary.setKeyPoints(written.keyPoints());
        summary.setSections(written.sections());
        summary.setTemplateSlug(written.templateSlug() == null ? slug : written.templateSlug());
        summaries.save(summary);

        // Remembered on the meeting so a later reprocess keeps this shape.
        meeting.setSummaryTemplate(slug);
        audit.record(userId, "SUMMARY_RESUMMARIZED", "meeting", meetingId);

        return new SummaryResponse(meetingId, summary.getShortSummary(),
                summary.getDetailedSummary(), summary.getKeyPoints(),
                summary.getSections(), summary.getQuotes(), summary.getTemplateSlug());
    }

    /** Rename transcript speaker labels (e.g. {"S1":"Alice"}); returns updated segments. */
    @Transactional
    public TranscriptResponse renameSpeakers(String userId, String meetingId, Map<String, String> mapping) {
        require(userId, meetingId);
        var segs = segments.findByMeetingIdOrderByStartTimeAsc(meetingId);
        boolean changed = false;
        for (var seg : segs) {
            String mapped = mapping.get(seg.getSpeaker());
            if (mapped != null && !mapped.isBlank()) {
                seg.setSpeaker(mapped.trim());
                changed = true;
            }
        }
        // Retrieval passages are stored as "Speaker 1: ...", so a rename that
        // is not re-indexed leaves chat answering with the old label — and
        // citing a name the transcript no longer shows anywhere.
        if (changed) {
            reindex(userId, meetingId, segs);
            // Learned from the rename itself rather than a settings page, so
            // the suggestion list fills from ordinary use instead of needing to
            // be seeded by someone first.
            knownSpeakers.remember(userId, mapping.values());
        }
        audit.record(userId, "SPEAKERS_RENAMED", "meeting", meetingId);
        return getTranscript(userId, meetingId);
    }

    /**
     * Fix diarization rather than naming.
     *
     * <p>Renaming answers "who is Speaker 2?" — one label, one name. Neither of
     * the two ways diarization actually goes wrong is expressible that way:
     *
     * <ul>
     *   <li>One person gets split across two labels, usually across a long
     *       pause or a change in mic level. Renaming both to "Alice" produces a
     *       transcript where Alice appears to interrupt herself, because the
     *       turns stay separate. Merging folds the label away.
     *   <li>Individual turns land on the wrong person, typically where two
     *       people overlap. That is a per-segment correction, and a label-wide
     *       rename would move every other turn with it.
     * </ul>
     *
     * <p>Like an edit, this re-indexes: retrieval passages carry the speaker
     * prefix, so a rematch that is not re-indexed leaves chat attributing
     * quotes to whoever the transcript no longer says.
     */
    @Transactional
    public TranscriptResponse rematchSpeaker(String userId, String meetingId,
                                             SpeakerRematchRequest req) {
        require(userId, meetingId);

        String invalid = req.validate();
        if (invalid != null) {
            throw ApiException.badRequest(invalid);
        }

        String target = req.trimmedTo();
        var segs = segments.findByMeetingIdOrderByStartTimeAsc(meetingId);
        boolean changed;

        if (req.isMerge()) {
            String source = req.fromSpeaker().trim();
            changed = false;
            for (var seg : segs) {
                if (source.equals(seg.getSpeaker())) {
                    seg.setSpeaker(target);
                    changed = true;
                }
            }
            if (!changed) {
                throw ApiException.badRequest(
                        "No turns are labelled \"" + source + "\"; reload the transcript and try again");
            }
        } else {
            Map<String, TranscriptSegment> byId = segs.stream()
                    .collect(Collectors.toMap(TranscriptSegment::getId, s -> s, (a, b) -> a));
            changed = false;
            for (String segmentId : req.segmentIdsOrEmpty()) {
                var seg = byId.get(segmentId);
                // Refused rather than skipped, for the same reason an edit is:
                // silently dropping half a batch leaves the user believing
                // corrections landed that did not.
                if (seg == null) {
                    throw ApiException.badRequest(
                            "That segment is not part of this meeting; reload the transcript and try again");
                }
                if (!target.equals(seg.getSpeaker())) {
                    seg.setSpeaker(target);
                    changed = true;
                }
            }
        }

        if (!changed) {
            return getTranscript(userId, meetingId);
        }

        // The flat transcript carries the speaker prefixes, so it is as stale
        // after a rematch as it is after an edit — and the export reads it.
        transcripts.findFirstByMeetingIdOrderByCreatedAtDesc(meetingId)
                .ifPresent(t -> t.setTranscriptText(joinSegments(segs)));
        reindex(userId, meetingId, segs);
        knownSpeakers.remember(userId, List.of(target));
        audit.record(userId, "SPEAKER_REMATCHED", "meeting", meetingId);
        return getTranscript(userId, meetingId);
    }

    /**
     * Correct what the transcriber heard.
     *
     * <p>Transcription is very good and still wrong about names, jargon and
     * anything said over a cough. Those errors are load-bearing: the corrected
     * text is what the summary is written from, what chat retrieves, and what
     * the export hands to someone who was not in the room.
     *
     * <p>Three things follow from an edit, and each is a correctness issue
     * rather than a nicety:
     *
     * <ul>
     *   <li>The flat transcript is rebuilt from the segments, because it is a
     *       denormalised copy and the export reads it.
     *   <li>The edited segment's word timings are dropped. They describe words
     *       that were spoken; once the text says something else they point at
     *       the wrong ones, and a highlight that lands on the wrong word is
     *       worse than one estimated from the segment span — which is what the
     *       UI falls back to.
     *   <li>The meeting is re-indexed, because retrieval reads chunks rather
     *       than segments. Skipping it means the user corrects a name and chat
     *       carries on using the old one.
     * </ul>
     *
     * <p>The summary and action items are deliberately <em>not</em> regenerated.
     * That costs a model call per save and would surprise someone who fixed a
     * typo; re-summarizing is a button they already have, and it is their call
     * whether a correction was material enough to be worth it.
     */
    @Transactional
    public TranscriptResponse editSegments(String userId, String meetingId,
                                           List<TranscriptEditRequest.SegmentEdit> edits) {
        require(userId, meetingId);
        var segs = segments.findByMeetingIdOrderByStartTimeAsc(meetingId);
        Map<String, TranscriptSegment> byId = segs.stream()
                .collect(Collectors.toMap(
                        TranscriptSegment::getId, s -> s, (a, b) -> a));

        boolean changed = false;
        for (var edit : edits) {
            var seg = byId.get(edit.id());
            // Addressed by id, so an unknown one means the client is working
            // from a stale transcript. Refused rather than ignored: silently
            // dropping half a batch would leave the user believing corrections
            // landed that did not.
            if (seg == null) {
                throw ApiException.badRequest(
                        "That segment is not part of this meeting; reload the transcript and try again");
            }
            String text = edit.text().trim();
            if (text.equals(seg.getText())) {
                continue;
            }
            seg.setText(text);
            seg.setWords(List.of());
            changed = true;
        }

        if (!changed) {
            return getTranscript(userId, meetingId);
        }

        transcripts.findFirstByMeetingIdOrderByCreatedAtDesc(meetingId)
                .ifPresent(t -> t.setTranscriptText(joinSegments(segs)));
        reindex(userId, meetingId, segs);
        audit.record(userId, "TRANSCRIPT_EDITED", "meeting", meetingId);
        return getTranscript(userId, meetingId);
    }

    /**
     * Rebuild the flat transcript from its segments.
     *
     * <p>Same "Speaker: text" shape the worker produces, so an edited
     * transcript and a freshly-processed one read identically — the export and
     * the re-summarize path cannot tell which they were handed.
     */
    private static String joinSegments(List<TranscriptSegment> segs) {
        return segs.stream()
                .map(s -> (s.getSpeaker() == null || s.getSpeaker().isBlank())
                        ? s.getText()
                        : s.getSpeaker() + ": " + s.getText())
                .filter(line -> line != null && !line.isBlank())
                .collect(Collectors.joining("\n"));
    }

    /**
     * Push the current segments back into pgvector.
     *
     * <p>Failure is logged and swallowed: the edit itself is already correct and
     * committed, and refusing to save a correction because the search index
     * could not be updated would be the wrong trade. The stale index is
     * repaired by the next edit or a reprocess.
     */
    private void reindex(String userId, String meetingId,
                         List<TranscriptSegment> segs) {
        try {
            ai.reindex(userId, meetingId, joinSegments(segs),
                    segs.stream().map(SegmentDto::from).toList());
        } catch (Exception e) {
            log.warn("Re-indexing meeting {} failed; chat may answer from stale text: {}",
                    meetingId, e.toString());
        }
    }

    // --- reprocess + delete ------------------------------------------------- //

    @Transactional
    public ReprocessResponse reprocess(String userId, String meetingId) {
        Meeting meeting = require(userId, meetingId);
        // A URL import has no object key — the worker re-downloads from the
        // source instead — so either one is enough to re-run the pipeline.
        if (meeting.getObjectKey() == null && meeting.getSourceUrl() == null) {
            throw ApiException.badRequest("Meeting has no source to reprocess");
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
        actionItems.deleteByMeetingId(meetingId);
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
                m.getDurationSeconds(), m.getCreatedAt(), m.getErrorMessage(),
                m.getSourceType(), m.getSourceUrl(), m.getLanguage(),
                m.getSummaryTemplate(), m.getContentType());
    }

    private void validateContentType(String contentType) {
        if (contentType == null) {
            throw ApiException.badRequest("Only audio, video or PDF uploads are supported");
        }
        boolean media = ALLOWED_PREFIXES.stream().anyMatch(contentType::startsWith);
        if (!media && !PDF.equals(contentType)) {
            throw ApiException.badRequest("Only audio, video or PDF uploads are supported");
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
