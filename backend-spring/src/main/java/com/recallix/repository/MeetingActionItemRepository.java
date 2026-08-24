package com.recallix.repository;

import com.recallix.entity.MeetingActionItem;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.time.LocalDate;
import java.util.Collection;
import java.util.List;
import java.util.Optional;

public interface MeetingActionItemRepository extends JpaRepository<MeetingActionItem, String> {

    /**
     * Ownership, tested on the row itself.
     *
     * <p>Was a subquery through the parent meeting until V36. It had to change
     * when an action item stopped needing a meeting: a task typed on the home
     * screen has no {@code meeting_id}, so the old predicate was false for
     * exactly the rows somebody had just created, and their own work would have
     * been invisible to them. It is also cheaper — one column comparison rather
     * than a primary-key lookup per row.
     */
    String OWNED_BY = " a.userId = :userId ";

    /**
     * One deadline order, used everywhere a list of tasks is shown.
     *
     * <p>Finished work sinks, undated work sinks within its group, and the
     * nearest deadline is at the top — which is the only ordering that answers
     * the question somebody opens this page to ask.
     *
     * <p>Priority used to break ties between two items due the same day. It is
     * gone (V54), so those fall back to newest first — which is what this
     * already did for everything undated, and is a fact about the list rather
     * than a guess about the work.
     */
    String DEADLINE_ORDER = """
            ORDER BY CASE WHEN a.status = 'DONE' THEN 1 ELSE 0 END,
                     CASE WHEN a.dueOn IS NULL THEN 1 ELSE 0 END,
                     a.dueOn,
                     a.createdAt DESC
            """;

    @Query("SELECT a FROM MeetingActionItem a WHERE a.meetingId = :meetingId " + DEADLINE_ORDER)
    List<MeetingActionItem> findByMeetingId(@Param("meetingId") String meetingId);

    void deleteByMeetingId(String meetingId);

    /**
     * Clear only what the extractor owns, ahead of writing its output again.
     *
     * <p>A row somebody has ticked off, retitled, reassigned or added by hand is
     * theirs, and a reprocess — which is how you pick up a corrected transcript
     * — must not be a way to lose it. Mirrors
     * {@code MeetingInsightRepository.deleteDerivedByMeetingId}.
     */
    @Modifying
    @Query("DELETE FROM MeetingActionItem a WHERE a.meetingId = :meetingId AND a.edited = false")
    void deleteDerivedByMeetingId(@Param("meetingId") String meetingId);

    @Query("SELECT a FROM MeetingActionItem a WHERE a.meetingId = :meetingId AND a.edited = true")
    List<MeetingActionItem> findEditedByMeetingId(@Param("meetingId") String meetingId);

    /** Everything one account has committed to, counted — the privacy inventory. */
    @Query("SELECT COUNT(a) FROM MeetingActionItem a WHERE " + OWNED_BY)
    long countForUser(@Param("userId") String userId);

    /** Fetch a single item scoped to its owning user (via the parent meeting). */
    @Query("SELECT a FROM MeetingActionItem a WHERE a.id = :id AND " + OWNED_BY)
    Optional<MeetingActionItem> findByIdForUser(@Param("id") String id, @Param("userId") String userId);

    /** The same check for a set of ids — bulk actions must not become a per-id round trip. */
    @Query("SELECT a FROM MeetingActionItem a WHERE a.id IN :ids AND " + OWNED_BY)
    List<MeetingActionItem> findAllByIdForUser(@Param("ids") Collection<String> ids,
                                               @Param("userId") String userId);

    /**
     * The action-items page, with every filter it offers.
     *
     * <p>Each filter is a null-means-unfiltered parameter rather than a query
     * per combination; there are five of them and the alternative is thirty-two
     * methods. {@code owner} is compared lower-cased and trimmed because the
     * extractor writes the name the way the transcript spells it — and the empty
     * string is a real value here, meaning unassigned, which is why "no filter"
     * has to be null rather than blank.
     *
     * <p>{@code status} also takes {@code OPEN_ANY}, meaning anything not
     * finished. That is the default view and it is not expressible as one of the
     * three stored values — OPEN and IN_PROGRESS are both outstanding, and a
     * page that made you choose between them would hide half your work.
     *
     * <p>{@code standalone} keeps only the items nobody's transcript produced —
     * the ones somebody typed. It is not {@code meetingId} with a special value:
     * that filter names one meeting, and there is no id meaning "none". The two
     * are independent and a caller asking for both gets the empty page it
     * deserves.
     *
     * <p>{@code due} buckets against {@code today} rather than against
     * {@code now()}: a deadline is a day, not an instant, and comparing a date
     * to a timestamp would make everything due today look overdue after
     * midnight UTC in half the world.
     */
    @Query("SELECT a FROM MeetingActionItem a WHERE " + OWNED_BY + """
              AND (:status IS NULL
                   OR (:status = 'OPEN_ANY' AND a.status <> 'DONE')
                   OR a.status = :status)
              AND (:meetingId IS NULL OR a.meetingId = :meetingId)
              AND (:standalone = FALSE OR a.meetingId IS NULL)
              AND (:owner IS NULL OR LOWER(TRIM(COALESCE(a.ownerName, ''))) = :owner)
              AND (:due IS NULL
                   OR (:due = 'overdue' AND a.status <> 'DONE' AND a.dueOn IS NOT NULL AND a.dueOn < :today)
                   OR (:due = 'soon'    AND a.status <> 'DONE' AND a.dueOn IS NOT NULL
                                        AND a.dueOn >= :today AND a.dueOn <= :soonEnd)
                   OR (:due = 'dated'   AND a.dueOn IS NOT NULL)
                   OR (:due = 'none'    AND a.dueOn IS NULL))
            """ + DEADLINE_ORDER)
    Page<MeetingActionItem> findForUser(@Param("userId") String userId,
                                        @Param("status") String status,
                                        @Param("meetingId") String meetingId,
                                        @Param("standalone") boolean standalone,
                                        @Param("owner") String owner,
                                        @Param("due") String due,
                                        @Param("today") LocalDate today,
                                        @Param("soonEnd") LocalDate soonEnd,
                                        Pageable pageable);

