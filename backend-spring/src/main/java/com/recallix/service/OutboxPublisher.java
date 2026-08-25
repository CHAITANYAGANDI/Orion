package com.recallix.service;

import com.recallix.entity.OutboxEvent;
import com.recallix.repository.OutboxEventRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

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

    private final OutboxEventRepository repo;
    private final KafkaTemplate<String, String> kafka;
    private final com.fasterxml.jackson.databind.ObjectMapper mapper;

    public OutboxPublisher(OutboxEventRepository repo,
                           KafkaTemplate<String, String> kafka,
                           com.fasterxml.jackson.databind.ObjectMapper mapper) {
        this.repo = repo;
        this.kafka = kafka;
        this.mapper = mapper;
    }

    /**
     * Claim a batch, publish it, mark it, commit.
     *
     * <p>The transaction is the claim. {@code claimBatch} takes a row lock on
     * everything it returns and another relay steps over those rows rather than
     * waiting for them, so two instances divide the backlog instead of both
     * publishing all of it. The locks are released by this method returning —
     * on commit with the rows marked published, on rollback with them untouched
     * and eligible again on somebody's next tick.
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
     * it". The cost is that the row locks are held for the length of the batch:
     * with a slow or unreachable broker, up to the producer's delivery timeout
     * for the message that stalls, after which the batch stops. Another relay is
     * unaffected — it skips these rows and works on other meetings.
     */
    @Transactional
    public void publishBatch() {
        List<OutboxEvent> pending = repo.claimBatch(BATCH);
        for (OutboxEvent event : pending) {
            try {
                String payload = mapper.writeValueAsString(event.getPayload());
                kafka.send(event.getTopic(), event.getPartitionKey(), payload).get();
                event.setPublished(true);
            } catch (Exception e) {
                // Leave unpublished; retried next tick. The break stops this
                // batch rather than skipping past the failure: within one key
                // the next event must not overtake the one that just failed,
                // and a broker that refused this message is unlikely to take
                // the next hundred.
                //
                // Rows already marked in this batch still commit — they are
                // genuinely in Kafka. The failed row and everything after it
                // stay unpublished, and their locks go when this returns.
                log.warn("Outbox publish failed for {} ({}): {}", event.getId(), event.getTopic(), e.getMessage());
                break;
            }
        }
    }
}
