package com.recallix.security;

import com.recallix.common.ApiException;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.Base64;
import java.util.HashSet;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Encryption of OAuth tokens at rest.
 *
 * <p>What these guard is mostly the ways AES-GCM is quietly misused. A reused IV
 * is the classic one: it still round-trips correctly in a unit test, so nothing
 * fails, while in production it leaks the XOR of two plaintexts and lets an
 * attacker forge tags. So the IV test asserts on ciphertexts rather than on
 * decryptions — the only place the mistake is visible.
 */
class TokenCipherTest {

    private static final String KEY = Base64.getEncoder().encodeToString(new byte[32]);

    private static TokenCipher cipher() {
        return new TokenCipher(KEY);
    }

    @Test
    @DisplayName("a token survives the round trip")
    void roundTrip() {
        TokenCipher c = cipher();
        String token = "1//0eXaMpLe-refresh-token_value";
        assertThat(c.decrypt(c.encrypt(token))).isEqualTo(token);
    }

    @Test
    @DisplayName("the stored form does not contain the plaintext")
    void ciphertextHidesThePlaintext() {
        String token = "super-secret-refresh-token";
        String stored = cipher().encrypt(token);
        assertThat(stored).doesNotContain(token);
        assertThat(stored).startsWith("v1:");
    }

    @Test
    @DisplayName("encrypting the same value twice never repeats a ciphertext")
    void ivIsNeverReused() {
        TokenCipher c = cipher();
        Set<String> seen = new HashSet<>();
        for (int i = 0; i < 200; i++) {
            seen.add(c.encrypt("identical-token"));
        }
        // Equal ciphertexts would mean an equal IV under the same key, which is
        // the one failure mode GCM does not tolerate.
        assertThat(seen).hasSize(200);
    }

    @Test
    @DisplayName("a tampered ciphertext is rejected, not silently decrypted")
    void tamperingIsDetected() {
        TokenCipher c = cipher();
        String stored = c.encrypt("a-token");

        byte[] raw = Base64.getDecoder().decode(stored.substring(3));
        raw[raw.length - 1] ^= 0x01;      // flip one bit of the tag
        String tampered = "v1:" + Base64.getEncoder().encodeToString(raw);

        assertThatThrownBy(() -> c.decrypt(tampered))
                .isInstanceOf(IllegalStateException.class);
    }

    @Test
    @DisplayName("a value encrypted under a different key does not decrypt")
    void wrongKeyFails() {
        byte[] other = new byte[32];
        other[0] = 7;
        TokenCipher a = cipher();
        TokenCipher b = new TokenCipher(Base64.getEncoder().encodeToString(other));

        String stored = a.encrypt("a-token");
        assertThatThrownBy(() -> b.decrypt(stored)).isInstanceOf(IllegalStateException.class);
    }

    @Test
    @DisplayName("an unversioned value is refused rather than guessed at")
    void unknownFormatIsRefused() {
        assertThatThrownBy(() -> cipher().decrypt("just-some-plaintext"))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("recognised format");
    }

    @Test
    @DisplayName("nulls pass through, so an absent refresh token is not an error")
    void nullsPassThrough() {
        TokenCipher c = cipher();
        // Microsoft omits refresh_token when offline_access was not granted.
        assertThat(c.encrypt(null)).isNull();
        assertThat(c.decrypt(null)).isNull();
    }

    @Test
    @DisplayName("without a key, the cipher reports unconfigured instead of pretending")
    void unconfiguredIsVisible() {
        TokenCipher c = new TokenCipher("");
        assertThat(c.isConfigured()).isFalse();
        assertThatThrownBy(() -> c.encrypt("x")).isInstanceOf(ApiException.class);
    }

    @Test
    @DisplayName("a wrong-length key fails at construction, not at first use")
    void shortKeyFailsFast() {
        String tooShort = Base64.getEncoder().encodeToString(new byte[16]);
        assertThatThrownBy(() -> new TokenCipher(tooShort))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("32 bytes");
    }

    @Test
    @DisplayName("a non-base64 key fails at construction")
    void malformedKeyFailsFast() {
        assertThatThrownBy(() -> new TokenCipher("not!valid!base64!"))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("base64");
    }

    @Test
    @DisplayName("configured cipher reports itself as such")
    void configuredIsVisible() {
        assertThat(cipher().isConfigured()).isTrue();
    }
}
