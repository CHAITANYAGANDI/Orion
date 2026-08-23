package com.recallix.controller;

import com.recallix.domain.MeetingStatus;
import com.recallix.dto.MeetingCreateRequest;
import com.recallix.dto.MeetingLanguageRequest;
import com.recallix.dto.MeetingResponse;
import com.recallix.dto.MeetingUpdateRequest;
import com.recallix.dto.PageResponse;
import com.recallix.dto.ReprocessResponse;
import com.recallix.dto.ResummarizeRequest;
import com.recallix.dto.SpeakerRematchRequest;
import com.recallix.dto.SpeakerRematchResponse;
import com.recallix.dto.SpeakerRenameRequest;
import com.recallix.dto.SummaryResponse;
import com.recallix.dto.TranscriptEditRequest;
import com.recallix.dto.TranscriptResponse;
import com.recallix.dto.UploadUrlRequest;
import com.recallix.dto.UploadUrlResponse;
import com.recallix.security.SecurityUtils;
import com.recallix.service.ErasureService;
import com.recallix.service.MeetingService;
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
     * Fix diarization: merge a label that was split across two speakers, or
     * move individual turns to the person who actually said them.
     *
     * <p>Distinct from the rename above, which only changes what a label is
     * called, and from the rematch below, which is not manual at all. This
     * endpoint used to live at {@code /speakers/rematch} and was moved, because
     * that name has to mean the automatic operation — every other product uses
     * it that way, and a menu item called "Rematch speakers" that opened a pair
     * of merge dropdowns was answering a question nobody had asked.
     *
     * <p>The capability itself is unchanged and still needed: diarization
     * splitting one person across two labels is a different problem from not
     * knowing who they are, and no amount of voice matching fixes it.
     */
    @PatchMapping("/{id}/speakers/merge")
    public TranscriptResponse fixDiarization(@PathVariable String id,
                                             @Valid @RequestBody SpeakerRematchRequest req) {
        return meetings.fixDiarization(SecurityUtils.currentUserId(), id, req);
    }

    /**
     * Rematch speakers: identify the unresolved ones against known voices.
     *
     * <p>One click, no arguments, no dialog. Every speaker still labelled
     * "Speaker N" is compared acoustically against the voice profiles this
     * account has built by naming people in other meetings; the ones that are
     * confidently somebody get their name, and the rest are left exactly as they
     * were. Speakers a human has already named are never touched.
     *
     * <p>POST rather than PATCH because the request body is empty and the
     * caller is not describing a change — it is asking the server to work out
     * whether there is one to make. It may legitimately make none.
     *
     * <p>Returns a count rather than a transcript: the client invalidates and
     * refetches, and what it needs from this call is what to put in the toast.
     */
    @PostMapping("/{id}/speakers/rematch")
    public SpeakerRematchResponse rematchSpeakers(@PathVariable String id) {
        return meetings.rematchSpeakers(SecurityUtils.currentUserId(), id);
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
