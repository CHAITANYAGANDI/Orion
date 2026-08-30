import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  authStore,
  isAuthReady,
  authPhase,
  currentSessionId,
  cacheOwner,
  setTokenGetter,
  publishAuthState,
  resolveTokenProbe,
  claimApiCache,
  resetAuthReadiness,
  subscribeAuthReady,
  buildAuthHeaders,
  AuthUnavailableError,
  type TokenStatus,
} from "@/lib/auth-store";

/**
 * Readiness, as a state machine, asserted directly.
 *
 * <h2>Two bugs, one file</h2>
 *
 * <p>The first: readiness meant `tokenGetter !== null` — "a function that can
 * ask for a token exists" — which a signed-out visitor on `/sign-in` satisfied,
 * because the bridge wraps the root layout and registered it unconditionally.
 *
 * <p>The second: fixing that left a proven token as the whole of the answer,
 * and it is only half. The other half — that the RTK Query cache in the store
 * belongs to this session rather than the last one — lived in a passive effect
 * with no ordering relationship to the gate. Both halves are here now, and
 * `app-ready` is the single barrier that requires them together.
 *
 * <p>Several of these states cannot be staged through a component: a probe
 * resolving after the session it was about has been replaced, a cache claimed
 * for a session that is no longer current. Those are the two that decide
 * whether one person's data can be shown to another.
 */

beforeEach(() => {
  authStore.mode = "clerk";
  setTokenGetter(null);
  resetAuthReadiness();
});

afterEach(() => {
  authStore.mode = "clerk";
});

/** Take a session all the way to app-ready, the way the app does. */
function fullyReady(sessionId: string) {
  publishAuthState({ sessionId, phase: "preparing-session" });
  resolveTokenProbe(sessionId, true);
  claimApiCache(sessionId);
}

describe("what readiness means", () => {
  it("starts knowing nothing in clerk mode", () => {
    expect(authPhase()).toBe("loading");
    expect(isAuthReady()).toBe(false);
  });

  it("is not made ready by a token getter existing", () => {
    // The first bug, in one line. This is the state a signed-out visitor
    // sitting on /sign-in was in, and it used to open the whole app.
    setTokenGetter(async () => "tok_123");

    expect(isAuthReady()).toBe(false);
  });

  it("is not ready while Clerk is still loading", () => {
    publishAuthState({ sessionId: null, phase: "loading" });
    expect(authPhase()).toBe("loading");
  });

  it("is not ready when Clerk is loaded and nobody is signed in", () => {
    publishAuthState({ sessionId: null, phase: "signed-out" });

    expect(authPhase()).toBe("signed-out");
    expect(isAuthReady()).toBe(false);
  });

  it("is not ready while the token for this session is still being fetched", () => {
    publishAuthState({ sessionId: "sess_A", phase: "preparing-session" });

    expect(authPhase()).toBe("preparing-session");
    expect(isAuthReady()).toBe(false);
  });

  it("is not ready when the token came back empty", () => {
    publishAuthState({ sessionId: "sess_A", phase: "preparing-session" });
    resolveTokenProbe("sess_A", false);

    expect(authPhase()).toBe("failed");
    expect(isAuthReady()).toBe(false);
  });

  it("is ready only when the token is proven AND the cache is this session's", () => {
    fullyReady("sess_A");

    expect(authPhase()).toBe("app-ready");
    expect(isAuthReady()).toBe(true);
  });

  it("never reports ready from any phase but app-ready", () => {
    const statuses: TokenStatus[] = ["loading", "signed-out", "preparing-session", "failed"];
    for (const phase of statuses) {
      publishAuthState({ sessionId: "sess_A", phase });
      expect(isAuthReady(), phase).toBe(false);
    }
  });
});

