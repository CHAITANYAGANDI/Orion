import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as React from "react";
import { render, screen, act, waitFor } from "@testing-library/react";
import { Provider as ReduxProvider } from "react-redux";
import { configureStore, type Middleware } from "@reduxjs/toolkit";

/**
 * The whole first-authenticated-render sequence, in one place.
 *
 * <h2>Why an integration test and not more unit tests</h2>
 *
 * <p>Readiness, the cache reset and the query hooks were each correct on their
 * own and each had passing tests. What was wrong was the <em>order they ran
 * in</em>, and an order is not a property of any one of them — it emerges from
 * where they sit in the tree and which React commit each one's effect belongs
 * to. Nothing short of mounting the real arrangement can see it.
 *
 * <p>So this renders the production nesting: the real store, the real `api`
 * with the real `fetchBaseQuery`, the real `AuthGate` and `SessionCacheGuard`,
 * and query hooks standing in for the ones that failed in production — the
 * sidebar folder tree, Home's meeting list, and the usage badge that kept
 * working while the other two did not.
 *
 * <p>Only `fetch` and Clerk are stubbed.
 */

const auth = vi.hoisted(() => ({
  value: { sessionKey: "", isLoaded: false, userId: "", isSignedIn: false },
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => auth.value,
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { api } from "@/lib/api";
import { AuthGate } from "@/components/auth-gate";
import { SessionCacheGuard } from "@/components/session-cache-guard";
import {
  authStore,
  setTokenGetter,
  publishAuthState,
  resolveTokenProbe,
  resetAuthReadiness,
} from "@/lib/auth-store";

/* ------------------------------- the wire -------------------------------- */

let served: string[] = [];

function bodyFor(url: string): unknown {
  if (url.includes("/projects")) return [{ id: "prj_1", name: "Design" }];
  if (url.includes("/usage")) return { aiCallsUsed: 1, aiCallsLimit: 100 };
  return { content: [{ id: "mtg_1", title: "A meeting" }], page: 0, size: 50, totalElements: 1, totalPages: 1 };
}

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      served.push(url);
      const body = JSON.stringify(bodyFor(url));
      return {
        ok: true,
        status: 200,
        headers: {
          get: (n: string) => (n.toLowerCase() === "content-type" ? "application/json" : null),
          forEach: () => {},
        },
        json: async () => JSON.parse(body),
        text: async () => body,
        clone() {
          return this;
        },
      } as unknown as Response;
    }),
  );
}

/* ------------------------------- the store ------------------------------- */

/** Every action, in order, so the *sequence* can be asserted rather than the end state. */
let actions: string[] = [];

const recorder: Middleware = () => (next) => (action) => {
  actions.push((action as { type: string }).type);
  return next(action);
};

function makeStore() {
  return configureStore({
    reducer: { [api.reducerPath]: api.reducer },
    middleware: (getDefault) => getDefault().concat(api.middleware).concat(recorder),
  });
}

/** Where the API cache was wiped, and where each query first went out. */
const resetAt = () => actions.indexOf("api/resetApiState");
const firstQueryAt = () => actions.findIndex((t) => t === "api/executeQuery/pending");

/* ------------------------------ the subtree ------------------------------ */

const mounts = { folders: 0, meetings: 0, usage: 0 };

function Folders() {
  const { data } = api.useGetProjectsQuery();
  React.useEffect(() => {
    mounts.folders += 1;
  }, []);
  // Exactly what components/folder-tree.tsx does, and the reason an empty tree
  // is indistinguishable from a killed query on that screen.
  const folders = data ?? [];
  return <div data-testid="folders">{folders.length ? "folders-loaded" : "folders-empty"}</div>;
}

function Meetings() {
  const { data } = api.useGetMeetingsQuery({ page: 0, size: 50 });
  React.useEffect(() => {
    mounts.meetings += 1;
  }, []);
  return (
    <div data-testid="meetings">{data?.content.length ? "meetings-loaded" : "meetings-empty"}</div>
  );
}

function Usage() {
  const { data } = api.useGetUsageQuery();
  React.useEffect(() => {
    mounts.usage += 1;
  }, []);
  return <div data-testid="usage">{data ? "usage-loaded" : "usage-empty"}</div>;
}

