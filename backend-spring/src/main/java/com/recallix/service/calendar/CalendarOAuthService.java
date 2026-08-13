package com.recallix.service.calendar;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.recallix.common.ApiException;
import com.recallix.common.IdGenerator;
import com.recallix.entity.CalendarAccount;
import com.recallix.repository.CalendarAccountRepository;
import com.recallix.security.TokenCipher;
import com.recallix.service.AuditService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * The OAuth authorization-code flow for Google and Microsoft calendars.
 *
 * <p>Written once for both providers; everything that differs is data on
 * {@link OAuthProvider}. The parts worth reading twice:
 *
 * <ul>
 *   <li><b>State is consumed, not compared.</b> {@link OAuthStateStore} deletes
 *       it on read, so a replayed callback fails rather than connecting a second
 *       account.</li>
 *   <li><b>The user comes from the state, never from the request.</b> Trusting a
 *       user id in the callback would let anyone attach their calendar to
 *       somebody else's account.</li>
 *   <li><b>A missing refresh token is a hard failure.</b> Both providers will
 *       happily return an access token and no refresh token if the authorization
 *       request was built wrong. Everything works for an hour and then stops
 *       forever. Refusing to save such a connection turns a silent time bomb
 *       into an error at the only moment anyone is watching.</li>
 * </ul>
 */
@Service
public class CalendarOAuthService {

    private static final Logger log = LoggerFactory.getLogger(CalendarOAuthService.class);

    private final CalendarAccountRepository accounts;
    private final CalendarProviders providers;
    private final OAuthStateStore states;
    private final TokenCipher cipher;
    private final AuditService audit;
    private final ObjectMapper mapper;
    private final String redirectBase;
    private final HttpClient http;

