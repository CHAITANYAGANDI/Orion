package com.reverie.controller;

import com.reverie.domain.MeetingStatus;
import com.reverie.dto.SegmentSpeakerRequest;
import com.reverie.dto.MeetingCreateRequest;
import com.reverie.dto.MeetingLanguageRequest;
import com.reverie.dto.MeetingResponse;
import com.reverie.dto.MeetingUpdateRequest;
import com.reverie.dto.PageResponse;
import com.reverie.dto.ReprocessResponse;
import com.reverie.dto.ResummarizeRequest;
import com.reverie.dto.SpeakerMergeRequest;
import com.reverie.dto.SpeakerRenameRequest;
import com.reverie.dto.SummaryResponse;
import com.reverie.dto.TranscriptEditRequest;
import com.reverie.dto.TranscriptResponse;
import com.reverie.dto.UploadUrlRequest;
import com.reverie.dto.UploadUrlResponse;
import com.reverie.security.SecurityUtils;
import com.reverie.service.ErasureService;
import com.reverie.service.MeetingService;
import jakarta.validation.Valid;
import org.springframework.format.annotation.DateTimeFormat;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

import java.time.Instant;
import java.util.Map;

@RestController
@RequestMapping("/api/v1/meetings")
public class MeetingController {

    private final MeetingService meetings;
    private final ErasureService erasure;

    public MeetingController(MeetingService meetings, ErasureService erasure) {
        this.meetings = meetings;
        this.erasure = erasure;
    }

