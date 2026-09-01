package com.reverie.security;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.springframework.security.oauth2.jwt.Jwt;

import java.time.Instant;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Reading a second-factor claim off a Clerk token.
 *
 * <p>Three-valued on purpose, and that is the whole of what these tests defend.
 * Clerk's default session token carries no claim about factors — it has to be
 * added to the JWT template, exactly like the email claim — so "absent" is the
 * common case rather than an edge one.
 *
 * <p>Collapsing absent into false is the dangerous direction. A settings page
 * telling somebody who has two-factor authentication switched on that it is off
 * teaches them the page is wrong, and after that it cannot warn them about
 * anything. The opposite error is worse still: claiming a factor that is not
 * there. So silence stays silence.
 */
class SecondFactorClaimTest {

    private static Jwt tokenWith(Map<String, Object> claims) {
        Map<String, Object> all = new java.util.HashMap<>(claims);
        all.putIfAbsent("sub", "user_123");
        return new Jwt("token-value", Instant.now(), Instant.now().plusSeconds(600),
                Map.of("alg", "RS256"), all);
    }

    @Nested
    @DisplayName("when the token says something")
    class Asserted {

        @Test
        @DisplayName("reads a boolean true")
        void booleanTrue() {
            assertThat(AuthenticationFilter.secondFactorClaim(
                    tokenWith(Map.of("two_factor_enabled", true)))).isTrue();
        }

        @Test
        @DisplayName("reads a boolean false")
        void booleanFalse() {
            assertThat(AuthenticationFilter.secondFactorClaim(
                    tokenWith(Map.of("two_factor_enabled", false)))).isFalse();
        }

        @Test
        @DisplayName("reads the string a template interpolation produces")
        void stringForm() {
            // A JWT template written as "{{user.two_factor_enabled}}" renders a
            // string, not a JSON boolean, and the difference is invisible until
            // the page reports the wrong thing.
            assertThat(AuthenticationFilter.secondFactorClaim(
                    tokenWith(Map.of("two_factor_enabled", "true")))).isTrue();
            assertThat(AuthenticationFilter.secondFactorClaim(
                    tokenWith(Map.of("two_factor_enabled", "false")))).isFalse();
        }

        @Test
        @DisplayName("accepts the other spellings a template might use")
        void alternativeSpellings() {
            assertThat(AuthenticationFilter.secondFactorClaim(
                    tokenWith(Map.of("twoFactorEnabled", true)))).isTrue();
            assertThat(AuthenticationFilter.secondFactorClaim(
                    tokenWith(Map.of("mfa", true)))).isTrue();
            assertThat(AuthenticationFilter.secondFactorClaim(
                    tokenWith(Map.of("tfa", true)))).isTrue();
        }
    }

    @Nested
    @DisplayName("when the token says nothing")
    class Silent {

        @Test
        @DisplayName("a token with no such claim asserts nothing")
        void absent() {
            assertThat(AuthenticationFilter.secondFactorClaim(
                    tokenWith(Map.of("email", "ana@example.com")))).isNull();
        }

        @Test
        @DisplayName("a value that is neither true nor false asserts nothing")
        void unreadable() {
            // "yes" is somebody's idea of a boolean and nobody else's. Guessing
            // at it would be inventing an answer to a security question.
            assertThat(AuthenticationFilter.secondFactorClaim(
                    tokenWith(Map.of("two_factor_enabled", "yes")))).isNull();
            assertThat(AuthenticationFilter.secondFactorClaim(
                    tokenWith(Map.of("two_factor_enabled", 1)))).isNull();
        }
    }

    @Nested
    @DisplayName("what the account page is told")
    class Reported {

        @Test
        @DisplayName("a dev session has no provider and therefore no factors")
        void devSession() {
            SignInSecurity dev = SignInSecurity.dev();

            assertThat(dev.managedExternally()).isFalse();
            assertThat(dev.secondFactor()).isNull();
        }

        @Test
        @DisplayName("a Clerk session is managed somewhere else, which is where 2FA lives")
        void clerkSession() {
            SignInSecurity clerk = new SignInSecurity("clerk", Boolean.TRUE);

            // The page uses this to decide whether to offer a link out at all:
            // Reverie cannot enrol a factor it will never be asked to check.
            assertThat(clerk.managedExternally()).isTrue();
            assertThat(clerk.secondFactor()).isTrue();
        }
    }
}
