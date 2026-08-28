package com.orion.repository;

import com.orion.dto.SearchFacets;
import com.orion.dto.SearchQuery;
import com.orion.dto.SearchResponse.CommitmentHit;
import com.orion.dto.SearchResponse.InsightHit;
import com.orion.dto.SearchResponse.MentionHit;
import com.orion.dto.SearchResponse.PersonHit;
import com.orion.dto.SearchResponse.SearchGroup;
import jakarta.persistence.EntityManager;
import jakarta.persistence.Query;
import org.springframework.stereotype.Repository;

import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Function;

/**
 * The five queries behind a workspace search, written by hand.
 *
 * <p><b>Why this is not five Spring Data interfaces.</b> Every group answers the
 * same question about a different table, and every one of them has to honour the
 * same eight filters. Split across five repositories that shared predicate would
 * be copied five times and would drift the first time one of them gained a
 * condition — which is exactly the bug a user reports as "the date filter works
 * on meetings but not on decisions". Here {@link #MEETING_FILTER} is one string,
 * interpolated into each query, and a filter cannot apply to four groups out of
 * five.
 *
 * <p><b>Why every filter parameter is a string, never null.</b> These are native
 * queries, so an untyped null parameter is a planning error rather than a match
 * of nothing. Absence is the empty string and is unwrapped in SQL with
 * {@code NULLIF(:param, '')}, which has a type Postgres can infer and a meaning
 * a reader can see. The date bounds go further and coalesce to
 * {@code ±infinity}, because a bare {@code OR} around a cast is not safe: the
 * planner may evaluate {@code CAST('' AS timestamptz)} even when the other side
 * of the {@code OR} is true, and that is an error, not a false.
 *
 * <p><b>Why the totals come from a window function.</b> Each group shows a count
 * and a handful of rows. Counting with a second query would double the round
 * trips and, worse, count a different result set than the one being displayed if
 * anything changed in between. {@code COUNT(*) OVER ()} is evaluated over the
 * full result before {@code LIMIT}, so the number and the rows come out of one
 * pass over one snapshot.
 */
@Repository
public class SearchRepository {

    /**
     * The filters, in terms of a meeting aliased {@code m}.
     *
     * <p>Three of them are existence tests against other tables rather than
     * columns on the meeting, which is what makes them worth stating once:
     * "meetings where Priya spoke" is a fact about the transcript, "meetings
     * with a commitment owned by Marcus" a fact about the tracker, and "meetings
     * that settled something" a fact about the insights. A reader filtering by
     * speaker does not care which table holds the evidence.
     */
    private static final String MEETING_FILTER = """
              AND m.created_at >= COALESCE(CAST(NULLIF(:fromTs, '') AS timestamptz),
                                           CAST('-infinity' AS timestamptz))
              AND m.created_at <  COALESCE(CAST(NULLIF(:toTs, '') AS timestamptz),
                                           CAST('infinity' AS timestamptz))
              AND (NULLIF(:status, '') IS NULL OR m.status = :status)
              AND (NULLIF(:type, '') IS NULL OR m.summary_template = :type)
              AND (NULLIF(:tag, '') IS NULL OR m.tags @> jsonb_build_array(CAST(:tag AS text)))
              -- 'none' is a value, not an absence: "what have I not filed yet"
              -- is a real question, and one nobody can ask by picking a project.
              AND (NULLIF(:project, '') IS NULL
                   OR (:project = 'none' AND m.project_id IS NULL)
                   OR m.project_id = :project)
              AND (NULLIF(:speaker, '') IS NULL OR EXISTS (
                      SELECT 1 FROM transcript_segments fs
                       WHERE fs.meeting_id = m.id AND fs.speaker = :speaker))
              AND (NULLIF(:owner, '') IS NULL OR EXISTS (
                      SELECT 1 FROM meeting_action_items fa
                       WHERE fa.meeting_id = m.id AND fa.owner_name = :owner))
              AND (:withDecisions <> 'true' OR EXISTS (
                      SELECT 1 FROM meeting_insights fi
                       WHERE fi.meeting_id = m.id AND fi.kind = 'DECISION'))
            """;

