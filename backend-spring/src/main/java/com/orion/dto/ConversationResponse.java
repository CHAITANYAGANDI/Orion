package com.orion.dto;

import com.orion.entity.ChatConversation;

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
        /** Set for a meeting chat; null otherwise. */
        String meetingId,
        /** Set for a project chat; null otherwise. Both null is the workspace. */
        String projectId,
        String title,
        int messageCount,
        Instant createdAt,
        Instant updatedAt
) {
    public static ConversationResponse from(ChatConversation c, long messageCount) {
        return new ConversationResponse(
                c.getId(),
                c.getMeetingId(),
                c.getProjectId(),
                c.getTitle(),
                (int) messageCount,
                c.getCreatedAt(),
                c.getUpdatedAt());
    }
}
