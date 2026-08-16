package com.recallix.repository;

import com.recallix.entity.Notification;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.time.Instant;
import java.util.Optional;

public interface NotificationRepository extends JpaRepository<Notification, String> {

    /**
     * The list, newest first, optionally only the unread ones.
     *
     * <p>One query rather than two methods because the bell and the page differ
     * by exactly this flag, and two derived queries would drift the ordering.
     */
    @Query("""
            SELECT n FROM Notification n
            WHERE n.userId = :userId
              AND (:unreadOnly = false OR n.readAt IS NULL)
            ORDER BY n.createdAt DESC
            """)
    Page<Notification> findForUser(@Param("userId") String userId,
                                   @Param("unreadOnly") boolean unreadOnly,
                                   Pageable pageable);

    long countByUserIdAndReadAtIsNull(String userId);

    Optional<Notification> findByIdAndUserId(String id, String userId);

    @Modifying(clearAutomatically = true, flushAutomatically = true)
    @Query("UPDATE Notification n SET n.readAt = :now WHERE n.userId = :userId AND n.readAt IS NULL")
    int markAllRead(@Param("userId") String userId, @Param("now") Instant now);

    @Modifying(clearAutomatically = true, flushAutomatically = true)
    @Query("DELETE FROM Notification n WHERE n.userId = :userId")
    int deleteAllForUser(@Param("userId") String userId);

    /**
     * Whether this exact thing has already been said.
     *
     * <p>The unique index in V34 is what actually enforces it — two reminder
     * passes racing would both pass a read-then-write check. This exists so the
     * common case does not have to be a caught constraint violation.
     */
    boolean existsByUserIdAndKindAndDedupeKey(String userId,
                                              com.recallix.domain.NotificationKind kind,
                                              String dedupeKey);
}
