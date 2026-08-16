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

    @Column(name = "include_summary", nullable = false)
    private boolean includeSummary = true;

    @Column(name = "include_action_items", nullable = false)
    private boolean includeActionItems = true;

    /** Off by default for the same reason as the transcript, and more so. */
    @Column(name = "include_audio", nullable = false)
    private boolean includeAudio = false;

    /**
     * bcrypt hash, or null for an unprotected link.
     *
     * <p>The second factor for a link that has leaked but not been noticed —
     * the only control that helps after a URL is somewhere it should not be,
     * since revoking requires knowing.
     */
    @Column(name = "password_hash")
    private String passwordHash;

    /** The owner's own name for this link; several to one meeting look alike. */
    @Column(nullable = false)
    private String label = "";

    /** Null for a whole-meeting link; set together to share one excerpt. */
    @Column(name = "start_seconds")
    private Double startSeconds;

    @Column(name = "end_seconds")
    private Double endSeconds;

    /** The words the excerpt was made from, denormalised — see V31. */
    @Column(nullable = false)
    private String quote = "";

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

    /** Whether this link points at one excerpt rather than the whole meeting. */
    public boolean isMoment() {
        return startSeconds != null && endSeconds != null;
    }

    public boolean isPasswordProtected() {
        return passwordHash != null && !passwordHash.isBlank();
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

    public boolean isIncludeSummary() { return includeSummary; }
    public void setIncludeSummary(boolean includeSummary) { this.includeSummary = includeSummary; }

    public boolean isIncludeActionItems() { return includeActionItems; }
    public void setIncludeActionItems(boolean includeActionItems) { this.includeActionItems = includeActionItems; }

    public boolean isIncludeAudio() { return includeAudio; }
    public void setIncludeAudio(boolean includeAudio) { this.includeAudio = includeAudio; }

    public String getPasswordHash() { return passwordHash; }
    public void setPasswordHash(String passwordHash) { this.passwordHash = passwordHash; }

    public String getLabel() { return label; }
    public void setLabel(String label) { this.label = label; }

    public Double getStartSeconds() { return startSeconds; }
    public void setStartSeconds(Double startSeconds) { this.startSeconds = startSeconds; }

    public Double getEndSeconds() { return endSeconds; }
    public void setEndSeconds(Double endSeconds) { this.endSeconds = endSeconds; }

    public String getQuote() { return quote; }
    public void setQuote(String quote) { this.quote = quote; }

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
