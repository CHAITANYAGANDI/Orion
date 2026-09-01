package com.reverie.repository;

import com.reverie.entity.ActionItemComment;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.Collection;
import java.util.List;
import java.util.Optional;

public interface ActionItemCommentRepository extends JpaRepository<ActionItemComment, String> {

    /** One item's log, oldest first — a log read newest-first is a feed, not a log. */
    List<ActionItemComment> findByActionItemIdOrderByCreatedAtAsc(String actionItemId);

    long countByActionItemId(String actionItemId);

    Optional<ActionItemComment> findByIdAndUserId(String id, String userId);

    /**
     * How many entries each of these items has.
     *
     * <p>A list of tasks shows a count per row; asking per row is one query per
     * task, which on a page of fifty is fifty round trips for a number.
     */
    @Query("""
            SELECT c.actionItemId, COUNT(c)
              FROM ActionItemComment c
             WHERE c.actionItemId IN :ids
             GROUP BY c.actionItemId
            """)
    List<Object[]> countByActionItemIds(@Param("ids") Collection<String> ids);
}
