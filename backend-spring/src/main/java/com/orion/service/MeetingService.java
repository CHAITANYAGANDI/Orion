package com.orion.service;

import com.orion.common.ApiException;
import com.orion.common.IdGenerator;
import com.orion.common.SpeakerLabels;
import com.orion.config.KafkaTopicsConfig;
import com.orion.domain.Language;
import com.orion.domain.SpokenWord;
import com.orion.domain.MeetingStatus;
import com.orion.domain.SourceType;
import com.orion.dto.MeetingCreateRequest;
import com.orion.dto.MeetingResponse;
import com.orion.dto.MeetingUpdateRequest;
import com.orion.dto.PageResponse;
import com.orion.dto.callback.AiInsight;
import com.orion.dto.ReprocessResponse;
import com.orion.dto.SegmentDto;
import com.orion.dto.SegmentSpeakerRequest;
import com.orion.dto.SpeakerRematchResponse;
import com.orion.dto.SpeakerStatsDto;
import com.orion.dto.SummaryResponse;
import com.orion.dto.TranscriptEditRequest;
import com.orion.dto.TranscriptResponse;
import com.orion.dto.UploadUrlRequest;
import com.orion.dto.UploadUrlResponse;
import com.orion.entity.Meeting;
import com.orion.entity.MeetingInsight;
import com.orion.entity.TranscriptSegment;
import com.orion.repository.MeetingInsightRepository;
import com.orion.repository.MeetingRepository;
import com.orion.repository.MeetingSummaryRepository;
import com.orion.repository.MeetingTranslationRepository;
import com.orion.repository.MeetingTranscriptRepository;
import com.orion.repository.ProjectRepository;
import com.orion.repository.TranscriptSegmentRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.List;
import java.util.ArrayList;
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
    private final NotificationService notifications;
    /** Only to verify a project id a client sent — see {@code createMeeting}. */
    private final ProjectRepository projects;
    /** Only to flag translations when the words underneath them change (V33). */
    private final MeetingTranslationRepository translations;
    /** Owns every grain of deletion, so the button and the retention pass agree (V35). */
    private final ErasureService erasure;
    private final UserService users;

    private final SpeakerIdentityService speakerIdentity;

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
                          ProjectRepository projects,
                          MeetingTranslationRepository translations,
                          NotificationService notifications,
                          ErasureService erasure,
                          UserService users,
                          SpeakerIdentityService speakerIdentity) {
        this.speakerIdentity = speakerIdentity;
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

        // Charged at confirmation (not at presign) so abandoned uploads are free.
        // Two allowances, both for the life of the account: transcription
        // minutes, and imports. `recordedHere` is what tells them apart — a
        // browser recording spends minutes only, a file spends one of three
        // imports as well. See UsageLimitService.
        usage.chargeMeetingOrThrow(userId, req.recordedHere(), req.durationSeconds());

        // The title was set from the filename at presign. Only a client with a
        // better name overrides it — the recorder, whose files are timestamps.
        String override = req.titleOverrideOrNull();
        if (override != null) {
            meeting.setTitle(override);
        }
        // A recording's name is a date, which is a placeholder rather than a
        // name: a dozen of them in a list cannot be told apart. The worker
        // writes a real one from the transcript, and this is the permission to
        // use it. An upload keeps its filename — dull is still chosen. See V52.
        meeting.setAutoTitle(req.recordedHere());
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
            // Named by a person now, so the worker must not rename it. This
            // matters most in the minute it is easiest to forget: somebody can
            // type a name while the recording is still being transcribed, and
            // the model's title arrives after theirs.
            meeting.setAutoTitle(false);
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
        // a system context with no user, and sending the value with the job
        // keeps that boundary intact. Blank means auto-detect, which is what
        // every account did before the setting existed.
        event.put("language", language(meeting));
        // What the recording is about, for transcription prompting -- pinned at
        // enqueue for the same reason, so a rename mid-run cannot change a
        // transcript halfway through.
        event.put("context", transcriptionContext(meeting));
        // How many voices to look for. Auto unless a human said otherwise.
        event.put("speakers", speakerExpectation(meeting));
        // Which run this is, fixed at the moment the job is created and carried
        // by the worker through every retry and redelivery of this message.
        //
        // The alternative -- letting the callbacks read the current number off
        // the meeting when they land -- is a race with reprocess. A result whose
        // response was lost comes back after the user has asked for the meeting
        // to be redone, reads the row, calls itself the new run, and spends that
        // run's AI-minute claim and notification keys on a transcript that is
        // already out of date.
        event.put("processingAttempt", meeting.getProcessingAttempt());

        outbox.enqueue(KafkaTopicsConfig.MEETING_UPLOADED, meeting.getId(), event);
    }

    /**
     * What Orion already knows about this recording, for the transcriber.
     *
     * <p>None of this is new information — the title, the project and the shape
     * of meeting were all sitting in the database while every transcription job
     * was submitted without them. Speech models guess, and they guess
     * differently when told the domain: "Kafka" over "coffee".
     *
     * <p>It used to carry a participant list too, taken from
     * {@code known_speakers} and used for prompting and keyterms. That feature
     * is gone and so is the list; the field stays on the event contract at its
     * empty default rather than being resent as something it is not.
     *
     * <p>Never fatal. A project that cannot be read is not a reason to refuse to
     * transcribe a recording somebody has already uploaded.
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
     * whether or not that many spoke. Orion has an attendee count available
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
        // Always a model call -- there is no cached answer to hand back, since
        // the point of asking is that the existing one is wrong.
        usage.requireAiOrThrow(userId, UsageLimitService.AiFeature.RESUMMARIZE);
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
                    var fresh = new com.orion.entity.MeetingSummary();
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

    /**
     * Rename transcript speaker labels (e.g. {"Speaker 1":"Alice"}).
     *
     * <p><b>The mapping arrives keyed by display name and is applied by
     * canonical key.</b> The client can only name what it can see, but "every
     * turn labelled Speaker 2" and "every turn spoken by the second person to
     * speak" are not the same set the moment anything has been merged or
     * reassigned — and it is the second one the user means. So the labels are
     * resolved to {@code speakerKey}s first, and the rename is applied to those.
     * Segments written before V46 have no key and fall back to matching on the
     * name, exactly as this always did.
     *
     * <p>The key itself is never touched. That is what keeps a speaker's colour,
     * their talk-time row and their voiceprint attached to them across a rename:
     * the display name is the only thing that changes, which is the whole point
     * of having two fields.
     *
     * <p>A rename is also the one moment a human states, about audio they own,
     * that a particular voice is a particular person. For an account that has
     * switched speaker learning on, that is when a voice profile is learned —
     * see {@link SpeakerIdentityService}. Nothing is learned otherwise, and
     * automatic identification never learns at all.
     */
    @Transactional
    public TranscriptResponse renameSpeakers(String userId, String meetingId, Map<String, String> mapping) {
        require(userId, meetingId);
        var segs = segments.findByMeetingIdOrderByStartTimeAsc(meetingId);

        // Which canonical speakers the named labels belong to, resolved before
        // anything is written — once the first segment is renamed, the label
        // the user asked about no longer exists to match on.
        Map<String, String> keyToName = new java.util.LinkedHashMap<>();
        for (var seg : segs) {
            String wanted = mapping.get(seg.getSpeaker());
            if (wanted == null || wanted.isBlank() || seg.getSpeakerKey() == null) {
                continue;
            }
            keyToName.putIfAbsent(seg.getSpeakerKey(), wanted.trim());
        }

        boolean changed = false;
        for (var seg : segs) {
            String byKey = seg.getSpeakerKey() == null ? null : keyToName.get(seg.getSpeakerKey());
            String mapped = byKey != null ? byKey : mapping.get(seg.getSpeaker());
            if (mapped != null && !mapped.isBlank() && !mapped.trim().equals(seg.getSpeaker())) {
                seg.setSpeaker(mapped.trim());
                changed = true;
            }
        }
        // Retrieval passages are stored as "Speaker 1: ...", so a rename that
        // is not re-indexed leaves chat answering with the old label — and
        // citing a name the transcript no longer shows anywhere.
        if (changed) {
            // The flat transcript carries the prefixes too, and the export reads
            // it. It used to be left alone here while a rematch rewrote it,
            // which meant a rename quietly desynchronised the two.
            transcripts.findFirstByMeetingIdOrderByCreatedAtDesc(meetingId)
                    .ifPresent(t -> t.setTranscriptText(joinSegments(segs)));
            reindex(userId, meetingId, segs);
            // The outline names speakers by design, so it now refers to labels
            // the transcript no longer contains.
            markSummaryStale(meetingId);
            // Speaker NAMING: the user has said *whose* a voice is, so the
            // account's named profile for that person is updated from this
            // meeting's audio. Deliberately the opposite of what
            // `setSegmentSpeaker` does -- that one says *where* a voice belongs
            // and therefore throws the meeting's voiceprints away rather than
            // learning from them. Renaming does not move a single span, so the
            // cache is still an accurate description of who said what.
            learnFromRename(userId, meetingId, segs, keyToName);
        }
        audit.record(userId, "SPEAKERS_RENAMED", "meeting", meetingId);
        return getTranscript(userId, meetingId);
    }

    /**
     * Remember the voices behind the names somebody just typed.
     *
     * <p>Only for an account that has opted in, only for names that are actually
     * names — renaming "Speaker 3" to "Speaker 2" is a merge, not an
     * identification — and never fatally. The rename is the user's edit and has
     * already been applied; failing it because an enrolment could not run would
     * be the wrong end of the stick.
     */
    private void learnFromRename(String userId, String meetingId,
                                 List<TranscriptSegment> segs, Map<String, String> renamed) {
        if (renamed.isEmpty() || !speakerIdentity.learningEnabled(userId)) {
            return;
        }
        var meeting = meetings.findByIdAndUserId(meetingId, userId).orElse(null);
        if (meeting == null) {
            return;
        }
        var turns = speakerIdentity.turnsOf(segs);
        for (var entry : renamed.entrySet()) {
            if (SpeakerLabels.isUnresolved(entry.getValue())) {
                continue;
            }
            ai.learnSpeaker(userId, meetingId, meeting.getObjectKey(),
                    entry.getKey(), entry.getValue(), turns);
        }
    }

    /**
     * Re-evaluate the unresolved speakers in this meeting against known voices.
     *
     * <p>This is what "Rematch speakers" does. It is one operation with no
     * arguments: every speaker still wearing a generated label is compared
     * acoustically against the profiles this account has built by naming people
     * in other meetings, and the ones that are confidently somebody are renamed.
     *
     * <p><b>What it will not do</b>, because each of these is a way of being
     * confidently wrong:
     * <ul>
     *   <li>touch a speaker somebody has already named — manual names and names
     *       from an earlier rematch are both left exactly alone;
     *   <li>touch an unattributed turn, which has no voice of its own to match;
     *   <li>rename on a weak match, or on a match that is barely ahead of the
     *       next candidate;
     *   <li>match by speaker number, by position, by the provider's cluster
     *       letters, or by anything said in the transcript. Identity here is an
     *       acoustic question and is answered acoustically or not at all.
     * </ul>
     *
     * <p>Renaming nobody is a normal, common and correct outcome, and it is
     * reported as such rather than as a failure.
     */
    @Transactional
    public SpeakerRematchResponse rematchSpeakers(String userId, String meetingId) {
        var meeting = require(userId, meetingId);
        if (!speakerIdentity.learningEnabled(userId)) {
            return SpeakerRematchResponse.unavailable(
                    "Turn on speaker matching in Settings to identify speakers automatically.");
        }

        var segs = segments.findByMeetingIdOrderByStartTimeAsc(meetingId);
        if (segs.isEmpty()) {
            return SpeakerRematchResponse.none(0);
        }

        // Here rather than at the top, so the two answers above still get
        // through. "Turn on speaker matching in Settings" tells somebody what to
        // do about it; being told the account is out of minutes instead would
        // send them looking for the wrong problem -- and neither of those paths
        // asks the model for anything.
        usage.requireAiOrThrow(userId, UsageLimitService.AiFeature.SPEAKER_REMATCH);

        var turns = speakerIdentity.turnsOf(segs);
        var result = ai.identifySpeakers(userId, meetingId, meeting.getObjectKey(), turns);
        if (!result.ran()) {
            return SpeakerRematchResponse.unavailable(result.unavailable());
        }
        if (result.matches().isEmpty()) {
            return SpeakerRematchResponse.none(result.considered());
        }

        Map<String, String> byKey = new java.util.LinkedHashMap<>();
        for (var match : result.matches()) {
            byKey.put(match.speakerKey(), match.displayName());
        }

        List<String> named = new ArrayList<>();
        boolean changed = false;
        for (var seg : segs) {
            String name = seg.getSpeakerKey() == null ? null : byKey.get(seg.getSpeakerKey());
            // Belt to the matcher's braces. It was told which labels were
            // unresolved and is trusted not to propose the others, but this is
            // the line between "a bad match" and "overwrote the name a user
            // typed", and it is cheap to make that second thing impossible here.
            if (name == null || !SpeakerLabels.isUnresolved(seg.getSpeaker())) {
                continue;
            }
            if (!name.equals(seg.getSpeaker())) {
                seg.setSpeaker(name);
                changed = true;
                if (!named.contains(name)) {
                    named.add(name);
                }
            }
        }

        if (!changed) {
            return SpeakerRematchResponse.none(result.considered());
        }

        // Same tail as any other change to who said what: the flat transcript
        // carries the speaker prefixes and the export reads it, the retrieval
        // passages carry them too and chat reads those, and the outline names
        // speakers so it is now out of date.
        transcripts.findFirstByMeetingIdOrderByCreatedAtDesc(meetingId)
                .ifPresent(t -> t.setTranscriptText(joinSegments(segs)));
        reindex(userId, meetingId, segs);
        markSummaryStale(meetingId);
        audit.record(userId, "SPEAKERS_REMATCHED", "meeting", meetingId);
        return new SpeakerRematchResponse(named.size(), named, result.considered(), null);
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
     * Move one turn, or part of one, to a different speaker.
     *
     * <p>The manual answer to a diarization mistake. Automatic diarization is
     * not perfect and the known short-turn case is a model limitation, not a
     * bug in this code: a provider that buries "Yes, sir." inside the other
     * person's utterance gives Orion nothing to split on. This is how a
     * human fixes it, and it is deliberately the *only* thing that changes when
     * they do.
     *
     * <h2>What it touches, and what it must not</h2>
     *
     * <p>Exactly the words named. No neighbouring turn is merged, re-split or
     * relabelled, and no other occurrence of the same speaker is touched. A
     * correction that "helpfully" applied itself elsewhere would be
     * unreviewable — the user can see one line, not the forty the rule fired
     * on.
     *
     * <p>It also does not teach a voice. {@code learnFromRename} enrols a
     * voiceprint when somebody puts a *name* to a speaker, which is a statement
     * about who that voice is. Moving a turn is the opposite: a statement that
     * these words were misattributed. Feeding that audio into a voiceprint
     * would train the model on the very mistake being corrected, so Rematch
     * learning is left strictly alone here.
     *
     * <p>Everything downstream of the segments does move, because they all
     * carry the speaker: the flat transcript (which the export reads), the
     * retrieval index (which chat cites), and the speaker statistics (derived
     * at read time from these same rows, so they follow for free). The summary
     * is marked stale rather than regenerated — it names speakers, so it may
     * now disagree, and silently spending a model call on a one-line fix is
     * worse than saying so.
     *
     * <h2>It can be refused</h2>
     *
     * <p>A correction that really moves something first invalidates this
     * meeting's cached voiceprints, and it will not save unless that deletion
     * is confirmed — a 503 if it cannot be, with nothing written. Unusual for an
     * edit, and deliberate: the cache is keyed on speaker, so a correction that
     * lands while a stale vector survives leaves a Rematch able to attach a real
     * person's name to the wrong voice. Refusing costs the user a retry.
     * Accepting costs them a wrong answer they have no way to see coming.
     *
     * @throws ApiException 503 when the voiceprint invalidation cannot be
     *                      confirmed; the transaction rolls back and the
     *                      transcript is untouched
     */
    @Transactional
    public TranscriptResponse setSegmentSpeaker(String userId, String meetingId,
                                                String segmentId, SegmentSpeakerRequest req) {
        require(userId, meetingId);
        var segs = segments.findByMeetingIdOrderByStartTimeAsc(meetingId);

        var target = segs.stream()
                .filter(x -> x.getId().equals(segmentId))
                .findFirst()
                .orElseThrow(() -> ApiException.badRequest(
                        "That line is not part of this meeting; reload the transcript and try again"));

        // The destination has to be a speaker this meeting already has. Anything
        // else would invent a participant from a typo in a request body.
        String key = req.speakerKey().trim();
        String name = segs.stream()
                .filter(x -> key.equals(x.getSpeakerKey()))
                .map(TranscriptSegment::getSpeaker)
                .filter(n -> n != null && !n.isBlank())
                .findFirst()
                .orElseThrow(() -> ApiException.badRequest(
                        "There is no such speaker in this meeting"));

        // Asked before anything is touched, because the invalidation below has
        // to come first and must not be spent on a request that changes nothing
        // or is about to be refused. An invalid range is rejected here, so a bad
        // request stays a bad request rather than becoming a wasted deletion.
        if (!movesAnything(target, req, key)) {
            // The segment was already attributed that way. Nothing moved, so
            // nothing cached about this meeting has gone out of date -- and
            // throwing away good voiceprints costs a re-embed of the whole
            // recording on the next rematch.
            return getTranscript(userId, meetingId);
        }

        // Past this line the attribution really changed, so the acoustic cache
        // is now wrong. Voiceprints are keyed on (meeting_id, speaker_key) and
        // were built from the spans that key owned AT THE TIME -- which is
        // exactly what the user has just told us was incorrect.
        //
        //   spk_1: [Alice] [Alice] [Cindy]   <-- the third span is misattributed
        //   spk_2: [Cindy]
        //
        // A voiceprint for spk_1 is an average of two Alices and a Cindy. Moving
        // that third span to spk_2 fixes the transcript and leaves the average
        // untouched, so the next "Rematch speakers" compares a blended vector
        // against the account's named profiles and can put a real person's name
        // on the wrong voice -- the one failure the whole feature exists to
        // avoid, arriving through the correction that was supposed to prevent it.
        //
        // Dropped rather than recomputed: recomputing needs the audio decoded
        // and the model loaded, which is seconds of work for a correction the
        // user expects to be instant. The next rematch rebuilds only what it
        // actually needs.
        //
        // NOTE: this is speaker CORRECTION -- "that line was the other person".
        // It invalidates the acoustic cache and teaches nothing, because the
        // user has said where a voice belongs, not whose it is.
        //
        // Speaker NAMING -- "that person is Priya" -- is the other operation, in
        // `rename` above: it feeds `learnSpeakers`, which updates the account's
        // named speaker profile from this meeting's audio. The two look similar
        // on screen and must not be confused here: learning from a diarization
        // correction would fold a span the user just disowned into a real
        // person's stored voice.
        //
        // Required, not best-effort, and first. If the deletion cannot be
        // confirmed this throws and the correction is refused: the transaction
        // rolls back, nothing here has written anything yet, and the user is
        // told to try again. That is a worse minute than a silent save and a
        // better week -- a correction saved over a surviving stale vector is
        // invisible until Rematch puts somebody's name on the wrong voice, and
        // by then nothing in the transcript records that it happened.
        // `forgetMeeting` (best-effort) is still what erasure and account
        // closure use, where finishing matters more than confirming.
        speakerIdentity.invalidateMeetingVoiceprintsRequired(userId, meetingId);

        // Only now is anything mutated. `moveWholeSegment` writes through to a
        // managed entity, so building the replacement before the line above
        // would leave a failed correction holding half-changed rows in the
        // persistence context and relying on rollback to undo them.
        List<TranscriptSegment> replacement = req.isPartial()
                ? splitForSpeaker(target, req, key, name)
                : moveWholeSegment(target, key, name);

        if (replacement.isEmpty()) {
            // Belt and braces: `movesAnything` said this would move something,
            // so reaching here means the two disagreed. Harmless if they ever
            // do -- the cost is one wasted re-embed on the next rematch, not a
            // wrong answer -- and quietly returning beats saving nothing while
            // claiming otherwise.
            return getTranscript(userId, meetingId);
        }

        if (replacement.size() > 1) {
            // A split: the original row is replaced by the pieces. Deleted and
            // re-inserted rather than mutated in place because one row cannot
            // become three, and the pieces need their own ids so a later edit
            // can address them.
            segments.delete(target);
            segments.saveAll(replacement);
        }

        // Re-read after a split so the flat transcript and the index are built
        // from the pieces rather than from the row that no longer exists.
        final var rows = replacement.size() > 1
                ? segments.findByMeetingIdOrderByStartTimeAsc(meetingId)
                : segs;

        transcripts.findFirstByMeetingIdOrderByCreatedAtDesc(meetingId)
                .ifPresent(t -> t.setTranscriptText(joinSegments(rows)));
        reindex(userId, meetingId, rows);
        markSummaryStale(meetingId);
        audit.record(userId, "SEGMENT_SPEAKER_CORRECTED", "meeting", meetingId);
        return getTranscript(userId, meetingId);
    }

    /**
     * Would this request actually move anything -- and is it even askable?
     *
     * <p>Separated from the movers below because the answer is needed before
     * they run: this meeting's cached voiceprints are invalidated before a
     * single segment is touched, and dropping them for a no-op would cost a
     * re-embed of the whole recording for nothing.
     *
     * <p>The range validation lives in {@link #wordRange}, which the split
     * itself also uses, so the two cannot drift into disagreeing about what a
     * valid range is -- which would show up as a correction that invalidated
     * the cache and then threw.
     */
    private boolean movesAnything(TranscriptSegment seg, SegmentSpeakerRequest req, String key) {
        boolean alreadyTheirs = key.equals(seg.getSpeakerKey());
        if (!req.isPartial()) {
            return !alreadyTheirs;
        }
        int[] range = wordRange(seg, req);
        boolean wholeLine = range[0] == 0 && range[1] == seg.getWords().size() - 1;
        // A range covering every word is a whole-line move by another name, and
        // moving a line to the speaker it already has does nothing. A sub-range
        // is a split: even when those words keep the speaker they had, the row
        // is replaced by pieces with their own ids and timings, which is a real
        // change to the transcript and is treated as one.
        return !(wholeLine && alreadyTheirs);
    }

    /**
     * The words this request addresses, validated. {@code [from, to]}, inclusive.
     *
     * <p>Null ends mean the whole line. Refused rather than clamped: a range
     * that runs past the end of the line is a client out of step with the
     * transcript it is editing, and moving the nearest words instead would
     * relabel something the user did not select.
     */
    private static int[] wordRange(TranscriptSegment seg, SegmentSpeakerRequest req) {
        var words = seg.getWords();
        if (words == null || words.isEmpty()) {
            throw ApiException.badRequest(
                    "This line has no word timings, so only the whole line can be moved");
        }
        int from = req.fromWord() == null ? 0 : req.fromWord();
        int to = req.toWord() == null ? words.size() - 1 : req.toWord();
        if (from > to || to >= words.size()) {
            throw ApiException.badRequest("That is not a valid range of words in this line");
        }
        return new int[] {from, to};
    }

    /**
     * The whole turn moves. Returns the mutated segment, or nothing if it was
     * already attributed that way.
     */
    private List<TranscriptSegment> moveWholeSegment(TranscriptSegment seg,
                                                     String key, String name) {
        if (key.equals(seg.getSpeakerKey())) {
            return List.of();
        }
        seg.setSpeakerKey(key);
        seg.setSpeaker(name);
        // A human has said whose this is, so it is attributed even if the
        // provider had given up on it.
        seg.setSpeakerStatus("attributed");
        seg.setWords(reattributeWords(seg.getWords(), 0, seg.getWords().size() - 1, key, name));
        return List.of(seg);
    }

    /**
     * Part of a turn moves, so the turn becomes two or three.
     *
     * <p>Split on word boundaries and timed from the words themselves, because
     * those are the only points in the utterance that correspond to anything in
     * the audio. A segment with no word timings cannot be split at all and says
     * so, rather than cutting the text at a character offset and producing a
     * turn whose start time is a guess.
     */
    private List<TranscriptSegment> splitForSpeaker(TranscriptSegment seg,
                                                    SegmentSpeakerRequest req,
                                                    String key, String name) {
        int[] range = wordRange(seg, req);
        var words = seg.getWords();
        int from = range[0];
        int to = range[1];
        if (from == 0 && to == words.size() - 1) {
            return moveWholeSegment(seg, key, name);
        }

        List<TranscriptSegment> out = new ArrayList<>();
        if (from > 0) {
            out.add(pieceOf(seg, words.subList(0, from),
                    seg.getSpeakerKey(), seg.getSpeaker(), seg.getSpeakerStatus()));
        }
        out.add(pieceOf(seg, words.subList(from, to + 1), key, name, "attributed"));
        if (to < words.size() - 1) {
            out.add(pieceOf(seg, words.subList(to + 1, words.size()),
                    seg.getSpeakerKey(), seg.getSpeaker(), seg.getSpeakerStatus()));
        }
        return out;
    }

    /** One piece of a split segment: its own row, its own id, its own timings. */
    private TranscriptSegment pieceOf(TranscriptSegment source, List<SpokenWord> words,
                                      String key, String name, String status) {
        var piece = new TranscriptSegment();
        piece.setId(IdGenerator.segment());
        piece.setMeetingId(source.getMeetingId());
        piece.setStartTime(words.get(0).start());
        piece.setEndTime(words.get(words.size() - 1).end());
        piece.setSpeaker(name);
        piece.setSpeakerKey(key);
        piece.setSpeakerStatus(status == null ? "attributed" : status);
        // The provider's own token stays with the words it came from, so a
        // complaint about this line is still traceable to whoever caused it.
        piece.setSpeakerRaw(source.getSpeakerRaw());
        piece.setLanguage(source.getLanguage());
        piece.setWords(reattributeWords(words, 0, words.size() - 1, key, name));
        piece.setText(joinWords(words));
        return piece;
    }

    /**
     * Per-word attribution follows the turn it now belongs to.
     *
     * <p>The words carry their own speaker (V46) and the diarization trace reads
     * them, so leaving them saying "spk_2" under a line labelled Speaker 1 would
     * make the record contradict itself.
     */
    private static List<SpokenWord> reattributeWords(List<SpokenWord> words, int from, int to,
                                                     String key, String name) {
        if (words == null || words.isEmpty()) {
            return List.of();
        }
        List<SpokenWord> out = new ArrayList<>(words.size());
        for (int i = 0; i < words.size(); i++) {
            var w = words.get(i);
            out.add(i >= from && i <= to
                    ? new SpokenWord(w.text(), w.start(), w.end(), key, w.speakerRaw())
                    : w);
        }
        return out;
    }

    /** The words of one piece, as the line a reader sees. */
    private static String joinWords(List<SpokenWord> words) {
        return words.stream()
                .map(SpokenWord::text)
                .map(String::trim)
                .filter(t -> !t.isEmpty())
                .collect(Collectors.joining(" "));
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
            // Which run the correction belongs to. Chunks are stored per run and
            // retrieval reads the newest, so an edit filed under an older one
            // would be invisible and chat would carry on answering with the name
            // that was just fixed.
            //
            // The same lookup every caller here already made, so it is the
            // persistence context answering rather than a second query — and
            // tenant-scoped, so this cannot read an attempt off somebody else's
            // meeting on the way past.
            int attempt = meetings.findByIdAndUserId(meetingId, userId)
                    .map(Meeting::getProcessingAttempt)
                    .orElse(1);
            ai.reindex(userId, meetingId, attempt, joinSegments(segs),
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
                            "Orion can only transcribe: "
                                    + String.join(", ", Language.all().stream()
                                            .map(Language::englishName).toList())))
                    .code());
        }
        audit.record(userId, "MEETING_LANGUAGE_SET", "meeting", meetingId);
        return reprocess(userId, meetingId);
    }

    /**
     * Run the whole pipeline again over the same audio.
     *
     * <p>Refusable, and in three ways. No source to re-read is a 400; a spent
     * minute allowance is a 429; and a meeting whose cached voiceprints cannot
     * be dropped is a 503 — see the invalidation below for why that one is
     * fatal rather than logged. All three refuse before the status moves, so a
     * refused reprocess never leaves a meeting reading "Processing" over a job
     * nobody started.
     *
     * @throws ApiException 503 when the voiceprint invalidation cannot be
     *                      confirmed; the transaction rolls back and the meeting
     *                      is left exactly as it was
     */
    @Transactional
    public ReprocessResponse reprocess(String userId, String meetingId) {
        Meeting meeting = require(userId, meetingId);
        // A URL import has no object key — the worker re-downloads from the
        // source instead — so either one is enough to re-run the pipeline.
        if (meeting.getObjectKey() == null && meeting.getSourceUrl() == null) {
            throw ApiException.badRequest("Meeting has no source to reprocess");
        }
        // The one on this list that genuinely re-transcribes: the whole
        // recording goes through the provider again, and the minutes are
        // charged again when it lands. Refusing it on a spent account is not a
        // policy choice about AI features -- it is the minute allowance doing
        // exactly what it counts.
        usage.requireAiOrThrow(userId, UsageLimitService.AiFeature.REPROCESS);
        // The cached voiceprints go now, and this is not housekeeping.
        //
        // A voiceprint is filed under a meeting-local speaker key, and a
        // reprocess re-derives those keys from scratch by first appearance. The
        // audio has not changed, but who ends up as spk_1 can: a re-clustering
        // that splits an early interjection differently is enough.
        //
        //   before:  spk_1 = Alice   spk_2 = Cindy
        //   after:   spk_1 = Cindy   spk_2 = Alice
        //
        // Left in place, the cache hands the previous occupant's voice to the
        // new one and the next rematch names each of them after the other --
        // confidently, because the vectors are perfectly good vectors filed
        // under the wrong keys. The exact failure this feature is arranged to
        // avoid, arriving through the back door.
        //
        // Required rather than best-effort, for the reason manual correction is:
        // swallowing this failure saves a reprocess whose result depends on a
        // deletion that did not happen. A confirmed deletion of zero rows is a
        // success -- a meeting nobody ever rematched has nothing cached, and
        // refusing that would refuse most reprocesses.
        //
        // Named profiles are untouched. They belong to the account, not to this
        // meeting, which is why a rematch can put every name back afterwards.
        //
        // ORDERING, both halves deliberate:
        //
        // *After* the allowance check, so a reprocess that is about to be
        // refused for a spent account does not cost the user their cached
        // voiceprints on the way out. The check spends nothing and writes
        // nothing, so running it first is free.
        //
        // *Before* the row lock below, because this is a call over the network
        // to another service. Taking the lock first would hold `FOR NO KEY
        // UPDATE` on the meeting row for the whole round trip -- and for the
        // whole of a timeout, when the far end is the thing that is wrong --
        // blocking every other reprocess and erasure of that meeting behind it.
        // Nothing has been written yet at this point, so there is no dirty
        // entity for a flush to sneak out ahead of the lock.
        speakerIdentity.invalidateMeetingVoiceprintsRequired(userId, meetingId);
        // Take the row before writing anything to it, and take the run number
        // from the row rather than from the entity in memory. Two people
        // pressing Reprocess at the same moment used to read the same N and
        // both write N+1, handing two live pipeline runs a single identity --
        // and every stale-callback check in the system is that identity. See
        // MeetingRepository.lockAndReadAttempt.
        //
        // Everything after this point writes the meeting, so this is also where
        // the row lock has to be taken: a flush before it would grab the row
        // with the stale number already in hand.
        int previousRun = meetings.lockAndReadAttempt(meetingId)
                .orElse(meeting.getProcessingAttempt());
        meeting.setStatus(MeetingStatus.QUEUED);
        meeting.setErrorMessage(null);
        // A new run, and deliberately a new identity for it. Everything the
        // previous run's completion claimed -- its AI-minute charge, its
        // "Summary ready" -- was keyed to the old number, so this one charges
        // and notifies again while a late redelivery of the old one does not.
        meeting.setProcessingAttempt(previousRun + 1);
        // Everything downstream is about to be rewritten from the audio, so any
        // translation of it now describes text that is on its way out. Flagged
        // here rather than when the result lands, because from this moment on
        // nobody should read a translated page as current.
        translations.markStaleByMeetingId(meetingId);
        enqueueProcessing(meeting);
        audit.record(userId, "MEETING_REPROCESS", "meeting", meetingId);
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

    private static SummaryResponse toResponse(String meetingId, com.orion.entity.MeetingSummary s) {
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
