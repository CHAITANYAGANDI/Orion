package com.recallix.repository;

import com.recallix.entity.MeetingActionItem;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.List;
import java.util.Optional;

public interface MeetingActionItemRepository extends JpaRepository<MeetingActionItem, String> {

    List<MeetingActionItem> findByMeetingId(String meetingId);

    void deleteByMeetingId(String meetingId);

    /** Fetch a single item scoped to its owning user (via the parent meeting). */
    @Query("""
            SELECT a FROM MeetingActionItem a
            WHERE a.id = :id
              AND a.meetingId IN (SELECT m.id FROM Meeting m WHERE m.userId = :userId)
            """)
    Optional<MeetingActionItem> findByIdForUser(@Param("id") String id, @Param("userId") String userId);

    /** Cross-meeting action items for a user with optional status/priority filters. */
    @Query("""
            SELECT a FROM MeetingActionItem a
            WHERE a.meetingId IN (SELECT m.id FROM Meeting m WHERE m.userId = :userId)
              AND (:status IS NULL OR a.status = :status)
              AND (:priority IS NULL OR a.priority = :priority)
            ORDER BY a.createdAt DESC
            """)
    Page<MeetingActionItem> findForUser(@Param("userId") String userId,
                                       @Param("status") String status,
                                       @Param("priority") String priority,
                                       Pageable pageable);
}
