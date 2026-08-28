package com.orion.security;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;

/**
 * Establishes — and, more importantly, tears down — the tenant for each request.
 *
 * <p>Runs outermost so its {@code finally} is the last thing to execute. Request
 * threads are pooled: a tenant left on a thread is inherited by whoever it
 * serves next, so clearing has to be guaranteed even when a handler throws.
 * {@link AuthenticationFilter} sets the user id inside this; all this filter
 * does is bracket it and mark the few paths that have no user at all.
 *
 * <p>System paths are marked here rather than in each controller because the
 * decision is about the route, and because a controller that forgets would fail
 * closed in a confusing way — an internal callback silently writing nothing.
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
public class TenantFilter extends OncePerRequestFilter {

    /**
     * Routes with no authenticated user, which therefore run with policies
     * bypassed.
     *
     * <ul>
     *   <li>{@code /internal/**} — worker callbacks, keyed by meeting rather
     *       than by user, and already guarded by {@link InternalTokenFilter}.</li>
     * </ul>
     *
     * <p>There were three. {@code /public/**} carried the calendar feed and then
     * share links, where an unguessable token in the URL was the only
     * credential; both features are gone (V48, V50) and the prefix is no longer
     * exempt or even permitted — a path that resolves without a session should
     * exist because something serves it, not because something used to. The
     * Stripe webhook went with billing in V49.
     */
    private static boolean isSystemPath(String path) {
        return path.startsWith("/internal/");
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
                                    FilterChain chain) throws ServletException, IOException {
        try {
            if (isSystemPath(request.getRequestURI())) {
                TenantContext.runAsSystem(() -> {
                    try {
                        chain.doFilter(request, response);
                    } catch (Exception e) {
                        throw new FilterFailure(e);
                    }
                });
            } else {
                chain.doFilter(request, response);
            }
        } catch (FilterFailure e) {
            Throwable cause = e.getCause();
            if (cause instanceof IOException io) throw io;
            if (cause instanceof ServletException se) throw se;
            throw new ServletException(cause);
        } finally {
            // The single most important line here. Everything else is setup.
            TenantContext.clear();
        }
    }

    /** Carries a checked exception out of the Runnable the helper takes. */
    private static final class FilterFailure extends RuntimeException {
        FilterFailure(Throwable cause) {
            super(cause);
        }
    }
}
