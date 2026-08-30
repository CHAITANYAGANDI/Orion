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

/**
 * How far along the app is in becoming usable for the session it is in.
 *
 * <h2>Why "a token exists" was not enough either</h2>
 *
 * <p>The previous version of this file fixed a real bug -- readiness used to
 * mean `tokenGetter !== null`, which a signed-out visitor on `/sign-in`
 * satisfied -- and left a second one behind, one layer up.
 *
 * <p>Two separate things had to be true before the authenticated app could be
 * shown, and only one of them was in this state machine. The other lived in a
 * passive effect in `SessionCacheGuard`, which cleared the previous tenant's
 * RTK Query cache. Two facts, two mechanisms, and no ordering between them
 * beyond where the components happened to sit in the tree -- so "the cache is
 * empty by the time children mount" was a property of sibling order rather
 * than a guarantee, and sibling order is not something a reviewer checks.
 *
 * <p>Worse, the two moved on different clocks. `sessionId` reaches the React
 * tree through context, which updates during <em>render</em>; readiness reaches
 * `AuthGate` through this store, which is written from ClerkBridge's
 * <em>effect</em> -- and a parent's effect runs after its children's. So there
 * is a commit in which the tree has already rendered under session B while this
 * store still reports session A as ready. In that commit the gate is open, the
 * authenticated subtree is mounted, and everything inside it is reading a cache
 * that belongs to somebody else.
 *
 * <p>So cache ownership is a fact about the session, and it lives here, beside
 * the token. `app-ready` is the single barrier, and it requires both.
 *
 * <ol>
 *   <li><b>loading</b> -- the Clerk SDK has not finished booting.</li>
 *   <li><b>signed-out</b> -- loaded, and there is no session.</li>
 *   <li><b>preparing-session</b> -- signed in; a token for <em>this</em>
 *       session is being fetched.</li>
 *   <li><b>token-ready</b> -- a usable token has been held in a hand, and the
 *       API cache still belongs to a previous session. Deliberately not enough
 *       on its own: this is the state the app used to mount in.</li>
 *   <li><b>app-ready</b> -- token proven <em>and</em> the cache owned by this
 *       session. The only state the gate opens on.</li>
 *   <li><b>failed</b> -- signed in, and no token could be obtained.</li>
 * </ol>
 */
export type AuthPhase =
  | "loading"
  | "signed-out"
  | "preparing-session"
  | "token-ready"
  | "app-ready"
  | "failed";

/** What the token half of the answer can be. `app-ready` is derived, not set. */
export type TokenStatus = "loading" | "signed-out" | "preparing-session" | "proven" | "failed";

interface AuthStore {
  mode: AuthMode;
  devUserId: string;
  /**
   * How to ask Clerk for a token, registered by the bridge.
   *
   * <p><b>No longer evidence of anything.</b> It says a function exists, which
   * was the original mistake.
   */
  tokenGetter: (() => Promise<string | null>) | null;
  /**
   * The generation everything else here is a statement about.
   *
   * <p>Clerk's session id in clerk mode; the dev user id in dev mode, which has
   * no sessions but does have a tenant that can be switched. One id, published
   * by whichever provider is running, so the token half and the cache half
   * cannot come to disagree about which sign-in they are talking about.
   */
  sessionId: string | null;
  status: TokenStatus;
  /**
   * The session the RTK Query cache belongs to.
   *
   * <p>`null` means nobody has claimed it -- a store that has never held an
   * authenticated response, which is every ordinary page load. Claiming an
   * unclaimed cache costs nothing and clears nothing; that is what stops a
   * cold start from wiping the queries it just started.
   */
  cacheSession: string | null;
}

/**
 * Dev mode's one tenant, known before anything renders.
 *
 * <p>The `X-Dev-User` header comes from a value hydrated at module load, so
 * there is genuinely nothing asynchronous to wait for -- and this is
 * deliberately not a fallback for Clerk being slow, which would be an
 * authentication bypass on a timer.
 */
const DEV_SESSION = "dev";