    /**
     * A meeting that matched, before its metadata is attached.
     *
     * <p>The row deliberately stops at the id: tags are jsonb and reading them
     * out of a native result means hand-parsing JSON, when the entity mapping
     * already does it correctly. The service fetches the meetings by id, the
     * same enrichment {@code SemanticSearchService} does for the same reason.
     */
    public record MeetingMatch(String id, long mentions, boolean titleMatch) {
    }

    private final EntityManager em;

    public SearchRepository(EntityManager em) {
        this.em = em;
    }

    /**
     * Meetings matching by name, by tag, or by something said in them.
     *
     * <p>The third is the one that matters. Matching titles alone would report
     * "0 meetings" for a term said in thirty of them, which reads as an empty
     * archive rather than as a search that only looked at the labels. So the
     * lateral counts matching utterances per meeting, and that count is both a
     * reason to include the meeting and something worth showing on the row.
     */
    public SearchGroup<MeetingMatch> meetings(String userId, SearchQuery s, String tsq, String like) {
        String sql = """
                SELECT m.id,
                       COALESCE(c.n, 0)                       AS mentions,
                       (NULLIF(:like, '') IS NOT NULL
                            AND m.title ILIKE :like ESCAPE '\\') AS title_match,
                       COUNT(*) OVER ()                       AS total
                  FROM meetings m
                  LEFT JOIN LATERAL (
                       SELECT COUNT(*) AS n
                         FROM transcript_segments s
                        WHERE s.meeting_id = m.id
                          AND s.search_tsv @@ to_tsquery('simple', NULLIF(:tsq, ''))
                  ) c ON TRUE
                 WHERE m.user_id = :userId
                """ + MEETING_FILTER + """
                   AND (NULLIF(:like, '') IS NULL
                        OR m.title ILIKE :like ESCAPE '\\'
                        OR c.n > 0
                        OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(m.tags) t
                                    WHERE t ILIKE :like ESCAPE '\\'))
                 ORDER BY title_match DESC, m.created_at DESC
                 LIMIT :limit OFFSET :offset
                """;

        Query q = em.createNativeQuery(sql);
        bind(q, userId, s, tsq, like);
        return collect(q, row -> new MeetingMatch(
                str(row[0]), num(row[1]), bool(row[2])), 3);
    }

