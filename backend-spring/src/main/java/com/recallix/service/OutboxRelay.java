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
 * <p><strong>A failure does not become a busy loop.</strong> A row that cannot
 * be published records the attempt and a time to try again, and is not claimed
 * before then — so an unreachable broker produces a handful of warnings that
 * thin out to one every five minutes, rather than one per second per instance
 * forever. The schedule is a column, so it is the same for every instance and
 * survives a restart. An event that can never be published at all is retired
 * rather than retried, and stops holding up the other events for its meeting.
 * {@link OutboxPublisher} has the detail.
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
