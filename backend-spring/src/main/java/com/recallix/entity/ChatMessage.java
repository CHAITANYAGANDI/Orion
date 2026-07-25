package com.recallix.entity;

import com.fasterxml.jackson.databind.JsonNode;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import java.time.Instant;

/**
 * One turn in a RAG chat (role = user | assistant).
 *
 * <p>{@code meetingId} is null for turns belonging to the user's workspace-wide
 * conversation, which is grounded across every meeting they own rather than one.
 */
@Entity
@Table(name = "chat_messages")
public class ChatMessage {

    @Id
    private String id;

    @Column(name = "meeting_id")
    private String meetingId;

    @Column(name = "user_id", nullable = false)
    private String userId;

    @Column(nullable = false)
    private String role;

    @Column(nullable = false)
    private String content;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "citations_json", columnDefinition = "jsonb")
    private JsonNode citations;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt = Instant.now();

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }

    public String getMeetingId() { return meetingId; }
    public void setMeetingId(String meetingId) { this.meetingId = meetingId; }

    public String getUserId() { return userId; }
    public void setUserId(String userId) { this.userId = userId; }

    public String getRole() { return role; }
    public void setRole(String role) { this.role = role; }

    public String getContent() { return content; }
    public void setContent(String content) { this.content = content; }

    public JsonNode getCitations() { return citations; }
    public void setCitations(JsonNode citations) { this.citations = citations; }

    public Instant getCreatedAt() { return createdAt; }
    public void setCreatedAt(Instant createdAt) { this.createdAt = createdAt; }
}
