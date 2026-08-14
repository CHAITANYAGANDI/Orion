package com.recallix.repository;

import com.recallix.entity.Meeting;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.Optional;

public interface MeetingRepository extends JpaRepository<Meeting, String> {

    Optional<Meeting> findByIdAndUserId(String id, String userId);

    /**
     * The most recent meeting a user owns, whatever its state.
     *
     * <p>Read only to date-stamp the workspace suggestion cache: if a meeting
     * arrived after the suggestions were written, they describe an archive that
     * no longer exists and are regenerated.
     */
    Optional<Meeting> findFirstByUserIdOrderByCreatedAtDesc(String userId);

    Optional<Meeting> findByObjectKeyAndUserId(String objectKey, String userId);

    /** Backs the "you already imported that video" check (unique index in V6). */
    Optional<Meeting> findByUserIdAndSourceUrl(String userId, String sourceUrl);

    long countByUserId(String userId);

    /**
     * Owner-scoped search. Optional case-insensitive title match, status filter
     * (as text), and tag containment against the jsonb `tags` array. Native so
     * the jsonb `?` containment operator is available; params are nullable to
     * make each filter optional. Written as `:param IS NULL OR ...`.
     */
    @Query(value = """
            SELECT * FROM meetings m
            WHERE m.user_id = :userId
              AND (:search IS NULL OR m.title ILIKE '%' || :search || '%')
              AND (:status IS NULL OR m.status = :status)
              AND (:tag IS NULL OR m.tags @> CAST(('["' || :tag || '"]') AS jsonb))
            ORDER BY m.created_at DESC
            """,
            countQuery = """
            SELECT COUNT(*) FROM meetings m
            WHERE m.user_id = :userId
              AND (:search IS NULL OR m.title ILIKE '%' || :search || '%')
              AND (:status IS NULL OR m.status = :status)
              AND (:tag IS NULL OR m.tags @> CAST(('["' || :tag || '"]') AS jsonb))
            """,
            nativeQuery = true)
    Page<Meeting> search(@Param("userId") String userId,
                         @Param("search") String search,
                         @Param("status") String status,
                         @Param("tag") String tag,
                         Pageable pageable);
}