    /**
     * People, from three places and counted three ways.
     *
     * <p><b>Where the names come from.</b> Diarized speakers are the obvious
     * source and, alone, the wrong one: it lists everyone who talked and nobody
     * who was talked about. Search "Priya" in a workspace where Priya owes three
     * commitments and is named in nine sentences, and a speakers-only query
     * answers "no such person". So the names are the union of who spoke and who
     * owns a commitment; only one of the two has to have attended anything.
     *
     * <p>There was a third source, {@code known_speakers}, which held the names
     * this user had applied to speakers before. That table is gone, and with it
     * the only names that came from neither a transcript nor a commitment.
     *
     * <p><b>Why three counts.</b> They answer different questions and one merged
     * number would blur them: how much someone spoke, how often anyone said
     * their name, and how much they owe. The row is kept only if at least one is
     * non-zero — a name with nothing behind it inside the current filters is not
     * a result, it is a name.
     *
     * <p>{@code strpos} rather than {@code ILIKE} for the mention count: the
     * pattern here is a name out of the database, not a term from the user, and
     * a name containing {@code %} would otherwise match every line in the
     * archive.
     *
     * <p><b>The known ceiling.</b> The mention count is a scan of the user's
     * utterances per matched name, and it runs before the {@code LIMIT} because
     * it is one of the things being sorted on. At workspace scale — a few dozen
     * names against tens of thousands of rows — that is fine. It would stop
     * being fine at a hundred times the size, and the fix then is a name/mention
     * rollup maintained on write rather than a cleverer query here; nothing in
     * this shape is worth pre-paying for now.
     */
    public SearchGroup<PersonHit> people(String userId, SearchQuery s, String like) {
        String sql = """
                WITH names AS (
                    SELECT DISTINCT btrim(name) AS name FROM (
                        SELECT s.speaker AS name
                          FROM transcript_segments s
                          JOIN meetings m ON m.id = s.meeting_id
                         WHERE m.user_id = :userId
                """ + MEETING_FILTER + """
                        UNION
                        SELECT a.owner_name
                          FROM meeting_action_items a
                          JOIN meetings m ON m.id = a.meeting_id
                         WHERE m.user_id = :userId
                """ + MEETING_FILTER + """
                    ) n
                    WHERE name IS NOT NULL
                      AND btrim(name) <> ''
                      AND (NULLIF(:like, '') IS NULL OR name ILIKE :like ESCAPE '\\')
                )
                SELECT p.name, p.meetings, p.segments, p.mentions, p.commitments,
                       -- Counted out here, not inside: window functions run
                       -- after WHERE at their own level, so a total computed
                       -- alongside the rows would include the names the filter
                       -- below is about to drop.
                       COUNT(*) OVER () AS total
                  FROM (
                    SELECT n.name,
                           COALESCE(spoke.meetings, 0) AS meetings,
                           COALESCE(spoke.segments, 0) AS segments,
                           (SELECT COUNT(*)
                              FROM transcript_segments t
                              JOIN meetings m ON m.id = t.meeting_id
                             WHERE m.user_id = :userId
                               AND strpos(lower(t.text), lower(n.name)) > 0
                """ + MEETING_FILTER + """
                           ) AS mentions,
                           (SELECT COUNT(*)
                              FROM meeting_action_items a
                              JOIN meetings m ON m.id = a.meeting_id
                             WHERE m.user_id = :userId
                               AND a.owner_name = n.name
                """ + MEETING_FILTER + """
                           ) AS commitments
                      FROM names n
                      LEFT JOIN LATERAL (
                           SELECT COUNT(DISTINCT s.meeting_id) AS meetings,
                                  COUNT(*)                     AS segments
                             FROM transcript_segments s
                             JOIN meetings m ON m.id = s.meeting_id
                            WHERE m.user_id = :userId
                              AND s.speaker = n.name
                """ + MEETING_FILTER + """
                      ) spoke ON TRUE
                ) p
                 WHERE p.segments > 0 OR p.mentions > 0 OR p.commitments > 0
                 ORDER BY (p.segments + p.mentions + p.commitments) DESC, p.name ASC
                 LIMIT :limit OFFSET :offset
                """;

        Query q = em.createNativeQuery(sql);
        bind(q, userId, s, "", like);
        return collect(q, row -> new PersonHit(
                str(row[0]), num(row[1]), num(row[2]), num(row[3]), num(row[4])), 5);
    }

    /** Decisions or risks — one table since V24, told apart by {@code kind}. */
    public SearchGroup<InsightHit> insights(String userId, SearchQuery s, String like, String kind) {
        String sql = """
                SELECT i.id, i.meeting_id, m.title, m.created_at, i.kind, i.text,
                       COUNT(*) OVER () AS total
                  FROM meeting_insights i
                  JOIN meetings m ON m.id = i.meeting_id
                 WHERE i.user_id = :userId
                   AND i.kind = :kind
                   AND (NULLIF(:like, '') IS NULL OR i.text ILIKE :like ESCAPE '\\')
                """ + MEETING_FILTER + """
                 ORDER BY m.created_at DESC, i.created_at ASC
                 LIMIT :limit OFFSET :offset
                """;

        Query q = em.createNativeQuery(sql);
        bind(q, userId, s, "", like);
        q.setParameter("kind", kind);
        return collect(q, row -> new InsightHit(
                str(row[0]), str(row[1]), str(row[2]), instant(row[3]),
                str(row[4]), str(row[5])), 6);
    }

