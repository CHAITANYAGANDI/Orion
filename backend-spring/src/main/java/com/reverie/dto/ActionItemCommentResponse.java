package com.reverie.dto;

import com.reverie.entity.ActionItemComment;

import java.time.Instant;

/**
 * One logged entry.
 *
 * <p>No author: there is one account per workspace, so naming the writer on
 * every line would be a column that says the same thing all the way down.
 */
public record ActionItemCommentResponse(
        String id,
        String actionItemId,
        String body,
        Instant createdAt,
        Instant updatedAt
) {
    public static ActionItemCommentResponse from(ActionItemComment c) {
        return new ActionItemCommentResponse(
                c.getId(), c.getActionItemId(), c.getBody(), c.getCreatedAt(), c.getUpdatedAt());
    }
}
