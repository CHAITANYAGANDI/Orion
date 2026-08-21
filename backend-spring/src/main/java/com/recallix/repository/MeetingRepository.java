package com.recallix.repository;

import com.recallix.entity.Meeting;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.time.Instant;
import java.util.List;
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
     * Everything one account owns, newest first.
     *
     * <p>Unpaged on purpose, and only ever called by the three operations that
     * genuinely mean all of it: exporting an account, closing one, and taking an
     * inventory of what is held. Paging those would mean a partial export or a
     * partial deletion, which are both worse than a slow one.
     */
    List<Meeting> findByUserIdOrderByCreatedAtDesc(String userId);

    /**
     * One account's meetings old enough for a retention rule to act on.
     *
     * <p>Per account rather than across the whole table, because the cut-off is
     * per account: two people with different policies have different definitions
     * of old. It also keeps the nightly pass inside the same tenant boundary as
     * every other read. V35 adds the composite index it needs.
     */
    List<Meeting> findByUserIdAndCreatedAtLessThanOrderByCreatedAtAsc(String userId, Instant before);

    /** One project's meetings, newest first — the project page's list. */
    List<Meeting> findByUserIdAndProjectIdOrderByCreatedAtDesc(String userId, String projectId);

    /** Everything not filed anywhere, which the tree shows last. */
    List<Meeting> findByUserIdAndProjectIdIsNullOrderByCreatedAtDesc(String userId);

    /**
     * What a project-scoped question is allowed to read.
     *
     * <p>Ids only: this feeds the retrieval filter, and loading whole meetings
     * to throw away everything but the key would be a page of rows read per
     * question asked.
     */
    @Query("SELECT m.id FROM Meeting m WHERE m.userId = :userId AND m.projectId = :projectId")
    List<String> findIdsByUserIdAndProjectId(@Param("userId") String userId,
                                             @Param("projectId") String projectId);

    /**
     * How many meetings each project holds, in one read.
     *
     * <p>Returned as rows of {@code [projectId, count]} rather than counted per
     * project: the sidebar shows every project at once, and a count query each
     * would be one round trip per row on the most-visited list in the app.
     */
    @Query("""
            SELECT m.projectId, COUNT(m)
              FROM Meeting m
             WHERE m.userId = :userId AND m.projectId IS NOT NULL
             GROUP BY m.projectId
            """)
    List<Object[]> countByProject(@Param("userId") String userId);

    /** Unfile every meeting in a project — see {@code ProjectService.delete}. */
    @Modifying
    @Query("UPDATE Meeting m SET m.projectId = NULL WHERE m.userId = :userId AND m.projectId = :projectId")
    int clearProject(@Param("userId") String userId, @Param("projectId") String projectId);

    /**
     * Owner-scoped search. Optional case-insensitive title match, status filter
     * (as text), tag containment against the jsonb `tags` array, and a
     * created-at window. Native so the jsonb `?` containment operator is
     * available; params are nullable to make each filter optional. Written as
     * `:param IS NULL OR ...`.
     *
     * <p>The window is half-open — {@code from} inclusive, {@code to}
     * exclusive — so a caller asking for one day passes midnight to midnight
     * and gets that day, rather than that day plus whatever landed exactly on
     * the following midnight.
     *
     * <p>{@code unfiled} is the one filter that is a flag rather than a value,
     * because the thing being matched is an absence: a meeting with no folder.
     * A nullable {@code projectId} could not express it — null already means
     * "do not filter by folder" — so the two questions are kept apart.
     */
    @Query(value = """
            SELECT * FROM meetings m
            WHERE m.user_id = :userId
              AND (:search IS NULL OR m.title ILIKE '%' || :search || '%')
              AND (:status IS NULL OR m.status = :status)
              AND (:tag IS NULL OR m.tags @> CAST(('["' || :tag || '"]') AS jsonb))
              AND (CAST(:from AS timestamptz) IS NULL OR m.created_at >= CAST(:from AS timestamptz))
              AND (CAST(:to   AS timestamptz) IS NULL OR m.created_at <  CAST(:to   AS timestamptz))
              AND (:unfiled = FALSE OR m.project_id IS NULL)
            ORDER BY m.created_at DESC
            """,
            countQuery = """
            SELECT COUNT(*) FROM meetings m
            WHERE m.user_id = :userId
              AND (:search IS NULL OR m.title ILIKE '%' || :search || '%')
              AND (:status IS NULL OR m.status = :status)
              AND (:tag IS NULL OR m.tags @> CAST(('["' || :tag || '"]') AS jsonb))
              AND (CAST(:from AS timestamptz) IS NULL OR m.created_at >= CAST(:from AS timestamptz))
              AND (CAST(:to   AS timestamptz) IS NULL OR m.created_at <  CAST(:to   AS timestamptz))
              AND (:unfiled = FALSE OR m.project_id IS NULL)
            """,
            nativeQuery = true)
    Page<Meeting> search(@Param("userId") String userId,
                         @Param("search") String search,
                         @Param("status") String status,
                         @Param("tag") String tag,
                         @Param("from") Instant from,
                         @Param("to") Instant to,
                         @Param("unfiled") boolean unfiled,
                         Pageable pageable);
}
