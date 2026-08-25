package com.recallix.entity;

import com.fasterxml.jackson.databind.JsonNode;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import java.time.Instant;

/**
 * Transactional outbox row (Outbox Pattern). Business writes and the event to
 * publish are committed in the same DB transaction; a scheduled publisher then
 * relays unpublished rows to Kafka, guaranteeing at-least-once delivery.
 *
 * <p>A row is in exactly one of three states:
 *
 * <ul>
 *   <li><strong>pending</strong> — {@code published} false, {@code failedAt}
 *       null. Claimable once {@code nextAttemptAt} has passed; before that it is
 *       backing off from a failure, and still holds its place at the head of its
 *       key's queue while it waits.</li>
 *   <li><strong>published</strong> — Kafka acknowledged it. Done.</li>
 *   <li><strong>terminal</strong> — {@code failedAt} set. Publication was
 *       abandoned because it could never succeed. Never claimed again, and out
 *       of its key's ordering chain so the next event can proceed. The row is
 *       kept, with its error and attempt count, to be looked at.</li>
 * </ul>
 */
@Entity
@Table(name = "outbox_events")
public class OutboxEvent {

    @Id
    private String id;

    @Column(nullable = false)
    private String topic;

    @Column(name = "partition_key")
    private String partitionKey;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(nullable = false, columnDefinition = "jsonb")
    private JsonNode payload;

    @Column(nullable = false)
    private boolean published = false;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt = Instant.now();

    /** Failed publication attempts so far; the input to the retry backoff. */
    @Column(name = "attempt_count", nullable = false)
    private int attemptCount = 0;

    /**
     * Not claimable before this. Durable on purpose: an in-memory schedule would
     * be reset by every restart and disagreed about by every instance.
     */
    @Column(name = "next_attempt_at", nullable = false)
    private Instant nextAttemptAt = Instant.now();

    /** Most recent failure, truncated. Never the payload. */
    @Column(name = "last_error")
    private String lastError;

    /** Set once publication is abandoned. The terminal mark. */
    @Column(name = "failed_at")
    private Instant failedAt;

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }

    public String getTopic() { return topic; }
    public void setTopic(String topic) { this.topic = topic; }

    public String getPartitionKey() { return partitionKey; }
    public void setPartitionKey(String partitionKey) { this.partitionKey = partitionKey; }

    public JsonNode getPayload() { return payload; }
    public void setPayload(JsonNode payload) { this.payload = payload; }

    public boolean isPublished() { return published; }
    public void setPublished(boolean published) { this.published = published; }

    public Instant getCreatedAt() { return createdAt; }
    public void setCreatedAt(Instant createdAt) { this.createdAt = createdAt; }

    public int getAttemptCount() { return attemptCount; }
    public void setAttemptCount(int attemptCount) { this.attemptCount = attemptCount; }

    public Instant getNextAttemptAt() { return nextAttemptAt; }
    public void setNextAttemptAt(Instant nextAttemptAt) { this.nextAttemptAt = nextAttemptAt; }

    public String getLastError() { return lastError; }
    public void setLastError(String lastError) { this.lastError = lastError; }

    public Instant getFailedAt() { return failedAt; }
    public void setFailedAt(Instant failedAt) { this.failedAt = failedAt; }

    /** Publication abandoned: not claimable, and not blocking its key. */
    public boolean isTerminal() { return failedAt != null; }
}