export const authStore: AuthStore = {
  mode: AUTH_MODE,
  devUserId: DEFAULT_DEV_USER,
  tokenGetter: null,
  sessionId: AUTH_MODE === "dev" ? DEV_SESSION : null,
  status: AUTH_MODE === "dev" ? "proven" : "loading",
  cacheSession: AUTH_MODE === "dev" ? DEV_SESSION : null,
};

/* -------------------------------------------------------------------------- */
/*  Is this store ready to authenticate a request?                            */
/* -------------------------------------------------------------------------- */

/**
 * Subscribers watching for readiness to change.
 *
 * <p>A module store plus `useSyncExternalStore` because the facts arrive from
 * an effect inside a provider and are read by components outside that tree, and
 * neither should have to know about the other.
 */
const readyListeners = new Set<() => void>();

function notify(): void {
  for (const listener of readyListeners) listener();
}

/** The whole answer, derived. See {@link AuthPhase}. */
export function authPhase(): AuthPhase {
  switch (authStore.status) {
    case "loading":
    case "signed-out":
    case "failed":
      return authStore.status;
    case "preparing-session":
      return "preparing-session";
    case "proven":
      /*
       * The barrier. A proven token is half of it; the other half is that the
       * cache in the store is this session's and not the last one's. Both, or
       * the app does not open.
       */
      return authStore.cacheSession === authStore.sessionId ? "app-ready" : "token-ready";
  }
}

/**
 * Whether the authenticated application may be shown right now.
 *
 * <p>One phase, and only one. `token-ready` in particular does not: that is
 * precisely the state in which the gate used to open over another session's
 * cache.
 */
export function isAuthReady(): boolean {
  return authPhase() === "app-ready";
}

/** The generation everything above is a statement about. */
export function currentSessionId(): string | null {
  return authStore.sessionId;
}

