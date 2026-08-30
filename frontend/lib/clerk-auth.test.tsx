import { describe, it, expect, beforeEach, vi } from "vitest";
import * as React from "react";
import { render, act } from "@testing-library/react";

/**
 * The bridge between Clerk and the readiness store.
 *
 * <h2>What it has to get right</h2>
 *
 * <p>This component is the only thing in the app that can see Clerk's state,
 * and the only thing that can turn "Clerk believes there is a session" into
 * "a credential for that session has actually been obtained". The gap between
 * those two is the first-login race: they are seconds apart on the first
 * navigation after a sign-in, and the app used to mount in the middle of it.
 *
 * <p>Clerk is mocked rather than driven, because the states worth asserting —
 * a session replaced while a token request is in flight, most of all — are not
 * ones a real SDK can be asked for on demand.
 *
 * <h2>What it does not do</h2>
 *
 * <p>It never reaches `app-ready`. Proving a token is half the barrier; the
 * other half is that the API cache belongs to this session, which
 * `SessionCacheGuard` publishes. So the assertions here stop at `token-ready`
 * — and the fact that `token-ready` does not open the gate is the point of the
 * whole arrangement, asserted in lib/auth-store.test and components/auth-gate.test.
 */

const clerk = vi.hoisted(() => ({
  /** What `useUser` hands back. Null until Clerk has loaded a session. */
  user: null as { fullName: string | null; primaryEmailAddress: { emailAddress: string } | null; hasImage: boolean; imageUrl: string } | null,
  state: {
    isLoaded: false,
    isSignedIn: false,
    sessionId: null as string | null,
    userId: null as string | null,
    getToken: async (): Promise<string | null> => "tok_1",
  },
}));

vi.mock("@clerk/nextjs", () => ({
  ClerkProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useAuth: () => ({
    ...clerk.state,
    signOut: vi.fn(),
  }),
  // The bridge reads the person's name and picture from here, so the account
  // button can stop rendering a primary key. Nothing in this file asserts on
  // them; the mock exists so the component can mount.
  useUser: () => ({ user: clerk.user }),
}));

vi.mock("@/lib/preference-store", () => ({ clearPreferences: vi.fn() }));

import { ClerkAuthProvider } from "@/lib/clerk-auth";
import { AuthContext } from "@/lib/auth";
import {
  authStore,
  authPhase,
  isAuthReady,
  currentSessionId,
  setTokenGetter,
  resetAuthReadiness,
  retryTokenProbe,
} from "@/lib/auth-store";

/** A promise whose resolution this test controls. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function signedOut() {
  clerk.state.isLoaded = true;
  clerk.state.isSignedIn = false;
  clerk.state.sessionId = null;
  clerk.state.userId = null;
}

function signedIn(sessionId: string, userId = "user_1") {
  clerk.state.isLoaded = true;
  clerk.state.isSignedIn = true;
  clerk.state.sessionId = sessionId;
  clerk.state.userId = userId;
}

/** A JWT naming the session it was minted for. */
function jwtFor(sessionId: string): string {
  const payload = Buffer.from(JSON.stringify({ sid: sessionId, sub: "user_1" })).toString(
    "base64url",
  );
  return `eyJhbGciOiJSUzI1NiJ9.${payload}.c2ln`;
}

function mount() {
  return render(
    <ClerkAuthProvider AuthContext={AuthContext}>
      <div>bridged</div>
    </ClerkAuthProvider>,
  );
}

beforeEach(() => {
  authStore.mode = "clerk";
  setTokenGetter(null);
  resetAuthReadiness();
  clerk.state.isLoaded = false;
  clerk.state.isSignedIn = false;
  clerk.state.sessionId = null;
  clerk.state.userId = null;
  clerk.state.getToken = async () => "tok_1";
});

