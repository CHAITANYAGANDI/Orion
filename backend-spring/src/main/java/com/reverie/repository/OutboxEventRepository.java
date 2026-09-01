package com.reverie.repository;

import com.reverie.entity.OutboxEvent;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.List;

public interface OutboxEventRepository extends JpaRepository<OutboxEvent, String> {

    /**
     * The rows this relay now owns, for the length of its transaction.
     *
     * <p>Must be called inside a transaction, and the transaction must stay open
     * until the rows have been published and marked: the locks are the claim,
     * and they are released by the commit. Called outside one, every row is
     * unlocked again the instant this returns and a second relay will take the
     * same rows.
     *
     * <p>See {@link OutboxClaimSql} for what the statement does and why. The
     * predecessor was {@code findByPublishedFalseOrderByCreatedAtAsc}, which
     * took no locks and handed both relays the same batch.
     */
    @Query(value = OutboxClaimSql.CLAIM, nativeQuery = true)
    List<OutboxEvent> claimBatch(@Param("batch") int batch);

    /**
     * Delete up to {@code batch} published events older than {@code cutoff}.
     *
     * <p>{@code published = true} is doing two jobs. It keeps this away from work
     * that has not happened yet, and it keeps it away from retired events, which
     * are kept deliberately and forever — a retired row is never published, so it
     * can never match here. That is the whole of the "do not purge failed events
     * with the normal cleanup" rule: it falls out of the predicate rather than
     * needing a second one.
     *
     * <p>The {@code LIMIT} makes the statement bounded, so this can never become
     * one enormous delete holding one enormous lock the first time it runs on a
     * table nobody has swept before.
     *
     * <p>Cannot collide with the relay, which locks only {@code published = false}
     * rows: the two never want the same row.
     *
     * @return how many rows went, so the caller knows whether to come round again
     */
    @Modifying
    // One transaction per batch, which is the point of batching: the caller runs
    // this in a loop with no transaction of its own, so each call opens, deletes
    // its two thousand rows and commits. A @Transactional purge() would have put
    // every batch in one transaction and produced exactly the long lock the
    // LIMIT is there to avoid.
    @Transactional
    @Query(value = """
            DELETE FROM outbox_events
             WHERE id IN (
                 SELECT id FROM outbox_events
                  WHERE published = true
                    AND created_at < :cutoff
                  LIMIT :batch)
            """, nativeQuery = true)
    int deletePublishedBefore(@Param("cutoff") Instant cutoff, @Param("batch") int batch);
}
