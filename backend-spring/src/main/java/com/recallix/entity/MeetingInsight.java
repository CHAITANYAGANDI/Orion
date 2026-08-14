package com.recallix.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

import java.time.Instant;

/**
 * One decision a meeting settled, or one risk it named.
 *
 * <p>Derived from the summary sections the worker already wrote rather than
 * extracted separately, so these rows and the Decisions section on the meeting
 * page are the same words and cannot disagree.
 *
 * <p>{@code userId} is denormalised from the meeting because the row-level
 * security policy tests ownership directly, as every user-owned table has since
 * V9. {@code edited} is what lets a reprocess replace the derived rows without
 * throwing away a correction somebody made by hand.
 */
@Entity
@Table(name = "meeting_insights")
public class MeetingInsight {

    @Id
    private String id;

    @Column(name = "meeting_id", nullable = false)
    private String meetingId;

    @Column(name = "user_id", nullable = false)
    private String userId;

    /** {@code DECISION} or {@code RISK}. */
    @Column(nullable = false)
    private String kind;

    @Column(nullable = false)
    private String text;

    /** Summary section it was read from; empty for a hand-added row. */
    @Column(name = "source_section", nullable = false)
    private String sourceSection = "";

    @Column(nullable = false)
    private boolean edited = false;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt = Instant.now();

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt = Instant.now();

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }

    public String getMeetingId() { return meetingId; }
    public void setMeetingId(String meetingId) { this.meetingId = meetingId; }

    public String getUserId() { return userId; }
    public void setUserId(String userId) { this.userId = userId; }

    public String getKind() { return kind; }
    public void setKind(String kind) { this.kind = kind; }

    public String getText() { return text; }
    public void setText(String text) { this.text = text; }

    public String getSourceSection() { return sourceSection; }
    public void setSourceSection(String sourceSection) { this.sourceSection = sourceSection; }

    public boolean isEdited() { return edited; }
    public void setEdited(boolean edited) { this.edited = edited; }

    public Instant getCreatedAt() { return createdAt; }
    public void setCreatedAt(Instant createdAt) { this.createdAt = createdAt; }

    public Instant getUpdatedAt() { return updatedAt; }
    public void setUpdatedAt(Instant updatedAt) { this.updatedAt = updatedAt; }
}
