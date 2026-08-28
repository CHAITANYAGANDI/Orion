package com.orion.security;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.NimbusJwtDecoder;
import org.springframework.stereotype.Component;

/**
 * The one place that decides whether a token is real.
 *
 * <p>There are two doors into Orion — the HTTP API and the STOMP socket —
 * and until this existed only one of them was locked. Adding the second lock
 * meant either duplicating the verification or sharing it, and duplicated
 * verification is where security bugs live: two decoders configured from the
 * same URL drift the moment one of them gains an issuer check, an audience
 * check or a clock-skew allowance that the other does not, and nothing fails
 * until the weaker one is the one being attacked.
 *
 * <p>So both go through here. {@link AuthenticationFilter} decides what to do
 * with a verified subject on a request; {@link StompAuthInterceptor} decides
 * the same for a connection. Neither decides what "verified" means.
 *
 * <p><b>The mode defaults to clerk</b>, like everything else that reads it. Dev
 * mode accepts an {@code X-Dev-User} header and becomes whoever it names, which
 * is right for running the stack with no Clerk account and is an authentication
 * bypass anywhere else; an unset or misspelt variable must not be able to
 * choose it. See {@code lib/auth-store.ts} and {@code middleware.ts} for the
 * same default on the other side.
 */
@Component
public class ClerkTokens {

    private final String authMode;
    private final String jwksUrl;

    /**
     * Built once, on first use, and shared.
     *
     * <p>Lazy rather than constructed eagerly because dev mode has no JWKS URL
     * and must still start; {@code volatile} with a synchronized build because
     * the first socket connection and the first API call can race, and two
     * decoders would mean two independent JWK caches fetching the same keys.
     */
    private volatile JwtDecoder decoder;

    public ClerkTokens(@Value("${orion.auth-mode:clerk}") String authMode,
                       @Value("${orion.clerk.jwks-url:}") String jwksUrl) {
        this.authMode = authMode;
        this.jwksUrl = jwksUrl;
    }

    /**
     * Whether the header-trusting local mode is on.
     *
     * <p>Only the exact word, ignoring case. Everything else — unset, empty,
     * "development", a typo — is clerk.
     */
    public boolean devMode() {
        return "dev".equalsIgnoreCase(authMode);
    }

    /** For logging, never for a decision. Decisions use {@link #devMode()}. */
    public String mode() {
        return authMode;
    }

    /**
     * Verify a token and return its claims.
     *
     * @throws org.springframework.security.oauth2.jwt.JwtException if the
     *     signature, expiry or shape is wrong — which every caller must treat
     *     as "not authenticated" rather than as an error to report
     */
    public Jwt verify(String token) {
        return decoder().decode(token);
    }

    private JwtDecoder decoder() {
        JwtDecoder local = decoder;
        if (local == null) {
            synchronized (this) {
                if (decoder == null) {
                    if (jwksUrl == null || jwksUrl.isBlank()) {
                        throw new IllegalStateException("clerk auth-mode requires CLERK_JWKS_URL");
                    }
                    decoder = NimbusJwtDecoder.withJwkSetUri(jwksUrl).build();
                }
                local = decoder;
            }
        }
        return local;
    }
}
