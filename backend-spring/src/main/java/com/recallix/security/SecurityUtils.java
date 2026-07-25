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
}
