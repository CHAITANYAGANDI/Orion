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
 * makes a row eligible only when it is the oldest unpublished row for its
 * {@code (topic, partition_key)} — which for {@code meeting_uploaded} is the
 * meeting. Two events for the same meeting can therefore never be in flight at
 * once or arrive out of order, while events for different meetings are claimed
 * and published concurrently. Global FIFO across all meetings is gone, and it
 * has to be: it is exactly the property that cannot survive two relays.
 *
 * <p>An older unpublished row blocks its successors whether it is locked by
 * another relay or simply not picked up yet, because both cases look identical
 * from here — still {@code published = false}. When it commits as published the
 * successor becomes eligible on the next tick; when it rolls back, it stays the
 * head of its own queue.
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
 */
public final class OutboxClaimSql {

    private OutboxClaimSql() {
    }

    public static final String CLAIM = """
            SELECT o.*
              FROM outbox_events o
             WHERE o.published = false
               AND NOT EXISTS (
                   SELECT 1
                     FROM outbox_events earlier
                    WHERE earlier.published = false
                      AND earlier.topic = o.topic
                      AND earlier.partition_key IS NOT DISTINCT FROM o.partition_key
                      AND (earlier.created_at, earlier.id) < (o.created_at, o.id))
             ORDER BY o.created_at, o.id
             LIMIT :batch
               FOR UPDATE SKIP LOCKED
            """;
}
