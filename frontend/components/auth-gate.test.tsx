import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Nothing authenticated renders before there is a token to authenticate with.
 *
 * <h2>The bug</h2>
 *
 * <p>A hard refresh brought the app up with empty panels and errors behind
 * them; refreshing again usually fixed it. Every request in that first pass had
 * gone out with no `Authorization` header and come back 401.
 *
 * <p>The cause is ordering. `ClerkBridge` registers `authStore.tokenGetter` in
 * an effect, and React runs effects *after* the subtree below has mounted. RTK
 * Query hooks fire on mount. So the first request of every hook in the app was
 * built during the render pass before the getter existed, and
 * `buildAuthHeaders` found `null` and sent nothing.
 *
 * <p>It looked intermittent because it is a race — a warm session sometimes let
 * the effect win — and it reproduced every time on a hard refresh, which is
 * exactly when Clerk has the most to do before it can produce a token.
 *
 * <p>These tests run in clerk mode, which is the default when
 * `NEXT_PUBLIC_AUTH_MODE` is unset (it fails closed — see auth-store). Nothing
 * here is mocked except Clerk's own `isLoaded`, which is supplied through the
 * real `AuthContext` rather than by mocking the module.
 */

import * as React from "react";
import { render, screen, act } from "@testing-library/react";
import { AuthGate } from "@/components/auth-gate";
import { AuthContext, type AuthContextValue } from "@/lib/auth";
import {
  authStore,
  setTokenGetter,
  isAuthReady,
  buildAuthHeaders,
  subscribeAuthReady as subscribeReady,
} from "@/lib/auth-store";

/** Counts renders, standing in for any component that queries on mount. */
const childRendered = vi.fn();

function QueryingChild() {
  childRendered();
  return <div>workspace</div>;
}

function ctx(isLoaded: boolean): AuthContextValue {
  return {
    mode: "clerk",
    userId: isLoaded ? "user_1" : "",
    setDevUserId: () => {},
    sessionKey: isLoaded ? "sess_1" : "",
    isSignedIn: isLoaded,
    isLoaded,
    signOut: () => {},
  };
}

function renderGate(isLoaded: boolean) {
  return render(
    <AuthContext.Provider value={ctx(isLoaded)}>
      <AuthGate>
        <QueryingChild />
      </AuthGate>
    </AuthContext.Provider>,
  );
}

describe("AuthGate", () => {
  beforeEach(() => {
    childRendered.mockClear();
    setTokenGetter(null);
  });

  it("is in clerk mode, so the race is real", () => {
    // Guards the rest of the file. In dev mode there is no getter to wait for
    // and every assertion below would pass for the wrong reason.
    expect(authStore.mode).toBe("clerk");
  });

  it("does not render children before the token getter is registered", () => {
    // The regression. A child that never mounts cannot fire a query, which is
    // the only version of this guarantee that also holds for pages nobody has
    // written yet.
    renderGate(true);

    expect(childRendered).not.toHaveBeenCalled();
    expect(screen.queryByText("workspace")).toBeNull();
  });

  it("does not render children while Clerk is still loading", () => {
    // Both conditions are required. The getter can be registered while Clerk is
    // still resolving the session, and calling it then returns null -- a
    // request with no token, which is the failure being prevented.
    act(() => {
      setTokenGetter(async () => "tok_123");
    });

    renderGate(false);

    expect(childRendered).not.toHaveBeenCalled();
  });

  it("renders children once Clerk is loaded and the getter exists", () => {
    act(() => {
      setTokenGetter(async () => "tok_123");
    });

    renderGate(true);

    expect(screen.getByText("workspace")).toBeInTheDocument();
  });

  it("lets children in as soon as the getter arrives, without a remount", async () => {
    // The real sequence: the gate renders first, the provider's effect runs,
    // and the subtree appears. Proves the store notification actually reaches
    // React -- a `useSyncExternalStore` that never re-renders would leave the
    // app stuck on the skeleton for ever, which is a worse bug than the one
    // being fixed.
    renderGate(true);
    expect(childRendered).not.toHaveBeenCalled();

    await act(async () => {
      setTokenGetter(async () => "tok_123");
    });

    expect(screen.getByText("workspace")).toBeInTheDocument();
    expect(childRendered).toHaveBeenCalled();
  });

  it("shows a busy state rather than an empty screen while it waits", () => {
    renderGate(true);

    expect(screen.getByText(/loading your workspace/i)).toBeInTheDocument();
  });

  it("never falls back to dev auth when Clerk is slow", async () => {
    // The dangerous shortcut: filling the gap with an `X-Dev-User` header would
    // make the symptom disappear and turn a 401 into an authentication bypass
    // reachable by anyone who can stall the network.
    expect(isAuthReady()).toBe(false);

    const headers = await buildAuthHeaders();

    expect(headers).not.toHaveProperty("X-Dev-User");
    expect(headers).toEqual({});
  });

  it("sends the bearer token once the getter is registered", async () => {
    act(() => {
      setTokenGetter(async () => "tok_123");
    });

    await expect(buildAuthHeaders()).resolves.toEqual({
      Authorization: "Bearer tok_123",
    });
  });
});

describe("auth readiness store", () => {
  beforeEach(() => setTokenGetter(null));

  it("reports not-ready until a getter arrives", () => {
    expect(isAuthReady()).toBe(false);
    setTokenGetter(async () => "t");
    expect(isAuthReady()).toBe(true);
    setTokenGetter(null);
    expect(isAuthReady()).toBe(false);
  });

  it("notifies subscribers, and stops after unsubscribe", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeReady(listener);

    setTokenGetter(async () => "t");
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    setTokenGetter(null);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("does not notify when the getter is unchanged", () => {
    // Re-registering the same function on every render of the provider would
    // otherwise wake every subscriber in the app for nothing.
    const getter = async () => "t";
    setTokenGetter(getter);

    const listener = vi.fn();
    const unsubscribe = subscribeReady(listener);
    setTokenGetter(getter);

    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });
});
