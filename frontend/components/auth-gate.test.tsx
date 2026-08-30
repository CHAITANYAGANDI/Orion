import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Nothing authenticated renders before there is a token to authenticate with.
 *
 * <h2>The first bug</h2>
 *
 * <p>A hard refresh brought the app up with empty panels and errors behind
 * them; refreshing again usually fixed it. Every request in that first pass had
 * gone out with no `Authorization` header and come back 401. The cause was
 * ordering: `ClerkBridge` registers the token getter in an effect, effects run
 * after the subtree below has mounted, and RTK Query hooks fire on mount.
 *
 * <h2>The second bug, which these tests are now about</h2>
 *
 * <p>Holding the subtree back until the getter existed left a narrower version
 * of the same race. `tokenGetter !== null && isLoaded` says nothing about
 * anybody being signed in — this component's provider wraps `/` and `/sign-in`
 * too, so both halves were already true while the visitor was signed out. The
 * gate therefore opened in the same commit that a completed sign-in redirected
 * into `/home`, ahead of Clerk adopting the session, and roughly a dozen hooks
 * sent uncredentialed requests.
 *
 * <p>So the gate now reads one thing: has a token for the session the browser
 * is in <em>right now</em> actually been obtained. The machine behind that
 * answer is asserted in lib/auth-store.test; this file asserts that the gate
 * obeys it, and that nothing renders in the four states that are not ready.
 *
 * <p>These run in clerk mode, which is the default when `NEXT_PUBLIC_AUTH_MODE`
 * is unset (it fails closed — see auth-store).
 */

import * as React from "react";
import { render, screen, act } from "@testing-library/react";
import { AuthGate } from "@/components/auth-gate";
import {
  authStore,
  setTokenGetter,
  publishAuthState,
  resolveTokenProbe,
  claimApiCache,
  resetAuthReadiness,
  isAuthReady,
  buildAuthHeaders,
  type TokenStatus,
} from "@/lib/auth-store";

/** Counts renders, standing in for any component that queries on mount. */
const childRendered = vi.fn();

function QueryingChild() {
  childRendered();
  return <div>workspace</div>;
}

function renderGate() {
  return render(
    <AuthGate>
      <QueryingChild />
    </AuthGate>,
  );
}

/**
 * Everything the gate requires: a credential for this session, and an API cache
 * this session owns. Both, because either alone is a state the app must not
 * open in.
 */
function fullyReady(sessionId = "sess_1") {
  act(() => {
    setTokenGetter(async () => "tok_123");
    publishAuthState({ sessionId, phase: "preparing-session" });
    resolveTokenProbe(sessionId, true);
    claimApiCache(sessionId);
  });
}

