package com.orion.dto;

import java.util.List;

/**
 * Everything the action-items page needs that is not a page of rows.
 *
 * <p>One request rather than four. The counts are on the filter tabs, so they
 * are needed before anything can be rendered, and fetching them alongside the
 * first page would make the tabs pop in after the list they label.
 *
 * <p>{@code me} is the name this user is known by in their own transcripts,
 * which is the only thing that can turn a list of owners into "mine". It is null
 * until they say, and {@code owners} is what the page offers them to pick from —
 * the names actually assigned work in this workspace, so the answer is one click
 * rather than a text box you can spell wrong.
 */
public record ActionItemOverview(
        Counts counts,
        List<OwnerCount> owners,
        String me
) {
    /** All counts exclude finished work except {@code done}. */
    public record Counts(long open, long overdue, long dueSoon, long mine, long done) {
    }

    public record OwnerCount(String name, long count) {
    }
}
