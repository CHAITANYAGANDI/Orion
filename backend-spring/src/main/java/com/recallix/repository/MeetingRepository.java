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
     * Take this meeting's row, and hold it until the transaction ends.
     *
     * <p>Not for what it reads — the id is already known — but for the order it
     * imposes. Two things replace a meeting's transcript-derived rows: erasure
     * here, and the ai-service's RAG indexer. The indexer takes this row first
     * and {@code transcript_chunks} second (see {@code app/rag.py}), so anything
     * on this side that takes the chunks first and the meeting second is an
     * inverted lock order and deadlocks whenever the two overlap. This is how
     * the erasure path joins the same queue rather than fighting it.
     *
     * <p>{@code FOR NO KEY UPDATE} rather than {@code FOR UPDATE}, matching the
     * indexer: it conflicts with the ordinary {@code UPDATE} that both sides
     * eventually issue, which is the point, without blocking the
     * {@code FOR KEY SHARE} every insert referencing this meeting takes — a
     * segment, an action item, a notification.
     *
     * <p>Nothing slow may run while this is held. It is taken immediately before
     * the deletes and released by the commit that follows them.
     */
    @Query(value = "SELECT id FROM meetings WHERE id = :id FOR NO KEY UPDATE",
            nativeQuery = true)
    Optional<String> lockForWrite(@Param("id") String id);

    /**
     * Take the meeting row and read the run it is on, in one statement.
     *
     * <p>For allocating the next processing attempt. Reading the number and
     * writing number+1 as two separate steps is a lost update waiting for two
     * people to press Reprocess at once, or one person to press it twice: both
     * transactions read N, both write N+1, and two independent pipeline runs end
     * up sharing one identity — which is precisely the thing every stale-callback
     * check in the system is keyed on. One of the two runs is then
     * indistinguishable from the other and both are accepted.
     *
     * <p>Locking and reading together closes it. The second caller blocks here
     * until the first commits and then — because {@code FOR NO KEY UPDATE}
     * re-reads the row it waited for rather than the snapshot it started with —
     * sees N+1 and allocates N+2.
     *
     * <p>Deliberately not the entity's own {@code getProcessingAttempt()}: that
     * value was loaded whenever the entity was, which for the language-correction
     * path is before any of this, and a concurrent commit in between would not
     * show up in it.
     *
     * <p>Same row, same lock mode and same order as {@link #lockForWrite}, so
     * erasure and reprocess queue behind each other instead of deadlocking.
     */
    @Query(value = "SELECT processing_attempt FROM meetings WHERE id = :id FOR NO KEY UPDATE",
            nativeQuery = true)
    Optional<Integer> lockAndReadAttempt(@Param("id") String id);

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

    /**
     * Everything not filed anywhere, which the tree shows last.
     *
     * <p>Confirmed meetings only — see {@link #search} for what {@code CREATED}
     * means and why it is never listed.
     */
    @Query("""
            SELECT m FROM Meeting m
             WHERE m.userId = :userId
               AND m.projectId IS NULL
               AND m.status <> com.recallix.domain.MeetingStatus.CREATED
             ORDER BY m.createdAt DESC
            """)
    List<Meeting> findUnfiled(@Param("userId") String userId);

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
     *
     * <p><b>{@code CREATED} rows are never returned, and are not meetings.</b>
     * {@code createUploadUrl} writes one at presign so the object key can carry
     * the meeting id, and {@code createMeeting} is what turns it into a meeting:
     * it charges the allowance, applies the title, the folder and the tags, and
     * moves the row to {@code QUEUED}. Everything between those two calls is a
     * reservation — an upload that may never arrive, a confirmation that may be
     * refused for having no minutes left, a tab that was closed.
     *
     * <p>Nothing cleans those up, deliberately: the comment on
     * {@code createMeeting} notes that charging at confirmation is what makes an
     * abandoned upload free. Being free was handled and being invisible was not,
     * so every abandoned presign appeared in the list as a meeting stuck at
     * "Uploading recording… 1%" for ever, with no way to remove it. Excluded
     * here rather than swept, because a sweep still leaves them on screen until
     * it runs.
     */
    @Query(value = """
            SELECT * FROM meetings m
            WHERE m.user_id = :userId
              AND m.status <> 'CREATED'
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
              AND m.status <> 'CREATED'
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
