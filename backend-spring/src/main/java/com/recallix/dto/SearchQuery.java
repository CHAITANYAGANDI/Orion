package com.recallix.dto;

import com.recallix.common.ApiException;

import java.time.Instant;
import java.time.format.DateTimeParseException;
import java.util.Set;

/**
 * Everything one search asks for: the text, which groups to answer, how much of
 * each, and the filters that narrow all of them.
 *
 * <p><b>Why filters are strings and never null.</b> Every one of them is
 * optional, and the queries are native SQL where a null parameter has no type
 * Postgres can infer — {@code :status IS NULL OR status = :status} fails to
 * plan before it fails to match. Empty string is the absent value throughout,
 * unwrapped in SQL by {@code NULLIF(:param, '')}, so a filter is either a value
 * or provably nothing and there is no third state to get wrong.
 *
 * <p>{@code from} and {@code to} stay as ISO-8601 text, cast in the query rather
 * than parsed into instants — but they are <em>checked</em> here. Left
 * unchecked, a hand-edited {@code ?from=last-tuesday} reaches Postgres, fails
 * the cast and comes back a 500: a server error for what is plainly a bad
 * request. A date filter that silently ignored the value would be worse still,
 * since the results would look like an answer.
 */
public record SearchQuery(
        String text,
        Set<String> groups,
        int limit,
        int offset,
        String from,
        String to,
        String status,
        String type,
        String tag,
        /** A project id, or the literal {@code none} for meetings filed nowhere. */
        String project,
        String speaker,
        String owner,
        boolean withDecisions
) {

    /** Group keys, and the order they are answered in. */
    public static final Set<String> ALL_GROUPS =
            Set.of("meetings", "people", "decisions", "risks", "commitments", "mentions");

    /** A page of five reads as a preview; more and the groups stop being scannable. */
    public static final int DEFAULT_LIMIT = 5;

    /** One group opened on its own. Beyond this, paging is cheaper than scrolling. */
    public static final int MAX_LIMIT = 100;

    public SearchQuery {
        text = text == null ? "" : text.trim();
        groups = groups == null || groups.isEmpty() ? ALL_GROUPS : groups;
        limit = Math.clamp(limit, 1, MAX_LIMIT);
        offset = Math.max(offset, 0);
        from = instantOrBlank(blankIfNull(from), "from");
        to = instantOrBlank(blankIfNull(to), "to");
        status = blankIfNull(status);
        type = blankIfNull(type);
        tag = blankIfNull(tag);
        project = blankIfNull(project);
        speaker = blankIfNull(speaker);
        owner = blankIfNull(owner);
    }

    public boolean wants(String group) {
        return groups.contains(group);
    }

    /**
     * Whether this search asks for anything at all.
     *
     * <p>A filter with no text is a legitimate search — "everything from last
     * week where Priya spoke" is a question — so the emptiness test is text
     * <em>and</em> filters, not text alone.
     */
    public boolean isEmpty() {
        return text.isEmpty() && !hasFilters();
    }

    public boolean hasFilters() {
        return !from.isEmpty() || !to.isEmpty() || !status.isEmpty() || !type.isEmpty()
                || !tag.isEmpty() || !project.isEmpty() || !speaker.isEmpty()
                || !owner.isEmpty() || withDecisions;
    }

    private static String blankIfNull(String s) {
        return s == null ? "" : s.trim();
    }

    /**
     * Kept as text, but only text Postgres will accept as a timestamp.
     *
     * <p>Parsed and discarded rather than parsed and used: the value travels on
     * as the caller's own ISO string, so what the query casts is exactly what
     * was sent, with no chance of a round trip through {@link Instant}
     * shifting it.
     */
    private static String instantOrBlank(String value, String field) {
        if (value.isEmpty()) {
            return value;
        }
        try {
            Instant.parse(value);
            return value;
        } catch (DateTimeParseException e) {
            throw ApiException.badRequest(
                    "`" + field + "` must be an ISO-8601 instant, e.g. 2026-08-01T00:00:00Z");
        }
    }
}