describe("ClerkBridge readiness", () => {
  it("publishes loading while the SDK is still booting", async () => {
    await act(async () => {
      mount();
    });

    expect(authPhase()).toBe("loading");
    expect(authPhase()).not.toBe("token-ready");
  });

  it("publishes signed-out, and registers no token getter, while nobody is in", async () => {
    /*
     * The regression that mattered most. This component wraps the root layout,
     * so it is mounted on `/` and `/sign-in` — and it used to register the
     * getter here regardless, which made `isAuthReady()` true before anybody
     * had signed in and opened the app the instant a sign-in redirected.
     */
    signedOut();

    await act(async () => {
      mount();
    });

    expect(authPhase()).toBe("signed-out");
    expect(authStore.tokenGetter).toBeNull();
  });

  it("treats a lingering session id with no sign-in as signed out", async () => {
    /*
     * Clerk does not always clear both at once. On the way out `isSignedIn`
     * drops first and `sessionId` can still be populated for a render or two,
     * which is a state that looks exactly like being signed in if the only
     * thing consulted is the id.
     *
     * Probing there would ask for a token on a session that is being torn down
     * -- and if one came back, open the app on it.
     */
    const token = deferred<string | null>();
    clerk.state.getToken = () => token.promise;
    clerk.state.isLoaded = true;
    clerk.state.isSignedIn = false;
    clerk.state.sessionId = "sess_A";
    clerk.state.userId = "user_1";

    await act(async () => {
      mount();
    });

    expect(authPhase()).toBe("signed-out");
    expect(currentSessionId()).toBeNull();
    expect(authStore.tokenGetter).toBeNull();
  });

  it("does not report ready merely because Clerk says there is a session", async () => {
    // `isLoaded && isSignedIn` is Clerk's belief, not a credential.
    const token = deferred<string | null>();
    clerk.state.getToken = () => token.promise;
    signedIn("sess_A");

    await act(async () => {
      mount();
    });

    expect(authPhase()).toBe("preparing-session");
    expect(authPhase()).not.toBe("token-ready");
  });

  it("reports ready only once the token request has actually resolved", async () => {
    const token = deferred<string | null>();
    clerk.state.getToken = () => token.promise;
    signedIn("sess_A");
    await act(async () => {
      mount();
    });

    await act(async () => {
      token.resolve("tok_real");
    });

    expect(authPhase()).toBe("token-ready");
    expect(currentSessionId()).toBe("sess_A");
  });

  it("reports failed when the token comes back empty", async () => {
    clerk.state.getToken = async () => null;
    signedIn("sess_A");

    await act(async () => {
      mount();
    });

    expect(authPhase()).toBe("failed");
    expect(authPhase()).not.toBe("token-ready");
  });

  it("reports failed when the token request throws, and says nothing about it", async () => {
    clerk.state.getToken = async () => {
      throw new Error("clerk: instance foo.clerk.accounts.dev refused");
    };
    signedIn("sess_A");

    await act(async () => {
      mount();
    });

    expect(authPhase()).toBe("failed");
  });

  it("registers a getter that asks Clerk fresh every time", async () => {
    let issued = 0;
    clerk.state.getToken = async () => `tok_${++issued}`;
    signedIn("sess_A");
    await act(async () => {
      mount();
    });

    // Once for the readiness probe; the getter is for the requests after it,
    // and each of those gets its own call rather than a kept copy.
    await authStore.tokenGetter?.();
    await authStore.tokenGetter?.();

    expect(issued).toBe(3);
  });

  it("clears the getter when it unmounts", async () => {
    signedIn("sess_A");
    const view = await act(async () => mount());

    act(() => {
      view.unmount();
    });

    expect(authStore.tokenGetter).toBeNull();
  });
});

