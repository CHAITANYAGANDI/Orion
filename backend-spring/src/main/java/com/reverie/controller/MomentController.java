package com.reverie.controller;

import com.reverie.dto.MomentRequest;
import com.reverie.dto.MomentResponse;
import com.reverie.security.SecurityUtils;
import com.reverie.service.MomentService;
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
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/**
 * Highlights, bookmarks, notes and reactions on a transcript.
 *
 * <p>All four kinds share one path for the same reason decisions and risks do
 * (see {@link InsightController}): the list is rendered as one stream over one
 * transcript, and splitting it into three requests would let a page draw
 * highlights from one moment and notes from another.
 */
@RestController
@RequestMapping("/api/v1")
public class MomentController {

    private final MomentService moments;

    public MomentController(MomentService moments) {
        this.moments = moments;
    }

    @GetMapping("/meetings/{meetingId}/moments")
    public List<MomentResponse> list(@PathVariable String meetingId) {
        return moments.list(SecurityUtils.currentUserId(), meetingId);
    }

    @PostMapping("/meetings/{meetingId}/moments")
    @ResponseStatus(HttpStatus.CREATED)
    public MomentResponse add(@PathVariable String meetingId,
                              @Valid @RequestBody MomentRequest req) {
        return moments.add(SecurityUtils.currentUserId(), meetingId, req);
    }

    /** Edits the body only — a note's text, a bookmark's label, or a reaction's emoji. */
    @PatchMapping("/moments/{id}")
    public MomentResponse update(@PathVariable String id,
                                 @Valid @RequestBody MomentRequest req) {
        return moments.updateBody(SecurityUtils.currentUserId(), id, req);
    }

    @DeleteMapping("/moments/{id}")
    public ResponseEntity<Void> delete(@PathVariable String id) {
        moments.delete(SecurityUtils.currentUserId(), id);
        return ResponseEntity.noContent().build();
    }
}
