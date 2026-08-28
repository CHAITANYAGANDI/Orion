package com.recallix.config;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.boot.env.YamlPropertySourceLoader;
import org.springframework.core.env.PropertySource;
import org.springframework.core.env.StandardEnvironment;
import org.springframework.core.io.ClassPathResource;

import java.io.IOException;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * What {@code application.yml} resolves to when the environment says nothing.
 *
 * <h2>The bug this exists for</h2>
 *
 * <p>{@code AuthenticationFilter}, {@code ClerkTokens} and
 * {@code DeploymentCheck} all declare {@code @Value("${recallix.auth-mode:clerk}")},
 * and {@link com.recallix.security.AuthModeDefaultTest} pins that they fail
 * closed. All of it was dead. A {@code @Value} default applies only when the
 * property is <em>absent</em>, and {@code application.yml} said
 * {@code auth-mode: ${RECALLIX_AUTH_MODE:dev}} — which made it present, in
 * every profile, resolving to {@code dev}.
 *
 * <p>So there were two defaults for one decision, in two files, and the weaker
 * one won silently. Nothing failed: the unit tests passed, because they
 * construct the filter with an explicit mode and never go near this file.
 *
 * <p>That is the gap this closes. It resolves the real YAML the real way, with
 * no environment behind it, and asserts what Spring would actually hand the
 * application on a machine where nobody set anything.
 */
class ApplicationDefaultsTest {

    private StandardEnvironment environment;

    /**
     * A deliberately empty environment.
     *
     * <p>The system property sources are removed rather than left in place:
     * with them, this test would read whatever the developer happens to export
     * in their shell, and would pass or fail per machine. The whole question is
     * what happens when nothing is set, so nothing is set.
     */
    @BeforeEach
    void loadTheRealYaml() throws IOException {
        environment = new StandardEnvironment();
        environment.getPropertySources()
                .remove(StandardEnvironment.SYSTEM_ENVIRONMENT_PROPERTY_SOURCE_NAME);
        environment.getPropertySources()
                .remove(StandardEnvironment.SYSTEM_PROPERTIES_PROPERTY_SOURCE_NAME);
        for (PropertySource<?> source : new YamlPropertySourceLoader()
                .load("application.yml", new ClassPathResource("application.yml"))) {
            environment.getPropertySources().addLast(source);
        }
    }

    @Test
    @DisplayName("the auth mode defaults to clerk, not dev")
    void authModeFailsClosed() {
        // One word, and it is the entire access-control story for a deployment
        // whose environment did not arrive intact. In dev mode an X-Dev-User
        // header impersonates any user, over HTTP and over the socket both.
        assertThat(environment.getProperty("recallix.auth-mode")).isEqualTo("clerk");
    }

    @Test
    @DisplayName("the internal callback token has no default at all")
    void theInternalTokenIsUnset() {
        // It used to default to a value committed to this repository, which
        // made "never configured" indistinguishable from "configured with the
        // password everyone knows". Blank means InternalTokenFilter refuses
        // every /internal/** request instead.
        assertThat(environment.getProperty("recallix.internal-token")).isEmpty();
    }

    @Test
    @DisplayName("Clerk's issuer and JWKS have no defaults to fall back on")
    void clerkHasNoDefaults() {
        // There is no sensible guess for either, and a guess would be a decoder
        // built against somebody else's keys.
        assertThat(environment.getProperty("recallix.clerk.issuer")).isEmpty();
        assertThat(environment.getProperty("recallix.clerk.jwks-url")).isEmpty();
    }

    @Test
    @DisplayName("the URLs still default to localhost, which is why DeploymentCheck exists")
    void theUrlsAreStillLocal() {
        // Asserted rather than left implicit, because it looks like an
        // oversight and is not one: these defaults are what makes the stack run
        // on a laptop with an empty .env, and tightening them would break the
        // common case to protect the rare one. DeploymentCheck covers the rare
        // one instead, by refusing to start under the `production` profile.
        assertThat(environment.getProperty("app.frontend-url")).isEqualTo("http://localhost:3000");
        assertThat(environment.getProperty("app.public-url")).isEqualTo("http://localhost:8080");
    }
}
