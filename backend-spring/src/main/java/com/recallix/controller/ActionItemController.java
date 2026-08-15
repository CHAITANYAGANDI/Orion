package com.recallix.controller;

import com.recallix.dto.ActionItemCreateRequest;
import com.recallix.dto.ActionItemPatchRequest;
import com.recallix.dto.ActionItemResponse;
import com.recallix.dto.PageResponse;
import com.recallix.security.SecurityUtils;
import com.recallix.service.ActionItemService;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

@RestController
public class ActionItemController {

    private final ActionItemService actionItems;

    public ActionItemController(ActionItemService actionItems) {
        this.actionItems = actionItems;
    }

    @GetMapping("/api/v1/meetings/{id}/action-items")
    public List<ActionItemResponse> forMeeting(@PathVariable String id) {
        return actionItems.listForMeeting(SecurityUtils.currentUserId(), id);
    }

    /** Record a commitment the extraction pass missed — see the transcript's
     *  selection menu, which is where these come from. */
    @PostMapping("/api/v1/meetings/{id}/action-items")
    @ResponseStatus(HttpStatus.CREATED)
    public ActionItemResponse create(@PathVariable String id,
                                     @Valid @RequestBody ActionItemCreateRequest req) {
        return actionItems.create(SecurityUtils.currentUserId(), id, req);
    }

    @GetMapping("/api/v1/action-items")
    public PageResponse<ActionItemResponse> list(@RequestParam(defaultValue = "0") int page,
                                                 @RequestParam(defaultValue = "50") int size,
                                                 @RequestParam(required = false) String status,
                                                 @RequestParam(required = false) String priority) {
        return actionItems.list(SecurityUtils.currentUserId(), page, Math.min(size, 200), status, priority);
    }

    @PatchMapping("/api/v1/action-items/{id}")
    public ActionItemResponse patch(@PathVariable String id, @RequestBody ActionItemPatchRequest req) {
        return actionItems.patch(SecurityUtils.currentUserId(), id, req);
    }
}
