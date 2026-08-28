package com.orion.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.IdClass;
import jakarta.persistence.Table;

import java.time.Instant;

/**
 * One processing attempt that has been billed to an account's AI minutes.
 *
 * <p>The row is the charge. It exists so that a duplicate result callback —
 * which at-least-once Kafka delivery makes an ordinary event rather than an
 * exotic one — cannot spend a second slice of a 100-minute lifetime allowance.
 *
 * <p>Keyed by meeting <em>and attempt</em> rather than by meeting alone,
 * because reprocessing is a legitimate second charge: {@code reprocess}
 * increments {@code meetings.processing_attempt}, so a genuine re-run presents
 * a key nobody holds while a redelivery presents one that is already taken.
 */
@Entity
@Table(name = "meeting_usage_charges")
@IdClass(MeetingUsageChargeId.class)
public class MeetingUsageCharge {

    @Id
    @Column(name = "meeting_id", nullable = false)
    private String meetingId;

    @Id
    @Column(name = "attempt", nullable = false)
    private int attempt;

    @Column(name = "user_id", nullable = false)
    private String userId;

    @Column(name = "minutes", nullable = false)
    private int minutes;

    @Column(name = "charged_at", nullable = false)
    private Instant chargedAt = Instant.now();

    public String getMeetingId() { return meetingId; }
    public void setMeetingId(String meetingId) { this.meetingId = meetingId; }

    public int getAttempt() { return attempt; }
    public void setAttempt(int attempt) { this.attempt = attempt; }

    public String getUserId() { return userId; }
    public void setUserId(String userId) { this.userId = userId; }

    public int getMinutes() { return minutes; }
    public void setMinutes(int minutes) { this.minutes = minutes; }

    public Instant getChargedAt() { return chargedAt; }
    public void setChargedAt(Instant chargedAt) { this.chargedAt = chargedAt; }
}
