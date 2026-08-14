package com.recallix.controller;

import com.recallix.domain.MeetingStatus;
import com.recallix.dto.MeetingCreateRequest;
import com.recallix.dto.MeetingImportRequest;
import com.recallix.dto.MeetingResponse;
import com.recallix.dto.MeetingUpdateRequest;
import com.recallix.dto.PageResponse;
import com.recallix.dto.ReprocessResponse;
import com.recallix.dto.ResummarizeRequest;
import com.recallix.dto.SpeakerRematchRequest;
import com.recallix.dto.SpeakerRenameRequest;
import com.recallix.dto.SummaryResponse;
import com.recallix.dto.TranscriptEditRequest;
import com.recallix.dto.TranscriptResponse;
import com.recallix.dto.UploadUrlRequest;
import com.recallix.dto.UploadUrlResponse;
import com.recallix.security.SecurityUtils;
import com.recallix.service.MeetingService;
import jakarta.validation.Valid;
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

@RestController
@RequestMapping("/api/v1/meetings")
public class MeetingController {

    private final MeetingService meetings;

    public MeetingController(MeetingService meetings) {
        this.meetings = meetings;
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

    /** Import from a URL (YouTube) instead of uploading a file. */
    @PostMapping("/import")
    @ResponseStatus(HttpStatus.CREATED)
    public MeetingResponse importFromUrl(@Valid @RequestBody MeetingImportRequest req) {
        return meetings.importFromUrl(SecurityUtils.currentUserId(), req);
    }

    @GetMapping
    public PageResponse<MeetingResponse> list(@RequestParam(defaultValue = "0") int page,
                                              @RequestParam(defaultValue = "20") int size,
                                              @RequestParam(required = false) String search,
                                              @RequestParam(required = false) String tag,
                                              @RequestParam(required = false) MeetingStatus status) {
        return meetings.list(SecurityUtils.currentUserId(), page, Math.min(size, 100), search, tag, status);
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
     * called.
     */
    @PatchMapping("/{id}/speakers/rematch")
    public TranscriptResponse rematchSpeaker(@PathVariable String id,
                                             @Valid @RequestBody SpeakerRematchRequest req) {
        return meetings.rematchSpeaker(SecurityUtils.currentUserId(), id, req);
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

    @DeleteMapping("/{id}")
    public ResponseEntity<Void> delete(@PathVariable String id) {
        meetings.delete(SecurityUtils.currentUserId(), id);
        return ResponseEntity.noContent().build();
    }
}
