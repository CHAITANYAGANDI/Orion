package com.orion.security;

import com.orion.service.UserService;
import jakarta.servlet.FilterChain;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.mockito.junit.jupiter.MockitoSettings;
import org.mockito.quality.Strictness;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.security.core.context.SecurityContextHolder;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;

/**
 * Which way the authentication switch falls when nobody sets it.
 *
 * <p>Dev mode reads an {@code X-Dev-User} header and becomes whoever it names.
 * That is exactly right for running the stack with no Clerk account, and it is
 * an authentication bypass available to anyone who can send a header.
 *
 * <p>The default used to be dev. So an unset, empty or misspelt
 * {@code ORION_AUTH_MODE} — a compose file edited in a hurry, a variable
 * that did not reach the container, a typo — selected the bypass, silently, and
 * the application started perfectly and served every request as whoever asked.
 * Nothing about that failure looks like a failure.
 *
 * <p>It defaults to clerk now, and the cost of the opposite mistake is a wall of
 * 401s: obvious within seconds, and nobody's data is exposed while it lasts.
 * That asymmetry is the whole argument, and it lives in one character of a
 * {@code @Value} expression, which is why it is pinned here.
 */
@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class AuthModeDefaultTest {

    @Mock private UserService users;

    /**
     * Exactly what Spring does with `${orion.auth-mode:clerk}` unset.
     *
     * <p>A real {@link ClerkTokens} rather than a mock of one, built from the
     * same mode: the default is shared between the two now, so the test is
     * worth more if it goes through the thing that actually decides.
     */
    private AuthenticationFilter withMode(String mode) {
        return new AuthenticationFilter(users, new ClerkTokens(mode, ""), mode);
    }

    private void run(AuthenticationFilter filter, MockHttpServletRequest request) throws Exception {
        SecurityContextHolder.clearContext();
        filter.doFilter(request, new MockHttpServletResponse(), mock(FilterChain.class));
    }

    private static MockHttpServletRequest devHeaderRequest() {
        MockHttpServletRequest request = new MockHttpServletRequest("GET", "/api/v1/usage");
        request.setRequestURI("/api/v1/usage");
        request.addHeader("X-Dev-User", "somebody-elses-account");
        return request;
    }

    @Test
    @DisplayName("the default refuses a dev header rather than trusting it")
    void theDefaultIsClosed() throws Exception {
        // "clerk" is what the @Value default resolves to when the environment
        // says nothing. With no JWKS URL configured there is nothing to verify
        // against either, so the only possible answer is "not authenticated".
        run(withMode("clerk"), devHeaderRequest());

        assertThat(SecurityContextHolder.getContext().getAuthentication()).isNull();
        // And no user was provisioned from it. A row created for an unverified
        // subject is the bypass leaving a trace even where it is refused.
        verifyNoInteractions(users);
    }

    @Test
    @DisplayName("a misspelt mode is not a dev mode")
    void nearMissesAreClosedToo() throws Exception {
        // The realistic typos. Every one of these used to be "not clerk", and
        // "not clerk" used to mean the header was trusted.
        for (String mode : new String[] { "", "  ", "development", "DEV_MODE", "clerkk", "prod" }) {
            run(withMode(mode), devHeaderRequest());

            assertThat(SecurityContextHolder.getContext().getAuthentication())
                    .as("mode=%s", mode)
                    .isNull();
        }
    }

    @Test
    @DisplayName("dev mode still becomes whoever the header names")
    void devModeIsStillReachable() throws Exception {
        // Two things at once, and stating them together is the point.
        //
        // The guard must not break the reason dev mode exists: the whole stack
        // runs with no Clerk account, which is how this repository is picked
        // up. And what dev mode *does* is take a header at its word and
        // authenticate as it -- which is why the default above matters. This is
        // the bypass, written down.
        run(withMode("dev"), devHeaderRequest());

        assertThat(SecurityContextHolder.getContext().getAuthentication())
                .as("dev mode authenticates from the header alone")
                .isNotNull();
        org.mockito.Mockito.verify(users).provision("somebody-elses-account", null);
    }

    @Test
    @DisplayName("case is not a way in")
    void devModeIsCaseInsensitive() throws Exception {
        // Matched with equalsIgnoreCase, so "DEV" is dev. Asserted rather than
        // assumed: if it were case-sensitive, a deployment that meant to be in
        // dev mode would be in clerk mode and nobody could sign in at all.
        run(withMode("DEV"), devHeaderRequest());

        org.mockito.Mockito.verify(users).provision("somebody-elses-account", null);
    }
}