/**
 * The production nesting, exactly.
 *
 * <p>`SessionCacheGuard` is a sibling declared *before* the children, which is
 * what the old comment in Providers leaned on. The gate is inside the children,
 * because it lives in `app/(app)/layout.tsx`.
 */
function App({ store }: { store: ReturnType<typeof makeStore> }) {
  return (
    <ReduxProvider store={store}>
      <SessionCacheGuard />
      <AuthGate>
        <Folders />
        <Meetings />
        <Usage />
      </AuthGate>
    </ReduxProvider>
  );
}

/* -------------------------------- driving -------------------------------- */

/**
 * Wait until the three query hooks have actually answered.
 *
 * <p>`waitFor` rather than a fixed number of microtask flushes: the chain is
 * effect -> thunk -> stubbed fetch -> promise -> dispatch -> re-render, and
 * counting turns of it is a test that passes for the wrong reason on a good day
 * and fails for the wrong reason on a bad one. Guessing wrong here cost an hour
 * of chasing a bug that was not in the app.
 */
/** Wait for one panel to say it has what it asked for. */
async function loaded(id: string) {
  await waitFor(() => expect(screen.getByTestId(id)).toHaveTextContent(`${id}-loaded`), {
    timeout: 3000,
  });
}

async function settled(expected = 3) {
  await waitFor(
    () => {
      expect(actions.filter((t) => t === "api/executeQuery/fulfilled")).toHaveLength(expected);
    },
    { timeout: 2000 },
  );
}

function signIn(sessionId: string, userId = "user_1") {
  auth.value = { sessionKey: sessionId, isLoaded: true, userId, isSignedIn: true };
}

function signOut() {
  auth.value = { sessionKey: "", isLoaded: true, userId: "", isSignedIn: false };
}

/** What ClerkBridge publishes when Clerk reports a session. */
function clerkSawSession(sessionId: string) {
  setTokenGetter(async () => `tok_${sessionId}`);
  publishAuthState({ sessionId, phase: "preparing-session" });
}

function tokenArrived(sessionId: string) {
  resolveTokenProbe(sessionId, true);
}