describe("the barrier needs both halves", () => {
  it("does not open on a proven token while the cache is another session's", () => {
    /*
     * THE second bug. This is the state the app used to mount in: Clerk has a
     * credential for B, and the store is still full of A's meetings, folders
     * and usage. Every cache key in this app is endpoint + argument, with no
     * user in it, so B's first request is a hit on A's entry.
     */
    fullyReady("sess_A");
    publishAuthState({ sessionId: "sess_B", phase: "preparing-session" });
    resolveTokenProbe("sess_B", true);

    expect(authPhase()).toBe("token-ready");
    expect(isAuthReady()).toBe(false);
    expect(cacheOwner()).toBe("sess_A");
  });

  it("does not open on an owned cache while the token is still being fetched", () => {
    // The mirror. Order does not matter; both are required.
    publishAuthState({ sessionId: "sess_B", phase: "preparing-session" });
    claimApiCache("sess_B");

    expect(authPhase()).toBe("preparing-session");
    expect(isAuthReady()).toBe(false);
  });

  it("opens as soon as the second half arrives, whichever it is", () => {
    publishAuthState({ sessionId: "sess_B", phase: "preparing-session" });

    claimApiCache("sess_B");
    expect(isAuthReady()).toBe(false);
    resolveTokenProbe("sess_B", true);
    expect(isAuthReady()).toBe(true);

    // …and the other way round.
    resetAuthReadiness();
    publishAuthState({ sessionId: "sess_C", phase: "preparing-session" });
    resolveTokenProbe("sess_C", true);
    expect(isAuthReady()).toBe(false);
    claimApiCache("sess_C");
    expect(isAuthReady()).toBe(true);
  });

  it("leaves ownership behind when the session changes, so somebody must clear it", () => {
    // Ownership is a fact about the store's contents, not about the session.
    // Clearing it on a session change would make the gate open on an unclaimed
    // cache the moment a token arrived -- which is the whole bug.
    fullyReady("sess_A");

    publishAuthState({ sessionId: "sess_B", phase: "preparing-session" });

    expect(cacheOwner()).toBe("sess_A");
  });

  it("starts with nobody owning the cache, so a cold start clears nothing", () => {
    expect(cacheOwner()).toBeNull();
  });
});

describe("a proof belongs to the session it was about", () => {
  it("drops readiness when the session id changes", () => {
    fullyReady("sess_A");

    publishAuthState({ sessionId: "sess_B", phase: "preparing-session" });

    expect(isAuthReady()).toBe(false);
    expect(currentSessionId()).toBe("sess_B");
  });

  it("drops readiness on sign-out", () => {
    fullyReady("sess_A");

    publishAuthState({ sessionId: null, phase: "signed-out" });

    expect(isAuthReady()).toBe(false);
  });

  it("requires a fresh proof after signing out and back in as the same person", () => {
    fullyReady("sess_A1");
    publishAuthState({ sessionId: null, phase: "signed-out" });
    publishAuthState({ sessionId: "sess_A2", phase: "preparing-session" });

    expect(isAuthReady()).toBe(false);

    resolveTokenProbe("sess_A2", true);
    claimApiCache("sess_A2");
    expect(isAuthReady()).toBe(true);
  });

  it("drops readiness when Clerk is torn down and reinitialised", () => {
    fullyReady("sess_A");

    publishAuthState({ sessionId: null, phase: "loading" });

    expect(isAuthReady()).toBe(false);
  });

  it("does not un-prove a session on a re-render that republishes preparing", () => {
    fullyReady("sess_A");

    publishAuthState({ sessionId: "sess_A", phase: "preparing-session" });

    expect(isAuthReady()).toBe(true);
  });

  it("does not un-fail a session on a re-render either", () => {
    publishAuthState({ sessionId: "sess_A", phase: "preparing-session" });
    resolveTokenProbe("sess_A", false);

    publishAuthState({ sessionId: "sess_A", phase: "preparing-session" });

    expect(authPhase()).toBe("failed");
  });
});

describe("work that finishes after its session has been replaced", () => {
  it("cannot let a stale token probe mark the new session ready", () => {
    /*
     *   session A: getToken() ─────────────────────► resolves
     *   session B:      becomes current ──────────────────►
     *
     * Taking A's answer would open the app for B on A's credential.
     */
    publishAuthState({ sessionId: "sess_A", phase: "preparing-session" });
    publishAuthState({ sessionId: "sess_B", phase: "preparing-session" });

    resolveTokenProbe("sess_A", true);

    expect(isAuthReady()).toBe(false);
    expect(currentSessionId()).toBe("sess_B");
  });

  it("cannot let a stale cache claim mark the new session ready", () => {
    // The same race on the other half. A guard effect that started clearing for
    // A and finished after B arrived would otherwise announce that B owns a
    // cache nobody emptied for B.
    publishAuthState({ sessionId: "sess_A", phase: "preparing-session" });
    publishAuthState({ sessionId: "sess_B", phase: "preparing-session" });
    resolveTokenProbe("sess_B", true);

    claimApiCache("sess_A");

    expect(cacheOwner()).toBeNull();
    expect(isAuthReady()).toBe(false);
  });

  it("cannot fail a session that has already moved on", () => {
    publishAuthState({ sessionId: "sess_A", phase: "preparing-session" });
    publishAuthState({ sessionId: "sess_B", phase: "preparing-session" });
    resolveTokenProbe("sess_B", true);
    claimApiCache("sess_B");

    resolveTokenProbe("sess_A", false);

    expect(isAuthReady()).toBe(true);
  });

  it("cannot mark anything ready after a sign-out", () => {
    publishAuthState({ sessionId: "sess_A", phase: "preparing-session" });
    publishAuthState({ sessionId: null, phase: "signed-out" });

    resolveTokenProbe("sess_A", true);
    claimApiCache("sess_A");

    expect(isAuthReady()).toBe(false);
  });
});

