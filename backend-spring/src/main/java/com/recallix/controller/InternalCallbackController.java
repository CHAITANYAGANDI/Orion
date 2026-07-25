package com.recallix.controller;

import com.recallix.dto.callback.MeetingBriefResult;
import com.recallix.dto.callback.StatusCallbackRequest;
import com.recallix.service.CallbackService;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * FastAPI -> Spring callbacks (api-contracts §3). Authenticated by
 * {@code X-Internal-Token} via InternalTokenFilter, NOT a Clerk JWT.
 */
@RestController
@RequestMapping("/internal/meetings")
public class InternalCallbackController {

    private final CallbackService callback;

    public InternalCallbackController(CallbackService callback) {
        this.callback = callback;
    }

    @PostMapping("/{id}/status")
    public ResponseEntity<Void> status(@PathVariable String id, @RequestBody StatusCallbackRequest req) {
        callback.applyStatus(id, req);
        return ResponseEntity.ok().build();
    }

    @PostMapping("/{id}/result")
    public ResponseEntity<Void> result(@PathVariable String id, @RequestBody MeetingBriefResult result) {
        callback.applyResult(id, result);
        return ResponseEntity.ok().build();
    }
}
