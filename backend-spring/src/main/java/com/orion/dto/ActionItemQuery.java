package com.orion.dto;

import com.orion.common.ApiException;

import java.util.Set;

/**
 * The filters the action-items page can ask for.
 *
 * <p>Normalised and validated here rather than in the service, so that a
 * mistyped filter is a 400 with the allowed values in it and never a query that
 * quietly returns everything. A filter that silently does nothing is worse than
 * one that fails: the list looks like an answer.
 *
 * <p>Every field is null when absent, which the repository reads as unfiltered.
 * {@code owner} is the exception worth knowing about — {@code "unassigned"}
 * means the empty owner rather than a person, because "nobody owns this" is the
 * single most useful thing to filter a tracker by and it has no name to type.
 */
public record ActionItemQuery(
        String status,
        String owner,
        String due,
        String meetingId,
        /**
         * Keep only what nobody's transcript produced.
         *
         * <p>The home panel's whole list. Commitments lifted from a meeting are
         * read on that meeting, where the sentence they came from is a click
         * away; what is left here is the things somebody typed for themselves,
         * which belong to no meeting and have nowhere else to live.
         */
        boolean standalone,
        /** Restrict to items owned by the caller — resolved against their display name. */
        boolean mine,
        int page,
        int size
) {
    private static final Set<String> STATUSES = Set.of("OPEN", "IN_PROGRESS", "DONE", "OPEN_ANY");
    private static final Set<String> DUE = Set.of("overdue", "soon", "dated", "none");

    /** The empty owner, spelled so it survives a query string. */
    public static final String UNASSIGNED = "unassigned";

    private static final int MAX_SIZE = 200;

    public ActionItemQuery {
        status = oneOf(blankToNull(upper(status)), STATUSES, "status");
        due = oneOf(blankToNull(lower(due)), DUE, "due");
        meetingId = blankToNull(meetingId);

        String o = blankToNull(lower(owner));
        // "" is what the repository wants for unassigned, and is also what an
        // omitted query parameter can arrive as. Only the explicit word means it.
        owner = UNASSIGNED.equals(o) ? "" : o;

        page = Math.max(0, page);
        size = size <= 0 ? 50 : Math.min(size, MAX_SIZE);
    }

    /** The default view: everything still outstanding, nearest deadline first. */
    public static ActionItemQuery open() {
        return new ActionItemQuery("OPEN_ANY", null, null, null, false, false, 0, 50);
    }

    private static String oneOf(String value, Set<String> allowed, String field) {
        if (value != null && !allowed.contains(value)) {
            throw ApiException.badRequest(field + " must be one of " + allowed);
        }
        return value;
    }

    private static String blankToNull(String s) {
        return (s == null || s.isBlank()) ? null : s.trim();
    }

    private static String upper(String s) {
        return s == null ? null : s.trim().toUpperCase();
    }

    private static String lower(String s) {
        return s == null ? null : s.trim().toLowerCase();
    }
}