beforeEach(() => {
  served = [];
  actions = [];
  mounts.folders = 0;
  mounts.meetings = 0;
  mounts.usage = 0;
  auth.value = { sessionKey: "", isLoaded: false, userId: "", isSignedIn: false };
  authStore.mode = "clerk";
  setTokenGetter(null);
  resetAuthReadiness();
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/* ---------------------------------------------------------------------------
 * The transition
 * ------------------------------------------------------------------------ */

describe("signing into a new session while the Redux root survives", () => {
  /**
   * The sequence production actually performs. The document is not reloaded at
   * any point: `signOut` navigates to `afterSignOutUrl` and `<SignIn>`
   * navigates to `fallbackRedirectUrl`, and both are client navigations, so one
   * store spans all of it.
   */
  async function transitionAtoB(store: ReturnType<typeof makeStore>) {
    // --- session A, fully open ------------------------------------------
    signIn("sess_A");
    clerkSawSession("sess_A");
    const view = render(<App store={store} />);
    await act(async () => {
      tokenArrived("sess_A");
    });
    await settled();

    // --- signed out -----------------------------------------------------
    signOut();
    await act(async () => {
      publishAuthState({ sessionId: null, phase: "signed-out" });
      view.rerender(<App store={store} />);
    });

    // --- session B arrives ----------------------------------------------
    // Clerk publishes the new session and the context's `sessionKey` changes
    // in the same render, which is what production does.
    actions = [];
    served = [];
    signIn("sess_B", "user_2");
    await act(async () => {
      clerkSawSession("sess_B");
      view.rerender(<App store={store} />);
    });

    // --- the token for B lands, and the gate opens ----------------------
    await act(async () => {
      tokenArrived("sess_B");
    });
    await settled();
    return view;
  }

  it("never wipes the cache after the new session's queries have started", async () => {
    /*
     * THE BUG. `resetApiState` removes every cache entry *and every
     * subscription*, and a `useQuery` that is already mounted does not
     * re-subscribe afterwards -- its subscribing effect ran on mount and has no
     * reason to run again. So a query caught by a late reset is left
     * `isUninitialized` with nothing in flight, for ever.
     *
     * On the sidebar that is `projects ?? []` -- an empty folder tree with no
     * skeleton and no error, which is exactly what production showed. Only a
     * manual refresh fixes it, because only a refresh remounts the hooks.
     */
    await transitionAtoB(makeStore());

    const reset = resetAt();
    const firstQuery = firstQueryAt();
    if (reset === -1 || firstQuery === -1) {
      expect({ reset, firstQuery }).toMatchObject({ reset: expect.any(Number) });
    }
    expect(
      reset < firstQuery,
      `reset ran at ${reset} and the first new-session query at ${firstQuery}`,
    ).toBe(true);
  });

  it("loads the folder tree on the first authenticated render", async () => {
    await transitionAtoB(makeStore());

    await loaded("folders");
  });

  it("loads the meeting list on the first authenticated render", async () => {
    await transitionAtoB(makeStore());

    await loaded("meetings");
  });

  it("cannot end up with usage loaded while folders and meetings are empty", async () => {
    // The production screenshot, as an assertion. A reset that lands between
    // two hooks' first requests splits the page into panels that worked and
    // panels that did not, which reads as a broken account rather than a
    // broken load.
    await transitionAtoB(makeStore());
    await loaded("usage");
    await loaded("folders");
    await loaded("meetings");

    const text = [
      screen.getByTestId("usage").textContent,
      screen.getByTestId("folders").textContent,
      screen.getByTestId("meetings").textContent,
    ];
    expect(text).toEqual(["usage-loaded", "folders-loaded", "meetings-loaded"]);
  });

  it("mounts each query hook exactly once for the new session", async () => {
    await transitionAtoB(makeStore());

    expect(mounts).toEqual({ folders: 2, meetings: 2, usage: 2 });
  });

  it("serves the new session's requests, and none from the old cache", async () => {
    await transitionAtoB(makeStore());

    // Every one of the three went out again under B rather than being answered
    // from A's entries.
    expect(served.filter((u) => u.includes("/projects"))).toHaveLength(1);
    expect(served.filter((u) => u.includes("/meetings"))).toHaveLength(1);
    expect(served.filter((u) => u.includes("/usage"))).toHaveLength(1);
  });
});

describe("an ordinary first start, with no previous session in this store", () => {
  async function coldStart(store: ReturnType<typeof makeStore>) {
    const view = render(<App store={store} />);
    signIn("sess_A");
    await act(async () => {
      clerkSawSession("sess_A");
      view.rerender(<App store={store} />);
    });
    await act(async () => {
      tokenArrived("sess_A");
    });
    await settled();
    return view;
  }

  it("loads everything without a manual refresh", async () => {
    await coldStart(makeStore());

    await loaded("folders");
    await loaded("meetings");
    await loaded("usage");
  });

  it("does not wipe queries that have already started", async () => {
    // There is no previous tenant's data in this store, so there is nothing to
    // protect anybody from -- and a reset here would only be capable of
    // breaking the load it was supposed to be guarding.
    await coldStart(makeStore());

    const reset = resetAt();
    const firstQuery = firstQueryAt();
    expect(reset === -1 || reset < firstQuery).toBe(true);
  });

  it("mounts each query hook exactly once", async () => {
    await coldStart(makeStore());

    expect(mounts).toEqual({ folders: 1, meetings: 1, usage: 1 });
  });
});

describe("within one session", () => {
  async function open(store: ReturnType<typeof makeStore>) {
    signIn("sess_A");
    clerkSawSession("sess_A");
    const view = render(<App store={store} />);
    await act(async () => {
      tokenArrived("sess_A");
    });
    await settled();
    actions = [];
    return view;
  }

  it("does not reset the cache when the token is refreshed", async () => {
    const store = makeStore();
    const view = await open(store);

    // A refresh replaces the credential, not the tenant. Dropping the cache
    // here would empty the screen roughly once a minute.
    await act(async () => {
      setTokenGetter(async () => "tok_fresher");
      view.rerender(<App store={store} />);
    });

    expect(actions).not.toContain("api/resetApiState");
  });

  it("does not reset the cache on an ordinary re-render", async () => {
    const store = makeStore();
    const view = await open(store);

    await act(async () => {
      view.rerender(<App store={store} />);
    });
    await act(async () => {
      view.rerender(<App store={store} />);
    });

    expect(actions).not.toContain("api/resetApiState");
  });
});
