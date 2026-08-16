package com.recallix.domain;

import java.time.LocalDate;

/**
 * How a task stands against its deadline.
 *
 * <p>Computed here rather than in the browser so that there is one definition.
 * The list, the badge, the filter tabs and the reminder email all need to agree
 * on what "overdue" means; three of those run in Java and one runs a day later
 * on a scheduler, and a duplicate rule in TypeScript would eventually mail
 * somebody about a task their screen was calling due soon.
 *
 * <p>A completed task is {@link #NONE}: it has no standing against its deadline
 * any more, and a red badge on something already ticked off is noise that
 * teaches people to ignore red badges.
 */
public enum DueStatus {

    /** No date we could resolve — the item may still show the words that were said. */
    NONE,
    OVERDUE,
    TODAY,
    /** Within {@link #SOON_DAYS} of today, but not yet due. */
    SOON,
    LATER;

    /**
     * The near horizon. Three days rather than seven: a week ahead is most of an
     * open tracker, and a "due soon" filter that returns most of the tracker has
     * not narrowed anything.
     */
    public static final int SOON_DAYS = 3;

    public static DueStatus of(LocalDate dueOn, LocalDate today, boolean done) {
        if (done || dueOn == null) {
            return NONE;
        }
        if (dueOn.isBefore(today)) {
            return OVERDUE;
        }
        if (dueOn.isEqual(today)) {
            return TODAY;
        }
        return dueOn.isAfter(today.plusDays(SOON_DAYS)) ? LATER : SOON;
    }
}
