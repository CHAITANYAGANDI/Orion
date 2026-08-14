package com.recallix.controller;

import com.recallix.dto.InsightRequest;
import com.recallix.dto.InsightResponse;
import com.recallix.security.SecurityUtils;
import com.recallix.service.InsightService;
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
 * A meeting's decisions and risks.
 *
 * <p>Both kinds live on one path because they differ by one field and nothing
 * else — same shape, same lifecycle, same permissions. The list returns both so
 * the meeting page makes one request and splits them for display, rather than
 * two requests that can arrive out of step with each other.
 */
@RestController
@RequestMapping("/api/v1")
public class InsightController {

    private final InsightService insights;

    public InsightController(InsightService insights) {
        this.insights = insights;
    }

    @GetMapping("/meetings/{meetingId}/insights")
    public List<InsightResponse> list(@PathVariable String meetingId) {
        return insights.list(SecurityUtils.currentUserId(), meetingId);
    }

    @PostMapping("/meetings/{meetingId}/insights")
    @ResponseStatus(HttpStatus.CREATED)
    public InsightResponse add(@PathVariable String meetingId,
                               @Valid @RequestBody InsightRequest req) {
        return insights.add(SecurityUtils.currentUserId(), meetingId, req);
    }

    @PatchMapping("/insights/{id}")
    public InsightResponse update(@PathVariable String id,
                                  @Valid @RequestBody InsightRequest req) {
        return insights.update(SecurityUtils.currentUserId(), id, req);
    }

    @DeleteMapping("/insights/{id}")
    public ResponseEntity<Void> delete(@PathVariable String id) {
        insights.delete(SecurityUtils.currentUserId(), id);
        return ResponseEntity.noContent().build();
    }
}
