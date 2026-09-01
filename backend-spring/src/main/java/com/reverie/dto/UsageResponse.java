package com.reverie.dto;

/**
 * What this account has used, and what it is allowed.
 *
 * <p>No period on it any more. The allowance is a lifetime one, so the
 * {@code periodStart}/{@code periodEnd} pair this used to carry described a
 * month that no longer means anything — and a client showing "resets on the
 * 1st" would be making a promise nothing keeps.
 *
 * <p>{@code meetingsUsed} has no ceiling beside it on purpose: it is a figure,
 * not a limit. What is capped is minutes and imports.
 */
public record UsageResponse(
        String plan,
        int minutesUsed,
        int minutesLimit,
        int importsUsed,
        int importsLimit,
        int meetingsUsed
) {
}
