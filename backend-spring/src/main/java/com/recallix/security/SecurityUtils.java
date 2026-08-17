package com.recallix.security;

import com.recallix.common.ApiException;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;

/** Helper to read the authenticated local user id from the security context. */
public final class SecurityUtils {

    public static final String INTERNAL_PRINCIPAL = "internal";

    private SecurityUtils() {
    }

    /** Local user id (usr_...) of the caller, or throws 401 if unauthenticated. */
    public static String currentUserId() {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        if (auth == null || !auth.isAuthenticated() || auth.getName() == null
                || INTERNAL_PRINCIPAL.equals(auth.getName())) {
            throw ApiException.unauthorized("Authentication required");
        }
        return auth.getName();
    }

    /**
     * What the caller's credential said about how they signed in.
     *
     * <p>Falls back to a dev session rather than throwing, because every caller
     * of this is describing the account to its owner: a settings page that
     * cannot render because the details were not attached is worse than one that
     * says the least alarming true thing.
     */
    public static SignInSecurity signInSecurity() {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        if (auth != null && auth.getDetails() instanceof SignInSecurity details) {
            return details;
        }
        return SignInSecurity.dev();
    }
}
