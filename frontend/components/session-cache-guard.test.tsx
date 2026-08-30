import { describe, it, expect, beforeEach, vi } from "vitest";
import * as React from "react";
import { render, act } from "@testing-library/react";
import { Provider as ReduxProvider } from "react-redux";
import { configureStore } from "@reduxjs/toolkit";

/**
 * One person's cached data must not outlive their sign-in — and the gate must
 * not open until it has been handed over.
 *
 * <h2>What is actually at risk</h2>
 *
 * <p>RTK Query keys a cache entry by endpoint and serialised argument —
 * `getMeetings({page: 0, size: 50})` — and not one endpoint in this app puts a
 * user or a session in that key. They never needed to: a bearer token decided
 * whose meetings came back. So if the store outlives a change of sign-in, user
 * B's first `getMeetings` is a cache <em>hit</em> on user A's.
 *
 * <p>The first half of this file measures whether the store does outlive it,
 * because if a hard navigation already destroyed the store there would be
 * nothing worth adding. The second half is the handover itself, and the third
 * is the part that makes it a barrier rather than a race: ownership is
 * published into the same state machine `AuthGate` reads, so the gate cannot
 * open before this component has run — whenever it happens to run.
 */

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ sessionKey: "", isLoaded: false }),
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/ui/sonner", () => ({ Toaster: () => null }));

const storeSpy = vi.hoisted(() => ({ built: 0 }));
vi.mock("@/lib/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/store")>();
  return {
    ...actual,
    makeStore: () => {
      storeSpy.built += 1;
      return actual.makeStore();
    },
  };
});

import { SessionCacheGuard } from "@/components/session-cache-guard";
import { Providers } from "@/components/providers";
import { api } from "@/lib/api";
import {
  authStore,
  publishAuthState,
  resolveTokenProbe,
  resetAuthReadiness,
  cacheOwner,
  isAuthReady,
  authPhase,
  subscribeAuthReady,
} from "@/lib/auth-store";

function testStore() {
  return configureStore({
    reducer: { [api.reducerPath]: api.reducer },
    middleware: (getDefault) => getDefault().concat(api.middleware),
  });
}

/** How many API cache entries the store is holding. */
function cached(store: ReturnType<typeof testStore>): string[] {
  return Object.keys(store.getState()[api.reducerPath].queries);
}

function mountGuard(store: ReturnType<typeof testStore>) {
  return render(
    <ReduxProvider store={store}>
      <SessionCacheGuard />
    </ReduxProvider>,
  );
}

/** Put something in the cache the way a real query would. */
function warm(store: ReturnType<typeof testStore>, meetingId: string) {
  store.dispatch(
    api.util.upsertQueryData("getMeeting", meetingId, {
      id: meetingId,
      title: "A's private meeting",
    } as never),
  );
}

/** Clerk reports a session, and its token comes back. */
function sessionArrives(sessionId: string) {
  publishAuthState({ sessionId, phase: "preparing-session" });
  resolveTokenProbe(sessionId, true);
}

beforeEach(() => {
  authStore.mode = "clerk";
  resetAuthReadiness();
  storeSpy.built = 0;
});

describe("the store survives a change of sign-in", () => {
  it("is built once, and not rebuilt when the page below it changes", () => {
    // A client navigation swaps the layout's children; it does not remount the
    // provider that holds the store. Signing out navigates to
    // `afterSignOutUrl` and signing in navigates to `fallbackRedirectUrl`, and
    // neither necessarily reloads the document -- so the whole of
    // "A -> sign out -> B signs in" can happen in one store's lifetime.
    const view = render(
      <Providers>
        <div>home</div>
      </Providers>,
    );

    view.rerender(
      <Providers>
        <div>a meeting</div>
      </Providers>,
    );
    view.rerender(
      <Providers>
        <div>sign in</div>
      </Providers>,
    );

    expect(storeSpy.built).toBe(1);
  });
});

