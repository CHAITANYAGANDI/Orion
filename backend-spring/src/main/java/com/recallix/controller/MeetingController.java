package com.recallix.controller;

import com.recallix.domain.MeetingStatus;
import com.recallix.dto.DecisionResponse;
import com.recallix.dto.MeetingCreateRequest;
import com.recallix.dto.MeetingImportRequest;
import com.recallix.dto.MeetingResponse;
import com.recallix.dto.PageResponse;
import com.recallix.dto.ReprocessResponse;
import com.recallix.dto.ResummarizeRequest;
import com.recallix.dto.RiskResponse;
import com.recallix.dto.SpeakerRenameRequest;
import com.recallix.dto.SummaryResponse;
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

import java.util.List;

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
     * so only the summary call runs again. The extractions are untouched —
     * action items and decisions are facts about the meeting, not a choice of
     * layout.
     */
    @PostMapping("/{id}/summary")
    public SummaryResponse resummarize(@PathVariable String id,
                                       @Valid @RequestBody ResummarizeRequest req) {
        return meetings.resummarize(SecurityUtils.currentUserId(), id, req.template());
    }

    @GetMapping("/{id}/decisions")
    public List<DecisionResponse> decisions(@PathVariable String id) {
        return meetings.getDecisions(SecurityUtils.currentUserId(), id);
    }

    @GetMapping("/{id}/risks")
    public List<RiskResponse> risks(@PathVariable String id) {
        return meetings.getRisks(SecurityUtils.currentUserId(), id);
    }

    @PatchMapping("/{id}/speakers")
    public TranscriptResponse renameSpeakers(@PathVariable String id,
                                             @Valid @RequestBody SpeakerRenameRequest req) {
        return meetings.renameSpeakers(SecurityUtils.currentUserId(), id, req.mapping());
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
