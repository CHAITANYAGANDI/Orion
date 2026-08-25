package com.recallix.repository;

import com.recallix.entity.OutboxEvent;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

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
}