    /**
     * Commitments — which are action items, see {@code CommitmentHit}.
     *
     * <p>Matched on the owner and the sentence they came from as well as the
     * task itself, because "what did I promise Marcus" and "who took the Stripe
     * migration" are the same search to the person typing it.
     *
     * <p>Open work sorts first. A search that buries this week's outstanding
     * commitment under six finished ones has answered the wrong question.
     */
    public SearchGroup<CommitmentHit> commitments(String userId, SearchQuery s, String like) {
        String sql = """
                SELECT a.id, a.meeting_id, m.title, m.created_at,
                       a.title, a.owner_name, a.status, a.due_date,
                       COUNT(*) OVER () AS total
                  FROM meeting_action_items a
                  JOIN meetings m ON m.id = a.meeting_id
                 WHERE m.user_id = :userId
                   AND (NULLIF(:like, '') IS NULL
                        OR a.title ILIKE :like ESCAPE '\\'
                        OR a.owner_name ILIKE :like ESCAPE '\\'
                        OR a.source_sentence ILIKE :like ESCAPE '\\')
                   AND (NULLIF(:owner, '') IS NULL OR a.owner_name = :owner)
                """ + MEETING_FILTER + """
                 ORDER BY (a.status = 'DONE'), m.created_at DESC
                 LIMIT :limit OFFSET :offset
                """;

        Query q = em.createNativeQuery(sql);
        bind(q, userId, s, "", like);
        return collect(q, row -> new CommitmentHit(
                str(row[0]), str(row[1]), str(row[2]), instant(row[3]),
                str(row[4]), str(row[5]), str(row[6]), str(row[7])), 8);
    }

    /**
     * Individual utterances containing the term.
     *
     * <p>The only group served by the full-text index, and the only one that
     * needs it — see V29. Ordered by recency rather than by {@code ts_rank}:
     * relevance ranking over one-sentence documents mostly measures how short
     * they are, whereas "the most recent time this came up" is what someone
     * scanning twenty-seven mentions is actually after.
     *
     * <p>When a speaker filter is set it narrows to <em>their</em> utterances,
     * not merely to meetings they attended. Anything else would answer "what did
     * Priya say about Stripe" with everything everyone said in the meetings she
     * was in.
     */
    public SearchGroup<MentionHit> mentions(String userId, SearchQuery s, String tsq) {
        String sql = """
                SELECT s.id, s.meeting_id, m.title, m.created_at,
                       s.speaker, s.start_time, s.text,
                       COUNT(*) OVER () AS total
                  FROM transcript_segments s
                  JOIN meetings m ON m.id = s.meeting_id
                 WHERE m.user_id = :userId
                   AND s.search_tsv @@ to_tsquery('simple', NULLIF(:tsq, ''))
                   AND (NULLIF(:speaker, '') IS NULL OR s.speaker = :speaker)
                """ + MEETING_FILTER + """
                 ORDER BY m.created_at DESC, s.start_time ASC
                 LIMIT :limit OFFSET :offset
                """;

        Query q = em.createNativeQuery(sql);
        bind(q, userId, s, tsq, "");
        return collect(q, row -> new MentionHit(
                str(row[0]), str(row[1]), str(row[2]), instant(row[3]),
                str(row[4]), dbl(row[5]), str(row[6])), 7);
    }

