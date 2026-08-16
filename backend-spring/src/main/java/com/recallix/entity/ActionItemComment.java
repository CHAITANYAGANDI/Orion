package com.recallix.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.PreUpdate;
import jakarta.persistence.Table;

import java.time.Instant;

/**
 * One line in a task's working log.
 *
 * <p>Not a discussion: Recallix has one account per workspace, so there is
 * nobody to reply to and nothing to notify. This is the place for what a status
 * of OPEN cannot say — "waiting on legal until Thursday", "shipped the first
 * half" — and each entry keeps its own time, which is the whole reason these are
 * rows rather than one growing notes field.
 *
 * <p>{@code userId} is denormalised off the meeting behind the item because the
 * row-level security policy tests it directly. See V32.
 */
@Entity
@Table(name = "action_item_comments")
public class ActionItemComment {

    @Id
    private String id;

    @Column(name = "action_item_id", nullable = false)
    private String actionItemId;

    @Column(name = "user_id", nullable = false)
    private String userId;

    @Column(nullable = false)
    private String body;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt = Instant.now();

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt = Instant.now();

    @PreUpdate
    void onUpdate() {
        this.updatedAt = Instant.now();
    }

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }

    public String getActionItemId() { return actionItemId; }
    public void setActionItemId(String actionItemId) { this.actionItemId = actionItemId; }

    public String getUserId() { return userId; }
    public void setUserId(String userId) { this.userId = userId; }

    public String getBody() { return body; }
    public void setBody(String body) { this.body = body; }

    public Instant getCreatedAt() { return createdAt; }
    public void setCreatedAt(Instant createdAt) { this.createdAt = createdAt; }

    public Instant getUpdatedAt() { return updatedAt; }
    public void setUpdatedAt(Instant updatedAt) { this.updatedAt = updatedAt; }
}
