// Framework-agnostic auth state, readable from non-React code (RTK Query
// prepareHeaders). Kept in sync by the React AuthProvider in lib/auth.tsx.

export type AuthMode = "dev" | "clerk";

/**
 * Which of the two the browser is running under.
 *
 * <p><b>It fails closed.</b> This used to read "clerk if the variable says
 * clerk, otherwise dev" — so an unset, misspelt or empty
 * `NEXT_PUBLIC_AUTH_MODE` silently put the app into the mode that trusts an
 * `X-Dev-User` header, which is an authentication bypass reachable by anyone
 * who can send a header. A build arg that failed to reach the image was one
 * typo away from that.
 *
 * <p>Now only the exact string `dev` selects dev mode, and everything else is
 * clerk. The worst a missing variable can do is refuse to let people in. The
 * same reversal is applied in middleware.ts and in AuthenticationFilter.
 */
export const AUTH_MODE: AuthMode =
  process.env.NEXT_PUBLIC_AUTH_MODE === "dev" ? "dev" : "clerk";

export const DEV_USER_KEY = "orion.devUserId";
export const DEFAULT_DEV_USER = "usr_dev";

/**
 * Where a second factor is actually switched on.
 *
 * Orion never sees a sign-in — it verifies a token Clerk issued — so it
 * cannot enrol a factor it will never be asked to check. This is the address of
 * the provider's own account page, and it is absent rather than guessed when
 * nobody set it: a "Set up" button pointing at a URL invented by a UI is a
 * security control that leads nowhere, which is worse than no button.
 */
export const ACCOUNT_PORTAL_URL = (process.env.NEXT_PUBLIC_ACCOUNT_PORTAL_URL ?? "").trim();

interface AuthStore {
  mode: AuthMode;
  devUserId: string;
  // In clerk mode, the AuthProvider registers a token getter here.
  tokenGetter: (() => Promise<string | null>) | null;
}

export const authStore: AuthStore = {
  mode: AUTH_MODE,
  devUserId: DEFAULT_DEV_USER,
  tokenGetter: null,
};

/* -------------------------------------------------------------------------- */
/*  Is this store ready to authenticate a request?                            */
/* -------------------------------------------------------------------------- */

/**
 * Subscribers watching for the token getter to arrive.
 *
 * <p>The bug this exists for: `tokenGetter` is registered by the React bridge
 * in an effect, and effects run *after* the tree below them has mounted. Every
 * RTK Query hook in the app fires on mount, so on a hard refresh the first
 * request of each one was built before this field was set -- `buildAuthHeaders`
 * found `null`, sent no Authorization header, and the API answered 401.
 *
 * <p>It looked intermittent because it is a race: with a warm Clerk session the
 * effect sometimes won. It reproduced reliably on a hard refresh, which is
 * exactly when Clerk has the most work to do before it can hand over a token.
 *
 * <p>Retrying is the wrong fix -- it turns one 401 into two requests and still
 * shows an error state first. Nothing authenticated should be asked for until
 * this is ready, so readiness has to be observable from React. Same
 * module-store + `useSyncExternalStore` idiom as lib/processing-jobs.ts.
 */
const readyListeners = new Set<() => void>();

/**
 * Whether an authenticated request can be built right now.
 *
 * <p>Dev mode is always ready: `devUserId` is hydrated at module load, above,
 * so its header exists before any component renders. Clerk mode is ready only
 * once the bridge has handed over a getter.
 */
export function isAuthReady(): boolean {
  return authStore.mode === "dev" || authStore.tokenGetter !== null;
}

/** For `useSyncExternalStore`. Returns an unsubscribe. */
export function subscribeAuthReady(listener: () => void): () => void {
  readyListeners.add(listener);
  return () => {
    readyListeners.delete(listener);
  };
}

/**
 * Register (or clear) the Clerk token getter and wake anything waiting.
 *
 * <p>Assigning to `authStore.tokenGetter` directly still works and is what the
 * dev path does not need; this exists so the assignment cannot happen without
 * the notification, which is the half that was missing.
 */
export function setTokenGetter(getter: (() => Promise<string | null>) | null): void {
  if (authStore.tokenGetter === getter) return;
  authStore.tokenGetter = getter;
  for (const listener of readyListeners) listener();
}

// Hydrate the dev user id from localStorage as early as possible (client only).
if (typeof window !== "undefined" && AUTH_MODE === "dev") {
  try {
    const stored = window.localStorage.getItem(DEV_USER_KEY);
    if (stored) authStore.devUserId = stored;
  } catch {
    /* ignore storage errors */
  }
}

/** Headers attached to every Spring `/api/v1/**` request. */
export async function buildAuthHeaders(): Promise<Record<string, string>> {
  if (authStore.mode === "clerk") {
    try {
      const token = authStore.tokenGetter
        ? await authStore.tokenGetter()
        : null;
      if (token) return { Authorization: `Bearer ${token}` };
    } catch {
      /* fall through — request will 401 and surface an error state */
    }
    return {};
  }
  // dev mode
  return { "X-Dev-User": authStore.devUserId || DEFAULT_DEV_USER };
}