describe("AuthGate", () => {
  beforeEach(() => {
    childRendered.mockClear();
    authStore.mode = "clerk";
    setTokenGetter(null);
    resetAuthReadiness();
  });

  it("is in clerk mode, so the race is real", () => {
    expect(authStore.mode).toBe("clerk");
  });

  it("does not mount the authenticated subtree before Clerk has loaded", () => {
    renderGate();

    expect(screen.queryByText("workspace")).toBeNull();
    expect(childRendered).not.toHaveBeenCalled();
  });

  it("does not mount the authenticated subtree while nobody is signed in", () => {
    // The state the old gate could not see. `ClerkBridge` is mounted on
    // `/sign-in` as well, so this is where a visitor sits while typing a
    // password — and the old condition was fully satisfied here.
    act(() => {
      setTokenGetter(async () => "tok_123");
      publishAuthState({ sessionId: null, phase: "signed-out" });
    });

    renderGate();

    expect(screen.queryByText("workspace")).toBeNull();
  });

  it("does not mount while the token for this session is still being fetched", () => {
    // Signed in, getter registered, request in flight. This is the exact
    // instant the first authenticated navigation after a sign-in used to open
    // the whole application in.
    act(() => {
      setTokenGetter(async () => "tok_123");
      publishAuthState({ sessionId: "sess_1", phase: "preparing-session" });
    });

    renderGate();

    expect(screen.queryByText("workspace")).toBeNull();
  });

  it("does not mount when the token came back empty", () => {
    act(() => {
      setTokenGetter(async () => null);
      publishAuthState({ sessionId: "sess_1", phase: "preparing-session" });
      resolveTokenProbe("sess_1", false);
    });

    renderGate();

    expect(screen.queryByText("workspace")).toBeNull();
  });

  it.each<TokenStatus>(["loading", "signed-out", "preparing-session", "failed"])(
    "refuses to mount in the %s phase",
    (phase) => {
      act(() => {
        setTokenGetter(async () => "tok_123");
        publishAuthState({ sessionId: "sess_1", phase });
      });

      renderGate();

      expect(screen.queryByText("workspace")).toBeNull();
    },
  );

  it("does not mount on a proven token while the cache is another session's", () => {
    /*
     * THE remaining race. Clerk has a credential for this session and the store
     * is still full of the previous one's meetings, folders and usage -- every
     * cache key here is endpoint + argument with no user in it, so the first
     * request is a hit on the old entry. This is the state the app used to
     * mount in, and the state a manual refresh was curing.
     */
    act(() => {
      setTokenGetter(async () => "tok_123");
      publishAuthState({ sessionId: "sess_B", phase: "preparing-session" });
      resolveTokenProbe("sess_B", true);
    });

    renderGate();

    expect(screen.queryByText("workspace")).toBeNull();
  });

  it("does not mount on an owned cache while the token is still being fetched", () => {
    act(() => {
      publishAuthState({ sessionId: "sess_B", phase: "preparing-session" });
      claimApiCache("sess_B");
    });

    renderGate();

    expect(screen.queryByText("workspace")).toBeNull();
  });

  it("mounts once the token is proven and the cache is this session's", () => {
    fullyReady();

    renderGate();

    expect(screen.getByText("workspace")).toBeInTheDocument();
    expect(childRendered).toHaveBeenCalledTimes(1);
  });

  it("lets children in the moment readiness arrives, without a remount", () => {
    // Not a remount: the subtree that appears is the same one that stays, so a
    // hook does not fire, unmount and fire again.
    renderGate();
    expect(childRendered).not.toHaveBeenCalled();

    fullyReady();

    expect(screen.getByText("workspace")).toBeInTheDocument();
    expect(childRendered).toHaveBeenCalledTimes(1);
  });

  it("follows the whole sign-in, and mounts only at the end of it", () => {
    /*
     * The production sequence, in order:
     *   loaded + signed out  ->  signed in, session known  ->  token in hand.
     * Nothing authenticated may exist for the first two.
     */
    renderGate();
    const seenAt: Record<string, number> = {};

    act(() => {
      publishAuthState({ sessionId: null, phase: "signed-out" });
    });
    seenAt["signed-out"] = childRendered.mock.calls.length;

    act(() => {
      setTokenGetter(async () => "tok_123");
      publishAuthState({ sessionId: "sess_1", phase: "preparing-session" });
    });
    seenAt["preparing-session"] = childRendered.mock.calls.length;

    act(() => {
      resolveTokenProbe("sess_1", true);
    });
    seenAt["token-ready"] = childRendered.mock.calls.length;

    act(() => {
      claimApiCache("sess_1");
    });
    seenAt["app-ready"] = childRendered.mock.calls.length;

    expect(seenAt).toEqual({
      "signed-out": 0,
      "preparing-session": 0,
      "token-ready": 0,
      "app-ready": 1,
    });
  });

  it("closes again when the session ends under an open page", () => {
    fullyReady();
    renderGate();
    expect(screen.getByText("workspace")).toBeInTheDocument();

    act(() => {
      publishAuthState({ sessionId: null, phase: "signed-out" });
    });

    expect(screen.queryByText("workspace")).toBeNull();
  });

  it("closes when the session changes, until the new one is proven", () => {
    fullyReady("sess_A");
    renderGate();

    act(() => {
      publishAuthState({ sessionId: "sess_B", phase: "preparing-session" });
    });
    expect(screen.queryByText("workspace")).toBeNull();

    act(() => {
      resolveTokenProbe("sess_B", true);
      claimApiCache("sess_B");
    });
    expect(screen.getByText("workspace")).toBeInTheDocument();
  });

  it("is not opened for one session by another session's late answer", () => {
    // Session A's `getToken()` resolving after B is current says nothing about
    // B. Opening the app here would put B in front of A's credential.
    renderGate();
    act(() => {
      publishAuthState({ sessionId: "sess_A", phase: "preparing-session" });
      publishAuthState({ sessionId: "sess_B", phase: "preparing-session" });
      resolveTokenProbe("sess_A", true);
      claimApiCache("sess_A");
    });

    expect(screen.queryByText("workspace")).toBeNull();
  });

  it("shows a busy state rather than an empty screen while it waits", () => {
    renderGate();

    expect(screen.getByText(/loading your workspace/i)).toBeInTheDocument();
  });

  it("never falls back to dev auth when Clerk is slow", async () => {
    // A timer-based fallback to `X-Dev-User` would be an authentication bypass.
    act(() => {
      publishAuthState({ sessionId: null, phase: "loading" });
    });

    expect(isAuthReady()).toBe(false);
    await expect(buildAuthHeaders()).rejects.toThrow();
  });

  it("sends the bearer token once a session is ready", async () => {
    fullyReady();

    await expect(buildAuthHeaders()).resolves.toEqual({
      Authorization: "Bearer tok_123",
    });
  });
});

describe("AuthGate in dev mode", () => {
  beforeEach(() => {
    childRendered.mockClear();
    authStore.mode = "dev";
    resetAuthReadiness();
  });

  it("mounts immediately, with no getter and no session", () => {
    // Dev mode has nothing to wait for: the `X-Dev-User` header comes from a
    // value hydrated at module load. Gating it would make the "runs with no
    // keys at all" story a lie.
    setTokenGetter(null);

    renderGate();

    expect(screen.getByText("workspace")).toBeInTheDocument();
    expect(childRendered).toHaveBeenCalledTimes(1);
  });
});
