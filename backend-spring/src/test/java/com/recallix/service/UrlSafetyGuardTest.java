package com.recallix.service;

import com.recallix.common.ApiException;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * The SSRF guard.
 *
 * <p>A calendar URL cannot be defended with a host allowlist the way the
 * YouTube import is — every host on the internet is a plausible calendar
 * provider — so the check runs against the resolved address. These tests are
 * almost entirely about what must be refused, and name the specific internal
 * targets reachable from this deployment.
 */
class UrlSafetyGuardTest {

    private final UrlSafetyGuard guard = new UrlSafetyGuard();

    // --- refused ------------------------------------------------------------- //

    @ParameterizedTest
    @ValueSource(strings = {
            "http://127.0.0.1/",
            "http://127.0.0.1:8080/actuator/env",
            "http://localhost:8080/actuator/health",
            "http://[::1]:8080/",
            "http://0.0.0.0/",
    })
    @DisplayName("loopback is refused — the Spring actuator lives there")
    void loopbackRefused(String url) {
        assertThatThrownBy(() -> guard.requireSafe(url)).isInstanceOf(ApiException.class);
    }

    @ParameterizedTest
    @ValueSource(strings = {
            "http://10.0.0.5/",
            "http://172.16.4.1/",
            "http://192.168.1.1/admin",
    })
    @DisplayName("RFC 1918 ranges are refused")
    void privateRangesRefused(String url) {
        assertThatThrownBy(() -> guard.requireSafe(url)).isInstanceOf(ApiException.class);
    }

    @ParameterizedTest
    @ValueSource(strings = {
            "http://169.254.169.254/latest/meta-data/",
            "http://[fe80::1]/",
    })
    @DisplayName("link-local is refused — this is the cloud metadata endpoint")
    void linkLocalRefused(String url) {
        // An SSRF that reaches 169.254.169.254 on a cloud host returns the
        // instance's IAM credentials. This is the single most valuable target.
        assertThatThrownBy(() -> guard.requireSafe(url)).isInstanceOf(ApiException.class);
    }

    @Test
    @DisplayName("IPv6 unique-local (fc00::/7) is refused")
    void uniqueLocalIpv6Refused() {
        assertThatThrownBy(() -> guard.requireSafe("http://[fd00::1]/"))
                .isInstanceOf(ApiException.class);
    }

    @Test
    @DisplayName("carrier-grade NAT (100.64/10) is refused")
    void carrierGradeNatRefused() {
        // Not covered by isSiteLocalAddress, but routable inside many hosts.
        assertThatThrownBy(() -> guard.requireSafe("http://100.64.0.1/"))
                .isInstanceOf(ApiException.class);
        assertThatThrownBy(() -> guard.requireSafe("http://100.127.255.254/"))
                .isInstanceOf(ApiException.class);
    }

    @Test
    @DisplayName("100.0.0.1 is public and must NOT be caught by the CGNAT check")
    void adjacentPublicRangeIsAllowed() {
        // 100.0.0.0/10 boundaries are easy to get wrong in both directions.
        assertThat(guard.requireSafe("http://100.63.255.255/")).isNotNull();
        assertThat(guard.requireSafe("http://100.128.0.1/")).isNotNull();
    }

    @ParameterizedTest
    @ValueSource(strings = {
            "file:///etc/passwd",
            "ftp://example.com/x",
            "gopher://example.com/",
            "jar:http://example.com/a.jar!/",
    })
    @DisplayName("non-HTTP schemes are refused")
    void nonHttpSchemesRefused(String url) {
        assertThatThrownBy(() -> guard.requireSafe(url)).isInstanceOf(ApiException.class);
    }

    @ParameterizedTest
    @ValueSource(strings = {"", "   ", "not a url", "http://", "https:///path"})
    @DisplayName("malformed input is refused rather than crashing")
    void malformedRefused(String url) {
        assertThatThrownBy(() -> guard.requireSafe(url)).isInstanceOf(ApiException.class);
    }

    @Test
    @DisplayName("a null URL is refused")
    void nullRefused() {
        assertThatThrownBy(() -> guard.requireSafe(null)).isInstanceOf(ApiException.class);
    }

    @Test
    @DisplayName("service names inside the compose network are refused")
    void composeServiceNamesRefused() {
        // These only resolve inside Docker. Outside it they fail to resolve,
        // which is also a refusal — either way the URL never gets fetched.
        for (String url : new String[]{
                "http://minio:9000/recallix",
                "http://ai-service:8000/ai/process-meeting",
                "http://postgres:5432/",
        }) {
            assertThatThrownBy(() -> guard.requireSafe(url)).isInstanceOf(ApiException.class);
        }
    }

    // --- accepted ------------------------------------------------------------ //

    @Test
    @DisplayName("a public calendar URL is accepted")
    void publicUrlAccepted() {
        assertThat(guard.requireSafe("https://8.8.8.8/basic.ics")).isNotNull();
    }

    @Test
    @DisplayName("webcal:// is rewritten to https rather than rejected")
    void webcalIsRewritten() {
        // Every calendar app hands out webcal:// links; it is https underneath,
        // and refusing them would make the feature look broken.
        assertThat(guard.requireSafe("webcal://8.8.8.8/cal.ics").getScheme()).isEqualTo("https");
        assertThat(guard.requireSafe("WEBCAL://8.8.8.8/cal.ics").getScheme()).isEqualTo("https");
    }

    @Test
    @DisplayName("surrounding whitespace from a paste is tolerated")
    void whitespaceTolerated() {
        assertThat(guard.requireSafe("  https://8.8.8.8/cal.ics  ")).isNotNull();
    }
}
