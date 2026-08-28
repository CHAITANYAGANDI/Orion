package com.orion.service;

import com.orion.common.ApiException;
import com.orion.common.IdGenerator;
import com.orion.domain.Plan;
import com.orion.dto.UsageResponse;
import com.orion.entity.UsageLimit;
import com.orion.repository.MeetingUsageChargeRepository;
import com.orion.repository.UsageLimitRepository;
import com.orion.repository.UserRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
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

    private static final Logger log = LoggerFactory.getLogger(UsageLimitService.class);

    private final UsageLimitRepository usage;
    private final UserRepository users;
    private final MeetingUsageChargeRepository charges;

    public UsageLimitService(UsageLimitRepository usage, UserRepository users,
                             MeetingUsageChargeRepository charges) {
        this.usage = usage;
        this.users = users;
        this.charges = charges;
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
     * Everything that asks a model, and what to call it when it is refused.
     *
     * <p>An enum rather than a string per call site so the refusals cannot drift
     * apart: five features saying the same thing five slightly different ways
     * reads as five different problems. Each clause finishes the sentence begun
     * in {@link #requireAiOrThrow}.
     *
     * <p>Every one of them names what is <em>kept</em> as well as what is
     * refused. Running out of an allowance is not the account being closed, and
     * a refusal that does not say so is read as one.
     */
    public enum AiFeature {
        CHAT("AI Chat is closed",
                "Your meetings and the answers you already have are still here."),
        RESUMMARIZE("the summary cannot be rewritten",
                "The summary you have is still here."),
        SPEAKER_REMATCH("speakers cannot be rematched",
                "The speaker names already on this meeting are still here."),
        TRANSLATION("nothing further can be translated",
                "Translations you already have are still here."),
        REPROCESS("meetings cannot be reprocessed",
                "Everything already transcribed is still here.");

        private final String refused;
        private final String kept;

        AiFeature(String refused, String kept) {
            this.refused = refused;
            this.kept = kept;
        }
    }

    /**
     * Refuse anything that asks a model, once the minutes are gone.
     *
     * <p><b>Most of these spend no transcription minutes at all.</b> Chat spends
     * context and a completion; rewriting a summary and rematching speakers
     * re-read a transcript already paid for. On the arithmetic alone they could
     * run forever on an account that can no longer record. They do not, and the
     * reason is what the allowance is for rather than what it counts: 100
     * minutes is the whole of what an account gets, and AI features still
     * running afterwards would make it a limit on recording rather than on the
     * product.
     *
     * <p>Reprocessing is the exception that proves it — that one really does
     * re-transcribe the audio and really is charged again when it lands.
     *
     * <p><b>Reads are left alone.</b> Somebody out of minutes keeps every
     * conversation they have had, every summary, every translation and every
     * name they typed. This declines to do more work; it does not take away
     * work already done, and each refusal below says which of the two it is.
     */
    @Transactional(readOnly = true)
    public void requireAiOrThrow(String userId, AiFeature feature) {
        UsageLimit u = usage.findByUserId(userId).orElse(null);
        int used = u == null ? 0 : u.getAiMinutesUsed();
        if (used >= MINUTES_ALLOWANCE) {
            throw ApiException.usageLimitReached(
                    "You have used all " + MINUTES_ALLOWANCE
                            + " transcription minutes on this account, so "
                            + feature.refused + ". " + feature.kept);
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

    /**
     * Charge one processing attempt, once, however many times it is reported.
     *
     * <p>{@link #addAiMinutes} is a read-modify-write accumulator, which was
     * correct while a completed run was reported exactly once and became a
     * quota leak the moment Kafka delivery was allowed to redeliver. The guard
     * is the primary key of {@code meeting_usage_charges}, not a check here:
     * two duplicate callbacks in flight together would both pass an existence
     * check, and only one can win an insert.
     *
     * <p>A genuine reprocess arrives with a higher attempt number and is
     * charged, which is the behaviour that existed before this and is
     * deliberately kept — the allowance is for minutes transcribed, and
     * reprocessing transcribes them again.
     *
     * @return true when this call charged, false when the attempt was already
     *         billed and nothing was added.
     */
    @Transactional
    public boolean chargeAiMinutesOnce(String userId, String meetingId, int attempt, int minutes) {
        int billed = Math.max(0, minutes);
        if (charges.claim(meetingId, attempt, userId, billed) == 0) {
            log.debug("Attempt {} of meeting {} was already charged; adding nothing.", attempt, meetingId);
            return false;
        }
        UsageLimit u = forUser(userId);
        u.setAiMinutesUsed(u.getAiMinutesUsed() + billed);
        return true;
    }
}
