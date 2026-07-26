package com.recallix.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

import java.time.Instant;

/**
 * A revocable, unauthenticated link to one meeting's brief.
 *
 * <p>The {@code token} is the only credential, so it must be unguessable and is
 * never derived from the meeting id. Revoked rows are kept rather than deleted:
 * "this link was shared and later withdrawn" is worth being able to answer.
 */
@Entity
@Table(name = "meeting_shares")
public class MeetingShare {

    @Id
    private String id;

    @Column(name = "meeting_id", nullable = false)
    private String meetingId;

    @Column(name = "user_id", nullable = false)
    private String userId;

    @Column(nullable = false, unique = true)
    private String token;

    /** Verbatim transcript is excluded unless the owner opts in. */
    @Column(name = "include_transcript", nullable = false)
    private boolean includeTranscript = false;

    /** Null means the link never expires on its own. */
    @Column(name = "expires_at")
    private Instant expiresAt;

    @Column(nullable = false)
    private boolean revoked = false;

    @Column(name = "view_count", nullable = false)
    private int viewCount = 0;

    @Column(name = "last_viewed_at")
    private Instant lastViewedAt;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt = Instant.now();

    /** Usable only while un-revoked and un-expired. */
    public boolean isActive() {
        return !revoked && (expiresAt == null || expiresAt.isAfter(Instant.now()));
    }

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }

    public String getMeetingId() { return meetingId; }
    public void setMeetingId(String meetingId) { this.meetingId = meetingId; }

    public String getUserId() { return userId; }
    public void setUserId(String userId) { this.userId = userId; }

    public String getToken() { return token; }
    public void setToken(String token) { this.token = token; }

    public boolean isIncludeTranscript() { return includeTranscript; }
    public void setIncludeTranscript(boolean includeTranscript) { this.includeTranscript = includeTranscript; }

    public Instant getExpiresAt() { return expiresAt; }
    public void setExpiresAt(Instant expiresAt) { this.expiresAt = expiresAt; }

    public boolean isRevoked() { return revoked; }
    public void setRevoked(boolean revoked) { this.revoked = revoked; }

    public int getViewCount() { return viewCount; }
    public void setViewCount(int viewCount) { this.viewCount = viewCount; }

    public Instant getLastViewedAt() { return lastViewedAt; }
    public void setLastViewedAt(Instant lastViewedAt) { this.lastViewedAt = lastViewedAt; }

    public Instant getCreatedAt() { return createdAt; }
    public void setCreatedAt(Instant createdAt) { this.createdAt = createdAt; }
}
