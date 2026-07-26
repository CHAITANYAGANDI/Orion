package com.recallix.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

import java.time.Instant;

/**
 * An adjudicated relationship between two decisions made at different times.
 *
 * <p>Candidates come from vector similarity over {@code decision_vectors}; only
 * pairs the LLM judged to actually interact are stored here. Unrelated pairs are
 * discarded rather than persisted with an UNRELATED relation.
 */
@Entity
@Table(name = "decision_links")
public class DecisionLink {

    /** The two decisions cannot both hold — the later reverses the earlier. */
    public static final String CONTRADICTS = "CONTRADICTS";
    /** Same subject; the later replaces the earlier without directly conflicting. */
    public static final String SUPERSEDES = "SUPERSEDES";
    /** The later restates or confirms the earlier. */
    public static final String REAFFIRMS = "REAFFIRMS";

    @Id
    private String id;

    @Column(name = "user_id", nullable = false)
    private String userId;

    @Column(name = "earlier_decision_id", nullable = false)
    private String earlierDecisionId;

    @Column(name = "later_decision_id", nullable = false)
    private String laterDecisionId;

    @Column(nullable = false)
    private String relation;

    private String rationale;

    private Double similarity;

    @Column(nullable = false)
    private boolean acknowledged = false;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt = Instant.now();

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }

    public String getUserId() { return userId; }
    public void setUserId(String userId) { this.userId = userId; }

    public String getEarlierDecisionId() { return earlierDecisionId; }
    public void setEarlierDecisionId(String earlierDecisionId) { this.earlierDecisionId = earlierDecisionId; }

    public String getLaterDecisionId() { return laterDecisionId; }
    public void setLaterDecisionId(String laterDecisionId) { this.laterDecisionId = laterDecisionId; }

    public String getRelation() { return relation; }
    public void setRelation(String relation) { this.relation = relation; }

    public String getRationale() { return rationale; }
    public void setRationale(String rationale) { this.rationale = rationale; }

    public Double getSimilarity() { return similarity; }
    public void setSimilarity(Double similarity) { this.similarity = similarity; }

    public boolean isAcknowledged() { return acknowledged; }
    public void setAcknowledged(boolean acknowledged) { this.acknowledged = acknowledged; }

    public Instant getCreatedAt() { return createdAt; }
    public void setCreatedAt(Instant createdAt) { this.createdAt = createdAt; }
}