/** The session the API cache belongs to, or null if nobody has claimed it. */
export function cacheOwner(): string | null {
  return authStore.cacheSession;
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
 * <p>Kept as its own call, and deliberately not sufficient on its own. It
 * exists so `buildAuthHeaders` has something to call; whether that call will
 * succeed is what the phase answers.
 */
export function setTokenGetter(getter: (() => Promise<string | null>) | null): void {
  if (authStore.tokenGetter === getter) return;
  authStore.tokenGetter = getter;
  notify();
}

/**
 * Whether `next` should replace `current` for the <em>same</em> session.
 *
 * <p>The one interesting case is `preparing-session`. The bridge republishes it
 * on renders that have nothing to do with the session, and a proven session must
 * not be un-proven by a re-render -- that would close the gate under a working
 * app and start the probe again, repeatedly, for as long as the page is open.
 */
function supersedes(current: TokenStatus, next: TokenStatus): boolean {
  if (current === next) return false;
  if (next === "preparing-session" && (current === "proven" || current === "failed")) return false;
  return true;
}

/**
 * Publish what the active auth provider currently says.
 *
 * <p><b>A different session id is a different generation.</b> Signing out,
 * signing back in as the same person, another account signing in, a dev user
 * being switched, and Clerk being torn down and reinitialised all arrive here
 * as a changed `sessionId` (`null` for sign-out and for an unloaded SDK), and
 * every one of them drops the phase wholesale.
 *
 * <p>Cache ownership is deliberately <em>not</em> cleared here. It is a fact
 * about the store's contents, not about the session, and the whole point is
 * that it stays behind saying "this cache is still session A's" until somebody
 * has actually emptied it. Clearing it here would make the gate open on an
 * unclaimed cache the moment a token arrived.
 */
export function publishAuthState(next: { sessionId: string | null; phase: TokenStatus }): void {
  const sessionChanged = next.sessionId !== authStore.sessionId;
  if (!sessionChanged && !supersedes(authStore.status, next.phase)) return;
  authStore.sessionId = next.sessionId;
  authStore.status = next.phase;
  notify();
}

/**
 * Record what asking for a token actually produced.
 *
 * <h2>The async race this closes</h2>
 *
 * <pre>
 *   session A: getToken() ────────────────────────► resolves
 *   session B:        becomes current ─────────────────────►
 * </pre>
 *
 * <p>A's answer arrives after B is current, and it is an answer about A. Taking
 * it would open the app for B on the strength of A's credential -- a
 * tenant-isolation failure, not merely a stale flag. So the session id is
 * carried through the probe and checked on the way back, and a mismatch is
 * dropped without comment.
 */
export function resolveTokenProbe(sessionId: string, usable: boolean): void {
  if (sessionId !== authStore.sessionId) return;
  const next: TokenStatus = usable ? "proven" : "failed";
  if (authStore.status === next) return;
  authStore.status = next;
  notify();
}

/**
 * This session now owns the API cache.
 *
 * <p>Called by `SessionCacheGuard` once it has emptied whatever the previous
 * session left behind — never before. The claim is the second half of the
 * barrier, so publishing it early is exactly the bug this exists to prevent,
 * and the same stale-generation check as the token probe applies: a claim for
 * a session that is no longer current says nothing about the one that is.
 */
export function claimApiCache(sessionId: string): void {
  if (sessionId !== authStore.sessionId) return;
  if (authStore.cacheSession === sessionId) return;
  authStore.cacheSession = sessionId;
  notify();
}

/**
 * Nothing is known about anybody. For sign-out, and for test isolation.
 *
 * <p>Dev mode returns to fully ready rather than to loading: there is nothing
 * to wait for there, and leaving it closed would hang a mode that has no way
 * to open itself.
 */
export function resetAuthReadiness(): void {
  const dev = authStore.mode === "dev";
  authStore.sessionId = dev ? DEV_SESSION : null;
  authStore.status = dev ? "proven" : "loading";
  authStore.cacheSession = dev ? DEV_SESSION : null;
  notify();
}

/* -------------------------------------------------------------------------- */
/*  Building the header                                                       */
/* -------------------------------------------------------------------------- */

/**
 * No usable credential exists for the session we are in.
 *
 * <h2>Why this is thrown rather than swallowed</h2>
 *
 * <p>`buildAuthHeaders` used to answer this case with `{}` — an empty header
 * set — and let the request go. That converts "I could not authenticate you"
 * into "here is an anonymous request", and the API answers the anonymous
 * request with a 401 whose meaning the UI then has to guess at. In the worst
 * reading it does not even get that far: an endpoint that tolerated anonymity
 * would answer with somebody else's view of the world, or with an empty one,
 * and an empty one is indistinguishable from an account with nothing in it.
 *
 * <p>A signed-in application knowingly sending an uncredentialed request is
 * the thing to stop. So this is a real failure, surfaced as a real query error
 * (see the base query in lib/api.ts), and no request is sent at all.
 *
 * <p>It deliberately carries no detail. Clerk's own errors mention the
 * instance, the token template and sometimes the request; none of that belongs
 * in a browser log, let alone on a screen.
 */
export class AuthUnavailableError extends Error {
  constructor() {
    super("Not signed in, or the session could not be renewed.");
    this.name = "AuthUnavailableError";
  }
}

/**
 * Headers attached to every Spring `/api/v1/**` request.
 *
 * <p>Asked fresh every time, on purpose. The readiness probe proves a token
 * <em>can</em> be had; it is not a token to keep. Clerk's are short-lived and
 * it refreshes them behind this call, so caching one here would work for about
 * a minute and then quietly stop.
 *
 * @throws AuthUnavailableError in clerk mode when no token can be obtained
 */
export async function buildAuthHeaders(): Promise<Record<string, string>> {
  if (authStore.mode !== "clerk") {
    // dev mode: hydrated at module load, so there is nothing to fail.
    return { "X-Dev-User": authStore.devUserId || DEFAULT_DEV_USER };
  }
  let token: string | null = null;
  try {
    token = authStore.tokenGetter ? await authStore.tokenGetter() : null;
  } catch {
    // Swallowed and re-raised as our own below: what Clerk throws is not
    // something to propagate into a UI or a log.
    token = null;
  }
  if (!token) throw new AuthUnavailableError();
  return { Authorization: `Bearer ${token}` };
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
