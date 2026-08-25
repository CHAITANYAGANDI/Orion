package com.recallix.service;

import com.recallix.security.TenantContext;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Polls the outbox and relays unpublished events to Kafka (at-least-once). Runs
 * frequently. If Kafka is down the rows simply stay unpublished and are retried
 * on the next tick.
 *
 * <p><strong>Safe to run on every instance.</strong> Each tick claims its rows
 * with {@code FOR UPDATE SKIP LOCKED}, so two backends divide the backlog
 * rather than both publishing all of it — see {@code OutboxClaimSql}. There is
 * no leader election and nothing to configure: an instance that is up relays,
 * an instance that is not simply does not.
 *
 * <p>Runs in system context: this is infrastructure with no user behind it, and
 * {@code outbox_events} is readable only by system under the V9 policies. The
 * context is established here, outside the transaction, because the connection
 * is stamped when the transaction borrows it — {@link OutboxPublisher} holds
 * the transactional work for exactly that reason.
 */
@Component
public class OutboxRelay {

    private final OutboxPublisher publisher;

    public OutboxRelay(OutboxPublisher publisher) {
        this.publisher = publisher;
    }

    @Scheduled(fixedDelayString = "${recallix.outbox.poll-ms:1000}")
    public void publishPending() {
        TenantContext.runAsSystem(publisher::publishBatch);
    }
}
