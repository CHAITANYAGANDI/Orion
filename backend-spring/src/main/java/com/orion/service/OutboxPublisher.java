package com.orion.service;

import com.orion.entity.OutboxEvent;
import com.orion.event.OutboxEventRetired;
import com.orion.repository.OutboxEventRepository;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.List;

/**
 * The transactional half of the outbox relay.
 *
 * <p>Separate from {@link OutboxRelay} for the same reason the memory listener
 * is separate from its service: the tenant has to be established *before* the
 * transaction opens, because the connection is borrowed — and stamped — at that
 * moment. Setting it inside a {@code @Transactional} method would be too late,
 * and the outbox would silently read zero rows under row-level security.
 */
@Component
public class OutboxPublisher {

    private static final Logger log = LoggerFactory.getLogger(OutboxPublisher.class);
    private static final int BATCH = 100;

    /**
     * The first retry waits this long, and each further failure doubles it.
     *
     * <p>Five seconds rather than one because the relay ticks every second and a
     * broker that just refused a message will still be refusing it a second
     * later; the only thing a one-second retry produces is a log line.
     */
    static final Duration RETRY_BASE = Duration.ofSeconds(5);

    /**
     * And no longer than this, however many times it has failed.
     *
     * <p>Five minutes is the point where backing off further stops buying
     * anything: it is already three orders of magnitude quieter than the poll
     * interval, and an outage that has lasted five minutes will be noticed by a
     * person rather than out-waited. Capping also bounds how stale a recovered
     * broker leaves the backlog — after any outage, of any length, everything
     * drains within five minutes of the broker coming back.
     */
    static final Duration RETRY_MAX = Duration.ofMinutes(5);

    /** Failures beyond this stop being routine and get logged as errors. */
    private static final int ESCALATE_AFTER = 5;

    private final OutboxEventRepository repo;
    private final KafkaTemplate<String, String> kafka;
    private final com.fasterxml.jackson.databind.ObjectMapper mapper;
    private final ApplicationEventPublisher events;
    private final Clock clock;

    private final Counter published;
    private final Counter retired;
    private final Counter failedTransient;
    private final Counter failedPermanent;

    // Explicit, because there are two constructors and Spring will not guess
    // between them — it falls back to looking for a no-arg one and fails to
    // start. The other constructor exists only so a test can fix the clock.
    @Autowired
    public OutboxPublisher(OutboxEventRepository repo,
                           KafkaTemplate<String, String> kafka,
                           com.fasterxml.jackson.databind.ObjectMapper mapper,
                           MeterRegistry metrics,
                           ApplicationEventPublisher events) {
        this(repo, kafka, mapper, metrics, events, Clock.systemUTC());
    }

    OutboxPublisher(OutboxEventRepository repo,
                    KafkaTemplate<String, String> kafka,
                    com.fasterxml.jackson.databind.ObjectMapper mapper,
                    MeterRegistry metrics,
                    ApplicationEventPublisher events,
                    Clock clock) {
        this.repo = repo;
        this.kafka = kafka;
        this.mapper = mapper;
        this.events = events;
        this.clock = clock;
        this.published = Counter.builder("orion.outbox.published")
                .description("Outbox events acknowledged by Kafka")
                .register(metrics);
        this.retired = Counter.builder("orion.outbox.retired")
                .description("Outbox events abandoned as unpublishable. Alert on this.")
                .register(metrics);
        this.failedTransient = Counter.builder("orion.outbox.failures")
                .description("Failed publication attempts")
                .tag("category", "infrastructure")
                .register(metrics);
        this.failedPermanent = Counter.builder("orion.outbox.failures")
                .description("Failed publication attempts")
                .tag("category", "event_permanent")
                .register(metrics);
    }

    /**
     * Claim a batch, publish it, mark it, commit.
     *
     * <p>The transaction is the claim. {@code claimBatch} takes a row lock on
     * everything it returns and another relay steps over those rows rather than
     * waiting for them, so two instances divide the backlog instead of both
     * publishing all of it. The locks are released by this method returning —
     * on commit with the rows marked, on rollback with them untouched and
     * eligible again on somebody's next tick.
     *
     * <p><strong>This is at-least-once, not exactly-once, and the gap is
     * deliberate.</strong> Kafka acknowledges the send before the row is marked;
     * if this instance dies in between, the row is still {@code published =
     * false} and will be sent a second time. Nothing here can close that — two
     * systems cannot commit together — which is why the effects on the far side
     * are idempotent per processing attempt.
     *
     * <p>The batch is published one message at a time and waits for each
     * acknowledgement, which is what makes "marked published" mean "Kafka has
     * it".
     *
     * <h2>What happens when one fails</h2>
     *
     * <p>It depends entirely on <em>why</em>, which {@link OutboxFailure}
     * decides, and the two answers are opposite on purpose.
     *
     * <p><strong>The event's own fault</strong> — a payload the broker will
     * never accept, a topic name that is not a topic name. The row is retired:
     * {@code failed_at} set, kept for inspection, never claimed again, and lifted
     * out of its meeting's ordering chain so the events behind it can finally
     * go. Then the batch <em>carries on</em>. A rejection of this kind says
     * nothing at all about the broker, so there is no reason to stop, and no
     * risk in continuing: the claim query returns at most one row per key, so
     * every remaining row belongs to a different meeting and none of them could
     * possibly be the retired event's successor.
     *
     * <p><strong>Anything else</strong> — a timeout, a disconnect, an expired
     * API key. The row keeps its place, its attempt count goes up, and it is
     * scheduled for a retry. Then the batch <em>stops</em>, and that is worth
     * defending because it looks like the global blocking Phase 2 was trying to
     * get rid of. It is not, because of the backoff: the failed row steps aside
     * for at least five seconds, so on the very next tick — one second later —
     * the rest of the batch is claimed without it. The cost of stopping is one
     * second of delay for unrelated meetings. The cost of not stopping is that
     * an unreachable broker makes the relay wait out the producer's delivery
     * timeout a hundred times in a single transaction — two minutes each, more
     * than three hours of one held database connection out of a pool of five,
     * on every instance at once, while nothing succeeds. Stopping is not the
     * historical behaviour being preserved out of habit; it is the only one of
     * the two that survives an outage.
     *
     * <p>Rows already marked in this batch still commit either way — they are
     * genuinely in Kafka, and un-marking them would guarantee a duplicate rather
     * than risk one.
     */
    @Transactional
    public void publishBatch() {
        List<OutboxEvent> pending = repo.claimBatch(BATCH);
        for (OutboxEvent event : pending) {
            try {
                String payload = mapper.writeValueAsString(event.getPayload());
                kafka.send(event.getTopic(), event.getPartitionKey(), payload).get();
                event.setPublished(true);
                // last_error describes a retry that is no longer pending, so it
                // goes. attempt_count stays: "this one took four tries" is true
                // forever and is the number worth having in front of you when
                // the same key gives trouble again. next_attempt_at is left
                // where it is and means nothing on a published row -- see the
                // entity for the rule.
                event.setLastError(null);
                published.increment();
            } catch (Exception e) {
                if (e instanceof InterruptedException) {
                    // Shutdown, almost certainly. Record it as the transient
                    // failure it is, but do not swallow the interrupt.
                    Thread.currentThread().interrupt();
                }
                if (recordFailure(event, e) == OutboxFailure.INFRASTRUCTURE) {
                    break;
                }
            }
        }
    }

