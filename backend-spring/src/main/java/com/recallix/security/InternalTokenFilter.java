package com.recallix.security;

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
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.List;

/**
 * Authenticates FastAPI -> Spring callbacks on {@code /internal/**} using the
 * shared {@code X-Internal-Token} header (NOT a Clerk JWT). Requests with a
 * missing/invalid token are rejected with 401.
 *
 * <h2>Why an unset token closes the door rather than opening it</h2>
 *
 * <p>This used to default to the literal string {@code dev-internal-token},
 * which is committed to this repository and printed in the deployment docs.
 * That made a deployment which never set {@code RECALLIX_INTERNAL_TOKEN} look
 * exactly like one that did: healthy, quiet, and accepting result callbacks
 * from anybody who had read the source.
 *
 * <p>What those callbacks do is the reason it matters. {@code /internal/**} is
 * how a transcript, a summary and a status arrive — a forged one can overwrite
 * a meeting's contents or mark it READY with whatever it likes, without ever
 * touching a user session.
 *
 * <p>So blank now means <em>refuse everything</em>. The local stack still works
 * because docker-compose supplies the development token explicitly; what
 * changed is that supplying nothing is no longer the same as supplying the
 * password everyone knows. A deployment that forgets it gets 401s in the
 * ai-service logs and a queue of meetings that never leave PROCESSING, which is
 * loud, harmless and traceable in a way that silent acceptance is not.
 */
@Component
public class InternalTokenFilter extends OncePerRequestFilter {

    private static final Logger log = LoggerFactory.getLogger(InternalTokenFilter.class);

    /** Blank when unconfigured, which {@link #doFilterInternal} treats as closed. */
    private final String internalToken;

    public InternalTokenFilter(@Value("${recallix.internal-token:}") String internalToken) {
        this.internalToken = internalToken == null ? "" : internalToken.trim();
        if (this.internalToken.isEmpty()) {
            log.warn("RECALLIX_INTERNAL_TOKEN is not set: every /internal/** callback "
                    + "will be refused. The ai-service cannot deliver transcripts or "
                    + "results until both services share a value.");
        }
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        return !request.getRequestURI().startsWith("/internal");
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
                                    FilterChain chain) throws ServletException, IOException {
        String token = request.getHeader("X-Internal-Token");
        // An unconfigured token matches nothing -- not even an empty header.
        // Checked before the comparison rather than relying on it, because
        // constant-time equality of two empty strings is true.
        if (internalToken.isEmpty() || token == null || !constantTimeEquals(token, internalToken)) {
            response.setStatus(HttpServletResponse.SC_UNAUTHORIZED);
            response.setContentType("application/json");
            response.getWriter().write("{\"status\":401,\"error\":\"UNAUTHORIZED\",\"message\":\"Invalid internal token\"}");
            return;
        }
        var auth = new UsernamePasswordAuthenticationToken(
                SecurityUtils.INTERNAL_PRINCIPAL, null,
                List.of(new SimpleGrantedAuthority("ROLE_INTERNAL")));
        SecurityContextHolder.getContext().setAuthentication(auth);
        chain.doFilter(request, response);
    }

    private static boolean constantTimeEquals(String a, String b) {
        if (a.length() != b.length()) {
            return false;
        }
        int result = 0;
        for (int i = 0; i < a.length(); i++) {
            result |= a.charAt(i) ^ b.charAt(i);
        }
        return result == 0;
    }
}