    /**
     * The numbers on the filter tabs, in one read.
     *
     * <p>Five counts, and five {@code count} queries would be five sequential
     * scans of the same rows on every page load. {@code COALESCE} because
     * {@code SUM} over no rows is null, and a brand-new workspace is exactly the
     * case where a null would surface as a crash on an empty page.
     */
    @Query("""
            SELECT COALESCE(SUM(CASE WHEN a.status <> 'DONE' THEN 1 ELSE 0 END), 0),
                   COALESCE(SUM(CASE WHEN a.status <> 'DONE' AND a.dueOn IS NOT NULL
                                      AND a.dueOn < :today THEN 1 ELSE 0 END), 0),
                   COALESCE(SUM(CASE WHEN a.status <> 'DONE' AND a.dueOn IS NOT NULL
                                      AND a.dueOn >= :today AND a.dueOn <= :soonEnd THEN 1 ELSE 0 END), 0),
                   COALESCE(SUM(CASE WHEN a.status <> 'DONE' AND :me IS NOT NULL
                                      AND LOWER(TRIM(a.ownerName)) = :me THEN 1 ELSE 0 END), 0),
                   COALESCE(SUM(CASE WHEN a.status = 'DONE' THEN 1 ELSE 0 END), 0)
              FROM MeetingActionItem a
             WHERE
            """ + OWNED_BY)
    List<Object[]> counts(@Param("userId") String userId,
                          @Param("me") String me,
                          @Param("today") LocalDate today,
                          @Param("soonEnd") LocalDate soonEnd);

    /**
     * Every name tasks are assigned to, most-owned first.
     *
     * <p>Grouped case-insensitively so "Priya" and "priya" are one person in the
     * filter rather than two entries that return the same rows; {@code MAX}
     * picks one spelling to show, which is arbitrary but stable.
     */
    @Query("""
            SELECT MAX(TRIM(a.ownerName)), COUNT(a)
              FROM MeetingActionItem a
             WHERE
            """ + OWNED_BY + """
               AND a.ownerName IS NOT NULL AND TRIM(a.ownerName) <> ''
             GROUP BY LOWER(TRIM(a.ownerName))
             ORDER BY COUNT(a) DESC, MAX(TRIM(a.ownerName))
            """)
    List<Object[]> owners(@Param("userId") String userId);

    /**
     * Who has work coming due, and how much of it is already late.
     *
     * <p>Rows are {@code [userId, overdue, dueSoon]}. Grouped in the database
     * rather than by asking {@link #findDueThrough} once per user, because the
     * daily notification pass is for everybody with outstanding work — not just
     * the people who opted into the email — and the set of "everybody" is a
     * table scan the moment it is done in Java.
     *
     * <p>Grouped on the item's own {@code userId} since V36. Joining through
     * {@code Meeting} would silently drop every task somebody typed by hand,
     * which is the half of the list most likely to have a deadline on it.
     */
    @Query("""
            SELECT a.userId,
                   SUM(CASE WHEN a.dueOn < :today THEN 1 ELSE 0 END),
                   SUM(CASE WHEN a.dueOn >= :today THEN 1 ELSE 0 END)
            FROM MeetingActionItem a
            WHERE a.status <> 'DONE'
              AND a.dueOn IS NOT NULL
              AND a.dueOn <= :through
            GROUP BY a.userId
            """)
    List<Object[]> dueByUser(@Param("today") LocalDate today, @Param("through") LocalDate through);

    /** Everything outstanding and dated on or before a day — the reminder digest. */
    @Query("SELECT a FROM MeetingActionItem a WHERE " + OWNED_BY + """
              AND a.status <> 'DONE'
              AND a.dueOn IS NOT NULL
              AND a.dueOn <= :through
            """ + DEADLINE_ORDER)
    List<MeetingActionItem> findDueThrough(@Param("userId") String userId,
                                           @Param("through") LocalDate through);
}
