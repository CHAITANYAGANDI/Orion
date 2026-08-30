package com.orion.config;

import jakarta.annotation.PostConstruct;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Profile;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * Refuses to start a production deployment that is still wearing development
 * settings.
 *
 * <h2>Why a startup check and not a default</h2>
 *
 * <p>Every value below has a development default that is correct on a laptop
 * and wrong on the internet: an auth mode that trusts a header, a shared secret
 * printed in this repository, a CORS origin of {@code http://localhost:3000}.
 * Tightening the defaults themselves is not available — the local stack is the
 * reason they exist, and breaking it to protect a deployment that has not
 * happened yet trades a real cost for a hypothetical one.
 *
 * <p>What makes them dangerous is not their value but their silence. Each one
 * fails in a way that looks like success: the app starts, the health check
 * passes, pages render. {@code ORION_AUTH_MODE} unset serves every request
 * as whoever asks. {@code APP_FRONTEND_URL} unset blocks every browser request
 * at CORS, which reads as "the API is down". Nothing announces itself, so the
 * announcement has to be built.
 *
 * <p>So the mode declares itself instead. Under the {@code production} profile
 * — set by {@code render.yaml} and by nothing else — a development-shaped value
 * is a startup failure with a named cause, before the first request is served.
 * A deployment that cannot boot is a bad ten minutes; a deployment that boots
 * open is a bad quarter.
 *
 * <h2>Why all of them at once</h2>
 *
 * <p>The problems are collected and reported together rather than thrown one at
 * a time. Fixing a misconfigured deploy one restart per variable, each cycle
 * revealing the next thing wrong, is how a checklist becomes an afternoon.
 */
@Component
@Profile("production")
public class DeploymentCheck {

    private static final Logger log = LoggerFactory.getLogger(DeploymentCheck.class);

    /**
     * The token that used to be the default. Named here so that a deployment
     * which copied it out of the old compose file is caught rather than
     * trusted; {@link com.orion.security.InternalTokenFilter} no longer has
     * a default at all, but the string is still out there in shells and notes.
     */
    private static final String PUBLISHED_TOKEN = "dev-internal-token";

    /** Hosts that mean "this machine", none of which a browser can reach. */
    private static final List<String> LOCAL_HOSTS =
            List.of("localhost", "127.0.0.1", "0.0.0.0", "::1", "host.docker.internal");

    /**
     * What a transaction-mode connection pooler looks like in a JDBC URL.
     *
     * <p>Neon spells it in the host — {@code ep-xxx-pooler.region.aws.neon.tech}
     * — and Supabase and others take a {@code pgbouncer=true} parameter. Both
     * are the same thing for this purpose: a pooler that reassigns the server
     * connection between transactions.
     */
    private static final List<String> POOLER_MARKERS = List.of("-pooler", "pgbouncer=true");

    private final String authMode;
    private final String issuer;
    private final String jwksUrl;
    private final String internalToken;
    private final String frontendUrl;
    private final String publicUrl;
    private final String aiServiceUrl;
    private final String datasourceUrl;

    public DeploymentCheck(
            @Value("${orion.auth-mode:clerk}") String authMode,
            @Value("${orion.clerk.issuer:}") String issuer,
            @Value("${orion.clerk.jwks-url:}") String jwksUrl,
            @Value("${orion.internal-token:}") String internalToken,
            @Value("${app.frontend-url:}") String frontendUrl,
            @Value("${app.public-url:}") String publicUrl,
            @Value("${app.ai-service-url:}") String aiServiceUrl,
            @Value("${spring.datasource.url:}") String datasourceUrl) {
        this.authMode = authMode;
        this.issuer = issuer;
        this.jwksUrl = jwksUrl;
        this.internalToken = internalToken;
        this.frontendUrl = frontendUrl;
        this.publicUrl = publicUrl;
        this.aiServiceUrl = aiServiceUrl;
        this.datasourceUrl = datasourceUrl;
    }

    @PostConstruct
    void check() {
        warnings().forEach(log::warn);
        List<String> problems = problems();
        if (problems.isEmpty()) {
            log.info("Production configuration check passed.");
            return;
        }
        throw new IllegalStateException(
                "This deployment is running with the `production` profile but still holds "
                        + problems.size() + " development setting(s). Fix these and redeploy:"
                        + System.lineSeparator()
                        + "  - " + String.join(System.lineSeparator() + "  - ", problems));
    }

    /**
     * Everything that must be true before this is safe to expose.
     *
     * <p>Package-private and pure so the list can be asserted directly. A check
     * that can only be exercised by starting an application context is a check
     * nobody adds a case to.
     */
    List<String> problems() {
        List<String> problems = new ArrayList<>();

        if (!"clerk".equalsIgnoreCase(trim(authMode))) {
            // The only one of these that is an open door rather than a broken
            // feature, so it is stated as what an attacker gets, not as what is
            // misconfigured.
            problems.add("ORION_AUTH_MODE is '" + trim(authMode) + "', not 'clerk'. "
                    + "Any request could impersonate any user with an X-Dev-User header.");
        } else {
            // Only meaningful in clerk mode: dev mode has no JWKS and is not
            // supposed to. Reported inside the else so a dev-mode deployment
            // gets one clear problem instead of three confusing ones.
            if (trim(jwksUrl).isEmpty()) {
                problems.add("CLERK_JWKS_URL is not set. Tokens cannot be verified, so every "
                        + "signed-in request will fail once the app is already serving traffic.");
            }
            if (trim(issuer).isEmpty()) {
                problems.add("CLERK_ISSUER is not set.");
            }
        }

        String token = trim(internalToken);
        if (token.isEmpty()) {
            problems.add("ORION_INTERNAL_TOKEN is not set. The ai-service cannot deliver "
                    + "transcripts or results, and meetings will never leave PROCESSING.");
        } else if (PUBLISHED_TOKEN.equals(token)) {
            problems.add("ORION_INTERNAL_TOKEN is the published development value. "
                    + "Anyone who has read this repository could forge a result callback.");
        }

        problems.addAll(urlProblem("APP_FRONTEND_URL", frontendUrl, true,
                "It is the single allowed CORS origin and the STOMP allowed origin, so a wrong "
                        + "value blocks every browser request and every socket."));
        problems.addAll(urlProblem("APP_PUBLIC_URL", publicUrl, true,
                "Calendar feeds are fetched by Google's and Apple's servers, which cannot "
                        + "resolve a private address."));

        if (trim(aiServiceUrl).isEmpty()) {
            problems.add("AI_SERVICE_URL is not set. Nothing can be transcribed or summarised.");
        }

        problems.addAll(poolerProblem());
        // Deliberately not checked for a scheme, unlike the two above. It names
        // a private service on the internal network, so there is exactly one
        // thing a missing scheme can mean and AiClient repairs it rather than
        // refusing -- see the note there. The public URLs get no such repair,
        // because http and https are both plausible and guessing wrong on those
        // is worse than stopping.

        return problems;
    }

    /**
     * The runtime must not reach Postgres through a transaction-mode pooler.
     *
     * <h2>What goes wrong</h2>
     *
     * <p>Row-level security is armed per connection: {@link TenantAwareDataSource}
     * runs {@code set_config('app.user_id', ?, false)} as each pooled connection
     * is handed out, and every policy in V9 tests what that set. The {@code
     * false} makes it <em>session</em>-level, which is correct for a connection
     * that belongs to this process — and wrong through a pooler that does not
     * keep sessions.
     *
     * <p>A transaction-mode pooler assigns a server connection per
     * <em>transaction</em>. The {@code set_config} lands on whichever backend
     * served it; the query that follows is a different transaction and may be
     * given a different backend, where {@code app.user_id} was never set. RLS
     * then matches nothing, and — this is the part that cost four days — that
     * is not an error. It is a 200 with an empty list and a perfectly ordinary
     * 404:
     *
     * <ul>
     *   <li>{@code GET /meetings} answers "you have no conversations",</li>
     *   <li>{@code GET /projects} answers "you have no folders",</li>
     *   <li>{@code GET /meetings/{id}} and {@code /transcript} answer 404,</li>
     * </ul>
     *
     * <p>each of them intermittently, per request, to an account that is
     * perfectly intact — because whether a given request works depends on which
     * backend the pooler happened to give it. Reloading re-rolls it, which is
     * why reloading "fixes" it.
     *
     * <p>And the same mechanism runs the other way: a backend still carrying a
     * previous borrower's {@code app.user_id} answers <em>this</em> request with
     * <em>that</em> tenant's rows. Nothing in the application can detect either
     * case, because from here both are the database answering honestly.
     *
     * <h2>Why refusing to start</h2>
     *
     * <p>Because the failure is silent and looks like data loss to the person
     * using it. The direct endpoint is the same host with {@code -pooler}
     * removed, and Hikari is already the connection pool this process needs.
     */
    List<String> poolerProblem() {
        String url = trim(datasourceUrl).toLowerCase(Locale.ROOT);
        boolean pooled = POOLER_MARKERS.stream().anyMatch(url::contains);
        if (!pooled) {
            return List.of();
        }
        // ASCII only: the build sets no source encoding, so a non-ASCII
        // character in a literal is decoded with whatever the platform
        // default happens to be.
        return List.of("SPRING_DATASOURCE_URL goes through a transaction-mode connection "
                + "pooler. Row-level security is armed with a session-level setting on each "
                + "connection, and such a pooler gives the next transaction a different "
                + "server connection, where that setting was never made. Requests are then "
                + "answered with no tenant - an intact account that reads as empty: no "
                + "conversations, no folders, 404 on a meeting - or with the previous "
                + "borrower's rows. Point the runtime at the DIRECT endpoint: the same host "
                + "with `-pooler` removed, which is what FLYWAY_URL already uses.");
    }

    /**
     * Things worth saying out loud that are not worth refusing to start over.
     *
     * <p>The line between the two is whether a reasonable deployment could
     * legitimately look like this. A staging environment on a Clerk development
     * instance is reasonable; a production one is a mistake — and this cannot
     * tell them apart, so it says so and steps aside.
     */
    List<String> warnings() {
        List<String> warnings = new ArrayList<>();
        String where = trim(issuer) + " " + trim(jwksUrl);
        if (where.contains(".accounts.dev")) {
            warnings.add("Clerk is configured against a DEVELOPMENT instance (.accounts.dev). "
                    + "Development instances have relaxed session handling, no custom domain, "
                    + "and their own user list -- real users signing in here will not exist in "
                    + "your production instance. Create a production instance and update "
                    + "CLERK_ISSUER, CLERK_JWKS_URL and NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY.");
        }
        return warnings;
    }

    /**
     * @param mustBePublic whether the URL is one somebody else's machine has to
     *     reach — which is what makes a loopback address a failure rather than
     *     a preference
     */
    private static List<String> urlProblem(String name, String value, boolean mustBePublic, String why) {
        String url = trim(value);
        if (url.isEmpty()) {
            return List.of(name + " is not set. " + why);
        }
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            // Render's blueprint cannot express a scheme: `fromService` yields
            // a bare host, and a bare host is not an origin. This is the single
            // most likely way to get here, so the message says the fix.
            return List.of(name + " is '" + url + "', which has no scheme. "
                    + "It must be an absolute URL, e.g. https://" + url + ". " + why);
        }
        if (mustBePublic && isLocal(url)) {
            return List.of(name + " points at " + url + ", which only this container can reach. " + why);
        }
        return List.of();
    }

    private static boolean isLocal(String url) {
        String host = url.substring(url.indexOf("://") + 3);
        int slash = host.indexOf('/');
        if (slash >= 0) {
            host = host.substring(0, slash);
        }
        // An IPv6 literal is bracketed in a URL and contains the same character
        // the port is separated by, so the brackets have to go first or the
        // port-stripping below eats half the address.
        if (host.startsWith("[")) {
            int close = host.indexOf(']');
            host = close > 0 ? host.substring(1, close) : host.substring(1);
        } else {
            int colon = host.lastIndexOf(':');
            if (colon > 0) {
                host = host.substring(0, colon);
            }
        }
        String lower = host.toLowerCase(Locale.ROOT);
        return LOCAL_HOSTS.contains(lower);
    }

    private static String trim(String value) {
        return value == null ? "" : value.trim();
    }
}
