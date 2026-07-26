package com.recallix.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

import java.time.Instant;

/**
 * What one later meeting said about one {@link Commitment}.
 *
 * <p>This is the audit trail behind a commitment's status — every row carries the
 * verbatim quote and its timestamp, so the UI can link back to the moment rather
 * than asking the user to trust an inferred status.
 */
@Entity
@Table(name = "commitment_evidence")
public class CommitmentEvidence {

    public static final String FULFILLED = "FULFILLED";
    public static final String SLIPPED = "SLIPPED";
    /** Discussed again with no resolution — keeps the commitment OPEN. */
    public static final String RESTATED = "RESTATED";
    public static final String CANCELLED = "CANCELLED";

    @Id
    private String id;

    @Column(name = "commitment_id", nullable = false)
    private String commitmentId;

    @Column(name = "meeting_id", nullable = false)
    private String meetingId;

    @Column(nullable = false)
    private String verdict;

    private String rationale;

    private String quote;

    @Column(name = "start_time")
    private Double startTime;

    private String confidence;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt = Instant.now();

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }

    public String getCommitmentId() { return commitmentId; }
    public void setCommitmentId(String commitmentId) { this.commitmentId = commitmentId; }

    public String getMeetingId() { return meetingId; }
    public void setMeetingId(String meetingId) { this.meetingId = meetingId; }

    public String getVerdict() { return verdict; }
    public void setVerdict(String verdict) { this.verdict = verdict; }

    public String getRationale() { return rationale; }
    public void setRationale(String rationale) { this.rationale = rationale; }

    public String getQuote() { return quote; }
    public void setQuote(String quote) { this.quote = quote; }

    public Double getStartTime() { return startTime; }
    public void setStartTime(Double startTime) { this.startTime = startTime; }

    public String getConfidence() { return confidence; }
    public void setConfidence(String confidence) { this.confidence = confidence; }

    public Instant getCreatedAt() { return createdAt; }
    public void setCreatedAt(Instant createdAt) { this.createdAt = createdAt; }
}
