package com.orion.service;

import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;

/**
 * How long each message is still worth delivering.
 *
 * <h2>Why a queue that never gives up is not the goal</h2>
 *
 * <p>The outbox exists so a provider outage delays a message instead of losing
 * it. Taken to its conclusion that means a digest for the 5th of March arriving
 * on the 20th, which is not a late message — it is a wrong one. Two bounds,
 * doing different jobs:
 *
 * <ul>
 *   <li>the retry ceiling bounds how long <em>delivery is attempted</em>, and is
 *       sized to the provider's idempotency window;</li>
 *   <li>this bounds how long <em>delivery is worth attempting</em>, and is sized
 *       to the message.</li>
 * </ul>
 *
 * <h2>The rule for each kind, and why they differ</h2>
 *
 * <p>The line is whether the message is a <b>prompt</b> or a <b>record</b>.
 *
 * <p><b>Prompts expire, and expire hard.</b> A retention warning stops being a
 * warning the moment the deletion happens — after that the honest message is the
 * confirmation, which is a different email that has already been queued by the
 * pass. A deadline digest is for one morning. A "your notes are ready" is for
 * roughly as long as somebody would still connect it to the meeting.
 *
 * <p><b>Records do not.</b> That an account was destroyed, that an allowance
 * ended, that retention deleted something — these are as true in September as
 * they were in June, and for the closure notice lateness is not even the main
 * risk: it is the only evidence the account holder has that it happened, and the
 * only way they would find out if it was not them. Ninety days of retryability
 * for those is a deliberate asymmetry, not an oversight.
 *
 * <p>The one dynamic rule is stated where it belongs rather than here: a pending
 * "85% spent" is superseded when "fully spent" is queued, because by then the
 * first is not merely stale, it is wrong. See
 * {@link com.orion.repository.MailOutboxRepository#supersede}.
 */
final class MailLifetime {

    private MailLifetime() {
    }

    /** Records. As true late as on the day; see the class note. */
    static final Duration RECORD = Duration.ofDays(90);

    /** Long enough to still be about the meeting somebody remembers having. */
    static final Duration NOTES_READY = Duration.ofDays(7);

    /**
     * When a warning about a deletion on {@code deletesOn} stops being one.
     *
     * <p>Midnight UTC on the day itself. The retention pass runs at 03:00 UTC,
     * so a warning still queued at midnight has hours at best and is about to be
     * contradicted by the confirmation. Warning somebody about something that
     * has already happened is worse than saying nothing: it reads as a chance to
     * act that has already gone.
     */
    static Instant retentionWarning(LocalDate deletesOn) {
        return deletesOn.atStartOfDay(ZoneOffset.UTC).toInstant();
    }

    /**
     * When a digest for {@code day} stops being today's.
     *
     * <p>The end of the day it is about. "Two tasks are due tomorrow" delivered
     * the day after tomorrow is not a reminder, and the tasks are still in the
     * app where the reader can see them.
     */
    static Instant taskReminder(LocalDate day) {
        return day.plusDays(1).atStartOfDay(ZoneOffset.UTC).toInstant();
    }

    /** A week after the notes were written. */
    static Instant notesReady(Instant now) {
        return now.plus(NOTES_READY);
    }

    /** Ninety days. Retention applied, allowance spent, account closed. */
    static Instant record(Instant now) {
        return now.plus(RECORD);
    }
}
