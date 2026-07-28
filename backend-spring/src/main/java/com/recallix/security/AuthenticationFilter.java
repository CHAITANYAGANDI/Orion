package com.recallix.security;

import com.recallix.service.UserService;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.NimbusJwtDecoder;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.List;

/**
 * Resolves the caller identity for `/api/v1/**`:
 * <ul>
 *   <li><b>dev</b> mode: trusts the {@code X-Dev-User} header (falls back to a
 *       fixed dev user so the stack runs with no Clerk account).</li>
 *   <li><b>clerk</b> mode: validates the Bearer JWT against Clerk's JWKS and
 *       uses {@code sub} as the Clerk user id.</li>
 * </ul>
 * On success it provisions a local user and stores the local user id as the
 * authentication principal. Non-API paths are skipped (see shouldNotFilter).
 */
@Component
public class AuthenticationFilter extends OncePerRequestFilter {

    private static final Logger log = LoggerFactory.getLogger(AuthenticationFilter.class);
    private static final String DEV_FALLBACK_USER = "dev-user";

    private final UserService userService;
    private final String authMode;
    private final String jwksUrl;

    private volatile JwtDecoder jwtDecoder;

    public AuthenticationFilter(UserService userService,
                                @Value("${recallix.auth-mode:dev}") String authMode,
                                @Value("${recallix.clerk.jwks-url:}") String jwksUrl) {
        this.userService = userService;
        this.authMode = authMode;
        this.jwksUrl = jwksUrl;
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        String path = request.getRequestURI();
        return !path.startsWith("/api/v1")
                || path.startsWith("/api/v1/billing/webhook");
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
                                    FilterChain chain) throws ServletException, IOException {
        try {
            Identity identity = resolveIdentity(request);
            String clerkUserId = identity.subject();
            if (clerkUserId != null && !clerkUserId.isBlank()) {
                // Provisioning looks the user up by clerk_user_id and may insert
                // a row — both before the local user id exists, so neither can
                // satisfy a tenant policy yet. This is the bootstrap case the
                // system context exists for.
                String localUserId = TenantContext.asSystem(
                        () -> userService.provision(clerkUserId, identity.email()));

                // From here on every connection this request borrows is stamped
                // with this user, and row-level security does the rest.
                TenantContext.setUserId(localUserId);

                var auth = new UsernamePasswordAuthenticationToken(
                        localUserId, null, List.of(new SimpleGrantedAuthority("ROLE_USER")));
                SecurityContextHolder.getContext().setAuthentication(auth);
            }
        } catch (Exception ex) {
            // Leave the context unauthenticated; the authorization layer returns 401.
            log.debug("Authentication resolution failed: {}", ex.getMessage());
            SecurityContextHolder.clearContext();
        }
        chain.doFilter(request, response);
    }

    /**
     * Claim names that may carry the address, in preference order. Clerk's
     * default session token has no email at all — it has to be added through a
     * JWT template — and which name it lands under depends on how that template
     * was written, so several spellings are accepted.
     */
    private static final List<String> EMAIL_CLAIMS = List.of(
            "email", "email_address", "primary_email_address", "primaryEmailAddress");

    /**
     * Resolve the caller and, where available, their email in a single decode.
     *
     * <p>The two are returned together because in clerk mode both come from the
     * same JWT: decoding twice would double the verification cost on every
     * request, and decoding once and discarding the email is what previously
     * left every Clerk-authenticated user with a null address — silently
     * disabling recap email in production while it worked fine in dev.
     */
    private record Identity(String subject, String email) {
    }

    private Identity resolveIdentity(HttpServletRequest request) {
        if ("clerk".equalsIgnoreCase(authMode)) {
            String header = request.getHeader("Authorization");
            if (header == null || !header.startsWith("Bearer ")) {
                return new Identity(null, null);
            }
            Jwt jwt = decoder().decode(header.substring(7));
            return new Identity(jwt.getSubject(), emailClaim(jwt));
        }
        // dev mode
        String devUser = request.getHeader("X-Dev-User");
        String subject = (devUser == null || devUser.isBlank()) ? DEV_FALLBACK_USER : devUser;
        String email = request.getHeader("X-Dev-Email");
        return new Identity(subject, (email == null || email.isBlank()) ? null : email);
    }

    private static String emailClaim(Jwt jwt) {
        for (String claim : EMAIL_CLAIMS) {
            Object value = jwt.getClaim(claim);
            if (value instanceof String s && !s.isBlank()) {
                return s.trim();
            }
        }
        // Not fatal: the user can still set a recap address by hand in Settings.
        // Logged because the usual cause is a missing Clerk JWT template claim,
        // which is invisible until somebody wonders why no email arrived.
        log.debug("No email claim on the Clerk token; add one to the JWT template "
                + "if recap email should work without manual entry.");
        return null;
    }

    private JwtDecoder decoder() {
        JwtDecoder local = jwtDecoder;
        if (local == null) {
            synchronized (this) {
                if (jwtDecoder == null) {
                    if (jwksUrl == null || jwksUrl.isBlank()) {
                        throw new IllegalStateException("clerk auth-mode requires CLERK_JWKS_URL");
                    }
                    jwtDecoder = NimbusJwtDecoder.withJwkSetUri(jwksUrl).build();
                }
                local = jwtDecoder;
            }
        }
        return local;
    }
}
