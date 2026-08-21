package com.recallix.service;

import com.recallix.common.ApiException;
import com.recallix.common.IdGenerator;
import com.recallix.config.KafkaTopicsConfig;
import com.recallix.domain.Language;
import com.recallix.domain.MeetingStatus;
import com.recallix.domain.SourceType;
import com.recallix.dto.MeetingCreateRequest;
import com.recallix.dto.MeetingResponse;
import com.recallix.dto.MeetingUpdateRequest;
import com.recallix.dto.PageResponse;
import com.recallix.dto.callback.AiInsight;
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
import com.recallix.entity.MeetingInsight;
import com.recallix.entity.TranscriptSegment;
import com.recallix.repository.MeetingInsightRepository;
import com.recallix.repository.MeetingRepository;
import com.recallix.repository.MeetingSummaryRepository;
import com.recallix.repository.MeetingTranslationRepository;
import com.recallix.repository.MeetingTranscriptRepository;
import com.recallix.dto.KnownSpeakerResponse;
import com.recallix.repository.ProjectRepository;
import com.recallix.repository.TranscriptSegmentRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
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

    private final MeetingRepository meetings;
    private final MeetingTranscriptRepository transcripts;
    private final TranscriptSegmentRepository segments;
    private final MeetingSummaryRepository summaries;
    private final MeetingInsightRepository insights;
    private final StorageService storage;
    private final UsageLimitService usage;
    private final OutboxService outbox;
    private final AuditService audit;
    private final AiClient ai;
    private final SummaryTemplateService templates;
    private final KnownSpeakerService knownSpeakers;
    private final VocabularyService vocabulary;
    private final NotificationService notifications;
    /** Only to verify a project id a client sent — see {@code createMeeting}. */
    private final ProjectRepository projects;
    /** Only to flag translations when the words underneath them change (V33). */
    private final MeetingTranslationRepository translations;
    /** Owns every grain of deletion, so the button and the retention pass agree (V35). */
    private final ErasureService erasure;
    private final UserService users;

    public MeetingService(MeetingRepository meetings,
                          MeetingTranscriptRepository transcripts,
                          TranscriptSegmentRepository segments,
                          MeetingSummaryRepository summaries,
                          MeetingInsightRepository insights,
                          StorageService storage,
                          UsageLimitService usage,
                          OutboxService outbox,
                          AuditService audit,
                          AiClient ai,
                          SummaryTemplateService templates,
                          KnownSpeakerService knownSpeakers,
                          VocabularyService vocabulary,
                          ProjectRepository projects,
                          MeetingTranslationRepository translations,
                          NotificationService notifications,
                          ErasureService erasure,
                          UserService users) {
        this.users = users;
        this.erasure = erasure;
        this.notifications = notifications;
        this.projects = projects;
        this.translations = translations;
        this.meetings = meetings;
        this.transcripts = transcripts;
        this.segments = segments;
        this.summaries = summaries;
        this.insights = insights;
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
        meeting.setSourceType(SourceType.AUDIO);
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

        // The title was set from the filename at presign. Only a client with a
        // better name overrides it — the recorder, whose files are timestamps.
        String override = req.titleOverrideOrNull();
        if (override != null) {
            meeting.setTitle(override);
        }
        meeting.setTags(req.tagsOrEmpty());
        if (req.durationSeconds() != null) {
            meeting.setDurationSeconds(req.durationSeconds());
        }
        // Which of the two clients this was (V40). Both reach here, and only one
        // of them says so, which is what lets the recap preference tell a
        // recording apart from an uploaded file.
        meeting.setRecorded(req.recordedHere());
        meeting.setSummaryTemplate(templates.requireKnown(req.summaryTemplate()));
        if (req.projectId() != null && !req.projectId().isBlank()) {
            // Checked, not trusted: an id from the client could name somebody
            // else's project, and filing into it would put this recording in
            // their sidebar and inside the answers their project chat gives.
            projects.findByIdAndUserId(req.projectId(), userId)
                    .orElseThrow(() -> ApiException.notFound("Project not found"));
            meeting.setProjectId(req.projectId());
        }
        int[] speakers = req.expectedSpeakerRangeOrNull();
        if (speakers != null) {
            // Zero is the "not given" half of a one-sided range; null is what
            // the column means by that, and what the worker reads as auto.
            meeting.setExpectedSpeakersMin(speakers[0] == 0 ? null : speakers[0]);
            meeting.setExpectedSpeakersMax(speakers[1] == 0 ? null : speakers[1]);
        }
        if (Boolean.TRUE.equals(req.consentConfirmed())) {
            // Stamped now rather than when the recorder started, because now is
            // when the meeting exists. The few minutes between the two are not
            // worth a second timestamp travelling up from the browser.
            meeting.setConsentConfirmedAt(java.time.Instant.now());
        }
        meeting.setStatus(MeetingStatus.QUEUED);

        enqueueProcessing(meeting);
        audit.record(userId, "MEETING_CREATED", "meeting", meeting.getId());
        notifications.processingStarted(meeting, "uploaded");
        return toResponse(meeting);
    }

    /**
     * Rename a meeting or re-tag it.
     *
     * <p>Each field is applied only when the caller sent it, so renaming from
     * the title row cannot wipe tags set from the tag row. For tags the
     * distinction is null (leave) versus empty (clear) — without it there would
     * be no way to remove the last tag.
     */
    @Transactional
    public MeetingResponse updateMeeting(String userId, String meetingId, MeetingUpdateRequest req) {
        Meeting meeting = meetings.findByIdAndUserId(meetingId, userId)
                .orElseThrow(() -> ApiException.notFound("Meeting not found"));

        String title = req.titleOrNull();
        if (title != null) {
            meeting.setTitle(title);
        }
        List<String> tags = req.tagsOrNull();
        if (tags != null) {
            meeting.setTags(tags);
        }

        audit.record(userId, "MEETING_UPDATED", "meeting", meetingId);
        return toResponse(meeting);
    }

    private void enqueueProcessing(Meeting meeting) {
        // The worker fetches by objectKey via its internal S3 endpoint. We send an
        // empty audioUrl on purpose: a browser-facing presigned URL points at the
        // public (localhost) endpoint, which is unreachable from inside the worker.
        // A LinkedHashMap rather than Map.of, which stops at ten pairs and this
        // outgrew. Ordered, so the serialised event stays diffable between runs
        // -- worth something when the only view of it is a log line.
        Map<String, Object> event = new java.util.LinkedHashMap<>();
        event.put("meetingId", meeting.getId());
        event.put("userId", meeting.getUserId());
        event.put("audioUrl", "");
        event.put("objectKey", meeting.getObjectKey() == null ? "" : meeting.getObjectKey());
        event.put("sourceType", meeting.getSourceType().name());
        event.put("sourceUrl", meeting.getSourceUrl() == null ? "" : meeting.getSourceUrl());
        // Sent with the job so the worker summarizes in the shape the user
        // chose the first time, rather than producing General notes that then
        // have to be rewritten.
        event.put("summaryTemplate", meeting.getSummaryTemplate() == null
                ? SummaryTemplateService.DEFAULT_SLUG : meeting.getSummaryTemplate());
        // Read at enqueue rather than fetched by the worker: the worker runs as
        // a system context with no user, and sending the list with the job
        // keeps that boundary intact. It also pins the vocabulary to what it
        // was when the job was queued, so a term added mid-run cannot change a
        // transcript halfway through.
        event.put("vocabulary", vocabulary.boostTermsFor(meeting.getUserId()));
        // Same reasoning as the vocabulary, and the same read: the worker has
        // no user context to look this up in. Blank means auto-detect, which is
        // what every account did before the setting existed.
        event.put("language", language(meeting));
        // What the recording is about, for transcription prompting -- pinned at
        // enqueue for the same reason, so a rename mid-run cannot change a
        // transcript halfway through.
        event.put("context", transcriptionContext(meeting));
        // How many voices to look for. Auto unless a human said otherwise.
        event.put("speakers", speakerExpectation(meeting));

        outbox.enqueue(KafkaTopicsConfig.MEETING_UPLOADED, meeting.getId(), event);
    }

    /**
     * What Recallix already knows about this recording, for the transcriber.
     *
     * <p>None of this is new information — the title, the project, the shape of
     * meeting and the names this user has applied to speakers before were all
     * sitting in the database while every transcription job was submitted
     * without them. Speech models guess, and they guess differently when told
     * the domain: "Kafka" over "coffee", a colleague's name over the common
     * word it sounds like.
     *
     * <p>Names come from {@code known_speakers}, which is written by the rename
     * feature — so it reflects people this user has actually labelled in
     * meetings rather than an address book that would drift from them. They are
     * used for prompting and for keyterms, and <em>never</em> to infer how many
     * speakers there are; see {@link #speakerExpectation}.
     *
     * <p>Never fatal. A profile or a project that cannot be read is not a
     * reason to refuse to transcribe a recording somebody has already uploaded.
     */
    private Map<String, Object> transcriptionContext(Meeting meeting) {
        String project = "";
        if (meeting.getProjectId() != null) {
            try {
                project = projects.findByIdAndUserId(meeting.getProjectId(), meeting.getUserId())
                        .map(p -> p.getName() == null ? "" : p.getName())
                        .orElse("");
            } catch (RuntimeException e) {
                // Same reasoning as the template name. A project that cannot be
                // read is a slightly worse prompt, not a meeting that fails.
                project = "";
            }
        }

        List<String> participants = List.of();
        try {
            participants = knownSpeakers.list(meeting.getUserId()).stream()
                    .map(KnownSpeakerResponse::displayName)
                    .filter(name -> name != null && !name.isBlank())
                    .distinct()
                    // Bounded: a heavy user has hundreds of these and a prompt
                    // listing all of them names nobody in particular.
                    .limit(24)
                    .toList();
        } catch (RuntimeException e) {
            // Prompting is an accuracy improvement, not a precondition.
        }

        // A LinkedHashMap, not Map.of, and this is not a style preference:
        // Map.of throws on a null value, so a collaborator returning null --
        // which any of these three can, and which a mocked one certainly does
        // -- would turn "prompting is unavailable" into an exception on the
        // enqueue path and stop the meeting being processed at all. This block
        // promises to be never fatal; it has to mean it.
        Map<String, Object> context = new java.util.LinkedHashMap<>();
        context.put("title", blank(meeting.getTitle()));
        context.put("project", blank(project));
        context.put("meetingType", blank(safeTemplateName(meeting)));
        context.put("participants", participants);
        context.put("organisations", List.of());
        return context;
    }

    private static String blank(String value) {
        return value == null ? "" : value;
    }

    /** The template's human name, or blank if the ai-service cannot be reached. */
    private String safeTemplateName(Meeting meeting) {
        try {
            return templates.displayName(meeting.getSummaryTemplate());
        } catch (RuntimeException e) {
            return "";
        }
    }

    /**
     * How many voices the transcriber should expect.
     *
     * <p><b>Only ever what a human chose.</b> These are hard constraints at the
     * provider: an exact count makes diarization find that many speakers
     * whether or not that many spoke. Recallix has an attendee count available
     * from calendar subscriptions and deliberately does not use it — an
     * invitation with four names is not four speakers, two of them were
     * listening, and a constraint derived from one would split a two-person
     * conversation into four people.
     */
    private Map<String, Object> speakerExpectation(Meeting meeting) {
        Integer low = meeting.getExpectedSpeakersMin();
        Integer high = meeting.getExpectedSpeakersMax();
        if (low == null && high == null) {
            return Map.of("mode", "auto");
        }
        if (low != null && low.equals(high)) {
            return Map.of("mode", "exact", "exact", low);
        }
        Map<String, Object> range = new java.util.LinkedHashMap<>();
        range.put("mode", "range");
        if (low != null) {
            range.put("minimum", low);
        }
        if (high != null) {
            range.put("maximum", high);
        }
        return range;
    }

    /**
     * The language to tell the transcriber to expect, or blank to detect.
     *
     * <p>This meeting's own answer wins over the account's. The account setting
     * is the right default and the wrong granularity for one French meeting in
     * an English workspace — and somebody who has just told us what language
     * *this* recording is in has said something more specific than a preference
     * they set months ago.
     *
     * <p>Never fatal. A profile that cannot be read is not a reason to refuse to
     * transcribe a recording somebody has already uploaded — detection is the
     * behaviour they had before the setting existed.
     */
    private String language(Meeting meeting) {
        String own = meeting.getSpokenLanguage();
        if (own != null && !own.isBlank()) {
            return own;
        }
        try {
            String code = users.require(meeting.getUserId()).getDefaultLanguage();
            return code == null ? "" : code;
        } catch (RuntimeException e) {
            return "";
        }
    }

    // --- reads -------------------------------------------------------------- //

    @Transactional(readOnly = true)
    public PageResponse<MeetingResponse> list(String userId, int page, int size,
                                              String search, String tag, MeetingStatus status,
                                              Instant from, Instant to, boolean unfiled) {
        // Filtered in the query rather than after the page is built. Narrowing a
        // page of twenty in memory would answer "meetings from July" with
        // whichever of the twenty most recent happened to fall in July — and
        // would report a total that counted the ones it had just hidden.
        Page<Meeting> result = meetings.search(
                userId,
                blankToNull(search),
                status == null ? null : status.name(),
                blankToNull(tag),
                from,
                to,
                unfiled,
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
        return toResponse(meetingId, summary);
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
        // Regenerated with the sections they were drawn from. Only replaced
        // when the worker returned some: an older worker sends none, and
        // clearing good chips because the answer was silent would be worse than
        // leaving slightly stale ones.
        if (!written.suggestions().isEmpty()) {
            summary.setSuggestions(written.suggestions());
        }
        // Freshly written from the current transcript, whatever it said before.
        summary.setStale(false);
        summaries.save(summary);
        // And every translation of the summary it replaces is now a translation
        // of prose nobody can see any more.
        translations.markStaleByMeetingId(meetingId);

        // The decisions and risks were read out of the sections that have just
        // been replaced, so leaving them would put the store and the notes in
        // disagreement — the one thing deriving them was meant to make
        // impossible. Corrections survive: only the derived rows are replaced.
        insights.deleteDerivedByMeetingId(meetingId);
        for (AiInsight i : written.insights()) {
            MeetingInsight e = new MeetingInsight();
            e.setId(IdGenerator.insight());
            e.setMeetingId(meetingId);
            e.setUserId(userId);
            e.setKind(i.kind());
            e.setText(i.text().trim());
            e.setSourceSection(i.sourceSection() == null ? "" : i.sourceSection());
            insights.save(e);
        }

        // Remembered on the meeting so a later reprocess keeps this shape.
        meeting.setSummaryTemplate(slug);
        audit.record(userId, "SUMMARY_RESUMMARIZED", "meeting", meetingId);
        // A genuinely separate event from the first write: it takes seconds and
        // people start it and switch tabs.
        notifications.summaryRewritten(meeting, slug);

        return toResponse(meetingId, summary);
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
            // The outline names speakers by design, so it now refers to labels
            // the transcript no longer contains.
            markSummaryStale(meetingId);
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
        markSummaryStale(meetingId);
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
        // Chat and search now answer from the corrected words; the summary still
        // asserts the old ones. Say so rather than letting the two disagree
        // silently.
        markSummaryStale(meetingId);
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

    /**
     * Say what language this meeting is in, and transcribe it again.
     *
     * <p>Setting the field without re-running would be a control that changes
     * nothing on screen: the transcript in front of the user is the one the
     * wrong language produced, and it is the reason they opened this. So the
     * two are one operation, and the UI says plainly what re-transcribing
     * costs — every manual correction on this transcript is about to be
     * replaced by a fresh one.
     *
     * <p>Blank clears the override and hands the meeting back to the account
     * default, which is how somebody undoes a wrong answer without having to
     * know what their account setting is.
     */
    @Transactional
    public ReprocessResponse setSpokenLanguage(String userId, String meetingId, String raw) {
        Meeting meeting = require(userId, meetingId);
        String code = raw == null ? "" : raw.trim();
        if (code.isEmpty()) {
            meeting.setSpokenLanguage(null);
        } else {
            // Refused rather than passed through. A code the transcriber does
            // not know is not a language it will fall back from gracefully —
            // it is an hour of audio transcribed as gibberish, discovered
            // twenty minutes later.
            meeting.setSpokenLanguage(Language.find(code)
                    .orElseThrow(() -> ApiException.badRequest(
                            "Recallix can only transcribe: "
                                    + String.join(", ", Language.all().stream()
                                            .map(Language::englishName).toList())))
                    .code());
        }
        audit.record(userId, "MEETING_LANGUAGE_SET", "meeting", meetingId);
        return reprocess(userId, meetingId);
    }

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
        // Everything downstream is about to be rewritten from the audio, so any
        // translation of it now describes text that is on its way out. Flagged
        // here rather than when the result lands, because from this moment on
        // nobody should read a translated page as current.
        translations.markStaleByMeetingId(meetingId);
        enqueueProcessing(meeting);
        audit.record(userId, "MEETING_REPROCESS", "meeting", meetingId);
        notifications.processingStarted(meeting, "reprocessed");
        return new ReprocessResponse(meetingId, MeetingStatus.QUEUED);
    }

    /**
     * Delete the meeting and everything about it.
     *
     * <p>Delegated to {@link ErasureService}, which owns all four grains of
     * deletion — audio, transcript, meeting, account. Keeping a second copy here
     * would mean the button and the nightly retention pass could quietly come to
     * disagree about what "deleted" includes.
     */
    @Transactional
    public void delete(String userId, String meetingId) {
        erasure.eraseMeeting(userId, meetingId);
    }

    // --- helpers ------------------------------------------------------------ //

    private static SummaryResponse toResponse(String meetingId, com.recallix.entity.MeetingSummary s) {
        return new SummaryResponse(meetingId, s.getShortSummary(),
                s.getDetailedSummary(), s.getKeyPoints(),
                s.getSections(), s.getQuotes(), s.getTemplateSlug(),
                s.getSuggestions(), s.isStale());
    }

    /**
     * Mark the summary, and every translation of it, as no longer matching the
     * transcript.
     *
     * <p>Called from every path that changes what the transcript says. Nothing
     * is rewritten here: doing so would put a model call behind a one-word
     * correction, and behind each of the next nineteen — and with translations
     * in the picture it would be one call per language on top. Flagging leaves
     * the choice with the person who can see both.
     *
     * <p>The translations matter more than the summary does, because they are
     * further from the source and there is nothing on a translated page that
     * would otherwise hint the words underneath have moved on. A meeting with no
     * summary and no translations is simply skipped.
     */
    private void markSummaryStale(String meetingId) {
        summaries.findFirstByMeetingIdOrderByCreatedAtDesc(meetingId)
                .ifPresent(s -> s.setStale(true));
        translations.markStaleByMeetingId(meetingId);
    }

    private MeetingResponse toResponse(Meeting m) {
        String audioUrl = m.getObjectKey() != null ? storage.presignDownload(m.getObjectKey()) : m.getAudioUrl();
        return new MeetingResponse(
                m.getId(), m.getTitle(), m.getStatus(),
                m.getTags(), audioUrl,
                m.getDurationSeconds(), m.getCreatedAt(), m.getErrorMessage(),
                m.getSourceType(), m.getSourceUrl(), m.getLanguage(),
                m.getSpokenLanguage(),
                m.getSummaryTemplate(), m.getContentType(), m.getProjectId(),
                m.getAudioDeletedAt(), m.getTranscriptDeletedAt(), m.getConsentConfirmedAt());
    }

    /**
     * Refuse anything that is not a recording.
     *
     * <p>PDFs used to be accepted and turned into a DOCUMENT meeting whose text
     * skipped transcription. They are not any more: a document nobody spoke is
     * not a meeting, and every feature downstream — speakers, timestamps,
     * playback, moments — had to special-case it into meaninglessness.
     */
    private void validateContentType(String contentType) {
        if (contentType == null || ALLOWED_PREFIXES.stream().noneMatch(contentType::startsWith)) {
            throw ApiException.badRequest("Only audio and video uploads are supported");
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
