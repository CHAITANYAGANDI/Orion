package com.recallix.entity;

import com.recallix.domain.NotificationKind;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

import java.time.Instant;

/**
 * One thing Recallix did, written down.
 *
 * <p>{@code title} and {@code body} are stored rather than rendered on read.
 * A notification is a record of a moment: if the meeting is renamed afterwards,
 * "Sprint planning is ready" is still what happened, and re-deriving the text
 * from the current row would quietly rewrite it.
 */
@Entity
@Table(name = "notifications")
public class Notification {

    @Id
    private String id;

    @Column(name = "user_id", nullable = false)
    private String userId;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false)
    private NotificationKind kind;

    @Column(nullable = false)
    private String title;

    private String body;

    @Column(name = "meeting_id")
    private String meetingId;

    @Column(name = "action_item_id")
    private String actionItemId;

    /** Where clicking it goes, relative to the app root. */
    private String link;

    @Column(name = "read_at")
    private Instant readAt;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt = Instant.now();

    /**
     * Suppresses repeats of the kinds that recur — "this task is overdue" is
     * true again tomorrow, and a link shared with forty people is opened forty
     * times. Null means this one is always worth saying.
     */
    @Column(name = "dedupe_key")
    private String dedupeKey;

    public boolean isRead() {
        return readAt != null;
    }

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }

    public String getUserId() { return userId; }
    public void setUserId(String userId) { this.userId = userId; }

    public NotificationKind getKind() { return kind; }
    public void setKind(NotificationKind kind) { this.kind = kind; }

    public String getTitle() { return title; }
    public void setTitle(String title) { this.title = title; }

    public String getBody() { return body; }
    public void setBody(String body) { this.body = body; }

    public String getMeetingId() { return meetingId; }
    public void setMeetingId(String meetingId) { this.meetingId = meetingId; }

    public String getActionItemId() { return actionItemId; }
    public void setActionItemId(String actionItemId) { this.actionItemId = actionItemId; }

    public String getLink() { return link; }
    public void setLink(String link) { this.link = link; }

    public Instant getReadAt() { return readAt; }
    public void setReadAt(Instant readAt) { this.readAt = readAt; }

    public Instant getCreatedAt() { return createdAt; }
    public void setCreatedAt(Instant createdAt) { this.createdAt = createdAt; }

    public String getDedupeKey() { return dedupeKey; }
    public void setDedupeKey(String dedupeKey) { this.dedupeKey = dedupeKey; }
}
