package com.recallix.controller;

import com.recallix.dto.ActionItemBulkRequest;
import com.recallix.dto.ActionItemCommentRequest;
import com.recallix.dto.ActionItemCommentResponse;
import com.recallix.dto.ActionItemCreateRequest;
import com.recallix.dto.ActionItemOverview;
import com.recallix.dto.ActionItemPatchRequest;
import com.recallix.dto.ActionItemQuery;
import com.recallix.dto.ActionItemResponse;
import com.recallix.dto.PageResponse;
import com.recallix.security.SecurityUtils;
import com.recallix.service.ActionItemService;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;

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

    /** Record a commitment the extraction pass missed — from the transcript's
     *  selection menu, or typed straight into the meeting's action items. */
    @PostMapping("/api/v1/meetings/{id}/action-items")
    @ResponseStatus(HttpStatus.CREATED)
    public ActionItemResponse create(@PathVariable String id,
                                     @Valid @RequestBody ActionItemCreateRequest req) {
        return actionItems.create(SecurityUtils.currentUserId(), id, req);
    }

    /**
     * The workspace tracker.
     *
     * <p>Defaults to everything outstanding rather than everything ever: the
     * page is opened to find out what is left, and a first screen of finished
     * work from six months ago answers a question nobody asked.
     */
    @GetMapping("/api/v1/action-items")
    public PageResponse<ActionItemResponse> list(@RequestParam(defaultValue = "0") int page,
                                                 @RequestParam(defaultValue = "50") int size,
                                                 @RequestParam(defaultValue = "OPEN_ANY") String status,
                                                 @RequestParam(required = false) String priority,
                                                 @RequestParam(required = false) String owner,
                                                 @RequestParam(required = false) String due,
                                                 @RequestParam(required = false) String meetingId,
                                                 @RequestParam(defaultValue = "false") boolean mine) {
        return actionItems.list(SecurityUtils.currentUserId(),
                new ActionItemQuery(status, priority, owner, due, meetingId, mine, page, size));
    }

    /** Tab counts, the owner filter's values, and the caller's own name. */
    @GetMapping("/api/v1/action-items/overview")
    public ActionItemOverview overview() {
        return actionItems.overview(SecurityUtils.currentUserId());
    }

    @PatchMapping("/api/v1/action-items/{id}")
    public ActionItemResponse patch(@PathVariable String id,
                                    @Valid @RequestBody ActionItemPatchRequest req) {
        return actionItems.patch(SecurityUtils.currentUserId(), id, req);
    }

    /**
     * One status, many items.
     *
     * <p>Returns the number changed rather than the changed rows: the client
     * refetches the list anyway — the filter it is showing may no longer match
     * what was just completed — and echoing two hundred items back would be a
     * payload nobody reads.
     */
    @PatchMapping("/api/v1/action-items")
    public Map<String, Integer> bulk(@Valid @RequestBody ActionItemBulkRequest req) {
        return Map.of("changed", actionItems.bulkStatus(SecurityUtils.currentUserId(), req));
    }

    @DeleteMapping("/api/v1/action-items/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void delete(@PathVariable String id) {
        actionItems.delete(SecurityUtils.currentUserId(), id);
    }

    @GetMapping("/api/v1/action-items/{id}/comments")
    public List<ActionItemCommentResponse> comments(@PathVariable String id) {
        return actionItems.listComments(SecurityUtils.currentUserId(), id);
    }

    @PostMapping("/api/v1/action-items/{id}/comments")
    @ResponseStatus(HttpStatus.CREATED)
    public ActionItemCommentResponse comment(@PathVariable String id,
                                             @Valid @RequestBody ActionItemCommentRequest req) {
        return actionItems.addComment(SecurityUtils.currentUserId(), id, req);
    }

    @DeleteMapping("/api/v1/action-items/{id}/comments/{commentId}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void deleteComment(@PathVariable String id, @PathVariable String commentId) {
        actionItems.deleteComment(SecurityUtils.currentUserId(), id, commentId);
    }
}
