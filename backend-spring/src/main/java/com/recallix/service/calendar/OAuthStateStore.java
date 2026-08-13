package com.recallix.service.calendar;

import com.recallix.common.ApiException;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Component;

import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.Duration;
import java.util.Base64;
import java.nio.charset.StandardCharsets;

/**
 * One-shot CSRF state (and PKCE verifier) for an in-flight OAuth authorization.
 *
 * <p>The {@code state} parameter is the only thing standing between this flow
 * and a login-CSRF: without it, an attacker completes consent against their own
 * calendar, then hands the victim the resulting callback URL, and the victim's
 * Recallix account silently ends up connected to — and recording from — the
 * attacker's calendar. So state is random, bound to the user who started the
 * flow, and consumed on first use. Redis gives the expiry for free, which
 * matters because an abandoned flow should not leave a valid state lying around.
 *
 * <p>The PKCE verifier rides along in the same record. PKCE is not strictly
 * required for a confidential client, but the authorization code travels back
 * through a browser redirect, and binding the code to a secret the browser never
 * saw removes the value of intercepting it.
 */
@Component
public class OAuthStateStore {

    private static final String PREFIX = "oauth:cal:state:";
    /** Long enough to finish consent, short enough that abandoned flows expire. */
    private static final Duration TTL = Duration.ofMinutes(10);

    private final StringRedisTemplate redis;
    private final SecureRandom random = new SecureRandom();

    public OAuthStateStore(StringRedisTemplate redis) {
        this.redis = redis;
    }

    /** What was remembered when the flow started. */
    public record Pending(String userId, String provider, String codeVerifier, String returnTo) {
    }

    /** A new authorization attempt: returns the opaque state to send to the provider. */
    public String create(String userId, String provider, String codeVerifier, String returnTo) {
        String state = randomUrlSafe(32);
        // Tab-separated because none of these fields can contain a tab: ids are
        // generated, the provider is an allowlisted key, the verifier is base64url.
        String payload = String.join("\t", userId, provider, codeVerifier,
                returnTo == null ? "" : returnTo);
        redis.opsForValue().set(PREFIX + state, payload, TTL);
        return state;
    }

    /**
     * Consume a state, or fail.
     *
     * <p>Deleted as it is read, so a replayed callback cannot connect a second
     * account or re-run the exchange.
     */
    public Pending consume(String state) {
        if (state == null || state.isBlank()) {
            throw ApiException.badRequest("Missing OAuth state");
        }
        String key = PREFIX + state;
        String payload = redis.opsForValue().get(key);
        redis.delete(key);
        if (payload == null) {
            throw ApiException.badRequest(
                    "That calendar connection link has expired. Please try connecting again.");
        }
        String[] parts = payload.split("\t", -1);
        if (parts.length < 4) {
            throw ApiException.badRequest("Malformed OAuth state");
        }
        return new Pending(parts[0], parts[1], parts[2], parts[3].isEmpty() ? null : parts[3]);
    }

    /** A fresh PKCE code verifier: 43–128 chars of base64url, per RFC 7636. */
    public String newCodeVerifier() {
        return randomUrlSafe(64);
    }

    /** S256 challenge for a verifier. */
    public static String codeChallenge(String verifier) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256")
                    .digest(verifier.getBytes(StandardCharsets.US_ASCII));
            return Base64.getUrlEncoder().withoutPadding().encodeToString(digest);
        } catch (Exception e) {
            throw new IllegalStateException("SHA-256 unavailable", e);
        }
    }

    private String randomUrlSafe(int bytes) {
        byte[] buf = new byte[bytes];
        random.nextBytes(buf);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(buf);
    }
}
