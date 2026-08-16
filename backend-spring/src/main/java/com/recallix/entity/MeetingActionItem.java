package com.recallix.entity;

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
 * date by {@link com.recallix.common.DueDates}, and is what every deadline
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

    @Column(name = "meeting_id", nullable = false)
    private String meetingId;

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

    private String priority = "medium";

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

    public String getPriority() { return priority; }
    public void setPriority(String priority) { this.priority = priority; }

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
