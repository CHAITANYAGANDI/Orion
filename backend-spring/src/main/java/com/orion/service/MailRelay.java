package com.orion.service;

import com.orion.repository.MailOutboxRepository;
import com.orion.security.TenantContext;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.time.Instant;

/**
 * Drains the mail outbox, and clears up after itself.
 *
 * <p><b>Safe on every instance.</b> Each tick claims its rows with
 * {@code FOR UPDATE SKIP LOCKED}, so two backends divide the backlog rather
 * than both sending all of it. There is no leader election and nothing to
 * configure — an instance that is up relays, an instance that is not simply
 * does not. The same arrangement {@code OutboxRelay} has, and the reasoning is
 * spelled out in {@code OutboxClaimSql}.
 *
 * <p><b>An outage is a delay.</b> A message that cannot be delivered records
 * the attempt and a time to try again and is not claimed before then, so an
 * unreachable provider produces a handful of warnings that thin out to one an
 * hour rather than one per second per instance forever. The schedule is a
 * column, so every instance agrees on it and a restart does not reset it.
 *
 * <p>Runs in system context: this is infrastructure with no user behind it, and
 * {@code mail_outbox} is drainable only by the system role under the V64
 * policy. The context is established here, outside the transaction, because the
 * connection is stamped when the transaction borrows it —
 * {@link MailDispatcher} holds the transactional half for exactly that reason.
 */
@Component
public class MailRelay {

    private static final Logger log = LoggerFactory.getLogger(MailRelay.class);

    private final MailDispatcher dispatcher;
    private final MailOutboxRepository outbox;
    private final Duration keepSentFor;

    private final Duration keepAbandonedFor;

    public MailRelay(MailDispatcher dispatcher,
                     MailOutboxRepository outbox,
                     @Value("${orion.mail.keep-sent-days:7}") long keepSentDays,
                     @Value("${orion.mail.keep-abandoned-days:30}") long keepAbandonedDays) {
        this.dispatcher = dispatcher;
        this.outbox = outbox;
        this.keepSentFor = Duration.ofDays(keepSentDays);
        this.keepAbandonedFor = Duration.ofDays(keepAbandonedDays);
    }

    /**
     * Ten seconds, not one.
     *
     * <p>The Kafka relay ticks every second because a meeting waiting to be
     * transcribed is somebody watching a spinner. Nothing here is watched: the
     * fastest of these messages reports a recording that took minutes to
     * process, and the slowest is a digest with a day's tolerance. Ten seconds
     * costs nothing anybody notices and is a tenth of the queries.
     */
    @Scheduled(fixedDelayString = "${orion.mail.poll-ms:10000}")
    public void deliverPending() {
        try {
            int sent = TenantContext.asSystem(() -> {
                /*
                 * Retire what is past its useful-by date before claiming.
                 * The claim query already skips these; this is what stops them
                 * sitting in the pending state for ever, invisible to the relay
                 * and misleading to anybody reading the table.
                 */
                int expired = outbox.retireExpired();
                if (expired > 0) {
                    log.info("Retired {} message(s) that were no longer worth sending.", expired);
                }
                return dispatcher.deliverBatch();
            });
            if (sent > 0) {
                log.info("Delivered {} queued message(s).", sent);
            }
        } catch (Exception e) {
            // Never kill the scheduler thread: the Kafka relay, the retention
            // pass and both digests run on it too.
            log.error("Mail relay tick failed: {}", e.getMessage(), e);
        }
    }

    /**
     * The lifecycle, run once a night.
     *
     * <h2>Why this table needs one at all</h2>
     *
     * <p>{@code mail_outbox} has no foreign key to {@code users} and must not
     * have one — the account-closure message is delivered after the row it
     * would reference is gone. The cost is exactly what it sounds like: an
     * address, a subject and a body outlive {@code closeAccount}, which has
     * otherwise erased everything about the account. So the lifetime is written
     * down and it is short.
     *
     * <p><b>Seven days for delivered.</b> A delivered row is a receipt; the
     * message has arrived and the person has it. Long enough to answer "did
     * that go out on Tuesday", short enough that a closed account's address is
     * not sitting here a month later.
     *
     * <p><b>Thirty days for abandoned.</b> Longer than delivered, which looks
     * backwards for a privacy lifetime and is the deliberate choice: an
     * abandoned row is the record that somebody was <em>not</em> told
     * something, and for the closure notice it is the only trace the notice
     * failed. A week is not long enough for anybody to notice, ask and look.
     *
     * <p>Both are bounded-batch deletes, so two relays running this at once
     * delete disjoint sets and neither holds a long lock — the same property
     * {@code OutboxPurge} relies on.
     */
    @Scheduled(cron = "${orion.mail.purge-cron:0 40 3 * * *}", zone = "UTC")
    public void purge() {
        try {
            TenantContext.runAsSystem(() -> {
                int sent = drain(cutoff -> outbox.deleteSentBefore(cutoff, 2000),
                        Instant.now().minus(keepSentFor));
                int abandoned = drain(cutoff -> outbox.deleteAbandonedBefore(cutoff, 2000),
                        Instant.now().minus(keepAbandonedFor));
                if (sent + abandoned > 0) {
                    log.info("Purged {} delivered and {} abandoned message(s).", sent, abandoned);
                }
            });
        } catch (Exception e) {
            log.error("Mail purge failed: {}", e.getMessage(), e);
        }
    }

    private interface Batch {
        int delete(Instant cutoff);
    }

    /** Bounded batches until there are none left. Never one long lock. */
    private static int drain(Batch batch, Instant cutoff) {
        int removed;
        int total = 0;
        do {
            removed = batch.delete(cutoff);
            total += removed;
        } while (removed > 0);
        return total;
    }
}
