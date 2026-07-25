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
            String clerkUserId = resolveSubject(request);
            if (clerkUserId != null && !clerkUserId.isBlank()) {
                String localUserId = userService.provision(clerkUserId, extractEmail(request));
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

    private String resolveSubject(HttpServletRequest request) {
        if ("clerk".equalsIgnoreCase(authMode)) {
            String header = request.getHeader("Authorization");
            if (header == null || !header.startsWith("Bearer ")) {
                return null;
            }
            Jwt jwt = decoder().decode(header.substring(7));
            return jwt.getSubject();
        }
        // dev mode
        String devUser = request.getHeader("X-Dev-User");
        return (devUser == null || devUser.isBlank()) ? DEV_FALLBACK_USER : devUser;
    }

    private String extractEmail(HttpServletRequest request) {
        String email = request.getHeader("X-Dev-Email");
        return (email == null || email.isBlank()) ? null : email;
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
