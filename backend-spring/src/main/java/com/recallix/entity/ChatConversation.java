package com.recallix.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

import java.time.Instant;

/**
 * One named chat thread.
 *
 * <p>{@code meetingId} is null for the workspace-wide chat and set for a chat
 * about one meeting — the same discriminator {@link ChatMessage} already used,
 * kept rather than split into two tables that would differ by nothing else.
 *
 * <p>{@code updatedAt} is the last message time, not the last edit. It is what
 * the history picker sorts and groups by, so a conversation returned to today
 * appears under "Today" however old it is.
 */
@Entity
@Table(name = "chat_conversations")
public class ChatConversation {

    @Id
    private String id;

    @Column(name = "user_id", nullable = false)
    private String userId;

    @Column(name = "meeting_id")
    private String meetingId;

    /** Generated from the first exchange, then owned by the user. */
    @Column(nullable = false)
    private String title = "";

    @Column(name = "created_at", nullable = false)
    private Instant createdAt = Instant.now();

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt = Instant.now();

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }

    public String getUserId() { return userId; }
    public void setUserId(String userId) { this.userId = userId; }

    public String getMeetingId() { return meetingId; }
    public void setMeetingId(String meetingId) { this.meetingId = meetingId; }

    public String getTitle() { return title; }
    public void setTitle(String title) { this.title = title; }

    public Instant getCreatedAt() { return createdAt; }
    public void setCreatedAt(Instant createdAt) { this.createdAt = createdAt; }

    public Instant getUpdatedAt() { return updatedAt; }
    public void setUpdatedAt(Instant updatedAt) { this.updatedAt = updatedAt; }
}
