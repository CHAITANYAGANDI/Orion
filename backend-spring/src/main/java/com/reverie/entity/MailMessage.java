package com.reverie.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

import java.time.Instant;

/**
 * One message, committed with the thing it reports and delivered afterwards.
 *
 * <h2>Why the payload is copied in rather than looked up</h2>
 *
 * <p>Every field delivery needs is here, and none of it is a join. The
 * account-closed message is both the reason and the proof: by the time it is
 * sent, the user row is gone — with the address, the meeting count and the
 * switches on it. A row that had to look any of that up would be a row that
 * could never be sent, and this is the one message that can never be
 * regenerated from anything else.
 *
 * <p>So {@code userId} is a plain column with no {@code REFERENCES} and no
 * cascade. A cascade here would delete the record of the deletion.
 *
 * <h2>Three states</h2>
 *
 * <ul>
 *   <li><b>pending</b> — {@code sentAt} and {@code abandonedAt} both null.
 *       Claimable once {@code nextAttemptAt} has passed; before that it is
 *       backing off from a failed attempt.</li>
 *   <li><b>sent</b> — the provider accepted it. Done.</li>
 *   <li><b>abandoned</b> — delivery was given up on. Never claimed again; the
 *       row is kept with its error and its attempt count, to be read.</li>
 * </ul>
 *
 * <p>The same three {@link OutboxEvent} has, and for the same reasons. What is
 * different is {@link #dedupeKey}: Kafka is content to receive a duplicate and
 * an inbox is not, so this table carries a unique key and that key travels to
 * the provider as an idempotency header.
 */
@Entity
@Table(name = "mail_outbox")
public class MailMessage {

    @Id
    private String id;

    /**
     * Deterministic, never random, and unique.
     *
     * <p>It does three jobs. It makes enqueueing idempotent, so two scheduler
     * instances ticking in the same second produce one row. It replaces the
     * "already sent" stamp columns an earlier draft had, so there is one source
     * of truth rather than two that can disagree. And it goes to the provider
     * as an idempotency key, which is the only place the last gap can be
     * closed — a send that succeeded and was never marked.
     */
    @Column(name = "dedupe_key", nullable = false, unique = true)
    private String dedupeKey;

    @Column(name = "to_address", nullable = false)
    private String toAddress;

    @Column(nullable = false)
    private String subject;

    @Column(name = "body_text", nullable = false, columnDefinition = "text")
    private String bodyText;

    @Column(name = "body_html", nullable = false, columnDefinition = "text")
    private String bodyHtml;

    /** Whose it was. Informational; the row outlives the account. */
    @Column(name = "user_id")
    private String userId;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt = Instant.now();

    @Column(name = "sent_at")
    private Instant sentAt;

    @Column(name = "abandoned_at")
    private Instant abandonedAt;

    @Column(name = "attempt_count", nullable = false)
    private int attemptCount = 0;

    /**
     * Not claimable before this.
     *
     * <p>A column rather than an in-memory schedule, for the reason
     * {@link OutboxEvent} gives: a schedule in memory is reset by every restart
     * and disagreed about by every instance.
     */
    @Column(name = "next_attempt_at", nullable = false)
    private Instant nextAttemptAt = Instant.now();

    /**
     * Past this, delivering it would be worse than not delivering it.
     *
     * <p>Not the same bound as the retry ceiling. That one asks how long
     * delivery is <em>attempted</em> and is sized to the provider's idempotency
     * window; this asks how long delivery is <em>worth</em> attempting and is
     * sized to the message. A digest for one morning and a notice that an
     * account was destroyed are not the same kind of late. See
     * {@link MailLifetime}.
     *
     * <p>Null means "no useful-by date" and is not used by any message today;
     * it is there so a future one can say so explicitly rather than by omission.
     */
    @Column(name = "expires_at")
    private Instant expiresAt;

    /**
     * The most recent failure. Never the body, and never anything token-shaped.
     *
     * <p>Sanitised before it is written. This column outlives the attempt by a
     * month, a provider error body is not under our control, and a credential
     * echoed into it once would be stored permanently.
     */
    @Column(name = "last_error")
    private String lastError;

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }

    public String getDedupeKey() { return dedupeKey; }
    public void setDedupeKey(String dedupeKey) { this.dedupeKey = dedupeKey; }

    public String getToAddress() { return toAddress; }
    public void setToAddress(String toAddress) { this.toAddress = toAddress; }

    public String getSubject() { return subject; }
    public void setSubject(String subject) { this.subject = subject; }

    public String getBodyText() { return bodyText; }
    public void setBodyText(String bodyText) { this.bodyText = bodyText; }

    public String getBodyHtml() { return bodyHtml; }
    public void setBodyHtml(String bodyHtml) { this.bodyHtml = bodyHtml; }

    public String getUserId() { return userId; }
    public void setUserId(String userId) { this.userId = userId; }

    public Instant getCreatedAt() { return createdAt; }
    public void setCreatedAt(Instant createdAt) { this.createdAt = createdAt; }

    public Instant getSentAt() { return sentAt; }
    public void setSentAt(Instant sentAt) { this.sentAt = sentAt; }

    public Instant getAbandonedAt() { return abandonedAt; }
    public void setAbandonedAt(Instant abandonedAt) { this.abandonedAt = abandonedAt; }

    public int getAttemptCount() { return attemptCount; }
    public void setAttemptCount(int attemptCount) { this.attemptCount = attemptCount; }

    public Instant getNextAttemptAt() { return nextAttemptAt; }
    public void setNextAttemptAt(Instant nextAttemptAt) { this.nextAttemptAt = nextAttemptAt; }

    public Instant getExpiresAt() { return expiresAt; }
    public void setExpiresAt(Instant expiresAt) { this.expiresAt = expiresAt; }

    public String getLastError() { return lastError; }
    public void setLastError(String lastError) { this.lastError = lastError; }
}
