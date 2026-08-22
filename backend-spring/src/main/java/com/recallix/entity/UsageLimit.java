package com.recallix.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

/**
 * One account's usage, for the life of the account.
 *
 * <p>There used to be a row per user per calendar month, and the columns said
 * so: {@code period_start} and {@code period_end} bounded the five meetings you
 * got that month. The allowance is a lifetime one now (V47), so there is one row
 * per user and no period on it — a reset date that never arrives is worse than
 * no reset date, because somebody waits for it.
 */
@Entity
@Table(name = "usage_limits")
public class UsageLimit {

    @Id
    private String id;

    @Column(name = "user_id", nullable = false, unique = true)
    private String userId;

    /** Meetings created, ever. Counted for the figure, not capped. */
    @Column(name = "meetings_used", nullable = false)
    private int meetingsUsed = 0;

    /** Minutes actually transcribed, added when a meeting finishes processing. */
    @Column(name = "ai_minutes_used", nullable = false)
    private int aiMinutesUsed = 0;

    /** Files imported. A recording made in the browser is not one. */
    @Column(name = "imports_used", nullable = false)
    private int importsUsed = 0;

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }

    public String getUserId() { return userId; }
    public void setUserId(String userId) { this.userId = userId; }

    public int getMeetingsUsed() { return meetingsUsed; }
    public void setMeetingsUsed(int meetingsUsed) { this.meetingsUsed = meetingsUsed; }

    public int getAiMinutesUsed() { return aiMinutesUsed; }
    public void setAiMinutesUsed(int aiMinutesUsed) { this.aiMinutesUsed = aiMinutesUsed; }

    public int getImportsUsed() { return importsUsed; }
    public void setImportsUsed(int importsUsed) { this.importsUsed = importsUsed; }
}
