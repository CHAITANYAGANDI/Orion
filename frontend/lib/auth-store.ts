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
 * Which of five things is true about the current Clerk session.
 *
 * <h2>Why a phase and not a boolean</h2>
 *
 * <p>Readiness used to be `tokenGetter !== null` -- "somebody has handed us a
 * function capable of asking for a token". That is not the same claim as "a
 * token for the session we are in right now has actually been obtained", and
 * the gap between the two is the first-login race:
 *
 * <ul>
 *   <li>`ClerkBridge` wraps the whole root layout, including `/` and
 *       `/sign-in`, and registered the getter unconditionally -- so the getter
 *       existed while the visitor was signed <em>out</em>.</li>
 *   <li>`isLoaded` was true the whole time as well; Clerk had loaded long
 *       before anybody typed a password.</li>
 *   <li>So at the instant sign-in completed and Clerk client-side redirected
 *       to `/home`, both halves of `tokenReady && isLoaded` were already true
 *       and the gate opened in the same commit -- ahead of Clerk finishing its
 *       adoption of the new session.</li>
 *   <li>Every hook in the app fired, `getToken()` answered `null`, and the
 *       requests went out unauthenticated.</li>
 * </ul>
 *
 * <p>Refreshing fixed it because by then the session was long since adopted.
 * That is the signature of the bug: broken exactly once, on the first
 * authenticated navigation after a sign-in, and never again.
 *
 * <p>Each of the first four phases is a distinct reason not to open the app,
 * and collapsing them is what produced a "ready" that meant almost nothing.
 */
export type AuthPhase =
  /** The Clerk SDK has not finished booting. Nothing is known yet. */
  | "loading"
  /** Clerk is loaded and there is no session. `/sign-in` is the answer. */
  | "signed-out"
  /** Signed in, and a token for <em>this</em> session is being fetched. */
  | "acquiring"
  /** Signed in, and a usable token for this session has been held in a hand. */
  | "ready"
  /** Signed in, and the token could not be obtained. Not a reason to proceed. */
  | "failed";

interface AuthStore {
  mode: AuthMode;
  devUserId: string;
  /**
   * How to ask Clerk for a token, registered by the bridge.
   *
   * <p><b>No longer evidence of anything.</b> It says a function exists, which
   * was the whole mistake; readiness lives in `phase` below.
   */
  tokenGetter: (() => Promise<string | null>) | null;
  /**
   * The Clerk session `phase` is a statement about.
   *
   * <p>This is the identity of the readiness generation, and it is what makes
   * the answer to "is this app ready" un-reusable across sign-ins. A proof
   * obtained for session A is not a proof about session B, however recently it
   * arrived.
   */
  sessionId: string | null;
  phase: AuthPhase;
}

export const authStore: AuthStore = {
  mode: AUTH_MODE,
  devUserId: DEFAULT_DEV_USER,
  tokenGetter: null,
  sessionId: null,
  /*
   * Dev mode is ready before anything renders, and that is not a shortcut: the
   * `X-Dev-User` header comes from `devUserId`, hydrated at module load below,
   * so there is genuinely no asynchronous step to wait for. Clerk mode starts
   * knowing nothing, which is the honest starting point and the one that fails
   * closed if the bridge never mounts.
   */
  phase: AUTH_MODE === "dev" ? "ready" : "loading",
};

/* -------------------------------------------------------------------------- */
/*  Is this store ready to authenticate a request?                            */
/* -------------------------------------------------------------------------- */

/**
 * Subscribers watching for readiness to change.
 *
 * <p>A module store plus `useSyncExternalStore` because the facts arrive from
 * an effect inside a provider and are read by a component outside that tree,
 * and neither should have to know about the other. Same idiom as
 * lib/processing-jobs.ts.
 */
const readyListeners = new Set<() => void>();

function notify(): void {
  for (const listener of readyListeners) listener();
}

/**
 * Whether an authenticated request can be built <em>right now</em>.
 *
 * <p>One phase, and only one, means yes. In particular `acquiring` does not:
 * a token being on its way is exactly the state the app used to mount in.
 */
export function isAuthReady(): boolean {
  return authStore.phase === "ready";
}

/** The full phase, for anything that wants to say why rather than whether. */
export function authPhase(): AuthPhase {
  return authStore.phase;
}

/** The session the current phase is a statement about. */
export function currentSessionId(): string | null {
  return authStore.sessionId;
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
 * <p>Kept as its own call, and deliberately no longer sufficient on its own.
 * It exists so `buildAuthHeaders` has something to call; whether that call will
 * succeed is what `phase` answers.
 */
export function setTokenGetter(getter: (() => Promise<string | null>) | null): void {
  if (authStore.tokenGetter === getter) return;
  authStore.tokenGetter = getter;
  notify();
}

/**
 * Whether `next` should replace `current` for the <em>same</em> session.
 *
 * <p>The one interesting case is `acquiring`. The bridge republishes it on
 * every render that changes Clerk's identities, and a proven session must not
 * be un-proven by a re-render — that would close the gate under a working app
 * and start the probe again, repeatedly, for as long as the page is open.
 */
function supersedes(current: AuthPhase, next: AuthPhase): boolean {
  if (current === next) return false;
  if (next === "acquiring" && (current === "ready" || current === "failed")) return false;
  return true;
}

/**
 * Publish what Clerk currently says, and reset readiness if the session moved.
 *
 * <p><b>A different session id is a different generation.</b> Signing out,
 * signing back in as the same person, another account signing in, and Clerk
 * being torn down and reinitialised all arrive here as a changed `sessionId`
 * (`null` for the first and last), and every one of them drops the phase
 * wholesale. There is no path by which a proof survives the session it was
 * about.
 */
export function publishAuthState(next: { sessionId: string | null; phase: AuthPhase }): void {
  const sessionChanged = next.sessionId !== authStore.sessionId;
  if (!sessionChanged && !supersedes(authStore.phase, next.phase)) return;
  authStore.sessionId = next.sessionId;
  authStore.phase = next.phase;
  notify();
}

/**
 * Record what asking Clerk for a token actually produced.
 *
 * <h2>The async race this closes</h2>
 *
 * <p>`getToken()` is a promise, and the session can change while it is in
 * flight:
 *
 * <pre>
 *   session A: getToken() ────────────────────────► resolves
 *   session B:        becomes current ─────────────────────►
 * </pre>
 *
 * <p>A's answer arrives after B is current, and it is an answer about A. Taking
 * it would open the app for B on the strength of A's credential — a
 * tenant-isolation failure, not merely a stale flag. So the session id is
 * carried through the probe and checked on the way back, and a mismatch is
 * dropped without comment.
 *
 * @param sessionId the session the probe was started for
 * @param usable    whether a non-empty token came back
 */
export function resolveTokenProbe(sessionId: string, usable: boolean): void {
  if (sessionId !== authStore.sessionId) return;
  const next: AuthPhase = usable ? "ready" : "failed";
  if (authStore.phase === next) return;
  authStore.phase = next;
  notify();
}

/**
 * Nothing is known about anybody. For sign-out, and for test isolation.
 *
 * <p>Dev mode returns to ready rather than to loading: there is nothing to
 * wait for there, and leaving it closed would hang a mode that has no way to
 * open itself.
 */
export function resetAuthReadiness(): void {
  authStore.sessionId = null;
  authStore.phase = authStore.mode === "dev" ? "ready" : "loading";
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