describe("subscribers", () => {
  it("hear about every readiness change, including the cache claim", () => {
    const heard = vi.fn();
    const stop = subscribeAuthReady(heard);

    publishAuthState({ sessionId: "sess_A", phase: "preparing-session" });
    resolveTokenProbe("sess_A", true);
    claimApiCache("sess_A");

    expect(heard).toHaveBeenCalledTimes(3);
    stop();
  });

  it("stop hearing after unsubscribing", () => {
    const heard = vi.fn();
    subscribeAuthReady(heard)();

    publishAuthState({ sessionId: "sess_A", phase: "preparing-session" });

    expect(heard).not.toHaveBeenCalled();
  });

  it("are not woken by a publish that changes nothing", () => {
    publishAuthState({ sessionId: "sess_A", phase: "preparing-session" });
    const heard = vi.fn();
    const stop = subscribeAuthReady(heard);

    publishAuthState({ sessionId: "sess_A", phase: "preparing-session" });

    expect(heard).not.toHaveBeenCalled();
    stop();
  });

  it("are not woken by an ignored late probe or claim", () => {
    publishAuthState({ sessionId: "sess_B", phase: "preparing-session" });
    const heard = vi.fn();
    const stop = subscribeAuthReady(heard);

    resolveTokenProbe("sess_A", true);
    claimApiCache("sess_A");

    expect(heard).not.toHaveBeenCalled();
    stop();
  });

  it("are not woken by a claim that changes nothing", () => {
    // A guard effect re-running for the same session must not churn the gate.
    fullyReady("sess_A");
    const heard = vi.fn();
    const stop = subscribeAuthReady(heard);

    claimApiCache("sess_A");

    expect(heard).not.toHaveBeenCalled();
    stop();
  });
});

describe("dev mode", () => {
  beforeEach(() => {
    authStore.mode = "dev";
    resetAuthReadiness();
  });

  it("is ready with nothing to wait for", () => {
    expect(authPhase()).toBe("app-ready");
    expect(isAuthReady()).toBe(true);
  });

  it("owns its own cache from the start, so nothing is cleared on a cold start", () => {
    expect(cacheOwner()).toBe(currentSessionId());
  });

  it("stays ready with no token getter at all", () => {
    setTokenGetter(null);

    expect(isAuthReady()).toBe(true);
  });

  it("closes the gate when the dev user is switched, until the cache is handed over", () => {
    // A change of dev user is a change of tenant with no navigation to notice
    // it, so it goes through the same generation machinery as a Clerk session.
    publishAuthState({ sessionId: "dev:usr_b", phase: "proven" });

    expect(isAuthReady()).toBe(false);
    expect(authPhase()).toBe("token-ready");

    claimApiCache("dev:usr_b");
    expect(isAuthReady()).toBe(true);
  });

  it("sends its dev header without asking anybody for a token", async () => {
    authStore.devUserId = "usr_test";

    await expect(buildAuthHeaders()).resolves.toEqual({ "X-Dev-User": "usr_test" });
  });
});

describe("buildAuthHeaders", () => {
  it("attaches a bearer token when there is one", async () => {
    setTokenGetter(async () => "tok_123");

    await expect(buildAuthHeaders()).resolves.toEqual({
      Authorization: "Bearer tok_123",
    });
  });

  it("refuses rather than producing an anonymous request", async () => {
    setTokenGetter(async () => null);

    await expect(buildAuthHeaders()).rejects.toBeInstanceOf(AuthUnavailableError);
  });

  it("refuses when there is no getter at all", async () => {
    setTokenGetter(null);

    await expect(buildAuthHeaders()).rejects.toBeInstanceOf(AuthUnavailableError);
  });

  it("refuses when the token call throws", async () => {
    setTokenGetter(async () => {
      throw new Error("clerk: network error for instance foo.clerk.accounts.dev");
    });

    await expect(buildAuthHeaders()).rejects.toBeInstanceOf(AuthUnavailableError);
  });

  it("says nothing about the provider, the instance or the token", async () => {
    setTokenGetter(async () => {
      throw new Error("clerk: template 'orion' missing on instance foo.clerk.accounts.dev");
    });

    const error = await buildAuthHeaders().catch((e: Error) => e);

    expect(error.message).not.toMatch(/clerk|instance|template|token/i);
  });

  it("asks again on every call rather than keeping the token", async () => {
    // The readiness probe proves a token *can* be had; it is not a token to
    // keep. Clerk's last about a minute and it refreshes them behind this call.
    let issued = 0;
    setTokenGetter(async () => `tok_${++issued}`);

    await buildAuthHeaders();
    await buildAuthHeaders();

    expect(issued).toBe(2);
  });
});
