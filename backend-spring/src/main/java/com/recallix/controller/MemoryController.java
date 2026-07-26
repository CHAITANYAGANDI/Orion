package com.recallix.controller;

import com.recallix.dto.CommitmentPatchRequest;
import com.recallix.dto.CommitmentResponse;
import com.recallix.dto.DecisionDriftResponse;
import com.recallix.dto.MemoryStatsResponse;
import com.recallix.dto.PageResponse;
import com.recallix.security.SecurityUtils;
import com.recallix.service.MemoryService;
import jakarta.validation.Valid;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/**
 * Meeting Memory: the commitment ledger and decision-drift findings.
 *
 * <p>Both are populated automatically as meetings complete; these endpoints are
 * read-mostly, with manual override on a commitment's status and dismissal of a
 * drift finding.
 */
@RestController
public class MemoryController {

    private final MemoryService memory;

    public MemoryController(MemoryService memory) {
        this.memory = memory;
    }

    @GetMapping("/api/v1/commitments")
    public PageResponse<CommitmentResponse> commitments(
            @RequestParam(defaultValue = "0") int page,
            @RequestParam(defaultValue = "50") int size,
            @RequestParam(required = false) String status) {
        return memory.list(SecurityUtils.currentUserId(), page, size, status);
    }

    @GetMapping("/api/v1/commitments/{id}")
    public CommitmentResponse commitment(@PathVariable String id) {
        return memory.get(SecurityUtils.currentUserId(), id);
    }

    @PatchMapping("/api/v1/commitments/{id}")
    public CommitmentResponse patchCommitment(@PathVariable String id,
                                              @Valid @RequestBody CommitmentPatchRequest req) {
        return memory.updateStatus(SecurityUtils.currentUserId(), id, req.status());
    }

    @GetMapping("/api/v1/decisions/drift")
    public List<DecisionDriftResponse> drift(
            @RequestParam(defaultValue = "false") boolean includeAcknowledged) {
        return memory.drift(SecurityUtils.currentUserId(), includeAcknowledged);
    }

    @PostMapping("/api/v1/decisions/drift/{id}/acknowledge")
    public ResponseEntity<Void> acknowledgeDrift(@PathVariable String id) {
        memory.acknowledgeDrift(SecurityUtils.currentUserId(), id);
        return ResponseEntity.noContent().build();
    }

    @GetMapping("/api/v1/memory/stats")
    public MemoryStatsResponse stats() {
        return memory.stats(SecurityUtils.currentUserId());
    }
}
