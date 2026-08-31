package com.orion.service;

import java.util.Locale;
import java.util.regex.Pattern;

/**
 * What a failed attempt is allowed to leave behind on the row.
 *
 * <h2>Why a provider error is not safe to store verbatim</h2>
 *
 * <p>{@code last_error} is not a log line. It is a database column that
 * outlives the attempt by thirty days, sits in a table with no foreign key to
 * anything, and survives the deletion of the account it belongs to. Whatever
 * lands in it is kept, and kept somewhere the ordinary erasure paths do not
 * reach.
 *
 * <p>The text comes from an HTTP client exception. Its message is assembled
 * from a status line and a response body that this application does not
 * control, and Spring's own {@code HttpClientErrorException} message includes
 * the body. A provider that echoes a submitted header back in an error — and
 * several do, on 401 in particular — would put a live API key in that column
 * permanently. That is not a hypothetical class of bug; it is the ordinary way
 * credentials end up in databases.
 *
 * <p>So this is an allow-list rather than a scrub-list. The two facts worth
 * keeping are the status and a short human reason, and everything else is
 * dropped rather than inspected — a scrub-list only removes the secrets whose
 * shape somebody thought of.
 */
final class MailError {

    private MailError() {
    }

    /** Long enough for a status and a reason. Anything longer is a body. */
    private static final int MAX = 120;

    /**
     * Anything that looks like a credential, whatever else is going on.
     *
     * <p>A second line of defence: the length cap and the allow-list below
     * should already have removed it. Cheap enough to keep, and the cost of it
     * being redundant is nothing against the cost of it being needed.
     */
    private static final Pattern SECRETISH = Pattern.compile(
            "(?i)(re_[A-Za-z0-9_-]{4,}"          // Resend keys
                    + "|bearer\\s+\\S+"           // Authorization values
                    + "|sk_[A-Za-z0-9_-]{4,}"     // the usual secret-key convention
                    + "|[A-Za-z0-9_-]{32,})");    // any long opaque run

    /**
     * Header names, dropped along with their values.
     *
     * <p>The value is already gone by the time this runs — {@link #SECRETISH}
     * takes it. The name goes too, because a stored error containing the word
     * "Authorization" means the provider is reflecting request headers back at
     * us, and the right response to that is for none of it to reach the column
     * rather than to keep a note of it. It also lets {@link #looksSafe} stay
     * strict, which is the assertion the tests lean on.
     */
    private static final Pattern HEADERISH = Pattern.compile(
            "(?i)\\b(authorization|api[-_]?key|x-api-key|idempotency-key)\\b\\s*:?");

    /**
     * A storable description of a failure.
     *
     * @param status HTTP status, or 0 when the request never got one
     * @param reason a short phrase; anything unrecognised is dropped
     */
    static String describe(int status, String reason) {
        String safe = clean(reason);
        if (status > 0) {
            return safe.isEmpty() ? String.valueOf(status) : status + " " + safe;
        }
        return safe.isEmpty() ? "Delivery failed" : safe;
    }

    /**
     * Reduce free text to something that cannot carry a secret.
     *
     * <p>Letters, digits, spaces and a handful of punctuation. Not because the
     * others are dangerous in themselves, but because a string restricted to
     * this alphabet and this length cannot hold a JSON body, a header dump or a
     * URL with a token in the query.
     */
    private static String clean(String raw) {
        if (raw == null) {
            return "";
        }
        String redacted = SECRETISH.matcher(raw).replaceAll("[redacted]");
        redacted = HEADERISH.matcher(redacted).replaceAll("[header]");
        String kept = redacted.replaceAll("[^A-Za-z0-9 .,:_'\\[\\]-]", " ")
                .replaceAll("\\s+", " ")
                .trim();
        if (kept.length() > MAX) {
            kept = kept.substring(0, MAX - 3).trim() + "...";
        }
        return kept;
    }

    /**
     * The name of an exception class, which is safe by construction — it is a
     * Java identifier chosen by a library author, not text from a response.
     *
     * <p>Kept as its own entry point so the call site says which of the two
     * kinds of failure it has, rather than passing a message and hoping.
     */
    static String describe(Throwable cause) {
        return cause == null ? "Delivery failed" : cause.getClass().getSimpleName();
    }

    /** Whether a stored error looks like it leaked something. For the tests. */
    static boolean looksSafe(String stored) {
        return stored == null
                || (stored.length() <= MAX && !SECRETISH.matcher(stored).find()
                    && !stored.toLowerCase(Locale.ROOT).contains("authorization"));
    }
}
