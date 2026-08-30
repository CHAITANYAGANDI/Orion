import { describe, it, expect, beforeEach, vi } from "vitest";
import * as React from "react";
import { render } from "@testing-library/react";
import { Provider as ReduxProvider } from "react-redux";
import { configureStore } from "@reduxjs/toolkit";

/**
 * One person's cached data must not outlive their sign-in.
 *
 * <h2>What is actually at risk</h2>
 *
 * <p>RTK Query keys a cache entry by endpoint and serialised argument —
 * `getMeetings({page: 0, size: 50})` — and not one endpoint in this app puts a
 * user or a session in that key. They never needed to: a bearer token decided
 * whose meetings came back. So if the store outlives a change of sign-in, user
 * B's first `getMeetings` is a cache <em>hit</em> on user A's, and RTK Query
 * hands the cached page to the component while it revalidates.
 *
 * <p>The two halves of this file are therefore: does the store survive, and if
 * it does, is the cache emptied. The first is not assumed — it is measured,
 * because if a hard navigation already destroyed the store there would be
 * nothing here worth adding.
 */

const auth = vi.hoisted(() => ({
  value: { sessionKey: "", isLoaded: false } as { sessionKey: string; isLoaded: boolean },
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => auth.value,
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

function rerenderGuard(view: ReturnType<typeof mountGuard>, store: ReturnType<typeof testStore>) {
  view.rerender(
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

beforeEach(() => {
  auth.value = { sessionKey: "", isLoaded: false };
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

describe("SessionCacheGuard", () => {
  it("keeps the cache on the first pass, when there is no previous sign-in", () => {
    // The cache was warmed by this same sign-in. Clearing on mount would throw
    // away work for nothing.
    const store = testStore();
    auth.value = { sessionKey: "sess_A", isLoaded: true };
    warm(store, "mtg_1");

    mountGuard(store);

    expect(cached(store)).toHaveLength(1);
  });

  it("keeps the cache while the sign-in has not changed", () => {
    const store = testStore();
    auth.value = { sessionKey: "sess_A", isLoaded: true };
    const view = mountGuard(store);
    warm(store, "mtg_1");

    rerenderGuard(view, store);

    expect(cached(store)).toHaveLength(1);
  });

  it("empties the cache when another account signs in", () => {
    // The tenant-isolation case. Without this, B's `getMeeting("mtg_1")` is a
    // hit on A's entry and B reads A's meeting by title.
    const store = testStore();
    auth.value = { sessionKey: "sess_A", isLoaded: true };
    const view = mountGuard(store);
    warm(store, "mtg_1");
    expect(cached(store)).toHaveLength(1);

    auth.value = { sessionKey: "sess_B", isLoaded: true };
    rerenderGuard(view, store);

    expect(cached(store)).toHaveLength(0);
  });

  it("empties the cache on sign-out", () => {
    const store = testStore();
    auth.value = { sessionKey: "sess_A", isLoaded: true };
    const view = mountGuard(store);
    warm(store, "mtg_1");

    auth.value = { sessionKey: "", isLoaded: true };
    rerenderGuard(view, store);

    expect(cached(store)).toHaveLength(0);
  });

  it("empties the cache when the same person signs in again on a new session", () => {
    // A new session is a new sign-in even for the same account, and the data
    // behind it may have changed on another device in between.
    const store = testStore();
    auth.value = { sessionKey: "sess_A1", isLoaded: true };
    const view = mountGuard(store);
    warm(store, "mtg_1");

    auth.value = { sessionKey: "sess_A2", isLoaded: true };
    rerenderGuard(view, store);

    expect(cached(store)).toHaveLength(0);
  });

  it("empties the cache when a dev user is switched", () => {
    // Dev mode has no sessions, so `sessionKey` is the dev user id -- and
    // switching it changes the identity the API sees with no navigation at all.
    const store = testStore();
    auth.value = { sessionKey: "usr_a", isLoaded: true };
    const view = mountGuard(store);
    warm(store, "mtg_1");

    auth.value = { sessionKey: "usr_b", isLoaded: true };
    rerenderGuard(view, store);

    expect(cached(store)).toHaveLength(0);
  });

  it("does not treat Clerk finishing its boot as a change of sign-in", () => {
    // Before `isLoaded`, `sessionKey` is "" for want of an answer rather than
    // because nobody is signed in. Recording that would make the real session
    // look like a change on arrival and drop a warm cache for nothing.
    const store = testStore();
    auth.value = { sessionKey: "", isLoaded: false };
    const view = mountGuard(store);
    warm(store, "mtg_1");

    auth.value = { sessionKey: "sess_A", isLoaded: true };
    rerenderGuard(view, store);

    expect(cached(store)).toHaveLength(1);
  });

  it("drops every endpoint, not only the one that was invalidated", () => {
    const store = testStore();
    auth.value = { sessionKey: "sess_A", isLoaded: true };
    const view = mountGuard(store);
    warm(store, "mtg_1");
    warm(store, "mtg_2");
    expect(cached(store)).toHaveLength(2);

    auth.value = { sessionKey: "sess_B", isLoaded: true };
    rerenderGuard(view, store);

    expect(cached(store)).toEqual([]);
  });
});
