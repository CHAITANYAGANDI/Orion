package com.recallix.repository;

import com.recallix.entity.Commitment;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.List;
import java.util.Optional;

public interface CommitmentRepository extends JpaRepository<Commitment, String> {

    Optional<Commitment> findByIdAndUserId(String id, String userId);

    List<Commitment> findByActionItemIdIn(List<String> actionItemIds);

    @Query("""
            SELECT c FROM Commitment c
            WHERE c.userId = :userId
              AND (:status IS NULL OR c.status = :status)
            ORDER BY c.updatedAt DESC
            """)
    Page<Commitment> findForUser(@Param("userId") String userId,
                                 @Param("status") String status,
                                 Pageable pageable);

    /**
     * Commitments still worth checking against a newly-processed meeting: the
     * user's own, not yet resolved, and made in some <em>other</em> meeting.
     * A meeting cannot be evidence about a promise made in that same meeting.
     */
    @Query("""
            SELECT c FROM Commitment c
            WHERE c.userId = :userId
              AND c.originMeetingId <> :meetingId
              AND c.status IN ('OPEN', 'SLIPPED')
            ORDER BY c.createdAt ASC
            """)
    List<Commitment> findReconcilable(@Param("userId") String userId,
                                      @Param("meetingId") String meetingId);

    long countByUserIdAndStatus(String userId, String status);
}
