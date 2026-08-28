package com.recallix.config;

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
    private static final String ISSUER = "https://clerk.recallix.app";
    private static final String JWKS = "https://clerk.recallix.app/.well-known/jwks.json";
    private static final String TOKEN = "0f3a9c1d7e5b4a2f8c6d0e9b1a3f5c7d";
    private static final String FRONTEND = "https://recallix-frontend.onrender.com";
    private static final String PUBLIC = "https://recallix-backend.onrender.com";
    private static final String AI = "http://recallix-ai:10000";

    private static DeploymentCheck ready() {
        return new DeploymentCheck(MODE, ISSUER, JWKS, TOKEN, FRONTEND, PUBLIC, AI);
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
                    new DeploymentCheck("dev", ISSUER, JWKS, TOKEN, FRONTEND, PUBLIC, AI).problems();

            assertThat(problems).hasSize(1);
            // Named as the consequence, not as the setting. "RECALLIX_AUTH_MODE
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
                        new DeploymentCheck(mode, ISSUER, JWKS, TOKEN, FRONTEND, PUBLIC, AI).problems();

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
                    new DeploymentCheck("dev", "", "", TOKEN, FRONTEND, PUBLIC, AI).problems();

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
                    MODE, ISSUER, JWKS, "dev-internal-token", FRONTEND, PUBLIC, AI).problems();

            assertThat(problems).hasSize(1);
            assertThat(problems.get(0)).contains("forge a result callback");
        }

        @Test
        @DisplayName("an unset token is refused")
        void anUnsetTokenIsRefused() {
            List<String> problems =
                    new DeploymentCheck(MODE, ISSUER, JWKS, "", FRONTEND, PUBLIC, AI).problems();

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
                    MODE, ISSUER, JWKS, TOKEN, "http://localhost:3000", PUBLIC, AI).problems();

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
                        new DeploymentCheck(MODE, ISSUER, JWKS, TOKEN, url, PUBLIC, AI).problems();

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
                    MODE, ISSUER, JWKS, TOKEN, "recallix-frontend.onrender.com", PUBLIC, AI).problems();

            assertThat(problems).hasSize(1);
            assertThat(problems.get(0)).contains("https://recallix-frontend.onrender.com");
        }

        @Test
        @DisplayName("a public URL pointing at this container is refused")
        void thePublicUrlMustBePublic() {
            // Calendar feeds are fetched by Google and Apple, not by the user's
            // browser, so this is the one URL where "it works on my machine" is
            // literally the failure.
            List<String> problems = new DeploymentCheck(
                    MODE, ISSUER, JWKS, TOKEN, FRONTEND, "http://localhost:8080", AI).problems();

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
                    "recallix-ai:10000").problems()).isEmpty();
            assertThat(new DeploymentCheck(MODE, ISSUER, JWKS, TOKEN, FRONTEND, PUBLIC,
                    "http://recallix-ai:10000").problems()).isEmpty();
        }

        @Test
        @DisplayName("but an unset ai-service URL is still refused")
        void theInternalUrlMustExist() {
            assertThat(new DeploymentCheck(MODE, ISSUER, JWKS, TOKEN, FRONTEND, PUBLIC, "")
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
                    TOKEN, FRONTEND, PUBLIC, AI);

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
                "dev", "", "", "dev-internal-token", "http://localhost:3000", "", "");

        assertThat(check.problems()).hasSize(5);
    }

    @Test
    @DisplayName("startup fails, and the exception carries the list")
    void theContextRefusesToStart() {
        DeploymentCheck check = new DeploymentCheck(
                "dev", "", "", "dev-internal-token", "http://localhost:3000", "", "");

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
}
