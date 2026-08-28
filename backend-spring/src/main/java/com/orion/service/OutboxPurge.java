package com.orion.service;

import com.orion.repository.OutboxEventRepository;
import com.orion.security.TenantContext;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;

/**
 * Throw away outbox rows that have done their job.
 *
 * <p>The outbox is a queue, not a record. Once a row is published its only
 * remaining value is answering "did this event go out, and when" during the
 * hours after something looked wrong — and nothing in Orion reads it for any
 * other purpose: no endpoint exposes it, no report counts it, no replay reads
 * it, and it is not part of the audit trail. What a meeting actually did is in
 * {@code audit_logs} and in the meeting's own status and error message, both of
 * which outlive this table on purpose. Left alone the rows accumulate forever,
 * one per upload and one per reprocess, each carrying its full event payload.
 *
 * <p><strong>Seven days.</strong> Long enough that a problem noticed on Monday
 * can still be traced back through the weekend that caused it, which is the
 * realistic support question; short enough that the table stays a queue. The
 * pipeline itself finishes in minutes, so anything longer is keeping records to
 * answer questions nobody asks — thirty days was the obvious number and it is
 * four times more history than the thing being diagnosed takes to happen.
 *
 * <p><strong>Only published rows.</strong> Never pending ones, which are work
 * that has not happened yet. And never retired ones: those are kept
 * <em>deliberately</em>, with their payload and their error, because a retired
 * event is the record of a meeting that did not get processed and is the one
 * thing here somebody may need to read months later. If they should ever expire
 * too, that is a separate policy with a separate number, not a side effect of
 * this one.
 *
 * <p><strong>Batched.</strong> A single unbounded {@code DELETE} on a table that
 * has been quietly growing since the first deploy is one long lock and one large
 * transaction; a few thousand at a time is neither. It cannot collide with the
 * relay in any case — the relay locks only {@code published = false} rows and
 * this touches only {@code published = true} ones, so the two never want the
 * same row — but the bounded loop also means this job is never the reason a
 * connection is held for a long time.
 */
@Component
public class OutboxPurge {

    private static final Logger log = LoggerFactory.getLogger(OutboxPurge.class);

    /** Rows per statement, and per transaction. */
    private static final int BATCH = 2_000;

    /**
     * Give up after this many batches and finish tomorrow.
     *
     * <p>Only reachable on the first run after a long time without one, and the
     * point is that even then this job ends. 100 × 2000 is 200000 rows, well
     * beyond anything a backlog of published events will reach here.
     */
    private static final int MAX_BATCHES = 100;

    private final OutboxEventRepository repo;
    private final Duration keepFor;
    private final Clock clock;

    // Explicit for the same reason OutboxPublisher's is: two constructors and
    // Spring picks neither. The other one exists so a test can fix the clock and
    // shorten the window.
    @org.springframework.beans.factory.annotation.Autowired
    public OutboxPurge(OutboxEventRepository repo,
                       @Value("${orion.outbox.keep-published-days:7}") int keepPublishedDays) {
        this(repo, Duration.ofDays(keepPublishedDays), Clock.systemUTC());
    }

    OutboxPurge(OutboxEventRepository repo, Duration keepFor, Clock clock) {
        this.repo = repo;
        this.keepFor = keepFor;
        this.clock = clock;
    }

    /**
     * Nightly, at an hour chosen to not coincide with the retention pass at 03:00
     * — they touch different tables, but there is no reason to have both holding
     * connections from a five-connection pool at the same moment.
     */
    @Scheduled(cron = "${orion.outbox.purge-cron:0 30 4 * * *}", zone = "UTC")
    public void purgePublished() {
        try {
            TenantContext.runAsSystem(this::purge);
        } catch (Exception e) {
            // This job deletes rows on a schedule. It failing is a tidiness
            // problem; it killing the scheduler thread would stop the relay.
            log.error("Outbox purge failed: {}", e.getMessage(), e);
        }
    }

    /** Visible for testing; must already be in system context. */
    int purge() {
        Instant cutoff = clock.instant().minus(keepFor);
        int total = 0;
        for (int batch = 0; batch < MAX_BATCHES; batch++) {
            int deleted = repo.deletePublishedBefore(cutoff, BATCH);
            total += deleted;
            if (deleted < BATCH) {
                break;
            }
        }
        if (total > 0) {
            log.info("Outbox purge removed {} published event(s) older than {}.", total, cutoff);
        }
        return total;
    }
}