    /**
     * What the filter dropdowns are allowed to offer.
     *
     * <p>Five small reads rather than one union: each column comes from a
     * different table and they are wanted as five separate lists, so a union
     * would have to tag every row with which list it belonged to and be unpicked
     * again on arrival. This is fetched once per page load, not per keystroke.
     */
    public SearchFacets facets(String userId) {
        return new SearchFacets(
                strings("""
                        SELECT DISTINCT s.speaker
                          FROM transcript_segments s
                          JOIN meetings m ON m.id = s.meeting_id
                         WHERE m.user_id = :userId
                           AND s.speaker IS NOT NULL AND btrim(s.speaker) <> ''
                         ORDER BY 1
                         LIMIT 200
                        """, userId),
                strings("""
                        SELECT DISTINCT t
                          FROM meetings m, jsonb_array_elements_text(m.tags) t
                         WHERE m.user_id = :userId AND btrim(t) <> ''
                         ORDER BY 1
                         LIMIT 200
                        """, userId),
                strings("""
                        SELECT DISTINCT a.owner_name
                          FROM meeting_action_items a
                          JOIN meetings m ON m.id = a.meeting_id
                         WHERE m.user_id = :userId
                           AND a.owner_name IS NOT NULL AND btrim(a.owner_name) <> ''
                         ORDER BY 1
                         LIMIT 200
                        """, userId),
                strings("""
                        SELECT DISTINCT m.summary_template
                          FROM meetings m
                         WHERE m.user_id = :userId AND m.summary_template IS NOT NULL
                         ORDER BY 1
                        """, userId),
                strings("""
                        SELECT DISTINCT m.status
                          FROM meetings m
                         WHERE m.user_id = :userId
                         ORDER BY 1
                        """, userId));
    }

    // --- plumbing ---------------------------------------------------------- //

    private void bind(Query q, String userId, SearchQuery s, String tsq, String like) {
        q.setParameter("userId", userId);
        q.setParameter("limit", s.limit());
        q.setParameter("offset", s.offset());
        q.setParameter("fromTs", s.from());
        q.setParameter("toTs", s.to());
        q.setParameter("status", s.status());
        q.setParameter("type", s.type());
        q.setParameter("tag", s.tag());
        q.setParameter("project", s.project());
        q.setParameter("speaker", s.speaker());
        q.setParameter("owner", s.owner());
        q.setParameter("withDecisions", s.withDecisions() ? "true" : "");
        trySetParameter(q, "tsq", tsq);
        trySetParameter(q, "like", like);
    }

    /**
     * Not every query mentions every optional parameter.
     *
     * <p>{@code mentions} has no {@code :like} and {@code people} has no
     * {@code :tsq}; binding a parameter a query does not declare is an
     * {@link IllegalArgumentException} rather than a no-op. Asking first keeps
     * the binder single and the queries free to use only what they need.
     */
    private static void trySetParameter(Query q, String name, String value) {
        try {
            q.setParameter(name, value);
        } catch (IllegalArgumentException notDeclared) {
            // The query does not use this parameter.
        }
    }

    @SuppressWarnings("unchecked")
    private static <T> SearchGroup<T> collect(Query q, Function<Object[], T> mapper, int totalIndex) {
        List<Object[]> rows = q.getResultList();
        if (rows.isEmpty()) {
            return SearchGroup.empty();
        }
        List<T> hits = new ArrayList<>(rows.size());
        for (Object[] row : rows) {
            hits.add(mapper.apply(row));
        }
        return new SearchGroup<>(num(rows.get(0)[totalIndex]), hits);
    }

    @SuppressWarnings("unchecked")
    private List<String> strings(String sql, String userId) {
        List<Object> rows = em.createNativeQuery(sql).setParameter("userId", userId).getResultList();
        List<String> out = new ArrayList<>(rows.size());
        for (Object row : rows) {
            String value = str(row);
            if (value != null && !value.isBlank()) {
                out.add(value);
            }
        }
        return out;
    }

    // JDBC types vary by driver and by column; these keep the mapping honest
    // rather than assuming what a native result column comes back as.

    private static String str(Object o) {
        return o == null ? null : o.toString();
    }

    private static long num(Object o) {
        return o instanceof Number n ? n.longValue() : 0L;
    }

    private static Double dbl(Object o) {
        return o instanceof Number n ? n.doubleValue() : null;
    }

    private static boolean bool(Object o) {
        return o instanceof Boolean b && b;
    }

    private static Instant instant(Object o) {
        return switch (o) {
            case null -> null;
            case Instant i -> i;
            case java.sql.Timestamp t -> t.toInstant();
            case OffsetDateTime odt -> odt.toInstant();
            default -> null;
        };
    }
}