describe("ClerkBridge across a session change", () => {
  it("drops readiness and proves the new session before opening again", async () => {
    clerk.state.getToken = async () => "tok_A";
    signedIn("sess_A");
    const view = await act(async () => mount());
    expect(authPhase()).toBe("token-ready");

    const next = deferred<string | null>();
    clerk.state.getToken = () => next.promise;
    signedIn("sess_B", "user_2");
    await act(async () => {
      view.rerender(
        <ClerkAuthProvider AuthContext={AuthContext}>
          <div>bridged</div>
        </ClerkAuthProvider>,
      );
    });

    expect(authPhase()).not.toBe("token-ready");
    expect(currentSessionId()).toBe("sess_B");

    await act(async () => {
      next.resolve("tok_B");
    });
    expect(authPhase()).toBe("token-ready");
  });

  it("drops readiness on sign-out", async () => {
    clerk.state.getToken = async () => "tok_A";
    signedIn("sess_A");
    const view = await act(async () => mount());

    signedOut();
    await act(async () => {
      view.rerender(
        <ClerkAuthProvider AuthContext={AuthContext}>
          <div>bridged</div>
        </ClerkAuthProvider>,
      );
    });

    expect(authPhase()).toBe("signed-out");
    expect(authStore.tokenGetter).toBeNull();
  });

  it("requires a fresh proof for a new session of the same account", async () => {
    clerk.state.getToken = async () => "tok_1";
    signedIn("sess_A1", "user_1");
    const view = await act(async () => mount());
    expect(authPhase()).toBe("token-ready");

    const again = deferred<string | null>();
    clerk.state.getToken = () => again.promise;
    // Same person, new session. The credential is per session, so the old
    // proof is about a session that no longer exists.
    signedIn("sess_A2", "user_1");
    await act(async () => {
      view.rerender(
        <ClerkAuthProvider AuthContext={AuthContext}>
          <div>bridged</div>
        </ClerkAuthProvider>,
      );
    });

    expect(authPhase()).not.toBe("token-ready");
  });

  it("does not let a superseded session's token open the app for the next one", async () => {
    /*
     * The async race, driven end to end:
     *
     *   session A: getToken() ─────────────────────────► resolves
     *   session B:        becomes current ────────────────────────►
     *
     * A's answer arrives last and is an answer about A. Taking it would put B
     * in front of the app on A's credential.
     */
    const slowA = deferred<string | null>();
    clerk.state.getToken = () => slowA.promise;
    signedIn("sess_A", "user_1");
    const view = await act(async () => mount());
    expect(authPhase()).toBe("preparing-session");

    const pendingB = deferred<string | null>();
    clerk.state.getToken = () => pendingB.promise;
    signedIn("sess_B", "user_2");
    await act(async () => {
      view.rerender(
        <ClerkAuthProvider AuthContext={AuthContext}>
          <div>bridged</div>
        </ClerkAuthProvider>,
      );
    });

    // A's request finally comes back, carrying a perfectly good token for A.
    await act(async () => {
      slowA.resolve("tok_A");
    });

    expect(authPhase()).not.toBe("token-ready");
    expect(currentSessionId()).toBe("sess_B");

    await act(async () => {
      pendingB.resolve("tok_B");
    });
    expect(authPhase()).toBe("token-ready");
  });

  it("survives Clerk unloading and reinitialising", async () => {
    clerk.state.getToken = async () => "tok_A";
    signedIn("sess_A");
    const view = await act(async () => mount());
    expect(authPhase()).toBe("token-ready");

    clerk.state.isLoaded = false;
    await act(async () => {
      view.rerender(
        <ClerkAuthProvider AuthContext={AuthContext}>
          <div>bridged</div>
        </ClerkAuthProvider>,
      );
    });

    expect(authPhase()).toBe("loading");
    expect(authPhase()).not.toBe("token-ready");
  });
});

/* ---------------------------------------------------------------------------
 * Whose token did Clerk actually hand back?
 * ------------------------------------------------------------------------ */

describe("a token minted for the session that just ended", () => {
  /*
   * `getToken()` answers from a cache that a sign-out does not empty, and a
   * Clerk JWT is short-lived rather than revocable. So the first probe after
   * signing back in can be answered with the *previous* session's credential --
   * which verifies, which the API accepts, and which describes the account that
   * session belonged to.
   *
   * Opening the gate on that is how a first login lands on somebody else's
   * empty workspace, with no error anywhere to say so.
   */
  it("does not open the app on it", async () => {
    signedIn("sess_NEW");
    clerk.state.getToken = async () => jwtFor("sess_OLD");

    await act(async () => {
      mount();
    });

    expect(authPhase()).not.toBe("token-ready");
    expect(isAuthReady()).toBe(false);
  });

  it("opens on the fresh one when Clerk can mint it", async () => {
    signedIn("sess_NEW");
    clerk.state.getToken = async (options?: { skipCache?: boolean }) =>
      options?.skipCache ? jwtFor("sess_NEW") : jwtFor("sess_OLD");

    await act(async () => {
      mount();
    });

    expect(authPhase()).toBe("token-ready");
  });

  it("opens on a token that names this session", async () => {
    signedIn("sess_NEW");
    clerk.state.getToken = async () => jwtFor("sess_NEW");

    await act(async () => {
      mount();
    });

    expect(authPhase()).toBe("token-ready");
    expect(currentSessionId()).toBe("sess_NEW");
  });
});

describe("asking again after a failed probe", () => {
  it("runs the probe a second time, and can succeed on it", async () => {
    /*
     * What the gate's Try again is wired to. A probe that failed leaves the app
     * with a credential it could not get and nothing to do about it; before
     * this the only way through was a reload.
     *
     * Nothing here is scheduled: the counter changes when somebody presses a
     * button, which is the difference between this and a retry loop.
     */
    signedIn("sess_1");
    let attempts = 0;
    clerk.state.getToken = async () => {
      attempts += 1;
      return attempts === 1 ? null : jwtFor("sess_1");
    };

    await act(async () => {
      mount();
    });
    expect(authPhase()).toBe("failed");

    await act(async () => {
      retryTokenProbe();
    });

    expect(attempts).toBe(2);
    expect(authPhase()).toBe("token-ready");
  });
});
