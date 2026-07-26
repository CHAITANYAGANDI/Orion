package com.recallix.service;

import com.recallix.common.ApiException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.net.InetAddress;
import java.net.URI;
import java.net.UnknownHostException;
import java.util.List;

/**
 * Blocks server-side request forgery on user-supplied URLs the server fetches.
 *
 * <p>The YouTube import could be defended with a host allowlist. A calendar
 * subscription cannot: any host on the internet is a legitimate calendar
 * provider, so the check has to run against the resolved address instead.
 *
 * <p>Every private, loopback, link-local and multicast range is refused. That
 * covers the interesting targets in this deployment specifically — the Spring
 * actuator, MinIO's unauthenticated internal endpoint, Postgres, Kafka, the
 * ai-service — plus the cloud metadata endpoints (169.254.169.254 and its IPv6
 * equivalent) that turn an SSRF into stolen instance credentials.
 *
 * <p>Two limitations, stated rather than hidden:
 * <ul>
 *   <li>This is check-then-fetch, so a DNS entry that resolves differently on
 *       the second lookup can slip through (a "DNS rebinding" attack). Closing
 *       that properly means pinning the resolved address into the connection,
 *       which the JDK HTTP client does not expose. For a single-user
 *       deployment the residual risk is small and the check still stops every
 *       non-adversarial mistake and every naive attack.
 *   <li>Redirects are refused rather than followed, because a redirect target
 *       would bypass a check already performed on the original URL.
 * </ul>
 */
@Component
public class UrlSafetyGuard {

    private static final Logger log = LoggerFactory.getLogger(UrlSafetyGuard.class);

    private static final List<String> ALLOWED_SCHEMES = List.of("http", "https");

    /**
     * Validate a user-supplied URL that the server is about to fetch.
     *
     * @return the parsed URI when it is safe
     * @throws ApiException when it is not
     */
    public URI requireSafe(String rawUrl) {
        if (rawUrl == null || rawUrl.isBlank()) {
            throw ApiException.badRequest("A URL is required");
        }

        String trimmed = rawUrl.trim();
        // Calendar apps hand out webcal:// links; it is plain HTTPS underneath.
        if (trimmed.regionMatches(true, 0, "webcal://", 0, 9)) {
            trimmed = "https://" + trimmed.substring(9);
        }

        URI uri;
        try {
            uri = new URI(trimmed);
        } catch (Exception e) {
            throw ApiException.badRequest("That doesn't look like a valid URL");
        }

        String scheme = uri.getScheme();
        if (scheme == null || ALLOWED_SCHEMES.stream().noneMatch(scheme::equalsIgnoreCase)) {
            throw ApiException.badRequest("Only http and https URLs are supported");
        }

        String host = uri.getHost();
        if (host == null || host.isBlank()) {
            throw ApiException.badRequest("That URL has no host");
        }

        InetAddress[] addresses;
        try {
            addresses = InetAddress.getAllByName(host);
        } catch (UnknownHostException e) {
            throw ApiException.badRequest("That host could not be resolved: " + host);
        }

        // Every address must be public. A host resolving to both a public and a
        // private address is a classic bypass, so one bad answer fails it all.
        for (InetAddress address : addresses) {
            if (isPrivate(address)) {
                log.warn("Refused URL {} — host {} resolves to non-public address {}.",
                        trimmed, host, address.getHostAddress());
                throw ApiException.badRequest(
                        "That URL points at a private or internal address, which isn't allowed");
            }
        }

        return uri;
    }

    /** True when the address is anything other than a routable public one. */
    private static boolean isPrivate(InetAddress address) {
        return address.isAnyLocalAddress()      // 0.0.0.0, ::
                || address.isLoopbackAddress()   // 127.0.0.0/8, ::1
                || address.isLinkLocalAddress()  // 169.254.0.0/16 (metadata), fe80::/10
                || address.isSiteLocalAddress()  // 10/8, 172.16/12, 192.168/16, fec0::/10
                || address.isMulticastAddress()
                || isUniqueLocalIpv6(address)
                || isCarrierGradeNat(address);
    }

    /** fc00::/7 — the IPv6 equivalent of the RFC 1918 ranges. */
    private static boolean isUniqueLocalIpv6(InetAddress address) {
        byte[] bytes = address.getAddress();
        return bytes.length == 16 && (bytes[0] & 0xFE) == 0xFC;
    }

    /**
     * 100.64.0.0/10 (RFC 6598). Not covered by {@code isSiteLocalAddress}, but
     * routable inside many hosting providers' internal networks.
     */
    private static boolean isCarrierGradeNat(InetAddress address) {
        byte[] bytes = address.getAddress();
        if (bytes.length != 4) {
            return false;
        }
        int first = bytes[0] & 0xFF;
        int second = bytes[1] & 0xFF;
        return first == 100 && second >= 64 && second <= 127;
    }
}