    /**
     * Write down what went wrong, and decide whether this row gets another go.
     *
     * <p>All of it lands in the same transaction as the rest of the batch, so
     * the schedule is durable the moment the tick commits: a restart, a
     * failover or a deploy finds the backoff exactly where it was left, and
     * every instance reads the same one. There is no timer in memory anywhere.
     */
    private OutboxFailure recordFailure(OutboxEvent event, Throwable thrown) {
        OutboxFailure category = OutboxFailure.of(thrown);
        int attempt = event.getAttemptCount() + 1;

        event.setAttemptCount(attempt);
        event.setLastError(OutboxFailure.describe(thrown));

        if (category == OutboxFailure.EVENT_PERMANENT) {
            event.setFailedAt(clock.instant());
            failedPermanent.increment();
            retired.increment();
            // ERROR on the first occurrence, not the fifth: this one is never
            // going to resolve itself, and a meeting has stopped moving.
            log.error("Outbox event retired after {} attempt(s) — it can never be published. "
                            + "id={} topic={} key={} category={} error={}",
                    attempt, event.getId(), event.getTopic(), event.getPartitionKey(),
                    category, event.getLastError());
            // Say so, in this transaction, and let whoever owns the topic decide
            // what it means. Without this the row is honestly marked and the
            // meeting behind it waits in QUEUED for a message that is never
            // coming. See OutboxEventRetired for why it is synchronous.
            events.publishEvent(new OutboxEventRetired(
                    event.getId(), event.getTopic(), event.getPartitionKey(),
                    event.getPayload(), event.getLastError()));
            return category;
        }

        Instant due = clock.instant().plus(retryDelay(attempt));
        event.setNextAttemptAt(due);
        failedTransient.increment();
        if (attempt >= ESCALATE_AFTER) {
            log.error("Outbox publish still failing after {} attempts. "
                            + "id={} topic={} key={} category={} nextAttemptAt={} error={}",
                    attempt, event.getId(), event.getTopic(), event.getPartitionKey(),
                    category, due, event.getLastError());
        } else {
            log.warn("Outbox publish failed (attempt {}), retrying. "
                            + "id={} topic={} key={} category={} nextAttemptAt={} error={}",
                    attempt, event.getId(), event.getTopic(), event.getPartitionKey(),
                    category, due, event.getLastError());
        }
        return category;
    }

    /**
     * How long to wait before attempt {@code attempt + 1}.
     *
     * <p>Plain doubling from {@link #RETRY_BASE}, capped at {@link #RETRY_MAX}:
     *
     * <pre>
     *   attempt 1 →   5s        attempt 5 →  80s
     *   attempt 2 →  10s        attempt 6 → 160s
     *   attempt 3 →  20s        attempt 7 → 300s  (capped, and every one after)
     *   attempt 4 →  40s
     * </pre>
     *
     * <p>Reaching the cap takes about five and a quarter minutes of failures.
     *
     * <p><strong>No jitter</strong>, deliberately. Jitter exists to stop many
     * clients stampeding the same resource at the same instant, and there is no
     * stampede to prevent here: a row is claimed by exactly one relay at a time,
     * because {@code FOR UPDATE SKIP LOCKED} says so, and rows in backoff are not
     * claimed at all. Adding randomness would buy nothing and cost the property
     * that this function can be asserted on exactly.
     */
    static Duration retryDelay(int attempt) {
        if (attempt <= 1) {
            return RETRY_BASE;
        }
        // Shift is bounded so a wildly high attempt count cannot overflow into
        // a negative delay — an event stuck for a week would otherwise reach it.
        long seconds = RETRY_BASE.toSeconds() << Math.min(attempt - 1, 32);
        return seconds >= RETRY_MAX.toSeconds() ? RETRY_MAX : Duration.ofSeconds(seconds);
    }
}