describe("handing the cache over", () => {
  it("claims an unclaimed cache without clearing anything", async () => {
    /*
     * Every ordinary page load. There is no previous tenant in this store, so
     * there is nobody to protect anybody from -- and a reset here could only
     * disturb the queries it was supposed to be guarding.
     */
    const store = testStore();
    warm(store, "mtg_1");
    sessionArrives("sess_A");

    await act(async () => {
      mountGuard(store);
    });

    expect(cached(store)).toHaveLength(1);
    expect(cacheOwner()).toBe("sess_A");
  });

  it("empties the cache when another account signs in", async () => {
    // The tenant-isolation case. Without this, B's `getMeeting("mtg_1")` is a
    // hit on A's entry and B reads A's meeting by title.
    const store = testStore();
    sessionArrives("sess_A");
    const view = await act(async () => mountGuard(store));
    warm(store, "mtg_1");
    expect(cached(store)).toHaveLength(1);

    await act(async () => {
      sessionArrives("sess_B");
      view.rerender(
        <ReduxProvider store={store}>
          <SessionCacheGuard />
        </ReduxProvider>,
      );
    });

    expect(cached(store)).toHaveLength(0);
    expect(cacheOwner()).toBe("sess_B");
  });

  it("empties the cache when the same person signs in again on a new session", async () => {
    const store = testStore();
    sessionArrives("sess_A1");
    const view = await act(async () => mountGuard(store));
    warm(store, "mtg_1");

    await act(async () => {
      sessionArrives("sess_A2");
      view.rerender(
        <ReduxProvider store={store}>
          <SessionCacheGuard />
        </ReduxProvider>,
      );
    });

    expect(cached(store)).toHaveLength(0);
  });

  it("drops every endpoint, not only the one that was invalidated", async () => {
    const store = testStore();
    sessionArrives("sess_A");
    const view = await act(async () => mountGuard(store));
    warm(store, "mtg_1");
    warm(store, "mtg_2");
    expect(cached(store)).toHaveLength(2);

    await act(async () => {
      sessionArrives("sess_B");
      view.rerender(
        <ReduxProvider store={store}>
          <SessionCacheGuard />
        </ReduxProvider>,
      );
    });

    expect(cached(store)).toEqual([]);
  });

  it("holds the cache while signed out, and empties it when somebody claims it", async () => {
    // Nothing renders behind a closed gate, so there is nothing to protect
    // between the sign-out and the next sign-in -- and clearing at claim time
    // makes the reset happen exactly once per change of tenant.
    const store = testStore();
    sessionArrives("sess_A");
    const view = await act(async () => mountGuard(store));
    warm(store, "mtg_1");

    await act(async () => {
      publishAuthState({ sessionId: null, phase: "signed-out" });
      view.rerender(
        <ReduxProvider store={store}>
          <SessionCacheGuard />
        </ReduxProvider>,
      );
    });
    expect(cacheOwner()).toBe("sess_A");

    await act(async () => {
      sessionArrives("sess_B");
      view.rerender(
        <ReduxProvider store={store}>
          <SessionCacheGuard />
        </ReduxProvider>,
      );
    });

    expect(cached(store)).toHaveLength(0);
  });

  it("does not clear a cache it already owns when it is mounted again", async () => {
    /*
     * The guard's effect re-runs whenever it is remounted -- a layout that
     * remounts, a fast-refresh in development, anything that takes this
     * component out and puts it back. Ownership is the store's, not the
     * component's, so finding the cache already claimed by the current session
     * must mean there is nothing to do.
     *
     * Without that check, being remounted empties a perfectly good cache and
     * every panel on screen reloads.
     */
    const store = testStore();
    sessionArrives("sess_A");
    const first = await act(async () => mountGuard(store));
    warm(store, "mtg_1");
    await act(async () => {
      first.unmount();
    });

    await act(async () => {
      mountGuard(store);
    });

    expect(cached(store)).toHaveLength(1);
    expect(cacheOwner()).toBe("sess_A");
  });

  it("does nothing on a re-render within the same session", async () => {
    const store = testStore();
    sessionArrives("sess_A");
    const view = await act(async () => mountGuard(store));
    warm(store, "mtg_1");

    await act(async () => {
      view.rerender(
        <ReduxProvider store={store}>
          <SessionCacheGuard />
        </ReduxProvider>,
      );
    });

    expect(cached(store)).toHaveLength(1);
  });
});

describe("the barrier", () => {
  it("keeps the gate shut on a proven token until ownership is claimed", async () => {
    /*
     * The ordering guarantee, stated as a fact about the store rather than as a
     * fact about where these components sit in the tree. The old arrangement
     * relied on `SessionCacheGuard` being declared before `{children}` -- true
     * of one commit's effects, and silent about the commit in which the gate
     * opens.
     *
     * The guard is deliberately not mounted for the first half: this is the
     * state the app reaches on its own, and the assertion is that it is not
     * enough.
     */
    const store = testStore();
    sessionArrives("sess_A");
    warm(store, "mtg_1");
    // Someone owned this cache before B arrived.
    const first = await act(async () => mountGuard(store));
    expect(cacheOwner()).toBe("sess_A");
    await act(async () => {
      first.unmount();
    });

    await act(async () => {
      publishAuthState({ sessionId: "sess_B", phase: "preparing-session" });
      resolveTokenProbe("sess_B", true);
    });

    // Token in hand, cache still A's: not open.
    expect(authPhase()).toBe("token-ready");
    expect(isAuthReady()).toBe(false);
    expect(cached(store)).toHaveLength(1);

    await act(async () => {
      mountGuard(store);
    });

    expect(cached(store)).toHaveLength(0);
    expect(isAuthReady()).toBe(true);
  });

  it("opens the gate only after the cache is actually empty", async () => {
    // Ordering asserted from the inside: at the very moment readiness flips to
    // app-ready, there is nothing left of the previous session in the store.
    const store = testStore();
    sessionArrives("sess_A");
    const view = await act(async () => mountGuard(store));
    warm(store, "mtg_1");

    let entriesWhenOpened: number | null = null;
    const stop = subscribeAuthReady(() => {
      if (entriesWhenOpened === null && isAuthReady()) {
        entriesWhenOpened = cached(store).length;
      }
    });

    await act(async () => {
      sessionArrives("sess_B");
      view.rerender(
        <ReduxProvider store={store}>
          <SessionCacheGuard />
        </ReduxProvider>,
      );
    });
    stop();

    expect(isAuthReady()).toBe(true);
    expect(entriesWhenOpened).toBe(0);
  });
});
