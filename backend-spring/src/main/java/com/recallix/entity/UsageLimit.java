package com.recallix.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

import java.time.Instant;

@Entity
@Table(name = "usage_limits")
public class UsageLimit {

    @Id
    private String id;

    @Column(name = "user_id", nullable = false)
    private String userId;

    @Column(name = "period_start", nullable = false)
    private Instant periodStart;

    @Column(name = "period_end", nullable = false)
    private Instant periodEnd;

    @Column(name = "meetings_used", nullable = false)
    private int meetingsUsed = 0;

    @Column(name = "ai_minutes_used", nullable = false)
    private int aiMinutesUsed = 0;

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }

    public String getUserId() { return userId; }
    public void setUserId(String userId) { this.userId = userId; }

    public Instant getPeriodStart() { return periodStart; }
    public void setPeriodStart(Instant periodStart) { this.periodStart = periodStart; }

    public Instant getPeriodEnd() { return periodEnd; }
    public void setPeriodEnd(Instant periodEnd) { this.periodEnd = periodEnd; }

    public int getMeetingsUsed() { return meetingsUsed; }
    public void setMeetingsUsed(int meetingsUsed) { this.meetingsUsed = meetingsUsed; }

    public int getAiMinutesUsed() { return aiMinutesUsed; }
    public void setAiMinutesUsed(int aiMinutesUsed) { this.aiMinutesUsed = aiMinutesUsed; }
}
