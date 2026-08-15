package com.recallix.dto;

import com.recallix.entity.ChatConversation;

import java.time.Instant;

/**
 * One row in the chat-history picker.
 *
 * <p>{@code updatedAt} rather than {@code createdAt} drives the grouping the UI
 * shows — Today, Past week, Older — because a conversation returned to this
 * morning belongs under Today however long ago it was started.
 *
 * <p>{@code messageCount} is carried so the picker can tell an empty thread
 * from one with something in it without fetching every conversation's messages.
 */
public record ConversationResponse(
        String id,
        /** Null for the workspace-wide chat. */
        String meetingId,
        String title,
        int messageCount,
        Instant createdAt,
        Instant updatedAt
) {
    public static ConversationResponse from(ChatConversation c, long messageCount) {
        return new ConversationResponse(
                c.getId(),
                c.getMeetingId(),
                c.getTitle(),
                (int) messageCount,
                c.getCreatedAt(),
                c.getUpdatedAt());
    }
}