    @PostMapping("/upload-url")
    public UploadUrlResponse uploadUrl(@Valid @RequestBody UploadUrlRequest req) {
        return meetings.createUploadUrl(SecurityUtils.currentUserId(), req);
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public MeetingResponse create(@Valid @RequestBody MeetingCreateRequest req) {
        return meetings.createMeeting(SecurityUtils.currentUserId(), req);
    }

    /**
     * The meeting list, optionally narrowed.
     *
     * <p>{@code from} and {@code to} are ISO-8601 instants and the window is
     * half-open: {@code from} inclusive, {@code to} exclusive. The client sends
     * absolute instants rather than a preset name because only the client knows
     * which midnight the user meant — "today" in Auckland is a different pair of
     * instants from "today" in Lisbon, and a server that guessed would show
     * somebody an empty list for the day they are living in.
     */
    @GetMapping
    public PageResponse<MeetingResponse> list(@RequestParam(defaultValue = "0") int page,
                                              @RequestParam(defaultValue = "20") int size,
                                              @RequestParam(required = false) String search,
                                              @RequestParam(required = false) String tag,
                                              @RequestParam(required = false) MeetingStatus status,
                                              @RequestParam(required = false)
                                              @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) Instant from,
                                              @RequestParam(required = false)
                                              @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) Instant to,
                                              @RequestParam(defaultValue = "false") boolean unfiled) {
        return meetings.list(SecurityUtils.currentUserId(), page, Math.min(size, 100),
                search, tag, status, from, to, unfiled);
    }

    @GetMapping("/{id}")
    public MeetingResponse get(@PathVariable String id) {
        return meetings.get(SecurityUtils.currentUserId(), id);
    }

    /**
     * Rename a meeting, or change its tags.
     *
     * <p>Uploading collects neither, so this is the only way either is set —
     * which is the point: both are things you know after listening, not before.
     */
    @PatchMapping("/{id}")
    public MeetingResponse update(@PathVariable String id,
                                  @Valid @RequestBody MeetingUpdateRequest req) {
        return meetings.updateMeeting(SecurityUtils.currentUserId(), id, req);
    }

    @GetMapping("/{id}/transcript")
    public TranscriptResponse transcript(@PathVariable String id) {
        return meetings.getTranscript(SecurityUtils.currentUserId(), id);
    }

    @GetMapping("/{id}/summary")
    public SummaryResponse summary(@PathVariable String id) {
        return meetings.getSummary(SecurityUtils.currentUserId(), id);
    }

    /**
     * Rewrite the summary under a different template.
     *
     * <p>Separate from reprocess, and much cheaper: the transcript is reused,
     * so only the summary call runs again. The action items are untouched —
     * they are facts about the meeting, not a choice of layout.
     */
    @PostMapping("/{id}/summary")
    public SummaryResponse resummarize(@PathVariable String id,
                                       @Valid @RequestBody ResummarizeRequest req) {
        return meetings.resummarize(SecurityUtils.currentUserId(), id, req.template());
    }

    @PatchMapping("/{id}/speakers")
    public TranscriptResponse renameSpeakers(@PathVariable String id,
                                             @Valid @RequestBody SpeakerRenameRequest req) {
        return meetings.renameSpeakers(SecurityUtils.currentUserId(), id, req.mapping());
    }


    /**
     * Correct what the transcriber heard, a batch of segments at a time.
     *
     * <p>Saving re-indexes the meeting so chat and search read the corrected
     * text. The summary is not regenerated — that is the separate re-summarize
     * call, so a typo fix does not silently cost a model call.
     */
    @PatchMapping("/{id}/segments")
    public TranscriptResponse editSegments(@PathVariable String id,
                                           @Valid @RequestBody TranscriptEditRequest req) {
        return meetings.editSegments(SecurityUtils.currentUserId(), id, req.edits());
    }

    /**
     * Move one turn, or part of one, to a different speaker.
     *
     * <p>Separate from {@code PATCH /speakers}, which renames a voice
     * everywhere it appears. This corrects an attribution and changes nothing
     * else, including nothing about any other turn.
     *
     * <p>Returns the whole transcript rather than the changed line: a partial
     * move splits one segment into three, so the client cannot patch its cache
     * from the response without reimplementing the split.
     */
    @PatchMapping("/{id}/segments/{segmentId}/speaker")
    public TranscriptResponse setSegmentSpeaker(@PathVariable String id,
                                                @PathVariable String segmentId,
                                                @Valid @RequestBody SegmentSpeakerRequest req) {
        return meetings.setSegmentSpeaker(SecurityUtils.currentUserId(), id, segmentId, req);
    }

    /**
     * Fold one speaker into another: two labels the provider gave one person.
     *
     * <p>Separate from {@code PATCH /speakers}, which renames a voice, and from
     * {@code PATCH /segments/{id}/speaker}, which moves one turn. This changes
     * who owns every turn of a whole label, which is the only one of the three
     * that can fix over-diarization.
     *
     * <p>POST rather than PATCH: the body does not describe a new state of a
     * speaker, it names an operation performed on two of them, and the result is
     * that one of them stops existing.
     *
     * <p>Returns the whole transcript, because a merge can touch any number of
     * turns anywhere in it.
     */
    @PostMapping("/{id}/speakers/merge")
    public TranscriptResponse mergeSpeakers(@PathVariable String id,
                                            @Valid @RequestBody SpeakerMergeRequest req) {
        return meetings.mergeSpeakers(SecurityUtils.currentUserId(), id, req);
    }

    @PostMapping("/{id}/reprocess")
    @ResponseStatus(HttpStatus.ACCEPTED)
    public ReprocessResponse reprocess(@PathVariable String id) {
        return meetings.reprocess(SecurityUtils.currentUserId(), id);
    }

    /**
     * Correct the language this meeting was held in, and transcribe it again.
     *
     * <p>202 rather than 200, and the same shape as {@code /reprocess}, because
     * that is what it is: the answer is a queued job, and the transcript the
     * caller is looking at is about to be replaced by a different one.
     */
    @PostMapping("/{id}/language")
    @ResponseStatus(HttpStatus.ACCEPTED)
    public ReprocessResponse setLanguage(@PathVariable String id,
                                         @Valid @RequestBody MeetingLanguageRequest req) {
        return meetings.setSpokenLanguage(SecurityUtils.currentUserId(), id, req.language());
    }

    /**
     * Erase the recording and keep everything drawn from it (V35).
     *
     * <p>The grain most people actually want. The audio is somebody's voice and
     * the largest thing we hold; the notes are what the meeting was for. 200 with
     * the timestamp rather than 204, because the page immediately has to say when
     * it happened.
     */
    @DeleteMapping("/{id}/audio")
    public Map<String, Instant> eraseAudio(@PathVariable String id) {
        return Map.of("audioDeletedAt",
                erasure.eraseAudio(SecurityUtils.currentUserId(), id));
    }

    /**
     * Erase the transcript, its marks, its translations and its embeddings.
     *
     * <p>The summary and action items survive — see {@code ErasureService} for
     * why that is the right line, and why the embeddings are on this side of it.
     */
    @DeleteMapping("/{id}/transcript")
    public Map<String, Instant> eraseTranscript(@PathVariable String id) {
        return Map.of("transcriptDeletedAt",
                erasure.eraseTranscript(SecurityUtils.currentUserId(), id));
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<Void> delete(@PathVariable String id) {
        meetings.delete(SecurityUtils.currentUserId(), id);
        return ResponseEntity.noContent().build();
    }
}