    public CalendarOAuthService(CalendarAccountRepository accounts,
                                CalendarProviders providers,
                                OAuthStateStore states,
                                TokenCipher cipher,
                                AuditService audit,
                                ObjectMapper mapper,
                                @Value("${recallix.oauth.redirect-base:http://localhost:8080}") String redirectBase) {
        this.accounts = accounts;
        this.providers = providers;
        this.states = states;
        this.cipher = cipher;
        this.audit = audit;
        this.mapper = mapper;
        this.redirectBase = redirectBase.endsWith("/")
                ? redirectBase.substring(0, redirectBase.length() - 1)
                : redirectBase;
        this.http = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(10))
                .followRedirects(HttpClient.Redirect.NEVER)
                .build();
    }

    /** The registered callback for a provider. Must match the console exactly. */
    public String redirectUri(String providerKey) {
        return redirectBase + "/api/v1/calendar/oauth/" + providerKey + "/callback";
    }

    // --- start ---------------------------------------------------------------- //

    /**
     * Build the URL to send the user to.
     *
     * <p>Checks that tokens can be stored <em>before</em> redirecting. The
     * alternative is asking someone to grant calendar access and only then
     * discovering we cannot keep the result — leaving Recallix holding a live
     * grant it immediately throws away.
     */
    public String authorizationUrl(String userId, String providerKey, String returnTo) {
        OAuthProvider provider = providers.require(providerKey);
        if (!cipher.isConfigured()) {
            throw ApiException.badRequest(
                    "Calendar connections are not configured on this server");
        }

        String verifier = states.newCodeVerifier();
        String state = states.create(userId, provider.key(), verifier, returnTo);

        Map<String, String> params = new LinkedHashMap<>();
        params.put("client_id", provider.clientId());
        params.put("redirect_uri", redirectUri(provider.key()));
        params.put("response_type", "code");
        params.put("scope", String.join(" ", provider.scopes()));
        params.put("state", state);
        params.put("code_challenge", OAuthStateStore.codeChallenge(verifier));
        params.put("code_challenge_method", "S256");
        params.putAll(provider.extraAuthorizationParams());

        return provider.authorizationEndpoint() + "?" + form(params);
    }

    // --- callback ------------------------------------------------------------- //

    /**
     * Finish the flow.
     *
     * @return where to send the browser afterwards
     */
    @Transactional
    public String completeCallback(String providerKey, String code, String state, String error) {
        OAuthStateStore.Pending pending = states.consume(state);

        // The provider tells us which flow this was; the URL is only a hint and
        // a mismatch means the callback was not the one we started.
        if (!pending.provider().equals(providerKey)) {
            throw ApiException.badRequest("Calendar connection did not match the request");
        }
        if (error != null && !error.isBlank()) {
            // access_denied is a user pressing "cancel", not a fault.
            log.info("Calendar OAuth declined for provider {}: {}", providerKey, error);
            return frontendReturn(pending.returnTo(), "declined");
        }
        if (code == null || code.isBlank()) {
            throw ApiException.badRequest("Calendar connection returned no authorization code");
        }

        OAuthProvider provider = providers.require(providerKey);
        JsonNode token = exchange(provider, code, pending.codeVerifier());

        String accessToken = text(token, "access_token");
        String refreshToken = text(token, "refresh_token");
        if (accessToken == null) {
            throw ApiException.badRequest("Calendar connection returned no access token");
        }
        if (refreshToken == null) {
            // See the class javadoc: this is the failure that otherwise appears
            // an hour later as "the calendar just stopped syncing".
            log.warn("Provider {} returned no refresh token; refusing to store a connection "
                    + "that would expire within the hour", providerKey);
            throw ApiException.badRequest(
                    "That provider did not grant offline access, so the connection would stop "
                            + "working within the hour. Please remove Recallix from your account's "
                            + "connected apps and try again.");
        }

        long expiresIn = token.path("expires_in").asLong(3600);
        String identity = identify(provider, accessToken);
        String email = identity.isBlank() ? null : identity;

        // Reconnecting the same account updates it rather than duplicating.
        CalendarAccount account = accounts
                .findByUserIdAndProviderAndExternalAccountId(pending.userId(), provider.key(), identity)
                .orElseGet(() -> {
                    CalendarAccount fresh = new CalendarAccount();
                    fresh.setId(IdGenerator.generate("cal_"));
                    fresh.setUserId(pending.userId());
                    fresh.setProvider(provider.key());
                    fresh.setExternalAccountId(identity);
                    return fresh;
                });

        account.setAccountEmail(email);
        account.setAccessTokenEnc(cipher.encrypt(accessToken));
        account.setRefreshTokenEnc(cipher.encrypt(refreshToken));
        account.setAccessExpiresAt(Instant.now().plusSeconds(expiresIn));
        account.setScopes(provider.scopes());
        account.setLastError(null);
        accounts.save(account);

        audit.record(pending.userId(), "CALENDAR_OAUTH_CONNECTED", "calendar", account.getId());
        return frontendReturn(pending.returnTo(), "connected");
    }

    // --- tokens --------------------------------------------------------------- //

    /**
     * A usable access token for this account, refreshing if needed.
     *
     * <p>Refresh failures are recorded on the row and rethrown. A revoked grant
     * never recovers by retrying, so it is parked rather than retried into a
     * rate limit.
     */
    @Transactional
    public String freshAccessToken(CalendarAccount account) {
        if (!account.accessTokenExpired()) {
            return cipher.decrypt(account.getAccessTokenEnc());
        }
        OAuthProvider provider = providers.require(account.getProvider());
        String refreshToken = cipher.decrypt(account.getRefreshTokenEnc());
        if (refreshToken == null) {
            throw ApiException.badRequest("This calendar needs reconnecting");
        }

        Map<String, String> body = new LinkedHashMap<>();
        body.put("client_id", provider.clientId());
        body.put("client_secret", provider.clientSecret());
        body.put("grant_type", "refresh_token");
        body.put("refresh_token", refreshToken);

        JsonNode token;
        try {
            token = postForm(provider.tokenEndpoint(), body);
        } catch (ApiException e) {
            account.setLastError(shortMessage(e.getMessage()));
            accounts.save(account);
            throw e;
        }

        String accessToken = text(token, "access_token");
        if (accessToken == null) {
            account.setLastError("The provider refused to refresh this connection");
            accounts.save(account);
            throw ApiException.badRequest(
                    "That calendar connection was revoked. Please reconnect it.");
        }

        account.setAccessTokenEnc(cipher.encrypt(accessToken));
        account.setAccessExpiresAt(Instant.now().plusSeconds(token.path("expires_in").asLong(3600)));
        // Google usually omits refresh_token on refresh; Microsoft rotates it.
        // Keeping the old one when none is returned is required for Google and
        // harmless for Microsoft.
        String rotated = text(token, "refresh_token");
        if (rotated != null) {
            account.setRefreshTokenEnc(cipher.encrypt(rotated));
        }
        account.setLastError(null);
        accounts.save(account);
        return accessToken;
    }

    // --- accounts ------------------------------------------------------------- //

    @Transactional(readOnly = true)
    public List<CalendarAccount> accountsFor(String userId) {
        return accounts.findByUserIdOrderByCreatedAtAsc(userId);
    }

    @Transactional
    public void disconnect(String userId, String id) {
        CalendarAccount account = accounts.findByIdAndUserId(id, userId)
                .orElseThrow(() -> ApiException.notFound("Calendar not found"));
        accounts.delete(account);
        audit.record(userId, "CALENDAR_OAUTH_DISCONNECTED", "calendar", id);
    }

    // --- http ----------------------------------------------------------------- //

    private JsonNode exchange(OAuthProvider provider, String code, String verifier) {
        Map<String, String> body = new LinkedHashMap<>();
        body.put("client_id", provider.clientId());
        body.put("client_secret", provider.clientSecret());
        body.put("code", code);
        body.put("grant_type", "authorization_code");
        body.put("redirect_uri", redirectUri(provider.key()));
        body.put("code_verifier", verifier);
        return postForm(provider.tokenEndpoint(), body);
    }

    /**
     * Who this token belongs to.
     *
     * <p>Used as the account's stable identity so reconnecting updates rather
     * than duplicates. Falls back to the raw subject when the email is absent —
     * Microsoft work accounts sometimes expose only {@code userPrincipalName}.
     */
    private String identify(OAuthProvider provider, String accessToken) {
        String url = CalendarProviders.GOOGLE.equals(provider.key())
                ? "https://www.googleapis.com/oauth2/v3/userinfo"
                : "https://graph.microsoft.com/v1.0/me";
        try {
            HttpRequest request = HttpRequest.newBuilder(URI.create(url))
                    .timeout(Duration.ofSeconds(15))
                    .header("Authorization", "Bearer " + accessToken)
                    .header("Accept", "application/json")
                    .GET().build();
            HttpResponse<String> response = http.send(request, HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() != 200) {
                return "";
            }
            JsonNode node = mapper.readTree(response.body());
            for (String field : List.of("email", "mail", "userPrincipalName", "sub", "id")) {
                String value = text(node, field);
                if (value != null && !value.isBlank()) {
                    return value;
                }
            }
            return "";
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return "";
        } catch (Exception e) {
            log.warn("Could not identify {} account: {}", provider.key(), e.toString());
            return "";
        }
    }

    private JsonNode postForm(String url, Map<String, String> body) {
        HttpRequest request = HttpRequest.newBuilder(URI.create(url))
                .timeout(Duration.ofSeconds(20))
                .header("Content-Type", "application/x-www-form-urlencoded")
                .header("Accept", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(form(body)))
                .build();
        try {
            HttpResponse<String> response = http.send(request, HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() != 200) {
                // The body of a token error can echo request parameters, so only
                // the provider's error code is surfaced — never the raw body.
                String detail = errorCode(response.body());
                throw ApiException.badRequest("The calendar provider rejected the connection ("
                        + detail + ")");
            }
            return mapper.readTree(response.body());
        } catch (ApiException e) {
            throw e;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw ApiException.badRequest("The calendar connection was interrupted");
        } catch (Exception e) {
            throw ApiException.badRequest("Could not reach the calendar provider");
        }
    }

    private String errorCode(String body) {
        try {
            String code = text(mapper.readTree(body), "error");
            return code == null ? "unknown error" : code;
        } catch (Exception e) {
            return "unknown error";
        }
    }

    private String frontendReturn(String returnTo, String outcome) {
        // Only ever a path on our own frontend: an attacker-supplied absolute URL
        // here would turn this endpoint into an open redirect.
        String path = (returnTo != null && returnTo.startsWith("/") && !returnTo.startsWith("//"))
                ? returnTo
                : "/calendar";
        return path + (path.contains("?") ? "&" : "?") + "calendar=" + outcome;
    }

    private static String form(Map<String, String> params) {
        StringBuilder out = new StringBuilder();
        for (Map.Entry<String, String> e : params.entrySet()) {
            if (out.length() > 0) {
                out.append('&');
            }
            out.append(URLEncoder.encode(e.getKey(), StandardCharsets.UTF_8))
                    .append('=')
                    .append(URLEncoder.encode(e.getValue(), StandardCharsets.UTF_8));
        }
        return out.toString();
    }

    private static String text(JsonNode node, String field) {
        JsonNode value = node.get(field);
        return value == null || value.isNull() ? null : value.asText();
    }

    private static String shortMessage(String message) {
        if (message == null || message.isBlank()) {
            return "Refresh failed";
        }
        return message.length() > 200 ? message.substring(0, 200) + "…" : message;
    }

    /** Providers offered to the UI, so it never shows a button that cannot work. */
    public List<OAuthProvider> availableProviders() {
        return cipher.isConfigured() ? providers.configured() : List.of();
    }

    /** Exposed for the account listing. */
    public Optional<CalendarAccount> find(String userId, String id) {
        return accounts.findByIdAndUserId(id, userId);
    }
}
