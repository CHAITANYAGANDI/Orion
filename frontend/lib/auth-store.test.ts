import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  authStore,
  isAuthReady,
  authPhase,
  currentSessionId,
  setTokenGetter,
  publishAuthState,
  resolveTokenProbe,
  resetAuthReadiness,
  subscribeAuthReady,
  buildAuthHeaders,
  AuthUnavailableError,
} from "@/lib/auth-store";

/**
 * Readiness, as a state machine, asserted directly.
 *
 * <h2>Why this file exists</h2>
 *
 * <p>The first fix held the authenticated subtree back until
 * `authStore.tokenGetter !== null`, and its tests asserted exactly that. Which
 * they did correctly — the tests and the code agreed, and both were wrong about
 * what the app needed to know.
 *
 * <p>"A function that can ask for a token exists" is not "a token for the
 * session we are in has been obtained", and the distance between those two is
 * a signed-out visitor on `/sign-in` — where `ClerkBridge` is mounted, the
 * getter is registered, and Clerk has long since loaded. Every condition the
 * old gate checked was already satisfied before anybody signed in.
 *
 * <p>So the machine is pure and the matrix is asserted here. Several of these
 * states are unreachable through a component in a test — a probe resolving
 * after the session it was about has been replaced, most of all — and that one
 * is the difference between opening the app for the right person and the wrong
 * one.
 */

const CLERK = { mode: "clerk" as const };

beforeEach(() => {
  authStore.mode = "clerk";
  setTokenGetter(null);
  resetAuthReadiness();
});

afterEach(() => {
  authStore.mode = CLERK.mode;
});

describe("what readiness means", () => {
  it("starts knowing nothing in clerk mode", () => {
    expect(authPhase()).toBe("loading");
    expect(isAuthReady()).toBe(false);
  });

  it("is not made ready by a token getter existing", () => {
    // THE bug, in one line. This is the state a signed-out visitor sitting on
    // /sign-in was in, and it used to open the whole app.
    setTokenGetter(async () => "tok_123");

    expect(isAuthReady()).toBe(false);
  });

  it("is not ready while Clerk is still loading", () => {
    publishAuthState({ sessionId: null, phase: "loading" });
    expect(isAuthReady()).toBe(false);
  });

  it("is not ready when Clerk is loaded and nobody is signed in", () => {
    publishAuthState({ sessionId: null, phase: "signed-out" });

    expect(authPhase()).toBe("signed-out");
    expect(isAuthReady()).toBe(false);
  });

  it("is not ready while the token for this session is still being fetched", () => {
    // The precise moment the old gate opened in: Clerk believes there is a
    // session, and has not yet produced a credential for it.
    publishAuthState({ sessionId: "sess_A", phase: "acquiring" });

    expect(isAuthReady()).toBe(false);
  });

  it("is not ready when the token came back empty", () => {
    publishAuthState({ sessionId: "sess_A", phase: "acquiring" });
    resolveTokenProbe("sess_A", false);

    expect(authPhase()).toBe("failed");
    expect(isAuthReady()).toBe(false);
  });

  it("is ready only once a usable token for this session has been held", () => {
    publishAuthState({ sessionId: "sess_A", phase: "acquiring" });
    resolveTokenProbe("sess_A", true);

    expect(authPhase()).toBe("ready");
    expect(isAuthReady()).toBe(true);
  });

  it("never reports ready from any phase but ready", () => {
    for (const phase of ["loading", "signed-out", "acquiring", "failed"] as const) {
      publishAuthState({ sessionId: "sess_A", phase });
      expect(isAuthReady(), phase).toBe(false);
    }
  });
});

describe("a proof belongs to the session it was about", () => {
  function readyOn(sessionId: string) {
    publishAuthState({ sessionId, phase: "acquiring" });
    resolveTokenProbe(sessionId, true);
  }

  it("drops readiness when the session id changes", () => {
    readyOn("sess_A");

    publishAuthState({ sessionId: "sess_B", phase: "acquiring" });

    expect(isAuthReady()).toBe(false);
    expect(currentSessionId()).toBe("sess_B");
  });

  it("drops readiness on sign-out", () => {
    readyOn("sess_A");

    publishAuthState({ sessionId: null, phase: "signed-out" });

    expect(isAuthReady()).toBe(false);
    expect(authPhase()).toBe("signed-out");
  });

  it("requires a fresh proof after signing out and back in as the same person", () => {
    // The same account is a different *session*, and the credential is per
    // session. Nothing about A's proof says anything about A-again.
    readyOn("sess_A1");
    publishAuthState({ sessionId: null, phase: "signed-out" });
    publishAuthState({ sessionId: "sess_A2", phase: "acquiring" });

    expect(isAuthReady()).toBe(false);

    resolveTokenProbe("sess_A2", true);
    expect(isAuthReady()).toBe(true);
  });

  it("drops readiness when Clerk is torn down and reinitialised", () => {
    readyOn("sess_A");

    publishAuthState({ sessionId: null, phase: "loading" });

    expect(isAuthReady()).toBe(false);
  });

  it("does not un-prove a session on a re-render that republishes acquiring", () => {
    // The bridge republishes on renders that have nothing to do with the
    // session. Letting that reset the phase would close the gate under a
    // working app and restart the probe, over and over.
    readyOn("sess_A");

    publishAuthState({ sessionId: "sess_A", phase: "acquiring" });

    expect(isAuthReady()).toBe(true);
  });

  it("does not un-fail a session on a re-render either", () => {
    publishAuthState({ sessionId: "sess_A", phase: "acquiring" });
    resolveTokenProbe("sess_A", false);

    publishAuthState({ sessionId: "sess_A", phase: "acquiring" });

    expect(authPhase()).toBe("failed");
  });
});

