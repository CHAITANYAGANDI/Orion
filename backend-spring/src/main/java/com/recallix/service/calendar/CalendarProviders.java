package com.recallix.service.calendar;

import com.recallix.common.ApiException;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Configuration;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The two supported calendar providers, configured from the environment.
 *
 * <p>A provider with no client id is simply absent from {@link #configured()},
 * so a deployment can ship Google only, Microsoft only, or neither, without a
 * code change and without the UI offering a button that cannot work.
 */
@Configuration
public class CalendarProviders {

    public static final String GOOGLE = "google";
    public static final String MICROSOFT = "microsoft";

    private final Map<String, OAuthProvider> byKey = new LinkedHashMap<>();

    public CalendarProviders(
            @Value("${recallix.oauth.google.client-id:}") String googleId,
            @Value("${recallix.oauth.google.client-secret:}") String googleSecret,
            @Value("${recallix.oauth.microsoft.client-id:}") String msId,
            @Value("${recallix.oauth.microsoft.client-secret:}") String msSecret,
            // Personal Microsoft accounts and work/school accounts live behind
            // different tenants. "common" accepts both, which is what a consumer
            // product wants; a single-tenant deployment overrides it.
            @Value("${recallix.oauth.microsoft.tenant:common}") String msTenant) {

        byKey.put(GOOGLE, new SimpleProvider(
                GOOGLE, "Google Calendar",
                "https://accounts.google.com/o/oauth2/v2/auth",
                "https://oauth2.googleapis.com/token",
                List.of("https://www.googleapis.com/auth/calendar.readonly",
                        "https://www.googleapis.com/auth/userinfo.email",
                        "openid"),
                Map.of(
                        // Without offline access Google returns no refresh token
                        // at all, and the connection silently dies after an hour.
                        "access_type", "offline",
                        // And without this it returns one only on the very first
                        // consent ever given — so a user who reconnects, or who
                        // had connected before, gets none.
                        "prompt", "consent",
                        "include_granted_scopes", "true"),
                googleId, googleSecret));

        byKey.put(MICROSOFT, new SimpleProvider(
                MICROSOFT, "Microsoft Outlook",
                "https://login.microsoftonline.com/" + msTenant + "/oauth2/v2.0/authorize",
                "https://login.microsoftonline.com/" + msTenant + "/oauth2/v2.0/token",
                // offline_access is what produces a refresh token here.
                List.of("Calendars.Read", "User.Read", "offline_access"),
                Map.of(),
                msId, msSecret));
    }

    /** Only providers with credentials, in a stable order for the UI. */
    public List<OAuthProvider> configured() {
        return byKey.values().stream().filter(OAuthProvider::isConfigured).toList();
    }

    /**
     * Look up a provider by key, refusing unknown or unconfigured ones.
     *
     * <p>Rejecting an unconfigured provider here rather than mid-flow matters:
     * the alternative is redirecting the user to a provider, having them approve
     * access, and only then failing — which leaves Recallix holding a grant it
     * cannot use.
     */
    public OAuthProvider require(String key) {
        OAuthProvider provider = key == null ? null : byKey.get(key.toLowerCase(java.util.Locale.ROOT));
        if (provider == null) {
            throw ApiException.badRequest("Unknown calendar provider");
        }
        if (!provider.isConfigured()) {
            throw ApiException.badRequest(
                    provider.displayName() + " is not configured on this server");
        }
        return provider;
    }

    /** Immutable provider description. */
    private record SimpleProvider(
            String key,
            String displayName,
            String authorizationEndpoint,
            String tokenEndpoint,
            List<String> scopes,
            Map<String, String> extraAuthorizationParams,
            String clientId,
            String clientSecret
    ) implements OAuthProvider {

        @Override
        public boolean isConfigured() {
            return clientId != null && !clientId.isBlank()
                    && clientSecret != null && !clientSecret.isBlank();
        }
    }
}
