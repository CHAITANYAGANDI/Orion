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
 * <p><b>Why a recording can overrun and an import cannot.</b> An import is
 * refused if its stated length will not fit in what is left — the file is still
 * on the user's disk and nothing is lost by saying no. A recording only needs
 * some balance to exist: it has already happened, and refusing it at save time
 * would delete a meeting somebody sat through in order to defend a number. The
 * overrun that allows is bounded by one recording, and it is recorded rather
 * than hidden.
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

        if (!recordedHere && u.getImportsUsed() >= IMPORT_ALLOWANCE) {
            throw ApiException.usageLimitReached(
                    "You have used all " + IMPORT_ALLOWANCE + " imports on this account. "
                            + "Recording in the browser still works.");
        }

        int left = Math.max(0, MINUTES_ALLOWANCE - u.getAiMinutesUsed());
        if (left == 0) {
            throw ApiException.usageLimitReached(
                    "You have used all " + MINUTES_ALLOWANCE
                            + " transcription minutes on this account.");
        }
        // Only an import is measured against the balance, and the asymmetry is
        // deliberate. A file that does not fit is refused while it is still on
        // the user's disk, and nothing is lost by saying no. A recording is
        // already made -- somebody sat through the meeting -- and refusing it
        // at save time deletes an hour of their afternoon to defend a number.
        // So a recording only needs *some* balance, and the overrun it causes
        // is bounded by one meeting and recorded honestly by addAiMinutes.
        if (!recordedHere && durationSeconds != null && durationSeconds > 0) {
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
