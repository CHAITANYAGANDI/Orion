package com.recallix.service;

import com.recallix.common.ApiException;
import com.recallix.common.IdGenerator;
import com.recallix.domain.Plan;
import com.recallix.dto.UsageResponse;
import com.recallix.entity.UsageLimit;
import com.recallix.repository.UsageLimitRepository;
import com.recallix.repository.UserRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * What an account is allowed, and how much of it is gone.
 *
 * <p>One allowance, for the life of the account: {@value #MINUTES_ALLOWANCE}
 * transcribed minutes and {@value #IMPORT_ALLOWANCE} imported files. Not per
 * month — there is no rollover, no reset date and nothing to wait for.
 *
 * <p><b>Why minutes rather than meetings.</b> The old ceiling was five meetings
 * a calendar month, which charged the same for a two-minute voice note and a
 * ninety-minute workshop. Minutes are what a transcript actually costs to
 * produce, so they are what is counted; the number of recordings is still
 * tallied for the figure in the rail, and nothing refuses one for being the
 * eleventh.
 *
 * <p><b>Why imports are capped separately.</b> A recording is made in the
 * browser, in real time, by somebody sitting there — an hour of it costs an hour
 * of their day. An import is a file, and a folder of files is an afternoon of
 * someone else's archive arriving at once. The minute allowance would stop that
 * eventually; three imports stops it at the point where it is still obvious what
 * the product is for.
 *
 * <p><b>When each is charged.</b> Both at confirmation, in
 * {@link #chargeMeetingOrThrow}, so an upload somebody abandons is free. The
 * minutes themselves are added later by {@link #addAiMinutes}, when processing
 * finishes and the true duration is known.
 *
 * <p><b>Neither can overrun.</b> A meeting is refused if its length will not
 * fit in what is left, whether it was recorded here or imported. For an import
 * that is easy: the file is on the user's disk and nothing is lost by saying no.
 *
 * <p>For a recording it is only safe because the browser does not let one reach
 * this point. `lib/allowance.ts` refuses to start a recording with no balance
 * and stops one that reaches the edge of it, so what arrives here always fits.
 * This check is the authority rather than the mechanism — it is what makes
 * the limit real for a client that did not do that, and the reason the client
 * fails closed when it cannot read the balance. Enforcing it here *alone* would
 * mean the only way to hold the line against a recording is to destroy a
 * meeting somebody sat through, which is why the two halves exist together.
 *
 * <p>{@link RateLimitService} is a different thing and still separate: it is
 * requests per minute, to stop a loop, not an allowance.
 */
@Service
public class UsageLimitService {

    /** Transcribed minutes an account gets, ever. */
    public static final int MINUTES_ALLOWANCE = 100;

    /** Files an account may import, ever. A browser recording is not one. */
    public static final int IMPORT_ALLOWANCE = 3;

    private final UsageLimitRepository usage;
    private final UserRepository users;

    public UsageLimitService(UsageLimitRepository usage, UserRepository users) {
        this.usage = usage;
        this.users = users;
    }

    private Plan planOf(String userId) {
        return users.findById(userId).map(u -> Plan.fromString(u.getPlan())).orElse(Plan.FREE);
    }

    /**
     * The account's counter, created empty the first time it is needed.
     *
     * <p>Lazily rather than at signup, so an account that never records anything
     * never has a row — and so this cannot be forgotten in whichever of the
     * three places accounts come into being.
     */
    @Transactional
    public UsageLimit forUser(String userId) {
        return usage.findByUserId(userId).orElseGet(() -> {
            UsageLimit u = new UsageLimit();
            u.setId(IdGenerator.usage());
            u.setUserId(userId);
            return usage.save(u);
        });
    }

    @Transactional(readOnly = true)
    public UsageResponse getUsage(String userId) {
        Plan plan = planOf(userId);
        // Read rather than created: a GET that writes a row is a GET that fails
        // on a read-only replica and creates rows for anybody who opens the app.
        UsageLimit u = usage.findByUserId(userId).orElse(null);
        return new UsageResponse(
                plan.name(),
                u == null ? 0 : u.getAiMinutesUsed(),
                MINUTES_ALLOWANCE,
                u == null ? 0 : u.getImportsUsed(),
                IMPORT_ALLOWANCE,
                u == null ? 0 : u.getMeetingsUsed());
    }

    /**
     * Charge a meeting against the allowance, or refuse it.
     *
     * @param recordedHere   made in the browser rather than imported
     * @param durationSeconds how long the client says it is, or null if unknown
     */
    @Transactional
    public void chargeMeetingOrThrow(String userId, boolean recordedHere, Integer durationSeconds) {
        UsageLimit u = forUser(userId);

        int left = Math.max(0, MINUTES_ALLOWANCE - u.getAiMinutesUsed());

        if (!recordedHere && u.getImportsUsed() >= IMPORT_ALLOWANCE) {
            // "Recording still works" only when it does. Somebody who is out of
            // imports *and* out of minutes is out, and telling them to go and
            // record instead sends them to a second refusal -- which reads as
            // the product being broken rather than the account being spent.
            throw ApiException.usageLimitReached(
                    "You have used all " + IMPORT_ALLOWANCE + " imports on this account."
                            + (left > 0 ? " Recording in the browser still works." : ""));
        }

        if (left == 0) {
            throw ApiException.usageLimitReached(
                    "You have used all " + MINUTES_ALLOWANCE
                            + " transcription minutes on this account.");
        }
        // Measured against the balance whichever way it arrived. A recording
        // used to be exempt, because refusing one at save time destroys audio
        // somebody sat through -- but that exemption *was* the overrun, and the
        // limit is meant to be final. It is safe now because the recorder stops
        // itself at the balance (lib/allowance.ts), so a recording that reaches
        // here already fits and this only fires for a client that ignored it.
        if (durationSeconds != null && durationSeconds > 0) {
            // Rounded up: a 61-second clip spends two minutes of the allowance,
            // because the alternative is a file that fits by arithmetic and does
            // not fit by the time it has been transcribed.
            int wanted = (int) Math.ceil(durationSeconds / 60.0);
            if (wanted > left) {
                throw ApiException.usageLimitReached(
                        "That is " + wanted + " minutes and you have " + left
                                + " left of your " + MINUTES_ALLOWANCE + ".");
            }
        }

        u.setMeetingsUsed(u.getMeetingsUsed() + 1);
        if (!recordedHere) {
            u.setImportsUsed(u.getImportsUsed() + 1);
        }
    }

    /**
     * Refuse anything that asks a model, once the minutes are gone.
     *
     * <p>Chat does not spend transcription minutes — it spends context and a
     * completion — so on the arithmetic alone it could run forever on an
     * account that can no longer record. It does not, and the reason is what the
     * allowance is for rather than what it counts: 100 minutes is the whole of
     * what an account gets, and an AI feature still answering afterwards would
     * make the limit a limit on recording rather than on the product.
     *
     * <p>Reads are left alone. Somebody out of minutes keeps every conversation
     * they have already had, because those are theirs and hiding them would be
     * taking something away rather than declining to do more work.
     */
    @Transactional(readOnly = true)
    public void requireAiOrThrow(String userId) {
        UsageLimit u = usage.findByUserId(userId).orElse(null);
        int used = u == null ? 0 : u.getAiMinutesUsed();
        if (used >= MINUTES_ALLOWANCE) {
            throw ApiException.usageLimitReached(
                    "You have used all " + MINUTES_ALLOWANCE
                            + " transcription minutes on this account, so AI Chat is closed. "
                            + "Your meetings and the answers you already have are still here.");
        }
    }

    /**
     * Spend minutes, once a meeting has finished and the real length is known.
     *
     * <p>Not clamped to the allowance. A meeting that overruns what was left
     * finishes and is kept — refusing to store a transcript already paid for
     * would be destroying work to defend a number — and the account is simply
     * past its allowance afterwards, which the next request finds.
     */
    @Transactional
    public void addAiMinutes(String userId, int minutes) {
        UsageLimit u = forUser(userId);
        u.setAiMinutesUsed(u.getAiMinutesUsed() + Math.max(0, minutes));
    }
}
