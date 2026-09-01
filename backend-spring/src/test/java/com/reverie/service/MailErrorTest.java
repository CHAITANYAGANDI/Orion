package com.reverie.service;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * What a failed send is allowed to leave in the database.
 *
 * <h2>Why this is a privacy test and not a formatting one</h2>
 *
 * <p>{@code last_error} is not a log line. It is a column that lives for thirty
 * days, sits in a table with no foreign key to anything, and — uniquely in this
 * schema — <b>survives the deletion of the account it belongs to</b>. It is one
 * of the few places in Reverie where data can outlive
 * {@code PrivacyService.closeAccount}.
 *
 * <p>The text arriving there comes from an HTTP client exception whose message
 * Spring assembles from the response body. Several providers echo a submitted
 * header back on a 401. One of those responses stored once would put a live API
 * key in that column permanently, and nothing would ever notice.
 *
 * <p>So the rule is an allow-list: a status and a short phrase in a restricted
 * alphabet. A scrub-list only removes the secrets whose shape somebody thought
 * of, and the tests below include a couple of shapes nobody would have.
 */
class MailErrorTest {

    @Test
    @DisplayName("keeps the status and the reason, which is all anybody diagnoses from")
    void keepsWhatIsUseful() {
        assertThat(MailError.describe(422, "Unprocessable Entity"))
                .isEqualTo("422 Unprocessable Entity");
        assertThat(MailError.describe(429, "Too Many Requests"))
                .isEqualTo("429 Too Many Requests");
    }

    /*
     * A note on the fixtures below, because it is not an accident.
     *
     * They match the PREFIX the redactor keys on and nothing else. None of them
     * is shaped like a real provider credential: real Stripe and Resend keys are
     * an unbroken run of base62 after their prefix, and these are underscored
     * words that say what they are.
     *
     * The first draft used realistic-looking strings, and GitHub's push
     * protection blocked the push on `sk_live_` followed by 24 base62
     * characters. It was right to. A repository that has to be allowlisted past
     * a secret scanner to accept its own tests has trained everybody who works
     * on it to click through that warning, and the next one will be real.
     *
     * Nothing is lost: the realism was never what these assert. The regex
     * branches are, and each fixture still exercises one.
     */

    /** Matches the `re_` branch. Deliberately not shaped like a real key. */
    private static final String RESEND_SHAPED = "re_EXAMPLE_NOT_A_REAL_KEY";

    /** Matches the `sk_` branch. No `live`/`test` infix, for the same reason. */
    private static final String SECRET_SHAPED = "sk_EXAMPLE_NOT_A_REAL_KEY";

    @Test
    @DisplayName("never stores a Resend key, however it arrives")
    void redactsTheKey() {
        for (String body : new String[]{
                "Invalid API key: " + RESEND_SHAPED,
                "{\"message\":\"unauthorized\",\"key\":\"" + RESEND_SHAPED + "\"}",
                "Authorization: Bearer " + RESEND_SHAPED,
        }) {
            String stored = MailError.describe(401, body);
            assertThat(stored).as(body).doesNotContain(RESEND_SHAPED);
            assertThat(stored).as(body).doesNotContain("re_EXAMPLE");
            assertThat(MailError.looksSafe(stored)).as(body).isTrue();
        }
    }

    @Test
    @DisplayName("never stores a bearer token or a long opaque string")
    void redactsAnythingSecretShaped() {
        // The allow-list is doing the work; this is the belt to that pair of
        // braces, and it catches shapes the list was not written against.
        String stored = MailError.describe(403,
                "denied for " + SECRET_SHAPED + " via Bearer abcdefghijklmnop");

        assertThat(stored).doesNotContain("sk_EXAMPLE");
        assertThat(stored).doesNotContain("abcdefghijklmnop");
        assertThat(MailError.looksSafe(stored)).isTrue();
    }

    @Test
    @DisplayName("never stores a long opaque run, whatever it is")
    void redactsAnUnrecognisedShape() {
        /*
         * The branch that catches a credential from a provider nobody here has
         * heard of. Thirty-two characters with no prefix and no meaning is not
         * a status line, so it is dropped without needing to be identified --
         * which is the only defence that works against a format not yet
         * invented.
         */
        String opaque = "ZmFrZV9vcGFxdWVfdG9rZW5fZm9yX3Rlc3Rz";

        String stored = MailError.describe(401, "rejected: " + opaque);

        assertThat(stored).doesNotContain(opaque);
        assertThat(MailError.looksSafe(stored)).isTrue();
    }

    @Test
    @DisplayName("cannot store a response body, whatever is in it")
    void cannotStoreABody() {
        /*
         * The real defence. A string restricted to this alphabet and this
         * length cannot hold JSON, a header dump, or a URL with a token in the
         * query -- so a secret in a shape nobody anticipated still cannot fit.
         */
        String body = "{\"statusCode\":401,\"name\":\"validation_error\",\"message\":\""
                + "x".repeat(400) + "\"}";

        String stored = MailError.describe(401, body);

        assertThat(stored.length()).isLessThanOrEqualTo(130);
        assertThat(stored).doesNotContain("{").doesNotContain("\"");
        assertThat(MailError.looksSafe(stored)).isTrue();
    }

    @Test
    @DisplayName("an exception is reduced to its class name, which cannot carry anything")
    void classNameOnly() {
        // A Java identifier chosen by a library author, not text from a
        // response. Safe by construction rather than by filtering.
        assertThat(MailError.describe(new java.net.ConnectException("connect to 1.2.3.4:443 failed")))
                .isEqualTo("ConnectException");
    }

    @Test
    @DisplayName("says something rather than nothing when there is no reason to give")
    void neverEmpty() {
        // A blank last_error on an abandoned row reads as "nothing was tried".
        assertThat(MailError.describe(0, null)).isEqualTo("Delivery failed");
        assertThat(MailError.describe(0, "   ")).isEqualTo("Delivery failed");
        assertThat(MailError.describe(500, "")).isEqualTo("500");
        assertThat(MailError.describe(null)).isEqualTo("Delivery failed");
    }

    @Test
    @DisplayName("is idempotent, so passing an already-clean value through again is safe")
    void idempotent() {
        // MailDispatcher re-describes what Mailer already described. Doing that
        // twice must not mangle it or the row's error becomes unreadable.
        String once = MailError.describe(422, "Unprocessable Entity");

        assertThat(MailError.describe(0, once)).isEqualTo(once);
    }
}
