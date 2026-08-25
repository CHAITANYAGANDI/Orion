package com.recallix.repository;

/**
 * The statement that decides which outbox rows a relay owns.
 *
 * <p>It lives here as a constant rather than inline on the repository so the
 * concurrency test can execute the same text the application executes. A test
 * that proves {@code SKIP LOCKED} works against a hand-copied query proves
 * something about the copy.
 *
 * <p><strong>What it fixes.</strong> The relay used to read
 * {@code WHERE published = false ORDER BY created_at} with no locking at all.
 * With one Spring instance that is fine. With two, both read the same rows in
 * the same tick and both publish them: every meeting enqueued while two
 * instances were up would be transcribed twice, and the second copy is a
 * provider bill, not a duplicate row.
 *
 * <p><strong>{@code FOR UPDATE SKIP LOCKED}.</strong> Each relay takes the rows
 * it selects for the length of its transaction; a relay running concurrently
 * does not wait for them, it steps over them and takes the next eligible rows.
 * Nothing is written to say a row is claimed — the lock is the claim — so a
 * rollback, a killed instance or a lost connection releases the rows with no
 * lease to expire and no reaper to write. That is why there is no claim column
 * and no migration for one.
 *
 * <p><strong>Per-key FIFO, not global FIFO.</strong> The {@code NOT EXISTS}
 * makes a row eligible only when it is the oldest active row for its
 * {@code (topic, partition_key)} — which for {@code meeting_uploaded} is the
 * meeting. Two events for the same meeting can therefore never be in flight at
 * once or arrive out of order, while events for different meetings are claimed
 * and published concurrently. Global FIFO across all meetings is gone, and it
 * has to be: it is exactly the property that cannot survive two relays.
 *
 * <p>A consequence worth stating: because at most one row per key is ever
 * eligible, every row in a claimed batch belongs to a different key. That is
 * what lets the publisher retire a poison event and carry on with the rest of
 * the batch without any risk of letting a later event overtake it — the later
 * event is not in the batch, and could not have been.
 *
 * <p><strong>Ordering key.</strong> {@code created_at} is
 * {@code TIMESTAMPTZ DEFAULT now()}, which is transaction-start time and not
 * unique, so it cannot order rows on its own. {@code id} breaks the tie. It is
 * random ({@code obx_} plus twenty characters), so a tie is broken arbitrarily —
 * but consistently, by every relay, on every tick, which is the whole
 * requirement: two instances must never disagree about which row comes first.
 *
 * <p><strong>{@code IS NOT DISTINCT FROM}</strong> rather than {@code =} because
 * {@code partition_key} is nullable, and {@code NULL = NULL} would make every
 * unkeyed row its own island and let them overtake each other. There are none
 * today — every enqueue passes the meeting id — and treating them as one queue
 * is the conservative reading if any ever appear.
 *
 * <h2>Retry and terminal state</h2>
 *
 * <p>Two predicates differ between the outer query and the ordering subquery,
 * and the difference is the entire point of both.
 *
 * <p><strong>{@code next_attempt_at <= now()} is on the candidate only.</strong>
 * A row that failed recently is backing off and must not be picked up again for
 * a while. But it is still the head of its key's queue, and the events behind it
 * must not be allowed past while it waits — publishing A2 while A1 sits in
 * backoff is precisely the reordering the {@code NOT EXISTS} exists to prevent.
 * So the subquery does not ask whether the earlier row is <em>due</em>; it asks
 * only whether it is <em>still active</em>. Backing off blocks. Being claimed by
 * another relay blocks. Not having been looked at yet blocks. From here they are
 * indistinguishable, which is correct — in all three the event is still coming.
 *
 * <p><strong>{@code failed_at IS NULL} is on both.</strong> A terminal row is
 * one publication has been abandoned for. It must never be claimed again, hence
 * the outer predicate; and it must stop holding up the rest of its key, hence
 * the same predicate in the subquery, which lifts it out of the ordering chain
 * so the next event becomes the head. That is what stops one impossible event
 * from blocking a meeting forever. The row itself stays, with its error and its
 * attempt count, to be looked at.
 *
 * <p><strong>Ordering semantics, stated plainly.</strong> Per-key FIFO holds
 * across <em>active</em> events. A terminally failed event is removed from its
 * key's chain, so its successors proceed as though it were not there — they are
 * not held back by an event that is never going to be published. For
 * {@code meeting_uploaded}, the only topic in the application, this is safe
 * because ordering was never load-bearing there in the first place: Phase 1's
 * processing-attempt identity travels with each event, so an older attempt
 * cannot impersonate a newer one no matter what order they arrive in. A future
 * topic that genuinely needs a gap to stop the world must say so itself, with a
 * policy of its own, rather than quietly inheriting this one.
 *
 * <p><strong>No index for the new predicates.</strong> Measured rather than
 * assumed: against 5000 rows, {@code EXPLAIN ANALYZE} produced the same plan
 * with and without a covering
 * {@code (topic, partition_key, created_at, id) WHERE published = false AND failed_at IS NULL}
 * partial index — the planner used {@code idx_outbox_unpublished} for both sides
 * of the anti-join either way and never touched the new index. See V59.
 */
public final class OutboxClaimSql {

    private OutboxClaimSql() {
    }

    public static final String CLAIM = """
            SELECT o.*
              FROM outbox_events o
             WHERE o.published = false
               AND o.failed_at IS NULL
               AND o.next_attempt_at <= now()
               AND NOT EXISTS (
                   SELECT 1
                     FROM outbox_events earlier
                    WHERE earlier.published = false
                      AND earlier.failed_at IS NULL
                      AND earlier.topic = o.topic
                      AND earlier.partition_key IS NOT DISTINCT FROM o.partition_key
                      AND (earlier.created_at, earlier.id) < (o.created_at, o.id))
             ORDER BY o.created_at, o.id
             LIMIT :batch
               FOR UPDATE SKIP LOCKED
            """;
}
