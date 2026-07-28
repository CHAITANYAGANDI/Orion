package com.recallix.security;

import java.util.concurrent.Callable;

/**
 * The tenant whose data the current thread may touch.
 *
 * <p>Read by {@link com.recallix.config.TenantAwareDataSource} when a pooled
 * connection is handed out, and turned into the Postgres settings that the
 * row-level security policies in V9 test against.
 *
 * <p>Fail-closed by design: with nothing set, {@link #currentUserId()} returns
 * an empty string, which matches no rows under any policy. Forgetting to
 * establish a tenant therefore denies access rather than granting it — the
 * opposite of the pre-RLS model, where forgetting an ownership check granted
 * access to everything.
 */
public final class TenantContext {

    private static final ThreadLocal<String> USER_ID = new ThreadLocal<>();
    private static final ThreadLocal<Boolean> SYSTEM = ThreadLocal.withInitial(() -> false);

    private TenantContext() {
    }

    public static void setUserId(String userId) {
        USER_ID.set(userId);
    }

    /** The authenticated user, or "" when there is none. Never null. */
    public static String currentUserId() {
        String userId = USER_ID.get();
        return userId == null ? "" : userId;
    }

    public static boolean isSystem() {
        return Boolean.TRUE.equals(SYSTEM.get());
    }

    /**
     * Run work that legitimately has no tenant, with policies bypassed.
     *
     * <p>Reserved for the handful of paths that cannot have a user: the
     * worker's internal callbacks (keyed by meeting, not user), the outbox
     * relay, Stripe webhooks, public share-link resolution, and provisioning a
     * user during authentication — which by definition runs before the tenant
     * is known.
     *
     * <p>Restores the previous state rather than clearing it, so nesting is
     * safe and an exception cannot leave a thread stuck in system context —
     * which, on a pooled request thread, would hand the next request full
     * access to every tenant.
     */
    public static <T> T asSystem(Callable<T> work) throws Exception {
        boolean previous = isSystem();
        SYSTEM.set(true);
        try {
            return work.call();
        } finally {
            SYSTEM.set(previous);
        }
    }

    /** {@link #asSystem(Callable)} for work that returns nothing. */
    public static void runAsSystem(Runnable work) {
        boolean previous = isSystem();
        SYSTEM.set(true);
        try {
            work.run();
        } finally {
            SYSTEM.set(previous);
        }
    }

    /**
     * Clear both values. Must run at the end of every request: request threads
     * are pooled, and a leftover tenant would be inherited by whoever the
     * thread serves next.
     */
    public static void clear() {
        USER_ID.remove();
        SYSTEM.remove();
    }
}
