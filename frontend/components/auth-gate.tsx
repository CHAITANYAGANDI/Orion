"use client";

import * as React from "react";
import { useSyncExternalStore } from "react";
import { useAuth } from "@/lib/auth";
import { isAuthReady, subscribeAuthReady } from "@/lib/auth-store";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Nothing that needs a token renders before there is one.
 *
 * <h2>The bug</h2>
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
 * <p>It presented as flaky because it is a race — a warm session sometimes let
 * the effect win — and it reproduced every time on a hard refresh, which is
 * precisely when Clerk has the most to do before it can produce a token.
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
 * <p>`isAuthReady()` is true immediately in dev mode: the `X-Dev-User` header
 * comes from `authStore.devUserId`, hydrated at module load, before any
 * component renders. There is no race to wait for, so dev behaviour is
 * unchanged — and this deliberately does not fall back to dev auth when Clerk
 * is slow, which would be an authentication bypass on a timer.
 */
export function AuthGate({ children }: { children: React.ReactNode }) {
  /*
   * The store, not React state. The getter is registered from an effect in a
   * different provider; `useSyncExternalStore` is how a component outside that
   * tree learns about it without either of them knowing about the other.
   *
   * `getServerSnapshot` (the third argument) reports not-ready during SSR and
   * the hydration pass. That is honest — there is no Clerk on the server — and
   * it keeps the first client render identical to the server's, which is what
   * stops a hydration mismatch.
   */
  const tokenReady = useSyncExternalStore(
    subscribeAuthReady,
    isAuthReady,
    () => false,
  );

  // `isLoaded` is Clerk's own signal that it has finished booting. Both are
  // required: the getter can be registered while Clerk is still resolving the
  // session, and calling it then yields null -- a request with no token, which
  // is the failure this exists to prevent.
  const { isLoaded } = useAuth();

  if (!tokenReady || !isLoaded) {
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
