package com.orion.config;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * The checklist, as code.
 *
 * <p>Every case below is a deployment that starts cleanly, passes its health
 * check and is wrong. That is the whole reason the class exists: none of these
 * mistakes announce themselves, so the announcement is written here and
 * asserted.
 *
 * <p>The tests go through {@link DeploymentCheck#problems()} rather than
 * through an application context, so adding a case costs one line rather than a
 * Spring test.
 */
class DeploymentCheckTest {

    /* A deployment that is actually ready. Every test below spoils one field. */
    private static final String MODE = "clerk";
    private static final String ISSUER = "https://clerk.orion.app";
    private static final String JWKS = "https://clerk.orion.app/.well-known/jwks.json";
    private static final String TOKEN = "0f3a9c1d7e5b4a2f8c6d0e9b1a3f5c7d";
    private static final String FRONTEND = "https://orion-frontend.onrender.com";
    private static final String PUBLIC = "https://orion-backend.onrender.com";
    private static final String AI = "http://orion-ai:10000";
    private static final String DB = "jdbc:postgresql://ep-cool-sun-123.us-east-2.aws.neon.tech/neondb";
    private static final String MAIL_KEY = "re_EXAMPLE_NOT_A_REAL_KEY";
    private static final String MAIL_FROM = "Recallix <notifications@recallix.app>";

    private static DeploymentCheck ready() {
        return new DeploymentCheck(MODE, ISSUER, JWKS, TOKEN, FRONTEND, PUBLIC, AI, DB, MAIL_KEY, MAIL_FROM, false);
    }

    @Test
    @DisplayName("a fully configured deployment has nothing to say")
    void aReadyDeploymentPasses() {
        // If this ever fails, every other test in the file is meaningless: a
        // check that cannot pass is a check somebody deletes.
        assertThat(ready().problems()).isEmpty();
        assertThat(ready().warnings()).isEmpty();
    }

    @Nested
    @DisplayName("the open door")
    class AuthMode {

        @Test
        @DisplayName("dev mode is refused, and the message says what it costs")
        void devModeIsRefused() {
            List<String> problems =
                    new DeploymentCheck("dev", ISSUER, JWKS, TOKEN, FRONTEND, PUBLIC, AI, DB, MAIL_KEY, MAIL_FROM, false).problems();

            assertThat(problems).hasSize(1);
            // Named as the consequence, not as the setting. "ORION_AUTH_MODE
            // should be clerk" is a line somebody skims past at 2am.
            assertThat(problems.get(0)).contains("impersonate any user");
        }

        @Test
        @DisplayName("an unset or misspelt mode is refused too")
        void nearMissesAreRefused() {
            // These are the values that used to reach production silently,
            // because application.yml defaulted the property to dev and the
            // fail-closed default on the @Value never got a say.
            for (String mode : new String[] { "", "  ", "development", "DEV", "prod", "clerkk" }) {
                List<String> problems =
                        new DeploymentCheck(mode, ISSUER, JWKS, TOKEN, FRONTEND, PUBLIC, AI, DB, MAIL_KEY, MAIL_FROM, false).problems();

                assertThat(problems).as("mode=%s", mode).isNotEmpty();
            }
        }

        @Test
        @DisplayName("dev mode is not also nagged about its missing Clerk settings")
        void devModeReportsOneThing() {
            // A dev-mode deployment has no JWKS and is not supposed to. Listing
            // three problems when there is one sends somebody to configure
            // Clerk when what they need to do is stop using dev mode.
            List<String> problems =
                    new DeploymentCheck("dev", "", "", TOKEN, FRONTEND, PUBLIC, AI, DB, MAIL_KEY, MAIL_FROM, false).problems();

            assertThat(problems).hasSize(1);
        }
    }

    @Nested
    @DisplayName("the internal callback secret")
    class InternalToken {

        @Test
        @DisplayName("the published development token is refused")
        void thePublishedTokenIsRefused() {
            // It is in this repository's history, in the compose file and in the
            // deployment docs. Anybody who has read any of those can forge a
            // transcript callback.
            List<String> problems = new DeploymentCheck(
                    MODE, ISSUER, JWKS, "dev-internal-token", FRONTEND, PUBLIC, AI, DB, MAIL_KEY, MAIL_FROM, false).problems();

            assertThat(problems).hasSize(1);
            assertThat(problems.get(0)).contains("forge a result callback");
        }

        @Test
        @DisplayName("an unset token is refused")
        void anUnsetTokenIsRefused() {
            List<String> problems =
                    new DeploymentCheck(MODE, ISSUER, JWKS, "", FRONTEND, PUBLIC, AI, DB, MAIL_KEY, MAIL_FROM, false).problems();

            assertThat(problems).hasSize(1);
        }
    }

    @Nested
    @DisplayName("URLs that only work from inside")
    class Urls {

        @Test
        @DisplayName("a localhost frontend URL is refused")
        void localhostIsRefused() {
            // This one is worth being loud about because of how it presents:
            // APP_FRONTEND_URL is the single allowed CORS origin, so getting it
            // wrong makes every request from the browser fail, and it looks
            // exactly like the API being down.
            List<String> problems = new DeploymentCheck(
                    MODE, ISSUER, JWKS, TOKEN, "http://localhost:3000", PUBLIC, AI, DB, MAIL_KEY, MAIL_FROM, false).problems();

            assertThat(problems).hasSize(1);
            assertThat(problems.get(0)).contains("only this container can reach");
        }

        @Test
        @DisplayName("every way of writing 'this machine' is refused")
        void allLoopbackFormsAreRefused() {
            for (String url : new String[] {
                    "http://localhost:3000",
                    "https://localhost",
                    "http://127.0.0.1:3000",
                    "http://0.0.0.0:3000",
                    "http://host.docker.internal:3000",
                    "http://LOCALHOST:3000",
                    // Bracketed, because that is how a URL writes IPv6 -- and
                    // the brackets contain the same character the port is
                    // separated by, so this is the one that catches a naive
                    // split on the last colon.
                    "http://[::1]:3000",
                    "http://[::1]",
            }) {
                List<String> problems =
                        new DeploymentCheck(MODE, ISSUER, JWKS, TOKEN, url, PUBLIC, AI, DB, MAIL_KEY, MAIL_FROM, false).problems();

                assertThat(problems).as("url=%s", url).isNotEmpty();
            }
        }

        @Test
        @DisplayName("a bare hostname is refused, and the message shows the fix")
        void aSchemeIsRequired() {
            // The realistic mistake, and it comes from the blueprint rather than
            // from carelessness: Render's `fromService` yields a bare host, and
            // a bare host is not an origin -- CORS compares it against
            // `https://host` and never matches.
            List<String> problems = new DeploymentCheck(
                    MODE, ISSUER, JWKS, TOKEN, "orion-frontend.onrender.com", PUBLIC, AI, DB, MAIL_KEY, MAIL_FROM, false).problems();

            assertThat(problems).hasSize(1);
            assertThat(problems.get(0)).contains("https://orion-frontend.onrender.com");
        }

        @Test
        @DisplayName("a public URL pointing at this container is refused")
        void thePublicUrlMustBePublic() {
            // Calendar feeds are fetched by Google and Apple, not by the user's
            // browser, so this is the one URL where "it works on my machine" is
            // literally the failure.
            List<String> problems = new DeploymentCheck(
                    MODE, ISSUER, JWKS, TOKEN, FRONTEND, "http://localhost:8080", AI, DB, MAIL_KEY, MAIL_FROM, false).problems();

            assertThat(problems).hasSize(1);
            assertThat(problems.get(0)).contains("APP_PUBLIC_URL");
        }

        @Test
        @DisplayName("the ai-service URL may be scheme-less, and may be http")
        void theInternalUrlIsLeftAlone() {
            // AiClient repairs this one, because a private service on the
            // internal network can only mean http. Refusing it here would make
            // the blueprint's auto-wiring unusable for no gain.
            assertThat(new DeploymentCheck(MODE, ISSUER, JWKS, TOKEN, FRONTEND, PUBLIC,
                    "orion-ai:10000", DB, MAIL_KEY, MAIL_FROM, false).problems()).isEmpty();
            assertThat(new DeploymentCheck(MODE, ISSUER, JWKS, TOKEN, FRONTEND, PUBLIC,
                    "http://orion-ai:10000", DB, MAIL_KEY, MAIL_FROM, false).problems()).isEmpty();
        }

        @Test
        @DisplayName("but an unset ai-service URL is still refused")
        void theInternalUrlMustExist() {
            assertThat(new DeploymentCheck(MODE, ISSUER, JWKS, TOKEN, FRONTEND, PUBLIC, "", DB, MAIL_KEY, MAIL_FROM, false)
                    .problems()).hasSize(1);
        }
    }

    @Nested
    @DisplayName("what is worth saying but not worth stopping for")
    class Warnings {

        @Test
        @DisplayName("a Clerk development instance warns rather than refuses")
        void aDevelopmentClerkInstanceWarns() {
            // A staging environment on a development instance is a reasonable
            // thing to run, and this cannot tell staging from production. So it
            // says what is wrong and gets out of the way.
            DeploymentCheck check = new DeploymentCheck(
                    MODE,
                    "https://touching-locust-18.clerk.accounts.dev",
                    "https://touching-locust-18.clerk.accounts.dev/.well-known/jwks.json",
                    TOKEN, FRONTEND, PUBLIC, AI, DB, MAIL_KEY, MAIL_FROM, false);

            assertThat(check.problems()).isEmpty();
            assertThat(check.warnings()).singleElement()
                    .asString().contains("DEVELOPMENT instance");
        }
    }

    @Test
    @DisplayName("a deployment with several faults hears about all of them at once")
    void everythingIsReportedTogether() {
        // Fixing a deploy one restart per variable, each cycle revealing the
        // next thing wrong, is how a five-minute checklist becomes an afternoon.
        DeploymentCheck check = new DeploymentCheck(
                "dev", "", "", "dev-internal-token", "http://localhost:3000", "", "", DB, MAIL_KEY, MAIL_FROM, false);

        assertThat(check.problems()).hasSize(5);
    }

    @Test
    @DisplayName("startup fails, and the exception carries the list")
    void theContextRefusesToStart() {
        DeploymentCheck check = new DeploymentCheck(
                "dev", "", "", "dev-internal-token", "http://localhost:3000", "", "", DB, MAIL_KEY, MAIL_FROM, false);

        assertThatThrownBy(check::check)
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("impersonate any user")
                .hasMessageContaining("forge a result callback");
    }

    @Test
    @DisplayName("a ready deployment starts")
    void aReadyDeploymentStarts() {
        ready().check();
    }

    @Nested
    @DisplayName("the pooler that silently empties an account")
    class PooledDatabase {

        /*
         * This one shipped, and it cost four days of looking in the wrong place.
         *
         * Row-level security is armed with a session-level `set_config` on each
         * pooled connection. A transaction-mode pooler hands the next
         * transaction a different server connection, where that setting was
         * never made -- so the policies match nothing and the API answers, with
         * a straight face, that the account is empty. Per request, at random,
         * with no error anywhere. Reloading re-rolls which backend you get,
         * which is why reloading appears to fix it.
         *
         * docs/deploy.md recommended exactly this configuration, which is how
         * it got there.
         */
        @Test
        @DisplayName("a Neon pooled host is refused, and the message says what it looks like")
        void pooledHostIsRefused() {
            List<String> problems = new DeploymentCheck(MODE, ISSUER, JWKS, TOKEN, FRONTEND,
                    PUBLIC, AI,
                    "jdbc:postgresql://ep-cool-sun-123-pooler.us-east-2.aws.neon.tech/neondb",
                    MAIL_KEY, MAIL_FROM, false
            ).problems();

            assertThat(problems).hasSize(1);
            // The symptom, not the setting. Somebody reading this at 2am is
            // looking at an empty screen, not at a connection string.
            assertThat(problems.get(0))
                    .contains("no conversations")
                    .contains("DIRECT");
        }

        @Test
        @DisplayName("a pgbouncer=true parameter is the same mistake spelled differently")
        void pgbouncerParameterIsRefused() {
            assertThat(new DeploymentCheck(MODE, ISSUER, JWKS, TOKEN, FRONTEND, PUBLIC, AI,
                    "jdbc:postgresql://db.example.com/orion?sslmode=require&pgbouncer=true",
                    MAIL_KEY, MAIL_FROM, false
            ).problems()).hasSize(1);
        }

        @Test
        @DisplayName("the direct endpoint passes")
        void directHostPasses() {
            assertThat(ready().problems()).isEmpty();
        }

        @Test
        @DisplayName("a host that merely contains the word pooler is not the mistake")
        void anUnrelatedHostPasses() {
            // The hyphen is what identifies it. Matching on `pooler` alone
            // would accuse this host, which is a perfectly ordinary one.
            assertThat(new DeploymentCheck(MODE, ISSUER, JWKS, TOKEN, FRONTEND, PUBLIC, AI,
                    "jdbc:postgresql://carpooler-db.example.com/orion",
                    MAIL_KEY, MAIL_FROM, false).problems()).isEmpty();
        }

        @Test
        @DisplayName("an unset url is left to Spring, which has its own complaint")
        void unsetUrlIsNotThisCheckSProblem() {
            assertThat(new DeploymentCheck(MODE, ISSUER, JWKS, TOKEN, FRONTEND, PUBLIC, AI, "",
                    MAIL_KEY, MAIL_FROM, false).problems()).isEmpty();
        }
    }

    /**
     * Mail, which production cannot do without.
     *
     * <p>Five of the seven messages are switchable and off by default, so an
     * unconfigured deployment never queues them. Two have no switch, and one of
     * those -- the account closed and its data deleted -- is the only record of
     * an irreversible act that exists once the account is gone.
     *
     * <p>The outbox deliberately keeps what it cannot send, because a queue that
     * expired its contents during an outage would be the at-most-once behaviour
     * the whole design replaced. So an unconfigured production deployment
     * quietly accumulates closure notices for months and then delivers all of
     * them the day somebody sets a key. That is worse than either sending or
     * not sending, and it is invisible until it happens.
     */
    @Nested
    @DisplayName("mail")
    class Mail {

        @Test
        @DisplayName("refuses to start with no API key, and names what cannot be sent")
        void noKey() {
            List<String> problems = new DeploymentCheck(
                    MODE, ISSUER, JWKS, TOKEN, FRONTEND, PUBLIC, AI, DB, "", MAIL_FROM, false).problems();

            assertThat(problems).anyMatch(p -> p.contains("RESEND_API_KEY"));
            assertThat(problems).anyMatch(p -> p.contains("account closed"));
        }

        @Test
        @DisplayName("refuses to start with no sender")
        void noSender() {
            List<String> problems = new DeploymentCheck(
                    MODE, ISSUER, JWKS, TOKEN, FRONTEND, PUBLIC, AI, DB, MAIL_KEY, "", false).problems();

            assertThat(problems).anyMatch(p -> p.contains("ORION_MAIL_FROM is not set"));
        }

        @Test
        @DisplayName("never puts the key anywhere in the output")
        void neverLogsTheKey() {
            /*
             * These problems are thrown as an exception message and logged at
             * startup, which is exactly where a credential ends up in a log
             * aggregator and is kept for a year. Not the value, not a prefix,
             * not a masked form -- the only fact worth reporting is whether it
             * is set.
             */
            String secret = "re_EXAMPLE_PRETEND_THIS_IS_PRODUCTION";
            DeploymentCheck check = new DeploymentCheck(
                    MODE, ISSUER, JWKS, TOKEN, FRONTEND, PUBLIC, AI, DB, secret, "", false);

            String everything = String.join(" ", check.problems()) + String.join(" ", check.warnings());

            assertThat(everything).doesNotContain(secret);
            assertThat(everything).doesNotContain("re_EXAMPLE_PRETEND");
            assertThat(everything).doesNotContain(secret.substring(0, 8));
        }

        @Test
        @DisplayName("accepts a bare address as well as a display name")
        void bothSenderForms() {
            for (String from : List.of("notifications@recallix.app",
                    "Recallix <notifications@recallix.app>")) {
                assertThat(new DeploymentCheck(MODE, ISSUER, JWKS, TOKEN, FRONTEND, PUBLIC, AI,
                        DB, MAIL_KEY, from, false).mailProblem())
                        .as(from).isEmpty();
            }
        }

        @Test
        @DisplayName("refuses something that is not an address at all")
        void notAnAddress() {
            for (String from : List.of("Recallix", "notifications@", "@recallix.app",
                    "notifications at recallix.app")) {
                assertThat(new DeploymentCheck(MODE, ISSUER, JWKS, TOKEN, FRONTEND, PUBLIC, AI,
                        DB, MAIL_KEY, from, false).mailProblem())
                        .as(from).isNotEmpty();
            }
        }

        @Test
        @DisplayName("refuses Resend's own onboarding sender, which works and is the trap")
        void refusesTheOnboardingSender() {
            /*
             * onboarding@resend.dev is the address in Resend's quickstart. It
             * is accepted, it delivers -- and only ever to the account owner's
             * own address. A production deployment on it sends every
             * account-closure notice to the developer instead of the person
             * whose account it was.
             */
            List<String> problems = new DeploymentCheck(MODE, ISSUER, JWKS, TOKEN, FRONTEND,
                    PUBLIC, AI, DB, MAIL_KEY, "Recallix <onboarding@resend.dev>", false).mailProblem();

            assertThat(problems).hasSize(1);
            assertThat(problems.get(0)).contains("resend.dev").contains("only delivers to your own");
        }

        @Test
        @DisplayName("refuses the placeholder in this repository's own env example")
        void refusesThePlaceholder() {
            // `.env.example` ships ORION_MAIL_FROM=Recallix <notifications@yourdomain.com>.
            // Copying that file and filling in everything except this line is the
            // most likely way a deployment reaches production unable to send.
            assertThat(new DeploymentCheck(MODE, ISSUER, JWKS, TOKEN, FRONTEND, PUBLIC, AI, DB,
                    MAIL_KEY, "Recallix <notifications@yourdomain.com>", false).mailProblem())
                    .isNotEmpty();
        }

        @Test
        @DisplayName("refuses an unroutable sender domain")
        void refusesUnroutable() {
            for (String from : List.of("orion@localhost", "orion@recallix.test",
                    "orion@example.com", "orion@mail.example.com")) {
                assertThat(new DeploymentCheck(MODE, ISSUER, JWKS, TOKEN, FRONTEND, PUBLIC, AI,
                        DB, MAIL_KEY, from, false).mailProblem())
                        .as(from).isNotEmpty();
            }
        }

        @Test
        @DisplayName("says nothing about a properly configured sender")
        void happy() {
            assertThat(ready().mailProblem()).isEmpty();
        }

        /**
         * The escape hatch, and why it is a flag rather than an edit.
         *
         * <p>A check that cannot be satisfied is a check somebody deletes -- at
         * the end of a bad afternoon, in the file, permanently, for every future
         * deployment. A flag that has to be typed out and announces itself on
         * every boot is a decision anybody can see afterwards. Deleting the
         * check is a decision nobody can.
         */
        @Nested
        @DisplayName("with no domain to send from")
        class SelfOnly {

            private DeploymentCheck selfOnly(String key, String from) {
                return new DeploymentCheck(MODE, ISSUER, JWKS, TOKEN, FRONTEND, PUBLIC, AI, DB,
                        key, from, true);
            }

            @Test
            @DisplayName("boots with nothing configured at all")
            void bootsUnconfigured() {
                assertThat(selfOnly("", "").mailProblem()).isEmpty();
            }

            @Test
            @DisplayName("boots on Resend's shared sender, which is the whole point of it")
            void bootsOnTheSharedSender() {
                // onboarding@resend.dev delivers only to the Resend account
                // owner. That is wrong for a product and right for a deployment
                // whose only account is the operator's.
                assertThat(selfOnly(MAIL_KEY, "Recallix <onboarding@resend.dev>").mailProblem())
                        .isEmpty();
            }

            @Test
            @DisplayName("says what is being given up, every single boot")
            void warnsLoudly() {
                /*
                 * Unconditional, not once. The declaration stops being true the
                 * moment somebody else signs up, and nothing here can detect
                 * that -- so the only defence is that it is impossible to forget.
                 */
                List<String> warnings = selfOnly(MAIL_KEY, "x@resend.dev").warnings();

                assertThat(warnings).hasSize(1);
                assertThat(warnings.get(0))
                        .contains("Nobody but you will be told")
                        .contains("account was closed")
                        .contains("no users but you");
            }

            @Test
            @DisplayName("tells the truth about which of the two situations it is in")
            void namesTheSituation() {
                assertThat(selfOnly("", "").warnings().get(0))
                        .contains("nothing will be sent at all")
                        .contains("expire unsent");
                assertThat(selfOnly(MAIL_KEY, "x@resend.dev").warnings().get(0))
                        .contains("reach only you");
            }

            @Test
            @DisplayName("still never puts the key in the warning")
            void stillNoKey() {
                String secret = "re_EXAMPLE_PRETEND_THIS_IS_PRODUCTION";

                assertThat(String.join(" ", selfOnly(secret, "x@resend.dev").warnings()))
                        .doesNotContain(secret);
            }

            @Test
            @DisplayName("is off unless it is asked for")
            void offByDefault() {
                // The default is the refusal. Somebody who never heard of this
                // flag gets the check, which is the correct way round.
                assertThat(ready().warnings()).noneMatch(w -> w.contains("Nobody but you"));
                assertThat(new DeploymentCheck(MODE, ISSUER, JWKS, TOKEN, FRONTEND, PUBLIC, AI, DB,
                        "", "", false).mailProblem()).isNotEmpty();
            }
        }
    }
}
