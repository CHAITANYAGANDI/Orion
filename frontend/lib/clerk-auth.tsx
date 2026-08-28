"use client";

// Loaded lazily by lib/auth.tsx ONLY when NEXT_PUBLIC_AUTH_MODE=clerk.
// Dev builds never evaluate this module, so no Clerk key is required to run.

import * as React from "react";
import { ClerkProvider, useAuth as useClerkAuth } from "@clerk/nextjs";
import { authStore } from "@/lib/auth-store";
import { clearPreferences } from "@/lib/preference-store";
import type { AuthContextValue } from "@/lib/auth";

type Ctx = React.Context<AuthContextValue | null>;

function ClerkBridge({
  AuthContext,
  children,
}: {
  AuthContext: Ctx;
  children: React.ReactNode;
}) {
  const { getToken, userId, sessionId, isSignedIn, isLoaded, signOut } = useClerkAuth();

  React.useEffect(() => {
    authStore.tokenGetter = () => getToken();
    return () => {
      authStore.tokenGetter = null;
    };
  }, [getToken]);

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
     * at its own hosted pages. Orion hosts the two screens itself — see
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
