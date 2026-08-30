"use client";

import * as React from "react";
import { useSyncExternalStore } from "react";
import { isAuthReady, subscribeAuthReady } from "@/lib/auth-store";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Nothing that needs a token renders before there is one.
 *
 * <h2>The first bug</h2>
 *
 * <p>On a hard refresh the app came up with empty panels and errors behind
 * them, and a second refresh usually fixed it. Every authenticated request in
 * that first pass had gone out with no `Authorization` header and come back
 * 401.
 *
 * <p>The cause is ordering, not Clerk. `ClerkBridge` registers
 * `authStore.tokenGetter` in an effect, and React runs effects after the
 * subtree below has mounted. RTK Query hooks fire on mount. So the first
 * request of every hook in the app was built during the render pass *before*
 * the getter existed, `buildAuthHeaders` found `null`, and it sent nothing.
 *
 * <h2>The second bug, which this file is now about</h2>
 *
 * <p>Holding the subtree back until the getter existed fixed the refresh and
 * left a narrower version of the same race behind, on the first authenticated
 * navigation <em>after signing in</em>:
 *
 * <pre>
 *   tokenReady  = authStore.tokenGetter !== null
 *   isLoaded    = Clerk has booted
 *   gate opens  = tokenReady && isLoaded
 * </pre>
 *
 * <p>Neither half says anybody is signed in. `ClerkBridge` wraps the root
 * layout, so it is mounted on `/` and `/sign-in` too and had already registered
 * the getter while the visitor was signed out; Clerk had booted long before.
 * Both halves were therefore true *before the sign-in happened*, and the gate
 * opened in the same commit that Clerk redirected into `/home` — ahead of Clerk
 * adopting the new session. `getToken()` answered null, and roughly a dozen
 * hooks sent uncredentialed requests. Refreshing fixed it because by then the
 * session was long since adopted.
 *
 * <p>The distinction that was missing: <b>having a function that can ask for a
 * token is not having a token.</b> Readiness now means a token for the session
 * the browser is in right now has actually been obtained — see `AuthPhase` in
 * lib/auth-store, where the five states are spelled out and the session-change
 * rules live.
 *
 * <h2>Why here and not in the query layer</h2>
 *
 * <p>The alternatives are worse. Retrying a 401 turns one request into two and
 * still paints an error state first. `skipToken` on every hook is the same
 * condition repeated in ~40 call sites, where it will be forgotten exactly once
 * and reintroduce this. A delay is a guess about someone else's network.
 *
 * <p>Holding the subtree back is the only version where the guarantee is
 * structural: a hook that does not exist cannot fire an unauthenticated
 * request, so this holds for pages nobody has written yet.
 *
 * <h2>Why it wraps the app group and not the whole tree</h2>
 *
 * <p>`/`, `/sign-in` and `/sign-up` need no token and must render while Clerk
 * is still loading — gating them would mean showing a skeleton in front of the
 * sign-in form, which is where the token is supposed to come from. So this sits
 * in `app/(app)/layout.tsx`, around everything that is behind the login and
 * outside `<AppShell>`, because the shell itself queries (the bell, the
 * allowance, the folder tree).
 *
 * <h2>Dev mode is not gated</h2>
 *
 * <p>The store's phase starts at `ready` in dev mode: the `X-Dev-User` header
 * comes from `authStore.devUserId`, hydrated at module load, before any
 * component renders. There is no race to wait for, so dev behaviour is
 * unchanged — and this deliberately does not fall back to dev auth when Clerk
 * is slow, which would be an authentication bypass on a timer.
 */
export function AuthGate({ children }: { children: React.ReactNode }) {
  /*
   * The store, and nothing else.
   *
   * <p>It used to read Clerk's `isLoaded` from `useAuth()` as well, and that
   * second source is exactly what made the condition look sufficient while
   * proving nothing. Every fact this needs — has Clerk booted, is anybody
   * signed in, has a token for *this* session been obtained — is now published
   * to one place by `ClerkBridge`, so there is one thing to be wrong rather
   * than two things to disagree.
   *
   * <p>`getServerSnapshot` (the third argument) reports not-ready during SSR
   * and the hydration pass. That is honest — there is no Clerk on the server —
   * and it keeps the first client render identical to the server's, which is
   * what stops a hydration mismatch.
   *
   * <p>It also fails closed: if the bridge never mounts, the phase never leaves
   * `loading` and the authenticated app never renders.
   */
  const ready = useSyncExternalStore(subscribeAuthReady, isAuthReady, () => false);

  if (!ready) {
    return <AuthGateFallback />;
  }
  return <>{children}</>;
}

/**
 * What is on screen for the fraction of a second this takes.
 *
 * <p>Deliberately not a spinner and not the word "Loading". This replaces a
 * flash of the full application with empty panels, so the honest thing to show
 * is the shape of what is coming — and on a fast connection it is gone before
 * it is read.
 *
 * <p>The same fallback for all four of the states that are not ready. A
 * signed-out visitor does not linger here: the middleware answers `/home` with
 * a redirect to `/sign-in` before any of this is sent, so the only way to be
 * here signed out is a session ending under a page already open — and a
 * skeleton for the moment before the next navigation is better than an
 * explanation nobody will finish reading.
 */
function AuthGateFallback() {
  return (
    <div className="flex min-h-screen w-full flex-col gap-4 p-6" aria-busy="true">
      <span className="sr-only">Loading your workspace…</span>
      <Skeleton className="h-12 w-full" />
      <div className="flex flex-1 gap-4">
        <Skeleton className="hidden h-[60vh] w-64 shrink-0 md:block" />
        <Skeleton className="h-[60vh] flex-1" />
      </div>
    </div>
  );
}