describe("a probe that resolves late", () => {
  it("cannot mark a session ready once another one is current", () => {
    /*
     * The race, in three lines:
     *
     *   session A: getToken() ─────────────────────► resolves
     *   session B:      becomes current ──────────────────►
     *
     * Taking A's answer would open the app for B on A's credential. This is
     * the assertion that stops it, and it is not reachable from a component
     * test.
     */
    publishAuthState({ sessionId: "sess_A", phase: "acquiring" });
    publishAuthState({ sessionId: "sess_B", phase: "acquiring" });

    resolveTokenProbe("sess_A", true);

    expect(isAuthReady()).toBe(false);
    expect(currentSessionId()).toBe("sess_B");
  });

  it("cannot fail a session that has already moved on", () => {
    // The mirror. A's failure says nothing about B either, and letting it land
    // would show a signed-in user an error about somebody else's session.
    publishAuthState({ sessionId: "sess_A", phase: "acquiring" });
    publishAuthState({ sessionId: "sess_B", phase: "acquiring" });
    resolveTokenProbe("sess_B", true);

    resolveTokenProbe("sess_A", false);

    expect(isAuthReady()).toBe(true);
  });

  it("cannot mark anything ready after a sign-out", () => {
    publishAuthState({ sessionId: "sess_A", phase: "acquiring" });
    publishAuthState({ sessionId: null, phase: "signed-out" });

    resolveTokenProbe("sess_A", true);

    expect(isAuthReady()).toBe(false);
  });
});

describe("subscribers", () => {
  it("hear about every readiness change", () => {
    const heard = vi.fn();
    const stop = subscribeAuthReady(heard);

    publishAuthState({ sessionId: "sess_A", phase: "acquiring" });
    resolveTokenProbe("sess_A", true);

    expect(heard).toHaveBeenCalledTimes(2);
    stop();
  });

  it("stop hearing after unsubscribing", () => {
    const heard = vi.fn();
    subscribeAuthReady(heard)();

    publishAuthState({ sessionId: "sess_A", phase: "acquiring" });

    expect(heard).not.toHaveBeenCalled();
  });

  it("are not woken by a publish that changes nothing", () => {
    publishAuthState({ sessionId: "sess_A", phase: "acquiring" });
    const heard = vi.fn();
    const stop = subscribeAuthReady(heard);

    publishAuthState({ sessionId: "sess_A", phase: "acquiring" });

    expect(heard).not.toHaveBeenCalled();
    stop();
  });

  it("are not woken by an ignored late probe", () => {
    publishAuthState({ sessionId: "sess_B", phase: "acquiring" });
    const heard = vi.fn();
    const stop = subscribeAuthReady(heard);

    resolveTokenProbe("sess_A", true);

    expect(heard).not.toHaveBeenCalled();
    stop();
  });
});

describe("dev mode", () => {
  it("is ready with nothing to wait for", () => {
    // The header comes from a value hydrated at module load, so there is
    // genuinely no asynchronous step -- and this is deliberately not a fallback
    // for Clerk being slow, which would be an authentication bypass on a timer.
    authStore.mode = "dev";
    resetAuthReadiness();

    expect(isAuthReady()).toBe(true);
  });

  it("stays ready with no token getter at all", () => {
    authStore.mode = "dev";
    resetAuthReadiness();
    setTokenGetter(null);

    expect(isAuthReady()).toBe(true);
  });

  it("sends its dev header without asking anybody for a token", async () => {
    authStore.mode = "dev";
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
    // It used to return `{}` here and let the call go out. An uncredentialed
    // request is answered either with a 401 the UI has to guess at, or -- worse
    // -- with an empty view of the world that is indistinguishable from an
    // account with nothing in it.
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
