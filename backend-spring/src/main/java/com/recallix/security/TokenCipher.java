package com.recallix.security;

import com.recallix.common.ApiException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import javax.crypto.Cipher;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import java.nio.ByteBuffer;
import java.security.SecureRandom;
import java.util.Base64;

/**
 * Envelope encryption for OAuth tokens at rest.
 *
 * <p>A Google or Microsoft refresh token is not a session credential — it is
 * long-lived, silently renewable read access to somebody's entire calendar, and
 * it survives password changes. Row-level security already stops one tenant
 * reading another's row, but RLS is enforced by the database: it protects
 * nothing in a leaked backup, a replica, or a `pg_dump` in someone's downloads
 * folder. Encrypting before the value reaches Postgres means those artefacts
 * carry ciphertext.
 *
 * <p>AES-256-GCM, so the ciphertext is authenticated: a tampered value fails to
 * decrypt rather than decrypting into something attacker-chosen. Each encryption
 * draws a fresh 12-byte IV — mandatory for GCM, where reusing an IV under the
 * same key leaks the XOR of two plaintexts and lets an attacker forge tags. The
 * IV is prepended to the ciphertext, since it is not secret and must travel with
 * it.
 *
 * <p>Stored form is {@code v1:<base64(iv||ciphertext||tag)>}. The version prefix
 * exists so a future key rotation or algorithm change can recognise old values
 * instead of guessing at them.
 */
@Component
public class TokenCipher {

    private static final Logger log = LoggerFactory.getLogger(TokenCipher.class);

    private static final String PREFIX = "v1:";
    private static final String TRANSFORMATION = "AES/GCM/NoPadding";
    private static final int IV_BYTES = 12;
    private static final int TAG_BITS = 128;
    private static final int KEY_BYTES = 32;

    private final SecretKey key;
    private final SecureRandom random = new SecureRandom();

    /**
     * @param base64Key 32 raw bytes, base64-encoded. Generate with
     *                  {@code openssl rand -base64 32}.
     */
    public TokenCipher(@Value("${recallix.oauth.token-key:}") String base64Key) {
        this.key = parseKey(base64Key);
        if (this.key == null) {
            log.warn("recallix.oauth.token-key is not set — calendar OAuth is disabled. "
                    + "Generate one with: openssl rand -base64 32");
        }
    }

    private static SecretKey parseKey(String base64Key) {
        if (base64Key == null || base64Key.isBlank()) {
            return null;
        }
        byte[] raw;
        try {
            raw = Base64.getDecoder().decode(base64Key.trim());
        } catch (IllegalArgumentException e) {
            throw new IllegalStateException(
                    "recallix.oauth.token-key is not valid base64", e);
        }
        if (raw.length != KEY_BYTES) {
            // Failing at startup rather than at first use: a short key would
            // otherwise surface as a runtime error the first time somebody
            // connects a calendar, long after the deploy that caused it.
            throw new IllegalStateException(
                    "recallix.oauth.token-key must decode to " + KEY_BYTES
                            + " bytes, got " + raw.length);
        }
        return new SecretKeySpec(raw, "AES");
    }

    /**
     * Whether tokens can be stored at all.
     *
     * <p>Checked before starting an OAuth flow. Sending a user to Google, having
     * them approve access, and only then discovering the token cannot be stored
     * would grant Recallix access it then throws away — worse than refusing up
     * front.
     */
    public boolean isConfigured() {
        return key != null;
    }

    public String encrypt(String plaintext) {
        if (plaintext == null) {
            return null;
        }
        requireConfigured();
        try {
            byte[] iv = new byte[IV_BYTES];
            random.nextBytes(iv);

            Cipher cipher = Cipher.getInstance(TRANSFORMATION);
            cipher.init(Cipher.ENCRYPT_MODE, key, new GCMParameterSpec(TAG_BITS, iv));
            byte[] ciphertext = cipher.doFinal(plaintext.getBytes(java.nio.charset.StandardCharsets.UTF_8));

            byte[] packed = ByteBuffer.allocate(iv.length + ciphertext.length)
                    .put(iv).put(ciphertext).array();
            return PREFIX + Base64.getEncoder().encodeToString(packed);
        } catch (Exception e) {
            // Never log the plaintext, and never include it in the message.
            throw new IllegalStateException("Could not encrypt token", e);
        }
    }

    public String decrypt(String stored) {
        if (stored == null) {
            return null;
        }
        requireConfigured();
        if (!stored.startsWith(PREFIX)) {
            throw new IllegalStateException("Stored token is not in a recognised format");
        }
        try {
            byte[] packed = Base64.getDecoder().decode(stored.substring(PREFIX.length()));
            if (packed.length <= IV_BYTES) {
                throw new IllegalStateException("Stored token is truncated");
            }
            ByteBuffer buffer = ByteBuffer.wrap(packed);
            byte[] iv = new byte[IV_BYTES];
            buffer.get(iv);
            byte[] ciphertext = new byte[buffer.remaining()];
            buffer.get(ciphertext);

            Cipher cipher = Cipher.getInstance(TRANSFORMATION);
            cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(TAG_BITS, iv));
            return new String(cipher.doFinal(ciphertext), java.nio.charset.StandardCharsets.UTF_8);
        } catch (IllegalStateException e) {
            throw e;
        } catch (Exception e) {
            // Includes AEADBadTagException: wrong key, or the row was tampered
            // with. Both mean the same thing to a caller — this token is gone,
            // reconnect the account.
            throw new IllegalStateException("Could not decrypt token; the key may have changed", e);
        }
    }

    private void requireConfigured() {
        if (key == null) {
            throw ApiException.badRequest(
                    "Calendar connections are not configured on this server");
        }
    }
}
