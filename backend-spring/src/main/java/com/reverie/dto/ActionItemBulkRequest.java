package com.reverie.dto;

import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.Size;

import java.util.List;

/**
 * PATCH /api/v1/action-items — the same change applied to several items.
 *
 * <p>Ticking off a standup's worth of tasks one at a time is six requests, six
 * cache invalidations and a list that reorders under the cursor between each
 * one. This is one request and one reorder.
 *
 * <p>Ids not owned by the caller are silently skipped rather than failing the
 * batch: the response says how many were changed, and a selection that went
 * stale — an item deleted in another tab — should not lose the other five.
 */
public record ActionItemBulkRequest(
        @NotEmpty(message = "Select at least one action item")
        @Size(max = 200, message = "That is too many items to change at once")
        List<String> ids,
        /** OPEN, IN_PROGRESS or DONE. */
        String status
) {
}
