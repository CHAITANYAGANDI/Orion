package com.recallix.service.calendar;

import java.util.List;

/**
 * Everything that differs between Google and Microsoft, and nothing that does not.
 *
 * <p>The two are the same OAuth 2.0 authorization-code flow with different URLs
 * and a handful of vendor quirks, so the quirks live here as data and the flow
 * itself is written once in {@code CalendarOAuthService}. The quirks are the
 * interesting part:
 *
 * <ul>
 *   <li><b>Google</b> returns a refresh token <em>only</em> on the first consent,
 *       unless {@code access_type=offline} and {@code prompt=consent} are both
 *       sent. Omit them and everything works in testing — you have a valid access
 *       token — and then stops an hour later with nothing to refresh from.</li>
 *   <li><b>Microsoft</b> issues a refresh token only when {@code offline_access}
 *       is among the scopes, and fails the same silent way.</li>
 * </ul>
 *
 * <p>Both are handled by asking each provider for its own authorization
 * parameters rather than assuming a shared shape.
 */
public interface OAuthProvider {

    /** Stable key used in URLs and stored on the account row. */
    String key();

    /** Human name, for the connect button and error messages. */
    String displayName();

    /** Where the user is sent to consent. */
    String authorizationEndpoint();

    /** Where codes and refresh tokens are exchanged. */
    String tokenEndpoint();

    /** Scopes requested. Read-only calendar access, plus whatever the provider needs to refresh. */
    List<String> scopes();

    /**
     * Extra authorization-request parameters this provider needs to return a
     * refresh token. See the class javadoc — these are not optional niceties.
     */
    java.util.Map<String, String> extraAuthorizationParams();

    /** True once a client id and secret are configured for this provider. */
    boolean isConfigured();

    String clientId();

    String clientSecret();
}
