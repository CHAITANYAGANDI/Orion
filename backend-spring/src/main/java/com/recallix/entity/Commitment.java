package com.recallix.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.PreUpdate;
import jakarta.persistence.Table;

import java.time.Instant;

/**
 * A promise made in a meeting, tracked across every meeting that followed.
 *
 * <p>Promoted from a {@link MeetingActionItem} when its meeting completes. The
 * ledger diverges from the action item after that: the action item is a task the
 * user can tick off manually, while the commitment's status is inferred from
 * what later meetings actually said (see {@link CommitmentEvidence}).
 */
@Entity
@Table(name = "commitments")
public class Commitment {

    /** No later meeting has spoken to this promise yet. */
    public static final String OPEN = "OPEN";
    /** A later meeting reported the work as done. */
    public static final String FULFILLED = "FULFILLED";
    /** A later meeting reported it late, delayed or rescheduled. */
    public static final String SLIPPED = "SLIPPED";
    /** A later meeting reported it as no longer being done. */
    public static final String CANCELLED = "CANCELLED";
    /** Never mentioned again across several later meetings — silently dropped. */
    public static final String DROPPED = "DROPPED";

    @Id
    private String id;

    @Column(name = "user_id", nullable = false)
    private String userId;

    @Column(name = "action_item_id")
    private String actionItemId;

    @Column(name = "origin_meeting_id", nullable = false)
    private String originMeetingId;

    @Column(nullable = false)
    private String text;

    @Column(name = "owner_name")
    private String ownerName;

    @Column(name = "due_date")
    private String dueDate;

    @Column(nullable = false)
    private String status = OPEN;

    @Column(name = "checks_run", nullable = false)
    private int checksRun = 0;

    @Column(name = "last_checked_at")
    private Instant lastCheckedAt;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt = Instant.now();

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt = Instant.now();

    @PreUpdate
    void touch() {
        this.updatedAt = Instant.now();
    }

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }

    public String getUserId() { return userId; }
    public void setUserId(String userId) { this.userId = userId; }

    public String getActionItemId() { return actionItemId; }
    public void setActionItemId(String actionItemId) { this.actionItemId = actionItemId; }

    public String getOriginMeetingId() { return originMeetingId; }
    public void setOriginMeetingId(String originMeetingId) { this.originMeetingId = originMeetingId; }

    public String getText() { return text; }
    public void setText(String text) { this.text = text; }

    public String getOwnerName() { return ownerName; }
    public void setOwnerName(String ownerName) { this.ownerName = ownerName; }

    public String getDueDate() { return dueDate; }
    public void setDueDate(String dueDate) { this.dueDate = dueDate; }

    public String getStatus() { return status; }
    public void setStatus(String status) { this.status = status; }

    public int getChecksRun() { return checksRun; }
    public void setChecksRun(int checksRun) { this.checksRun = checksRun; }

    public Instant getLastCheckedAt() { return lastCheckedAt; }
    public void setLastCheckedAt(Instant lastCheckedAt) { this.lastCheckedAt = lastCheckedAt; }

    public Instant getCreatedAt() { return createdAt; }
    public void setCreatedAt(Instant createdAt) { this.createdAt = createdAt; }

    public Instant getUpdatedAt() { return updatedAt; }
    public void setUpdatedAt(Instant updatedAt) { this.updatedAt = updatedAt; }
}
