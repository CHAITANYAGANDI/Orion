"use client";

// Loaded lazily by lib/auth.tsx ONLY when NEXT_PUBLIC_AUTH_MODE=clerk.
// Dev builds never evaluate this module, so no Clerk key is required to run.

import * as React from "react";
import { ClerkProvider, useAuth as useClerkAuth, useUser } from "@clerk/nextjs";
import {
  setTokenGetter,
  publishAuthState,
  resolveTokenProbe,
  acquireSessionToken,
  subscribeAuthReady,
  tokenProbeAttempt,
} from "@/lib/auth-store";
import { clearPreferences } from "@/lib/preference-store";
import { normalizeProvider } from "@/lib/identity-owner";
import type { AuthContextValue, UserProfile } from "@/lib/auth";

type Ctx = React.Context<AuthContextValue | null>;

function ClerkBridge({
  AuthContext,
  children,
}: {
  AuthContext: Ctx;
  children: React.ReactNode;
}) {
  const { getToken, userId, sessionId, isSignedIn, isLoaded, signOut } = useClerkAuth();
  /*
   * The person, as Google (or the sign-up form) gave them to Clerk.
   *
   * Already in the browser -- `useUser` reads the session Clerk has loaded, so
   * this costs no request. It is here because the alternative was the account
   * button rendering `user_3IU...`: the backend only knows a name if somebody
   * typed one into Settings, and it only knows an address if a JWT template
   * was configured to send one.
   */
  const { user } = useUser();

  /*
   * Bumped when somebody presses Try again on the gate's failure screen. A
   * probe that failed leaves the app with nothing to do and no way to ask
   * again; this is that way. It is a counter and not a timer -- nothing here
   * re-runs on its own.
   */
  const attempt = React.useSyncExternalStore(subscribeAuthReady, tokenProbeAttempt, () => 0);

  /*
   * Hand the token getter to the non-React store.
   *
   * Only while somebody is signed in. It used to be registered unconditionally,
   * which meant a signed-out visitor sitting on `/sign-in` had already made
   * `isAuthReady()` true -- this component wraps the root layout, public pages
   * included -- and the gate opened the instant a sign-in redirected into the
   * app, before Clerk had adopted the session. See `AuthPhase` in
   * lib/auth-store for the full timeline.
   *
   * The getter is no longer proof of anything on its own; it is simply what
   * `buildAuthHeaders` calls. The proof is the probe below.
   */
  React.useEffect(() => {
    if (!isLoaded || !isSignedIn) {
      setTokenGetter(null);
      return;
    }
    // `options` forwarded rather than dropped: `acquireSessionToken` needs
    // `skipCache` to get past a cached token belonging to a session that has
    // ended. See lib/token-claims for what that cache does across a sign-in.
    setTokenGetter((options) => getToken(options));
    return () => {
      setTokenGetter(null);
    };
  }, [getToken, isLoaded, isSignedIn]);

  /*
   * The probe below reads the getter out of the store rather than closing over
   * `getToken`, which is also what keeps `getToken` out of its dependencies:
   * Clerk hands back a fresh identity for it on renders that have nothing to do
   * with the session changing, and keying a network call on that would re-run
   * it on every one of them. The effect above keeps the store's copy current.
   */

  /*
   * Prove a token can actually be had for THIS session, and say so.
   *
   * <p>This is the half that was missing. `isLoaded && isSignedIn` is Clerk
   * saying it believes there is a session; it is not Clerk having produced a
   * credential for it, and on the first navigation after a sign-in those two
   * are seconds apart. So the app waits for the second one.
   *
   * <p>Nothing here is timed. There is no delay, no retry loop and no reload:
   * the probe is the ordinary `getToken()` call every request makes, and its
   * resolution is the event being awaited.
   *
   * <p><b>Three independent guards against a stale answer.</b> The `cancelled`
   * flag stops a superseded effect from publishing at all, and
   * `resolveTokenProbe` re-checks the session id on the way in -- because the
   * consequence of getting this wrong is opening the app for session B on the
   * strength of session A's credential, and one flag in a closure is a thin
   * thing to hang tenant isolation on.
   *
   * <p>The third is inside `acquireSessionToken`, and it is the one the other
   * two could not give: they establish which session <em>asked</em>, and it
   * establishes which session the token that came back was actually minted
   * for. Clerk can hand out the previous session's cached JWT here, and a gate
   * opened on that credential is a gate opened onto somebody else's account.
   */
  React.useEffect(() => {
    if (!isLoaded) {
      publishAuthState({ sessionId: null, phase: "loading" });
      return;
    }
    if (!isSignedIn || !sessionId) {
      publishAuthState({ sessionId: null, phase: "signed-out" });
      return;
    }

    publishAuthState({ sessionId, phase: "preparing-session" });

    let cancelled = false;
    void (async () => {
      // The same call every request makes, so what the gate opens on and what
      // the wire carries cannot come apart. It does not throw.
      const token = await acquireSessionToken(sessionId);
      if (!cancelled) resolveTokenProbe(sessionId, Boolean(token));
    })();

    return () => {
      cancelled = true;
    };
  }, [isLoaded, isSignedIn, sessionId, attempt]);

  const profile: UserProfile = React.useMemo(
    () => ({
      // `fullName` is null when somebody signed up with an address and never
      // gave a name, which is every email sign-up -- the form deliberately does
      // not ask. `username` is not consulted at all: Reverie never collects one.
      name: user?.fullName?.trim() || user?.firstName?.trim() || "",
      email: user?.primaryEmailAddress?.emailAddress ?? "",
      imageUrl: user?.hasImage ? user.imageUrl : "",
      /*
       * The first connected account, which in this product is Google or
       * nothing. Its presence is what makes the name and the address somebody
       * else's -- see lib/identity-owner for what the profile page does with
       * it.
       */
      provider: normalizeProvider(user?.externalAccounts?.[0]?.provider),
      hasPassword: Boolean(user?.passwordEnabled),
    }),
    [user],
  );

  const value: AuthContextValue = {
    mode: "clerk",
    userId: userId ?? "",
    setDevUserId: () => {
      /* no-op in clerk mode */
    },
    // The session, not the user: signing out and back in as the same person is
    // a new session, and that is exactly the case anything stored per-sign-in
    // has to notice. See lib/preference-store.ts.
    sessionKey: isLoaded ? sessionId ?? "" : "",
    isSignedIn: Boolean(isSignedIn),
    isLoaded,
    profile,
    signOut: () => {
      // Belt to the session key's braces, and the part that runs even when the
      // next person to sign in on this browser is somebody else.
      clearPreferences();
      void signOut();
    },
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function ClerkAuthProvider({
  AuthContext,
  children,
}: {
  AuthContext: Ctx;
  children: React.ReactNode;
}) {
  const publishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || "";
  return (
    /*
     * The four URLs are given rather than left to Clerk's defaults, which point
     * at its own hosted pages. Reverie hosts the two screens itself — see
     * app/sign-in and app/sign-up — so a default that sent people to
     * accounts.clerk.dev would take them out of the product to come back into
     * it, and `afterSignOutUrl` is what stops signing out landing on a
     * protected route that immediately bounces you to sign in again.
     */
    <ClerkProvider
      publishableKey={publishableKey}
      signInUrl="/sign-in"
      signUpUrl="/sign-up"
      afterSignOutUrl="/"
    >
      <ClerkBridge AuthContext={AuthContext}>{children}</ClerkBridge>
    </ClerkProvider>
  );
}
