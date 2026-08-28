package com.orion.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.PreUpdate;
import jakarta.persistence.Table;

import java.time.Instant;
import java.time.LocalDate;

/**
 * One thing somebody undertook to do.
 *
 * <p>Two fields hold the deadline and they are not redundant. {@code dueDate} is
 * the phrasing as it was said — "Tuesday", "end of day" — and is what the item
 * displays, because that is the promise that was actually made. {@code dueOn} is
 * our reading of it as a calendar date, resolved once against the meeting's own
 * date by {@link com.orion.common.DueDates}, and is what every deadline
 * feature sorts and filters on. It is null whenever the phrasing had no single
 * reading, and null is treated as "no deadline" rather than guessed at.
 *
 * <p>{@code edited} is what lets a reprocess rewrite the extractor's output
 * without destroying work: a ticked-off item, a corrected title or an item added
 * by hand is spared the sweep. See V32.
 */
@Entity
@Table(name = "meeting_action_items")
public class MeetingActionItem {

    @Id
    private String id;

    /**
     * The conversation it was promised in, or null for one added by hand.
     *
     * <p>Nullable since V36. Every action item used to be a fact extracted from
     * a transcript; the workspace panel lets somebody type one, and that task
     * belongs to them rather than to any call.
     */
    @Column(name = "meeting_id")
    private String meetingId;

    /**
     * Who owes this.
     *
     * <p>Held directly rather than read through the meeting, because there may
     * not be a meeting — and because it is what row-level security now tests.
     */
    @Column(name = "user_id", nullable = false)
    private String userId;

    @Column(nullable = false)
    private String title;

    @Column(name = "owner_name")
    private String ownerName;

    /** The deadline in the words it was given in. Free text; may be anything. */
    @Column(name = "due_date")
    private String dueDate;

    /** {@link #dueDate} read as a date, or null when it could not be. */
    @Column(name = "due_on")
    private LocalDate dueOn;

    @Column(nullable = false)
    private String status = "OPEN";

    @Column(name = "source_sentence")
    private String sourceSentence;

    /** Where that sentence sits in the recording, when it could be located. */
    @Column(name = "source_start_seconds")
    private Double sourceStartSeconds;

    /** Set on the way into DONE, cleared on the way out. */
    @Column(name = "completed_at")
    private Instant completedAt;

    @Column(nullable = false)
    private boolean edited = false;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt = Instant.now();

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt = Instant.now();

    @PreUpdate
    void onUpdate() {
        this.updatedAt = Instant.now();
    }

    public boolean isDone() {
        return "DONE".equals(status);
    }

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }

    public String getUserId() { return userId; }
    public void setUserId(String userId) { this.userId = userId; }

    /** True for an item somebody typed rather than one a meeting produced. */
    public boolean isStandalone() { return meetingId == null; }

    public String getMeetingId() { return meetingId; }
    public void setMeetingId(String meetingId) { this.meetingId = meetingId; }

    public String getTitle() { return title; }
    public void setTitle(String title) { this.title = title; }

    public String getOwnerName() { return ownerName; }
    public void setOwnerName(String ownerName) { this.ownerName = ownerName; }

    public String getDueDate() { return dueDate; }
    public void setDueDate(String dueDate) { this.dueDate = dueDate; }

    public LocalDate getDueOn() { return dueOn; }
    public void setDueOn(LocalDate dueOn) { this.dueOn = dueOn; }

    public String getStatus() { return status; }
    public void setStatus(String status) { this.status = status; }

    public String getSourceSentence() { return sourceSentence; }
    public void setSourceSentence(String sourceSentence) { this.sourceSentence = sourceSentence; }

    public Double getSourceStartSeconds() { return sourceStartSeconds; }
    public void setSourceStartSeconds(Double sourceStartSeconds) { this.sourceStartSeconds = sourceStartSeconds; }

    public Instant getCompletedAt() { return completedAt; }
    public void setCompletedAt(Instant completedAt) { this.completedAt = completedAt; }

    public boolean isEdited() { return edited; }
    public void setEdited(boolean edited) { this.edited = edited; }

    public Instant getCreatedAt() { return createdAt; }
    public void setCreatedAt(Instant createdAt) { this.createdAt = createdAt; }

    public Instant getUpdatedAt() { return updatedAt; }
    public void setUpdatedAt(Instant updatedAt) { this.updatedAt = updatedAt; }
}
